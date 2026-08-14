import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { BoundedDiffCodeView, type RlyDiffCodeAnnotation, type RlyDiffCodeItem } from "@knpkv/rly/diff/bounded"
import {
  DiffFileTree,
  type RlyDiffFile,
  type RlyDiffFileContent,
  type RlyDiffInventory
} from "@knpkv/rly/diff/workbench"
import { Button, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Predicate from "effect/Predicate"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { BotIcon, CheckCircle2Icon, FileSearchIcon, ShieldCheckIcon, TestTube2Icon } from "lucide-react"
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  PullRequestDiffResponse,
  PullRequestRelayReviewResponse,
  RelayReviewFinding,
  RelayReviewKind
} from "../../server/Api.js"
import { ApiClient } from "../atoms/runtime.js"
import styles from "./pr-review-workspace.module.css"

const reviewFocuses: ReadonlyArray<{
  readonly description: string
  readonly icon: typeof BotIcon
  readonly kind: RelayReviewKind
  readonly label: string
}> = [
  { kind: "review", label: "Full review", description: "Correctness, security, and maintainability", icon: BotIcon },
  { kind: "security", label: "Security", description: "Trust boundaries and unsafe inputs", icon: ShieldCheckIcon },
  { kind: "tests", label: "Tests", description: "Missing behavioral guardrails", icon: TestTube2Icon },
  { kind: "explain", label: "Explain", description: "Architecture and merge risks", icon: FileSearchIcon }
]

const MAXIMUM_RENDERABLE_DIFF_INPUT_LINES = 5_000
const MAXIMUM_RENDERABLE_DIFF_LINE_PAIRS = 4_000_000

const lineCount = (text: string): number => {
  if (text.length === 0) return 0
  let count = 1
  for (const character of text) {
    if (character === "\n") count++
  }
  return count
}

const fileModeLabel = (file: PullRequestDiffResponse["files"][number]): string | null => {
  if (file.beforeMode === null && file.afterMode !== null) return `new file mode ${file.afterMode}`
  if (file.beforeMode !== null && file.afterMode === null) return `deleted file mode ${file.beforeMode}`
  if (file.beforeMode !== null && file.afterMode !== null && file.beforeMode !== file.afterMode) {
    return `mode ${file.beforeMode} → ${file.afterMode}`
  }
  return null
}

const priorityTone = (priority: RelayReviewFinding["priority"]): "critical" | "caution" | "neutral" =>
  priority === "P1" || priority === "P2" ? "critical" : priority === "P3" ? "caution" : "neutral"

const locationLabel = (finding: RelayReviewFinding): string => {
  switch (finding.location.scope) {
    case "general":
      return "Whole pull request"
    case "file":
      return finding.location.filePath
    case "line":
      return `${finding.location.filePath}:${finding.location.line} · ${finding.location.side}`
  }
}

const failureMessage = (failure: unknown, fallback: string): string =>
  Predicate.hasProperty(failure, "message") && typeof failure.message === "string" ? failure.message : fallback

const toRlyFile = (file: PullRequestDiffResponse["files"][number], content: RlyDiffFileContent): RlyDiffFile =>
  file.status === "renamed" && file.previousPath !== null
    ? {
        id: String(file.index),
        path: file.path,
        previousPath: file.previousPath,
        change: "renamed",
        content
      }
    : {
        id: String(file.index),
        path: file.path,
        change: file.status === "renamed" ? "modified" : file.status,
        content
      }

const annotationsFor = (
  findings: ReadonlyArray<RelayReviewFinding>,
  file: PullRequestDiffResponse["files"][number]
): ReadonlyArray<RlyDiffCodeAnnotation> =>
  findings.flatMap((finding): ReadonlyArray<RlyDiffCodeAnnotation> => {
    if (finding.location.scope !== "line") return []
    const expectedPath = finding.location.side === "before" ? (file.previousPath ?? file.path) : file.path
    if (finding.location.filePath !== expectedPath) return []
    return [
      {
        id: finding.id,
        accessibilityLabel: `${finding.priority} finding: ${finding.title}`,
        location: {
          itemId: String(file.index),
          lineNumber: finding.location.line,
          side: finding.location.side === "after" ? "additions" : "deletions"
        },
        render: () => (
          <aside className={styles.lineFinding}>
            <strong>
              {finding.priority} · {finding.title}
            </strong>
            <span>{finding.summary}</span>
          </aside>
        )
      }
    ]
  })

