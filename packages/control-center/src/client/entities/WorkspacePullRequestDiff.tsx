import {
  DiffFileTree,
  DiffHeader,
  DiffWorkbench,
  type RlyDiffFile,
  type RlyDiffFileContent,
  type RlyDiffInventory,
  type RlyDiffLayout
} from "@knpkv/rly/diff/workbench"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem } from "@knpkv/rly/diff/bounded"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Predicate from "effect/Predicate"
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { CompleteDiffContentRange, CompleteDiffInventory, CompleteDiffInventoryEntry } from "../../api/diff.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import type { PrReviewSuggestion, PrReviewSuggestionState } from "../../domain/prReview.js"
import type { Revision, VendorImmutableId } from "../../domain/sourceRevision.js"
import styles from "./WorkspacePullRequestDiff.module.css"

const BoundedDiffCodeView = lazy(async () => {
  const module = await import("@knpkv/rly/diff/bounded")
  return { default: module.BoundedDiffCodeView }
})

export interface WorkspacePullRequestDiffScope {
  readonly pluginConnectionId: PluginConnectionId
  readonly revision: Revision
  readonly vendorImmutableId: VendorImmutableId
}

export interface WorkspacePullRequestDiffTransport {
  readonly content: (
    scope: WorkspacePullRequestDiffScope,
    entry: Pick<CompleteDiffInventoryEntry, "anchor" | "path" | "previousPath" | "status">,
    side: "before" | "after",
    signal: AbortSignal
  ) => Promise<CompleteDiffContentRange>
  readonly inventory: (scope: WorkspacePullRequestDiffScope, signal: AbortSignal) => Promise<CompleteDiffInventory>
}

