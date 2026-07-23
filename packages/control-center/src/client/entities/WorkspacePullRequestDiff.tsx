import {
  DiffFileTree,
  DiffHeader,
  DiffWorkbench,
  type RlyDiffFile,
  type RlyDiffFileContent,
  type RlyDiffInventory,
  type RlyDiffLayout
} from "@knpkv/rly/diff/workbench"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Predicate from "effect/Predicate"
import { type ReactElement, useEffect, useMemo, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { CompleteDiffContentRange, CompleteDiffInventory, CompleteDiffInventoryEntry } from "../../api/diff.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import type { Revision, VendorImmutableId } from "../../domain/sourceRevision.js"

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
  transport = browserWorkspacePullRequestDiffTransport
}: {
  readonly heading: string
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly scope: WorkspacePullRequestDiffScope
  readonly sessionKey?: string | null
  readonly transport?: WorkspacePullRequestDiffTransport
}): ReactElement => {
  const [inventoryState, setInventoryState] = useState<InventoryLoadState>({ _tag: "loading" })
  const [selectedFileId, setSelectedFileId] = useState<string>()
  const [contentStates, setContentStates] = useState<ReadonlyMap<string, RlyDiffFileContent>>(new Map())
  const [loadedText, setLoadedText] = useState<ReadonlyMap<string, LoadedText>>(new Map())
  const [contentRetryKey, setContentRetryKey] = useState(0)
  const [layout, setLayout] = useState<RlyDiffLayout>("split")
  const [isWrapped, setIsWrapped] = useState(false)

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
            reason: "The content worker failed; select the file to retry."
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

  return (
    <DiffWorkbench
      emptyFindings="No review findings are attached to this revision."
      findings={[]}
      header={
        <DiffHeader
          findingFilter="all"
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
          <div data-control-center-diff-layout={layout} data-control-center-diff-wrap={isWrapped ? "true" : "false"}>
            <section aria-label={`Before ${selectedEntry.path}`}>
              <h3>Before</h3>
              <pre>{selectedText.before}</pre>
            </section>
            <section aria-label={`After ${selectedEntry.path}`}>
              <h3>After</h3>
              <pre>{selectedText.after}</pre>
            </section>
          </div>
        )
      }
    />
  )
}