const LoadedFileDiff = ({
  accountId,
  baseCommit,
  file,
  findings,
  headCommit,
  layout,
  onContentStateChange,
  pullRequestId,
  revisionId,
  wrap
}: {
  readonly accountId: string
  readonly baseCommit: string
  readonly file: PullRequestDiffResponse["files"][number]
  readonly findings: ReadonlyArray<RelayReviewFinding>
  readonly headCommit: string
  readonly layout: "split" | "stacked"
  readonly onContentStateChange: (fileIndex: number, content: RlyDiffFileContent) => void
  readonly pullRequestId: Domain.PullRequestId
  readonly revisionId: string
  readonly wrap: boolean
}): ReactElement => {
  const contentAtom = useMemo(
    () =>
      ApiClient.query("prs", "diffContent", {
        params: { awsAccountId: accountId, prId: pullRequestId, fileIndex: file.index },
        query: { revisionId, baseCommit, headCommit },
        timeToLive: "10 seconds"
      }),
    [accountId, baseCommit, file.index, headCommit, pullRequestId, revisionId]
  )
  const content = useAtomValue(contentAtom)
  const observedContentState = AsyncResult.isFailure(content)
    ? "error"
    : AsyncResult.isSuccess(content)
      ? content.value.state === "text"
        ? "ready"
        : content.value.state
      : null

  useEffect(() => {
    switch (observedContentState) {
      case "ready":
        onContentStateChange(file.index, { state: "ready" })
        break
      case "binary":
        onContentStateChange(file.index, {
          state: "binary",
          reason: "CodeCommit reports binary or non-UTF-8 content."
        })
        break
      case "oversized":
        onContentStateChange(file.index, {
          state: "oversized",
          reason: "Content exceeds the bounded CodeCommit blob limit."
        })
        break
      case "error":
        onContentStateChange(file.index, {
          state: "error",
          reason: "The exact file content request failed."
        })
        break
      case null:
        break
    }
  }, [file.index, observedContentState, onContentStateChange])

  if (AsyncResult.isInitial(content) || AsyncResult.isWaiting(content)) {
    return (
      <StatePanel
        announce="polite"
        description={`Reading both immutable sides of ${file.path}.`}
        title="Loading file diff"
        tone="progress"
      />
    )
  }
  if (AsyncResult.isFailure(content)) {
    return (
      <StatePanel
        announce="polite"
        description={failureMessage(content.cause, "Reload the pull request to retry this exact file.")}
        title="File diff unavailable"
        tone="critical"
      />
    )
  }
  if (!AsyncResult.isSuccess(content)) {
    return <StatePanel description="Reload the pull request to retry." title="File diff unavailable" tone="critical" />
  }
  if (content.value.state !== "text" || content.value.before === null || content.value.after === null) {
    return (
      <StatePanel
        description={
          content.value.state === "binary"
            ? "CodeCommit reports binary or non-UTF-8 content. The file remains in the complete inventory."
            : "One side exceeds the bounded CodeCommit blob limit and cannot be rendered safely."
        }
        title={content.value.state === "binary" ? "Binary change" : "File too large"}
        tone="neutral"
      />
    )
  }

  const beforeLines = lineCount(content.value.before)
  const afterLines = lineCount(content.value.after)
  if (
    beforeLines + afterLines > MAXIMUM_RENDERABLE_DIFF_INPUT_LINES ||
    beforeLines * afterLines > MAXIMUM_RENDERABLE_DIFF_LINE_PAIRS
  ) {
    return (
      <StatePanel
        description="This file exceeds the browser diff-complexity safety limit."
        title="Diff too large to render"
        tone="neutral"
      />
    )
  }

  const item: RlyDiffCodeItem = {
    id: String(file.index),
    before: {
      cacheKey: `${revisionId}:${String(file.index)}:before`,
      contents: content.value.before,
      name: file.previousPath ?? file.path
    },
    after: {
      cacheKey: `${revisionId}:${String(file.index)}:after`,
      contents: content.value.after,
      name: file.path
    }
  }

  return (
    <BoundedDiffCodeView
      annotations={annotationsFor(findings, file)}
      className={styles.codeView ?? ""}
      initialItems={[item]}
      mode={layout}
      wrap={wrap}
    />
  )
}