/** Generated-client transport; provider credentials remain behind the server session boundary. */
export const browserWorkspacePullRequestDiffTransport: WorkspacePullRequestDiffTransport = {
  inventory: (scope, signal) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeControlCenterApiClient()
        return yield* client.diff.inventory({
          params: {
            pluginConnectionId: scope.pluginConnectionId,
            vendorImmutableId: scope.vendorImmutableId
          },
          query: { revision: scope.revision }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  content: (scope, entry, side, signal) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeControlCenterApiClient()
        return yield* client.diff.content({
          params: {
            pluginConnectionId: scope.pluginConnectionId,
            vendorImmutableId: scope.vendorImmutableId
          },
          payload: {
            revision: scope.revision,
            anchor: entry.anchor,
            path: entry.path,
            status: entry.status,
            previousPath: entry.previousPath,
            side,
            offset: 0,
            length: 1_048_576
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

interface LoadedText {
  readonly after: string
  readonly before: string
}

type InventoryLoadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly inventory: CompleteDiffInventory }

type SuggestionSeverityFilter = "all" | PrReviewSuggestion["severity"]
type SuggestionStateFilter = "all" | PrReviewSuggestionState
const overviewScopeKinds = ["file", "changes"] satisfies ReadonlyArray<"file" | "changes">

const ignoreSessionExpiration = (_sessionKey: string): void => undefined
const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

const explicitContent = (entry: CompleteDiffInventoryEntry): RlyDiffFileContent =>
  entry.binary
    ? { state: "binary", reason: "CodeCommit reports binary content." }
    : entry.generated
      ? { state: "generated", reason: "Generated content is indexed but not rendered." }
      : entry.oversized
        ? { state: "oversized", reason: "Content exceeds the bounded renderer limit." }
        : { state: "ready" }

const unavailableContent = (reason: NonNullable<CompleteDiffContentRange["unavailableReason"]>): RlyDiffFileContent => {
  switch (reason) {
    case "binary":
      return { state: "binary", reason: "Binary content is indexed but not rendered." }
    case "generated":
      return { state: "generated", reason: "Generated content is indexed but not rendered." }
    case "oversized":
      return { state: "oversized", reason: "Content exceeds the one MiB renderer limit." }
    case "missing":
      return { state: "unavailable", reason: "This side is not present at the immutable revision." }
    case "provider-unavailable":
      return { state: "unavailable", reason: "CodeCommit content is temporarily unavailable." }
  }
}

const textFrom = (content: CompleteDiffContentRange): string | null => {
  if (content.unavailableReason !== null || content.bytesBase64 === null) return null
  const decoded = Encoding.decodeBase64(content.bytesBase64)
  return decoded._tag === "Failure" ? null : new TextDecoder().decode(decoded.success)
}

const toFile = (entry: CompleteDiffInventoryEntry, content: RlyDiffFileContent): RlyDiffFile =>
  entry.status === "renamed" && entry.previousPath !== null
    ? {
        id: entry.anchor,
        path: entry.path,
        previousPath: entry.previousPath,
        change: "renamed",
        content
      }
    : {
        id: entry.anchor,
        path: entry.path,
        change: entry.status === "copied" ? "added" : entry.status === "renamed" ? "modified" : entry.status,
        content
      }

/** Connect one complete immutable CodeCommit inventory to rly's lazy workbench. */
export const WorkspacePullRequestDiff = ({
  heading,
  onSessionExpired = ignoreSessionExpiration,
  scope,
  sessionKey = null,
  suggestions = [],
  transport = browserWorkspacePullRequestDiffTransport
}: {
  readonly heading: string
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly scope: WorkspacePullRequestDiffScope
  readonly sessionKey?: string | null
  readonly suggestions?: ReadonlyArray<PrReviewSuggestion>
  readonly transport?: WorkspacePullRequestDiffTransport
}): ReactElement => {
  const [inventoryState, setInventoryState] = useState<InventoryLoadState>({ _tag: "loading" })
  const [selectedFileId, setSelectedFileId] = useState<string>()
  const [contentStates, setContentStates] = useState<ReadonlyMap<string, RlyDiffFileContent>>(new Map())
  const [loadedText, setLoadedText] = useState<ReadonlyMap<string, LoadedText>>(new Map())
  const [contentRetryKey, setContentRetryKey] = useState(0)
  const [layout, setLayout] = useState<RlyDiffLayout>("split")
  const [isWrapped, setIsWrapped] = useState(false)
  const [severityFilter, setSeverityFilter] = useState<SuggestionSeverityFilter>("all")
  const [suggestionStateFilter, setSuggestionStateFilter] = useState<SuggestionStateFilter>("all")

  useEffect(() => {
    setSeverityFilter("all")
    setSuggestionStateFilter("all")
  }, [scope.pluginConnectionId, scope.revision, scope.vendorImmutableId])

  useEffect(() => {
    const abort = new AbortController()
    setInventoryState({ _tag: "loading" })
    setSelectedFileId(undefined)
    setContentStates(new Map())
    setLoadedText(new Map())
    setContentRetryKey(0)
    transport.inventory(scope, abort.signal).then(
      (inventory) => {
        if (abort.signal.aborted) return
        setInventoryState({ _tag: "ready", inventory })
        setSelectedFileId(inventory.entries.find((entry) => !entry.generated)?.anchor)
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (sessionKey !== null && isUnauthorizedFailure(failure)) {
          onSessionExpired(sessionKey)
          return
        }
        setInventoryState({ _tag: "failed" })
      }
    )
    return () => abort.abort()
  }, [onSessionExpired, scope.pluginConnectionId, scope.revision, scope.vendorImmutableId, sessionKey, transport])

  const entries = inventoryState._tag === "ready" ? inventoryState.inventory.entries : []
  const selectedEntry = entries.find(({ anchor }) => anchor === selectedFileId)
  useEffect(() => {
    if (
      selectedEntry === undefined ||
      selectedEntry.binary ||
      selectedEntry.generated ||
      selectedEntry.oversized ||
      loadedText.has(selectedEntry.anchor)
    )
      return
    const abort = new AbortController()
    setContentStates((current) =>
      new Map(current).set(selectedEntry.anchor, {
        state: "loading",
        label: "Loading bounded content"
      })
    )
    Promise.all([
      transport.content(scope, selectedEntry, "before", abort.signal),
      transport.content(scope, selectedEntry, "after", abort.signal)
    ]).then(
      ([before, after]) => {
        if (abort.signal.aborted) return
        const unavailable =
          before.unavailableReason !== null && before.unavailableReason !== "missing"
            ? before.unavailableReason
            : after.unavailableReason !== null && after.unavailableReason !== "missing"
              ? after.unavailableReason
              : null
        if (unavailable !== null) {
          setContentStates((current) => new Map(current).set(selectedEntry.anchor, unavailableContent(unavailable)))
          return
        }
        const beforeText = before.unavailableReason === "missing" ? "" : textFrom(before)
        const afterText = after.unavailableReason === "missing" ? "" : textFrom(after)
        if (beforeText === null || afterText === null) {
          setContentStates((current) =>
            new Map(current).set(selectedEntry.anchor, {
              state: "error",
              reason: "The bounded content response could not be decoded."
            })
          )
          return
        }
        setLoadedText((current) =>
          new Map(current).set(selectedEntry.anchor, {
            before: beforeText,
            after: afterText
          })
        )
        setContentStates((current) => new Map(current).set(selectedEntry.anchor, { state: "ready" }))
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (sessionKey !== null && isUnauthorizedFailure(failure)) {
          onSessionExpired(sessionKey)
          return
        }
        setContentStates((current) =>
          new Map(current).set(selectedEntry.anchor, {
            state: "error",
            reason: "The file content request failed; select the file to retry."
          })
        )
      }
    )
    return () => abort.abort()
  }, [contentRetryKey, loadedText, onSessionExpired, scope, selectedEntry, sessionKey, transport])

  const files = useMemo(
    () => entries.map((entry) => toFile(entry, contentStates.get(entry.anchor) ?? explicitContent(entry))),
    [contentStates, entries]
  )
  const inventory: RlyDiffInventory =
    inventoryState._tag === "loading"
      ? { files: [], indexedCount: 0, totalCount: 0, label: "Indexing every changed file", state: "loading" }
      : inventoryState._tag === "failed"
        ? {
            files: [],
            indexedCount: 0,
            totalCount: 0,
            title: "Diff inventory unavailable",
            description: "No partial inventory is reported as ready. Refresh the page to retry.",
            state: "error"
          }
        : { files, state: "ready" }
  const selectedText = selectedFileId === undefined ? undefined : loadedText.get(selectedFileId)
  const selectedCodeItems = useMemo<ReadonlyArray<RlyDiffCodeItem>>(
    () =>
      selectedEntry === undefined || selectedText === undefined
        ? []
        : [
            {
              id: selectedEntry.anchor,
              before: {
                cacheKey: `${scope.revision}:${selectedEntry.anchor}:before`,
                contents: selectedText.before,
                name: selectedEntry.previousPath ?? selectedEntry.path
              },
              after: {
                cacheKey: `${scope.revision}:${selectedEntry.anchor}:after`,
                contents: selectedText.after,
                name: selectedEntry.path
              }
            }
          ],
    [scope.revision, selectedEntry, selectedText]
  )
  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter(
        (suggestion) =>
          (severityFilter === "all" || suggestion.severity === severityFilter) &&
          (suggestionStateFilter === "all" || suggestion.state === suggestionStateFilter)
      ),
    [severityFilter, suggestionStateFilter, suggestions]
  )
  const annotations = useMemo<ReadonlyArray<RlyDiffCodeAnnotation>>(
    () =>
      visibleSuggestions.flatMap((suggestion) => {
        if (suggestion.anchor._tag !== "line") return []
        const anchor = suggestion.anchor
        const entry = entries.find(({ path }) => String(path) === String(anchor.path))
        if (entry === undefined) return []
        const annotation: RlyDiffCodeAnnotation = {
          accessibilityLabel: `${suggestion.severity} review suggestion with ${suggestion.confidence.level} confidence`,
          id: suggestion.suggestionId,
          location: {
            itemId: entry.anchor,
            lineNumber: anchor.line,
            side: "additions"
          },
          render: ({ returnFocus }) => (
            <article>
              <strong>
                {suggestion.severity} · {suggestion.confidence.level} confidence
              </strong>
              <p>{suggestion.title}</p>
              <p>
                <strong>Impact:</strong> {suggestion.impact}
              </p>
              <pre>{suggestion.evidence.excerpt}</pre>
              <p>
                <strong>Recommendation:</strong> {suggestion.recommendation}
              </p>
              <p>{suggestion.confidence.reason}</p>
              {suggestion.relatedLocations.length === 0 ? null : (
                <p>{suggestion.relatedLocations.length} related locations</p>
              )}
              {suggestion.replacement === undefined ? null : <pre>{suggestion.replacement.unifiedDiff}</pre>}
              <button onClick={returnFocus} type="button">
                Return to line
              </button>
            </article>
          )
        }
        return [annotation]
      }),
    [entries, visibleSuggestions]
  )
  const unattachedSuggestionCount = useMemo(
    () =>
      visibleSuggestions.filter((suggestion) => {
        const anchor = suggestion.anchor
        return anchor._tag !== "changes" && !entries.some(({ path }) => String(path) === String(anchor.path))
      }).length,
    [entries, visibleSuggestions]
  )
  const findings = useMemo(
    () =>
      visibleSuggestions.map((suggestion) => ({
        id: suggestion.suggestionId,
        content: (
          <>
            <strong>
              {suggestion.severity} · {suggestion.title}
            </strong>
            <p>
              {suggestion.anchor._tag === "changes"
                ? "Whole change"
                : `${suggestion.anchor.path}:${String(suggestion.anchor.line)}`}
            </p>
          </>
        )
      })),
    [visibleSuggestions]
  )
  const overviewSuggestions = visibleSuggestions.filter(({ anchor }) => anchor._tag !== "line")
  const severities = ["all", "P1", "P2", "P3", "P4"] satisfies ReadonlyArray<SuggestionSeverityFilter>
  const states = [
    "all",
    ...new Set(suggestions.map(({ state }) => state))
  ] satisfies ReadonlyArray<SuggestionStateFilter>

  return (
    <>
      <section aria-label="Review suggestion filters" className={styles.filters}>
        <div aria-label="Severity" role="group">
          {severities.map((severity) => (
            <button
              aria-label={`Filter suggestions by ${severity === "all" ? "all" : severity} severity`}
              aria-pressed={severityFilter === severity}
              key={severity}
              onClick={() => setSeverityFilter(severity)}
              type="button"
            >
              {severity === "all" ? "All severities" : severity}
            </button>
          ))}
        </div>
        <div aria-label="Suggestion state" role="group">
          {states.map((state) => (
            <button
              aria-label={`Filter suggestions by ${state} state`}
              aria-pressed={suggestionStateFilter === state}
              key={state}
              onClick={() => setSuggestionStateFilter(state)}
              type="button"
            >
              {state === "all" ? "All states" : state}
            </button>
          ))}
        </div>
      </section>
      {overviewSuggestions.length === 0 ? null : (
        <section aria-label="File and whole-change suggestions" className={styles.overview}>
          <header>
            <span>Review overview</span>
            <strong>{overviewSuggestions.length}</strong>
          </header>
          {overviewScopeKinds.map((scopeKind) => {
            const scoped = overviewSuggestions.filter(({ anchor }) => anchor._tag === scopeKind)
            if (scoped.length === 0) return null
            return (
              <section key={scopeKind}>
                <h3>{scopeKind === "file" ? "File suggestions" : "Whole-change suggestions"}</h3>
                <ul>
                  {scoped.map((suggestion) => {
                    const anchor = suggestion.anchor
                    return (
                      <li data-severity={suggestion.severity} key={suggestion.suggestionId}>
                        <span>
                          {suggestion.severity} · {suggestion.state}
                        </span>
                        <strong>{suggestion.title}</strong>
                        <p>{suggestion.problem}</p>
                        {anchor._tag !== "file" ? null : (
                          <button
                            onClick={() => {
                              const entry = entries.find(({ path }) => String(path) === String(anchor.path))
                              if (entry !== undefined) setSelectedFileId(entry.anchor)
                            }}
                            type="button"
                          >
                            {anchor.path}:{String(anchor.line)}
                          </button>
                        )}
                        {suggestion.relatedLocations.length === 0 ? null : (
                          <details>
                            <summary>Related locations</summary>
                            <ul>
                              {suggestion.relatedLocations.map((location) => (
                                <li key={`${location.path}:${String(location.startLine)}:${String(location.endLine)}`}>
                                  <code>
                                    {location.path}:{String(location.startLine)}
                                    {location.endLine === location.startLine ? "" : `–${String(location.endLine)}`}
                                  </code>
                                  <span>{location.label}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </section>
      )}
      {unattachedSuggestionCount === 0 ? null : (
        <p role="status">
          {unattachedSuggestionCount} validated review{" "}
          {unattachedSuggestionCount === 1 ? "suggestion is" : "suggestions are"} not attached because the anchor path
          is absent from this diff inventory.
        </p>
      )}
      <DiffWorkbench
        emptyFindings="No validated review suggestions are attached to this revision."
        findings={findings}
        header={
          <DiffHeader
            findingFilter="agent"
            heading={heading}
            indexedCount={files.length}
            isWrapped={isWrapped}
            layout={layout}
            onFindingFilterChange={() => undefined}
            onLayoutChange={setLayout}
            onWrapChange={setIsWrapped}
            totalCount={files.length}
            {...(selectedEntry === undefined ? {} : { selectedFileLabel: selectedEntry.path })}
          />
        }
        inventory={
          <DiffFileTree
            data={inventory}
            heading="Complete file inventory"
            onSelectedFileChange={(fileId) => {
              if (contentStates.get(fileId)?.state === "error") {
                setContentStates((current) => {
                  const next = new Map(current)
                  next.delete(fileId)
                  return next
                })
                setContentRetryKey((current) => current + 1)
              }
              setSelectedFileId(fileId)
            }}
            {...(selectedFileId === undefined ? {} : { selectedFileId })}
          />
        }
        label={`Complete diff for ${heading}`}
        onShowAllFiles={() => setSelectedFileId(undefined)}
        scope={
          selectedEntry === undefined
            ? { label: "All changed files", mode: "all-files" }
            : { fileId: selectedEntry.anchor, label: selectedEntry.path, mode: "selected-file" }
        }
        statusNotice={
          selectedEntry === undefined
            ? "Select a supported file to load its content."
            : selectedText === undefined
              ? contentStates.get(selectedEntry.anchor)?.state === "loading"
                ? "Loading this file only."
                : "Content is not rendered for this file."
              : undefined
        }
        viewer={
          selectedEntry === undefined || selectedText === undefined ? (
            "Select a supported text file to render its change."
          ) : (
            <Suspense fallback={<p aria-live="polite">Rendering complete diff…</p>}>
              <BoundedDiffCodeView
                annotations={annotations}
                key={selectedEntry.anchor}
                initialItems={selectedCodeItems}
                mode={layout}
                wrap={isWrapped}
              />
            </Suspense>
          )
        }
      />
    </>
  )
}