const ReviewFindings = ({
  onSelect,
  review,
  selectedFindingId
}: {
  readonly onSelect: (finding: RelayReviewFinding) => void
  readonly review: PullRequestRelayReviewResponse | null
  readonly selectedFindingId: string | null
}): ReactElement => {
  if (review === null) {
    return (
      <div className={styles.agentEmpty}>
        <BotIcon aria-hidden="true" />
        <Text as="h3" variant="card-title">
          Relay is ready
        </Text>
        <Text tone="secondary">Choose a focus, then run a prompt-only review over this exact CodeCommit revision.</Text>
      </div>
    )
  }
  if (review.kind === "explain" && review.result.explanation !== undefined) {
    return (
      <div className={styles.agentEmpty}>
        <FileSearchIcon aria-hidden="true" />
        <Text as="h3" variant="card-title">
          Change explanation
        </Text>
        <Text>{review.result.explanation}</Text>
        <Text tone="secondary">{review.result.verdict}</Text>
      </div>
    )
  }
  if (review.result.findings.length === 0) {
    return (
      <div className={styles.agentEmpty}>
        <CheckCircle2Icon aria-hidden="true" />
        <Text as="h3" variant="card-title">
          No actionable findings
        </Text>
        <Text tone="secondary">{review.result.verdict}</Text>
      </div>
    )
  }
  return (
    <div className={styles.findingDeck}>
      <Text as="p" className={styles.verdictCopy}>
        {review.result.verdict}
      </Text>
      <ol>
        {review.result.findings.map((finding) => (
          <li key={finding.id}>
            <button
              aria-pressed={selectedFindingId === finding.id}
              className={styles.findingCard}
              onClick={() => onSelect(finding)}
              type="button"
            >
              <span className={styles.findingMeta}>
                <StateLabel label={finding.priority} size="compact" tone={priorityTone(finding.priority)} />
                <code>{locationLabel(finding)}</code>
              </span>
              <strong>{finding.title}</strong>
              <span>{finding.summary}</span>
              <span>
                <b>Evidence:</b> {finding.details}
              </span>
              <small>
                <b>Recommendation:</b> {finding.recommendation}
              </small>
              <small>
                <b>Verification:</b> {finding.verification}
              </small>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

const ReadyReviewWorkspace = ({
  accountId,
  diff,
  pullRequest
}: {
  readonly accountId: string
  readonly diff: PullRequestDiffResponse
  readonly pullRequest: Domain.PullRequest
}): ReactElement => {
  const [selectedFileIndex, setSelectedFileIndex] = useState(diff.files[0]?.index ?? null)
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null)
  const [kind, setKind] = useState<RelayReviewKind>("review")
  const [layout, setLayout] = useState<"split" | "stacked">("split")
  const [wrap, setWrap] = useState(false)
  const [contentStates, setContentStates] = useState<ReadonlyMap<number, RlyDiffFileContent>>(new Map())
  const reviewAtom = useMemo(() => ApiClient.mutation("prs", "relayReview"), [])
  const runReview = useAtomSet(reviewAtom, { mode: "promise" })
  const reviewIdentity = `${accountId}:${pullRequest.id}:${diff.revisionId}:${diff.baseCommit}:${diff.headCommit}`
  const currentReviewIdentity = useRef(reviewIdentity)
  currentReviewIdentity.current = reviewIdentity
  const [completedReview, setCompletedReview] = useState<{
    readonly identity: string
    readonly value: PullRequestRelayReviewResponse
  } | null>(null)
  const [failedReview, setFailedReview] = useState<{ readonly identity: string; readonly message: string } | null>(null)
  const [reviewingIdentity, setReviewingIdentity] = useState<string | null>(null)
  const review = completedReview?.identity === reviewIdentity ? completedReview.value : null
  const reviewFailure = failedReview?.identity === reviewIdentity ? failedReview.message : null
  const isReviewing = reviewingIdentity === reviewIdentity
  const selectedFile = diff.files.find(({ index }) => index === selectedFileIndex) ?? diff.files[0]
  const selectedFileMode = selectedFile === undefined ? null : fileModeLabel(selectedFile)
  const files = diff.files.map((file) => toRlyFile(file, contentStates.get(file.index) ?? { state: "ready" }))
  const inventory: RlyDiffInventory = { files, state: "ready" }

  const updateContentState = useCallback((fileIndex: number, content: RlyDiffFileContent): void => {
    setContentStates((current) => {
      const previous = current.get(fileIndex)
      if (previous?.state === content.state) return current
      return new Map(current).set(fileIndex, content)
    })
  }, [])

  useEffect(() => {
    setSelectedFileIndex(diff.files[0]?.index ?? null)
    setSelectedFindingId(null)
    setContentStates(new Map())
  }, [diff.baseCommit, diff.headCommit, diff.revisionId])

  const executeReview = useCallback(async (): Promise<void> => {
    const submittedIdentity = reviewIdentity
    setReviewingIdentity(submittedIdentity)
    setFailedReview(null)
    try {
      const result = await runReview({
        params: { awsAccountId: accountId, prId: pullRequest.id },
        payload: {
          revisionId: diff.revisionId,
          baseCommit: diff.baseCommit,
          headCommit: diff.headCommit,
          kind
        }
      })
      if (currentReviewIdentity.current === submittedIdentity) {
        setCompletedReview({ identity: submittedIdentity, value: result })
      }
    } catch (cause) {
      if (currentReviewIdentity.current === submittedIdentity) {
        setFailedReview({
          identity: submittedIdentity,
          message: failureMessage(cause, "Relay could not complete this review.")
        })
      }
    } finally {
      setReviewingIdentity((current) => (current === submittedIdentity ? null : current))
    }
  }, [accountId, diff.baseCommit, diff.headCommit, diff.revisionId, kind, pullRequest.id, reviewIdentity, runReview])

  const selectFinding = useCallback(
    (finding: RelayReviewFinding): void => {
      setSelectedFindingId(finding.id)
      const location = finding.location
      if (location.scope === "general") return
      const file = diff.files.find(
        (candidate) => candidate.path === location.filePath || candidate.previousPath === location.filePath
      )
      if (file !== undefined) setSelectedFileIndex(file.index)
    },
    [diff.files]
  )

  return (
    <Surface as="section" className={styles.workspace} padding="none" shape="grouped">
      <header className={styles.workspaceHeader}>
        <div>
          <Text tone="secondary" variant="label">
            Exact-revision review
          </Text>
          <Text as="h2" variant="section-title">
            Diff & Relay
          </Text>
          <Text tone="secondary" variant="meta">
            {diff.files.length} changed {diff.files.length === 1 ? "file" : "files"} · head{" "}
            {diff.headCommit.slice(0, 12)}
          </Text>
        </div>
        <div className={styles.focusActions}>
          <div aria-label="Relay review focus" className={styles.focusChoices} role="group">
            {reviewFocuses.map((focus) => {
              const Icon = focus.icon
              return (
                <button
                  aria-pressed={kind === focus.kind}
                  key={focus.kind}
                  onClick={() => setKind(focus.kind)}
                  title={focus.description}
                  type="button"
                >
                  <Icon aria-hidden="true" />
                  {focus.label}
                </button>
              )
            })}
          </div>
          <Button
            disabled={isReviewing || diff.files.length === 0}
            loading={isReviewing}
            onClick={() => void executeReview()}
            size="compact"
            variant="primary"
          >
            {isReviewing ? "Relay reviewing…" : review === null ? "Run Relay" : "Run again"}
          </Button>
        </div>
      </header>

      {reviewFailure === null ? null : (
        <div className={styles.reviewFailure}>
          <StatePanel announce="polite" description={reviewFailure} title="Relay review failed" tone="critical" />
        </div>
      )}

      <div className={styles.workbench}>
        <DiffFileTree
          className={styles.fileTree}
          data={inventory}
          heading={`PR ${pullRequest.id}`}
          onSelectedFileChange={(fileId) => {
            setSelectedFileIndex(Number(fileId))
            setSelectedFindingId(null)
          }}
          {...(selectedFile === undefined ? {} : { selectedFileId: String(selectedFile.index) })}
        />

        <section aria-label="Selected file diff" className={styles.diffPane}>
          <header className={styles.diffToolbar}>
            <span>
              <code>{selectedFile?.path ?? "No changed file"}</code>
              {selectedFileMode === null ? null : <small>{selectedFileMode}</small>}
            </span>
            <div>
              <button aria-pressed={layout === "split"} onClick={() => setLayout("split")} type="button">
                Split
              </button>
              <button aria-pressed={layout === "stacked"} onClick={() => setLayout("stacked")} type="button">
                Stacked
              </button>
              <button aria-pressed={wrap} onClick={() => setWrap((current) => !current)} type="button">
                Wrap
              </button>
            </div>
          </header>
          <div className={styles.diffViewport}>
            {selectedFile === undefined ? (
              <StatePanel
                description="CodeCommit reports no changed files for this revision."
                title="Empty diff"
                tone="neutral"
              />
            ) : (
              <LoadedFileDiff
                accountId={accountId}
                baseCommit={diff.baseCommit}
                file={selectedFile}
                findings={review?.result.findings ?? []}
                headCommit={diff.headCommit}
                key={`${diff.revisionId}:${diff.baseCommit}:${diff.headCommit}:${String(selectedFile.index)}:${layout}:${String(wrap)}`}
                layout={layout}
                onContentStateChange={updateContentState}
                pullRequestId={pullRequest.id}
                revisionId={diff.revisionId}
                wrap={wrap}
              />
            )}
          </div>
        </section>

        <aside aria-label="Relay findings" className={styles.agentPane}>
          <header>
            <span>
              <BotIcon aria-hidden="true" />
              <Text as="h2" variant="section-title">
                Relay
              </Text>
            </span>
            {review === null ? null : <StateLabel label={review.kind} size="compact" tone="progress" />}
          </header>
          <ReviewFindings onSelect={selectFinding} review={review} selectedFindingId={selectedFindingId} />
        </aside>
      </div>
      <footer className={styles.workspaceFooter}>
        Relay is advisory and read-only. Findings stay local until a human chooses a provider action.
      </footer>
    </Surface>
  )
}

/** CodeCommit web parity surface for complete diffs and ephemeral Relay reviews. */
export const PullRequestReviewWorkspace = ({
  accountId,
  pullRequest
}: {
  readonly accountId: string
  readonly pullRequest: Domain.PullRequest
}): ReactElement => {
  const diffAtom = useMemo(
    () =>
      ApiClient.query("prs", "diff", {
        params: { awsAccountId: accountId, prId: pullRequest.id },
        serializationKey: `${accountId}:${pullRequest.id}:${pullRequest.lastModifiedDate.toISOString()}`,
        timeToLive: "30 seconds"
      }),
    [accountId, pullRequest.id, pullRequest.lastModifiedDate]
  )
  const diff = useAtomValue(diffAtom)

  if (AsyncResult.isInitial(diff) || AsyncResult.isWaiting(diff)) {
    return (
      <StatePanel
        announce="polite"
        description="Indexing every changed file."
        title="Loading exact diff"
        tone="progress"
      />
    )
  }
  if (AsyncResult.isFailure(diff)) {
    return (
      <StatePanel
        announce="polite"
        description={failureMessage(diff.cause, "Refresh this pull request to retry the CodeCommit diff read.")}
        title="Exact diff unavailable"
        tone="critical"
      />
    )
  }
  return AsyncResult.isSuccess(diff) ? (
    <ReadyReviewWorkspace accountId={accountId} diff={diff.value} pullRequest={pullRequest} />
  ) : (
    <StatePanel description="Refresh this pull request to retry." title="Exact diff unavailable" tone="critical" />
  )
}
