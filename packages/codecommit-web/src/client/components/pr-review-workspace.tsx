import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { presentReviewResult, type ReviewProfileResolution, resolveReviewProfile } from "@knpkv/review"
import { ReviewProfileControl, ReviewResultStatus } from "@knpkv/review/react"
import { BoundedDiffCodeView, type RlyDiffCodeAnnotation, type RlyDiffCodeItem } from "@knpkv/rly/diff/bounded"
import {
  DiffFileTree,
  type RlyDiffFile,
  type RlyDiffFileContent,
  type RlyDiffInventory
} from "@knpkv/rly/diff/workbench"
import { Button, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Schema from "effect/Schema"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleXIcon,
  FileSearchIcon,
  LoaderCircleIcon,
  MessageSquareMoreIcon
} from "lucide-react"
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"

import {
  type PullRequestDiffResponse,
  type PullRequestRelayReviewResponse,
  RelayReviewConversationTurn,
  type RelayReviewFinding,
  type RelayReviewStreamEvent
} from "../../server/Api.js"
import { configQueryAtom } from "../atoms/app.js"
import { ApiClient } from "../atoms/runtime.js"
import { useComments } from "../hooks/useComments.js"
import {
  applyFindingDecision,
  appendReviewTurn,
  type FindingDispositions,
  initialFindingDispositions,
  reconcileFindingDispositions,
  settleFindingPublication
} from "../review-session-state.js"
import { runRelayReviewStream } from "../relay-review-stream.js"
import {
  codeCommitReviewIdentity,
  codeCommitReviewProfile,
  codeCommitReviewThread
} from "../review-platform-adapter.js"
import {
  readRelayReviewSession,
  relayReviewSessionStorageKey,
  writeRelayReviewSession
} from "../review-session-storage.js"
import {
  fileIndexForComment,
  isCommentOnExactRevision,
  type ReviewCommentNavigation,
  type ReviewCommentNavigationTarget,
  reviewCommentNavigationTarget
} from "../review-comment-navigation.js"
import styles from "./pr-review-workspace.module.css"

const MAXIMUM_RENDERABLE_DIFF_INPUT_LINES = 5_000
const MAXIMUM_RENDERABLE_DIFF_LINE_PAIRS = 4_000_000
const MAXIMUM_RENDERABLE_DIFF_INPUT_BYTES = 512 * 1024
const diffTextEncoder = new TextEncoder()

const lineCount = (text: string): number => {
  if (text.length === 0) return 0
  let count = 1
  for (const character of text) {
    if (character === "\n") count++
  }
  return count
}

const exceedsRenderableDiffComplexity = (before: string, after: string): boolean => {
  if (
    diffTextEncoder.encode(before).byteLength + diffTextEncoder.encode(after).byteLength >
    MAXIMUM_RENDERABLE_DIFF_INPUT_BYTES
  )
    return true
  const beforeLines = lineCount(before)
  const afterLines = lineCount(after)
  return (
    beforeLines + afterLines > MAXIMUM_RENDERABLE_DIFF_INPUT_LINES ||
    beforeLines * afterLines > MAXIMUM_RENDERABLE_DIFF_LINE_PAIRS
  )
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

const FailureWithMessage = Schema.Struct({ message: Schema.String })
const isFailureWithMessage = Schema.is(FailureWithMessage)

type RelayStreamOutcome = { readonly completed: false } | { readonly completed: true; readonly reply?: string }

interface RelayStreamTerminal {
  event?: Extract<RelayReviewStreamEvent, { readonly type: "complete" }>
}

function failureMessage<Failure>(failure: Failure, fallback: string): string {
  return isFailureWithMessage(failure) ? failure.message : fallback
}

export const fileIndexForFinding = (
  files: PullRequestDiffResponse["files"],
  finding: RelayReviewFinding
): number | undefined => {
  const location = finding.location
  if (location.scope === "general") return undefined
  const file = files.find((candidate) => {
    if (location.scope === "file") {
      return candidate.path === location.filePath || candidate.previousPath === location.filePath
    }
    return location.side === "after"
      ? candidate.status !== "deleted" && candidate.path === location.filePath
      : candidate.status !== "added" && (candidate.previousPath ?? candidate.path) === location.filePath
  })
  return file?.index
}

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

const commentPreview = (content: string): string => {
  const compact = content
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/(^|\s)#{1,6}\s+/gu, "$1")
    .replace(/[*`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`
}

const CommentLineAnnotation = ({
  active,
  onNavigateToComment,
  target
}: {
  readonly active: boolean
  readonly onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
  readonly target: ReviewCommentNavigationTarget
}): ReactElement => {
  const annotationRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!active || annotationRef.current === null) return
    annotationRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    annotationRef.current.focus({ preventScroll: true })
  }, [active])

  return (
    <aside className={styles.lineComment} data-active={active ? "true" : undefined} ref={annotationRef} tabIndex={-1}>
      <span className={styles.lineCommentMeta}>
        <MessageSquareMoreIcon aria-hidden="true" />
        <strong>{target.author}</strong>
        <span>CodeCommit comment</span>
      </span>
      <span>{commentPreview(target.content)}</span>
      <button onClick={() => onNavigateToComment(target)} type="button">
        View in comments
      </button>
    </aside>
  )
}

const commentAnnotationsFor = (
  comments: ReadonlyArray<ReviewCommentNavigationTarget>,
  file: PullRequestDiffResponse["files"][number],
  activeCommentId: string | null,
  onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
): ReadonlyArray<RlyDiffCodeAnnotation> =>
  comments.flatMap((target): ReadonlyArray<RlyDiffCodeAnnotation> => {
    const expectedPath = target.side === "before" ? (file.previousPath ?? file.path) : file.path
    if (target.filePath !== expectedPath) return []
    return [
      {
        id: `comment:${target.commentId}`,
        accessibilityLabel: `CodeCommit comment by ${target.author}`,
        location: {
          itemId: String(file.index),
          lineNumber: target.lineNumber,
          side: target.side === "after" ? "additions" : "deletions"
        },
        render: () => (
          <CommentLineAnnotation
            active={activeCommentId === target.commentId}
            onNavigateToComment={onNavigateToComment}
            target={target}
          />
        )
      }
    ]
  })

const LoadedFileDiff = ({
  accountId,
  activeCommentId,
  baseCommit,
  comments,
  file,
  findings,
  headCommit,
  layout,
  onContentStateChange,
  onNavigateToComment,
  pullRequestId,
  revisionId,
  wrap
}: {
  readonly activeCommentId: string | null
  readonly accountId: string
  readonly baseCommit: string
  readonly comments: ReadonlyArray<ReviewCommentNavigationTarget>
  readonly file: PullRequestDiffResponse["files"][number]
  readonly findings: ReadonlyArray<RelayReviewFinding>
  readonly headCommit: string
  readonly layout: "split" | "stacked"
  readonly onContentStateChange: (fileIndex: number, content: RlyDiffFileContent) => void
  readonly onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
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
        ? content.value.before !== null &&
          content.value.after !== null &&
          exceedsRenderableDiffComplexity(content.value.before, content.value.after)
          ? "complexity"
          : "ready"
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
      case "complexity":
        onContentStateChange(file.index, {
          state: "oversized",
          reason: "Browser diff complexity safety limit exceeded."
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

  if (exceedsRenderableDiffComplexity(content.value.before, content.value.after)) {
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
      annotations={[
        ...annotationsFor(findings, file),
        ...commentAnnotationsFor(comments, file, activeCommentId, onNavigateToComment)
      ]}
      className={styles.codeView ?? ""}
      initialItems={[item]}
      mode={layout}
      wrap={wrap}
    />
  )
}

const ReviewFindings = ({
  canPost,
  dispositions,
  isReviewing,
  onAcknowledge,
  onPost,
  onReject,
  onSelect,
  review,
  selectedFindingId
}: {
  readonly canPost: boolean
  readonly dispositions: FindingDispositions
  readonly isReviewing: boolean
  readonly onAcknowledge: (finding: RelayReviewFinding) => void
  readonly onPost: (finding: RelayReviewFinding) => void
  readonly onReject: (finding: RelayReviewFinding) => void
  readonly onSelect: (finding: RelayReviewFinding) => void
  readonly review: PullRequestRelayReviewResponse | null
  readonly selectedFindingId: string | null
}): ReactElement => {
  if (isReviewing) {
    return (
      <div aria-live="polite" className={styles.agentEmpty}>
        <LoaderCircleIcon aria-hidden="true" className={styles.agentSpinner} />
        <Text as="h3" variant="card-title">
          Relay is reviewing
        </Text>
        <Text tone="secondary">Live stages are updating above. Findings will appear here when the run completes.</Text>
      </div>
    )
  }
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
    <section aria-label="Findings" className={styles.findingDeck}>
      <Text as="p" className={styles.verdictCopy}>
        {review.result.verdict}
      </Text>
      <ol>
        {review.result.findings.map((finding) => (
          <li key={finding.id}>
            <article
              className={styles.findingCard}
              data-selected={selectedFindingId === finding.id ? "true" : undefined}
            >
              <button className={styles.findingBody} onClick={() => onSelect(finding)} type="button">
                <span className={styles.findingMeta}>
                  <span>
                    <StateLabel label={finding.priority} size="compact" tone={priorityTone(finding.priority)} />
                    <code>{locationLabel(finding)}</code>
                  </span>
                  <StateLabel
                    label={dispositions[finding.id] ?? "pending"}
                    size="compact"
                    tone={
                      dispositions[finding.id] === "failed" || dispositions[finding.id] === "posted-stale"
                        ? "caution"
                        : "neutral"
                    }
                  />
                </span>
                <strong>{finding.title}</strong>
                <span>{finding.summary}</span>
              </button>
              <details className={styles.findingDetails}>
                <summary>Evidence &amp; recommendation</summary>
                <div>
                  <span>
                    <b>Evidence</b>
                    {finding.details}
                  </span>
                  <span>
                    <b>Recommendation</b>
                    {finding.recommendation}
                  </span>
                  <span>
                    <b>Verification</b>
                    {finding.verification}
                  </span>
                </div>
              </details>
              <div className={styles.findingActions}>
                <Button
                  disabled={!canPost || dispositions[finding.id] === "posting" || dispositions[finding.id] === "posted"}
                  loading={dispositions[finding.id] === "posting"}
                  onClick={() => onPost(finding)}
                  size="compact"
                  variant="primary"
                >
                  Accept · post
                </Button>
                <button
                  disabled={
                    dispositions[finding.id] === "posting" ||
                    dispositions[finding.id] === "posted" ||
                    dispositions[finding.id] === "posted-stale"
                  }
                  onClick={() => onAcknowledge(finding)}
                  type="button"
                >
                  <CircleCheckIcon /> Ack
                </button>
                <button
                  disabled={
                    dispositions[finding.id] === "posting" ||
                    dispositions[finding.id] === "posted" ||
                    dispositions[finding.id] === "posted-stale"
                  }
                  onClick={() => onReject(finding)}
                  type="button"
                >
                  <CircleXIcon /> Reject
                </button>
              </div>
            </article>
          </li>
        ))}
      </ol>
    </section>
  )
}

const ReadyReviewWorkspace = ({
  accountId,
  commentNavigation,
  comments,
  diff,
  diffFailure,
  onFindingPosted,
  onNavigateToComment,
  pullRequest
}: {
  readonly accountId: string
  readonly commentNavigation: ReviewCommentNavigation | null
  readonly comments: ReadonlyArray<ReviewCommentNavigationTarget>
  readonly diff: PullRequestDiffResponse
  readonly diffFailure: string | null
  readonly onFindingPosted: (operationId: string) => void
  readonly onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
  readonly pullRequest: Domain.PullRequest
}): ReactElement => {
  const navigate = useNavigate()
  const [selectedFileIndex, setSelectedFileIndex] = useState(diff.files[0]?.index ?? null)
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null)
  const [layout, setLayout] = useState<"split" | "stacked">("split")
  const [wrap, setWrap] = useState(false)
  const config = useAtomValue(configQueryAtom)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const postFindingMutation = useMemo(() => ApiClient.mutation("prs", "postRelayFinding"), [])
  const postFindingRequest = useAtomSet(postFindingMutation, { mode: "promise" })
  const reviewIdentity = codeCommitReviewIdentity(accountId, pullRequest.id, diff)
  const [contentStateCache, setContentStateCache] = useState<{
    readonly identity: string
    readonly values: ReadonlyMap<number, RlyDiffFileContent>
  }>(() => ({ identity: reviewIdentity, values: new Map() }))
  const reviewSessionKey = relayReviewSessionStorageKey(accountId, pullRequest.id)
  const [completedReview, setCompletedReview] = useState<{
    readonly identity: string
    readonly value: PullRequestRelayReviewResponse
  } | null>(null)
  const completedReviewRef = useRef(completedReview)
  completedReviewRef.current = completedReview
  const [reviewFailure, setReviewFailure] = useState<{
    readonly description: string
    readonly title: string
  } | null>(null)
  const [retainedAfterFailure, setRetainedAfterFailure] = useState(false)
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null)
  const [isReviewing, setIsReviewing] = useState(false)
  const [progress, setProgress] = useState<
    ReadonlyArray<Extract<RelayReviewStreamEvent, { readonly type: "progress" }>>
  >([])
  const [turns, setTurns] = useState<ReadonlyArray<RelayReviewConversationTurn>>([])
  const [message, setMessage] = useState("")
  const [dispositions, setDispositions] = useState<FindingDispositions>({})
  const [conversationCollapsed, setConversationCollapsed] = useState(true)
  const dispositionsRef = useRef(dispositions)
  dispositionsRef.current = dispositions
  const abortRef = useRef<AbortController | null>(null)
  const review = completedReview?.value ?? null
  const profiles = AsyncResult.isSuccess(config) ? config.value.review.profiles : []
  const platformProfiles = profiles.map(codeCommitReviewProfile)
  const profilesLoading = !AsyncResult.isSuccess(config) && !AsyncResult.isFailure(config)
  const profileResolution: ReviewProfileResolution = AsyncResult.isSuccess(config)
    ? resolveReviewProfile(platformProfiles, selectedProfileId, config.value.review.defaultProfileId)
    : { _tag: "Missing" }
  const selectedPlatformProfile = profileResolution._tag === "Resolved" ? profileResolution.profile : undefined
  const selectedProfile =
    selectedPlatformProfile === undefined ? undefined : profiles.find(({ id }) => id === selectedPlatformProfile.id)
  const reviewPresentation = presentReviewResult(
    codeCommitReviewThread(accountId, pullRequest.id, diff),
    review === null
      ? null
      : {
          identity: codeCommitReviewThread(accountId, pullRequest.id, review),
          profile: codeCommitReviewProfile(review.profile),
          result: review
        },
    retainedAfterFailure
  )
  const reviewIsStale = reviewPresentation._tag === "Stale"
  const selectedFile = diff.files.find(({ index }) => index === selectedFileIndex) ?? diff.files[0]
  const selectedFileMode = selectedFile === undefined ? null : fileModeLabel(selectedFile)
  const contentStates =
    contentStateCache.identity === reviewIdentity ? contentStateCache.values : new Map<number, RlyDiffFileContent>()
  const files = diff.files.map((file) => toRlyFile(file, contentStates.get(file.index) ?? { state: "ready" }))
  const inventory: RlyDiffInventory = { files, state: "ready" }

  useEffect(() => {
    if (!AsyncResult.isSuccess(config) || selectedProfileId !== null) return
    const resolution = resolveReviewProfile(
      config.value.review.profiles.map(codeCommitReviewProfile),
      null,
      config.value.review.defaultProfileId
    )
    if (resolution._tag === "Resolved") {
      setSelectedProfileId(resolution.profile.id)
    }
  }, [config, selectedProfileId])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (commentNavigation?.destination !== "diff") return
    if (!isCommentOnExactRevision(commentNavigation.target, diff)) {
      setNavigationNotice(
        "This comment belongs to an older CodeCommit revision and cannot be placed on the current diff."
      )
      return
    }
    const fileIndex = fileIndexForComment(diff.files, commentNavigation.target)
    if (fileIndex === undefined) {
      setNavigationNotice("The comment's file is not present in the current changed-file inventory.")
      return
    }
    setNavigationNotice(null)
    setSelectedFileIndex(fileIndex)
    setSelectedFindingId(null)
  }, [commentNavigation, diff])

  useEffect(() => {
    const stored = readRelayReviewSession(window.sessionStorage, reviewSessionKey, reviewIdentity)
    if (stored === null) {
      if (completedReviewRef.current !== null) return
      setCompletedReview(null)
      setTurns([])
      setDispositions({})
      setSelectedFindingId(null)
      return
    }
    const restored = { identity: stored.identity, value: stored.review }
    completedReviewRef.current = restored
    dispositionsRef.current = stored.dispositions
    setCompletedReview(restored)
    setSelectedProfileId(stored.review.profile.id)
    setRetainedAfterFailure(false)
    setTurns(stored.turns)
    setDispositions(stored.dispositions)
    setSelectedFindingId(stored.turns.at(-1)?.findingId ?? stored.review.result.findings[0]?.id ?? null)
  }, [reviewIdentity, reviewSessionKey])

  useEffect(() => {
    if (completedReview === null || completedReview.identity !== reviewIdentity) return
    writeRelayReviewSession(window.sessionStorage, reviewSessionKey, {
      identity: completedReview.identity,
      review: completedReview.value,
      turns,
      dispositions
    })
  }, [completedReview, dispositions, reviewIdentity, reviewSessionKey, turns])

  useEffect(() => {
    if (selectedFileIndex !== null && diff.files.some(({ index }) => index === selectedFileIndex)) return
    setSelectedFileIndex(diff.files[0]?.index ?? null)
  }, [diff.files, selectedFileIndex])

  const updateContentState = useCallback(
    (fileIndex: number, content: RlyDiffFileContent): void => {
      setContentStateCache((current) => {
        const values = current.identity === reviewIdentity ? current.values : new Map<number, RlyDiffFileContent>()
        const previous = values.get(fileIndex)
        if (current.identity === reviewIdentity && previous?.state === content.state) return current
        return { identity: reviewIdentity, values: new Map(values).set(fileIndex, content) }
      })
    },
    [reviewIdentity]
  )

  const runStream = useCallback(
    async (url: string, payload: Parameters<typeof runRelayReviewStream>[1]): Promise<RelayStreamOutcome> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setIsReviewing(true)
      setReviewFailure(null)
      setRetainedAfterFailure(false)
      setProgress([])
      let terminalError: string | null = null
      const terminal: RelayStreamTerminal = {}
      try {
        await runRelayReviewStream(
          url,
          payload,
          (event) => {
            if (event.type === "progress") {
              setProgress((current) => [...current, event].slice(-12))
              return
            }
            if (event.type === "error") {
              terminalError = event.message
              setReviewFailure({ description: event.message, title: "Relay review failed" })
              return
            }
            terminal.event = event
          },
          controller.signal
        )
        if (terminalError !== null) {
          setRetainedAfterFailure(completedReviewRef.current !== null)
          setReviewFailure({ description: terminalError, title: "Relay review failed" })
          return { completed: false }
        }
        const completedEvent = terminal.event
        if (completedEvent === undefined) return { completed: false }
        const prior = completedReviewRef.current?.value.result.findings ?? []
        const nextDispositions =
          prior.length === 0
            ? initialFindingDispositions(completedEvent.review.result.findings)
            : reconcileFindingDispositions(prior, completedEvent.review.result.findings, dispositionsRef.current)
        dispositionsRef.current = nextDispositions
        setDispositions(nextDispositions)
        const completed = { identity: reviewIdentity, value: completedEvent.review }
        completedReviewRef.current = completed
        setCompletedReview(completed)
        setSelectedFindingId((current) => current ?? completedEvent.review.result.findings[0]?.id ?? null)
        return completedEvent.reply === undefined
          ? { completed: true }
          : { completed: true, reply: completedEvent.reply }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setRetainedAfterFailure(completedReviewRef.current !== null)
          setReviewFailure({
            description: failureMessage(cause, "Relay could not complete this review."),
            title: "Relay review failed"
          })
        }
        return { completed: false }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
          setIsReviewing(false)
        }
      }
    },
    [reviewIdentity]
  )

  const executeReview = useCallback(async (): Promise<void> => {
    if (selectedProfile === undefined) return
    const outcome = await runStream(
      `/api/prs/${encodeURIComponent(accountId)}/${encodeURIComponent(pullRequest.id)}/relay-review/stream`,
      {
        revisionId: diff.revisionId,
        baseCommit: diff.baseCommit,
        headCommit: diff.headCommit,
        profile: selectedProfile
      }
    )
    if (outcome.completed) {
      setTurns([])
      setMessage("")
    }
  }, [accountId, diff.baseCommit, diff.headCommit, diff.revisionId, pullRequest.id, runStream, selectedProfile])

  const continueReview = useCallback(
    async (findingId: string, nextMessage: string): Promise<void> => {
      if (review === null) return
      const userTurn: RelayReviewConversationTurn = { findingId, role: "user", message: nextMessage }
      if (!Schema.is(RelayReviewConversationTurn)(userTurn)) {
        setReviewFailure({
          description: "Shorten the message so it can be retained in this review conversation.",
          title: "Message is too large"
        })
        return
      }
      const nextTurns = appendReviewTurn(turns, userTurn)
      const outcome = await runStream(
        `/api/prs/${encodeURIComponent(accountId)}/${encodeURIComponent(pullRequest.id)}/relay-review/continue`,
        {
          revisionId: diff.revisionId,
          baseCommit: diff.baseCommit,
          headCommit: diff.headCommit,
          profile: review.profile,
          currentReview: review.result,
          turns,
          findingId,
          message: nextMessage
        }
      )
      if (!outcome.completed) return
      setTurns(
        outcome.reply === undefined
          ? nextTurns
          : appendReviewTurn(nextTurns, { findingId, role: "assistant", message: outcome.reply })
      )
      setMessage("")
    },
    [accountId, diff.baseCommit, diff.headCommit, diff.revisionId, pullRequest.id, review, runStream, turns]
  )

  const postFinding = useCallback(
    async (finding: RelayReviewFinding): Promise<void> => {
      if (review === null || reviewIsStale) return
      setReviewFailure(null)
      setDispositions((current) => ({ ...current, [finding.id]: "posting" }))
      try {
        const receipt = await postFindingRequest({
          params: { awsAccountId: accountId, prId: pullRequest.id, findingId: finding.id },
          payload: {
            revisionId: review.revisionId,
            baseCommit: review.baseCommit,
            headCommit: review.headCommit,
            finding
          }
        })
        onFindingPosted(receipt.operationId)
        setDispositions((current) => {
          const settlement = settleFindingPublication(
            completedReviewRef.current?.value.result.findings ?? [],
            finding,
            current,
            "posted"
          )
          if (settlement.stale) {
            setReviewFailure({
              description: "CodeCommit received an older finding snapshot. Re-review before relying on it.",
              title: "Finding post needs review"
            })
          }
          return settlement.dispositions
        })
      } catch (cause) {
        setDispositions(
          (current) =>
            settleFindingPublication(
              completedReviewRef.current?.value.result.findings ?? [],
              finding,
              current,
              "failed"
            ).dispositions
        )
        setReviewFailure({
          description: failureMessage(cause, "CodeCommit did not accept this finding."),
          title: "Finding post failed"
        })
      }
    },
    [accountId, onFindingPosted, postFindingRequest, pullRequest.id, review, reviewIsStale]
  )

  const selectFinding = useCallback(
    (finding: RelayReviewFinding): void => {
      setSelectedFindingId(finding.id)
      setConversationCollapsed(false)
      const fileIndex = fileIndexForFinding(diff.files, finding)
      if (fileIndex !== undefined) setSelectedFileIndex(fileIndex)
    },
    [diff.files]
  )
  const selectedFinding = review?.result.findings.find(({ id }) => id === selectedFindingId) ?? null
  const conversationFindingId =
    selectedFinding?.id ??
    (selectedFindingId !== null && turns.some(({ findingId }) => findingId === selectedFindingId)
      ? selectedFindingId
      : null)
  const selectedTurns =
    conversationFindingId === null ? [] : turns.filter(({ findingId }) => findingId === conversationFindingId)
  const visibleProgress = progress.slice(-4)

  return (
    <Surface as="section" className={styles.workspace} padding="none" form="grouped">
      <header className={styles.workspaceHeader}>
        <div>
          <Text tone="secondary" variant="label">
            Exact-revision review
          </Text>
          <Text as="h2" variant="section-title">
            Diff
          </Text>
          <Text tone="secondary" variant="meta">
            {diff.files.length} changed {diff.files.length === 1 ? "file" : "files"} · head{" "}
            {diff.headCommit.slice(0, 12)}
          </Text>
        </div>
      </header>

      {diffFailure === null ? null : (
        <div className={styles.reviewFailure}>
          <StatePanel
            announce="polite"
            description={`${diffFailure} Showing the last successfully loaded exact revision.`}
            title="Latest diff unavailable"
            tone="caution"
          />
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
                activeCommentId={commentNavigation?.destination === "diff" ? commentNavigation.target.commentId : null}
                accountId={accountId}
                baseCommit={diff.baseCommit}
                comments={comments}
                file={selectedFile}
                findings={reviewIsStale ? [] : (review?.result.findings ?? [])}
                headCommit={diff.headCommit}
                key={`${diff.revisionId}:${diff.baseCommit}:${diff.headCommit}:${String(selectedFile.index)}:${layout}:${String(wrap)}`}
                layout={layout}
                onContentStateChange={updateContentState}
                onNavigateToComment={onNavigateToComment}
                pullRequestId={pullRequest.id}
                revisionId={diff.revisionId}
                wrap={wrap}
              />
            )}
          </div>
        </section>

        <aside aria-label="Relay findings" className={styles.agentPane}>
          <header>
            <div className={styles.agentTitle}>
              <span>
                <BotIcon aria-hidden="true" />
                <Text as="h2" variant="section-title">
                  Relay
                </Text>
              </span>
              <small>
                {isReviewing
                  ? "Reviewing the exact revision"
                  : review === null
                    ? "Review findings and discuss evidence"
                    : `${String(review.result.findings.length)} actionable ${
                        review.result.findings.length === 1 ? "finding" : "findings"
                      }`}
              </small>
            </div>
            {isReviewing ? (
              <StateLabel label="running" size="compact" tone="progress" />
            ) : (
              <ReviewResultStatus presentation={reviewPresentation} />
            )}
          </header>
          <section aria-label="Relay controls" className={styles.relayControls}>
            <ReviewProfileControl
              {...(styles.profileChoice === undefined ? {} : { className: styles.profileChoice })}
              disabled={isReviewing || !AsyncResult.isSuccess(config)}
              onProfileChange={(profile) => setSelectedProfileId(profile.id)}
              profiles={platformProfiles}
              selectedProfileId={selectedProfileId}
            />
            <Button
              disabled={isReviewing || diff.files.length === 0 || selectedProfile === undefined}
              loading={isReviewing}
              onClick={() => void executeReview()}
              size="compact"
              variant="primary"
            >
              {isReviewing ? "Relay reviewing…" : review === null ? "Run Relay" : "Run again"}
            </Button>
          </section>

          {AsyncResult.isFailure(config) ? (
            <div className={styles.reviewFailure}>
              <StatePanel
                action={
                  <Button onClick={() => void navigate(0)} size="compact" variant="secondary">
                    Reload
                  </Button>
                }
                announce="assertive"
                description={failureMessage(
                  config.cause,
                  "Check the server connection, then reload this page to retry."
                )}
                title="Relay profiles unavailable"
                tone="critical"
              />
            </div>
          ) : profilesLoading ? (
            <div className={styles.reviewFailure}>
              <StatePanel
                announce="polite"
                description="Loading the configured review methodology before Relay can run."
                title="Loading Relay profiles"
                tone="progress"
              />
            </div>
          ) : profileResolution._tag === "Unknown" ? (
            <div className={styles.reviewFailure}>
              <StatePanel
                description={`The saved profile ${profileResolution.profileId} no longer exists. Select an available profile before running Relay.`}
                title="Saved Relay profile unavailable"
                tone="caution"
              />
            </div>
          ) : profileResolution._tag === "Missing" ? (
            <div className={styles.reviewFailure}>
              <StatePanel
                description="Configure a default Relay profile before running a review."
                title="Relay profile required"
                tone="caution"
              />
            </div>
          ) : null}

          {visibleProgress.length === 0 ? null : (
            <ol aria-label="Relay progress" aria-live="polite" className={styles.progressRail}>
              {visibleProgress.map((event, index) => (
                <li
                  aria-current={index === visibleProgress.length - 1 ? "step" : undefined}
                  key={`${event.phase}:${String(index)}`}
                >
                  <span aria-hidden="true" />
                  <small>{event.phase}</small>
                  <strong>{event.message}</strong>
                  {event.detail === undefined ? null : <em>{event.detail}</em>}
                </li>
              ))}
            </ol>
          )}

          {reviewIsStale ? (
            <div className={styles.staleReview}>
              <span>
                This finding deck reviewed {completedReview?.value.headCommit.slice(0, 12)}; current head is{" "}
                {diff.headCommit.slice(0, 12)}.
              </span>
              <Button
                disabled={isReviewing || review === null}
                onClick={() =>
                  review === null
                    ? undefined
                    : void continueReview(
                        selectedFinding?.id ?? review.result.findings[0]?.id ?? "F1",
                        "Re-review the complete finding deck against the latest exact revision. Reconcile resolved, changed, and new findings."
                      )
                }
                size="compact"
                variant="secondary"
              >
                Re-review latest
              </Button>
            </div>
          ) : null}

          {retainedAfterFailure && review !== null ? (
            <div className={styles.staleReview} role="status">
              Previous result retained. The latest rerun failed; this output is not the attempted rerun.
            </div>
          ) : null}

          {reviewFailure === null ? null : (
            <div className={styles.reviewFailure}>
              <StatePanel
                announce="polite"
                description={reviewFailure.description}
                title={reviewFailure.title}
                tone="critical"
              />
            </div>
          )}

          {navigationNotice === null ? null : (
            <div className={styles.reviewFailure}>
              <StatePanel
                announce="polite"
                description={navigationNotice}
                title="Comment link unavailable"
                tone="caution"
              />
            </div>
          )}
          <ReviewFindings
            canPost={!reviewIsStale}
            dispositions={dispositions}
            isReviewing={isReviewing}
            onAcknowledge={(finding) =>
              setDispositions((current) => applyFindingDecision(current, finding.id, "acknowledged"))
            }
            onPost={(finding) => void postFinding(finding)}
            onReject={(finding) => setDispositions((current) => applyFindingDecision(current, finding.id, "rejected"))}
            onSelect={selectFinding}
            review={review}
            selectedFindingId={selectedFindingId}
          />
          {conversationFindingId === null ? null : (
            <section
              aria-label={`Conversation about ${conversationFindingId}`}
              className={styles.conversation}
              data-collapsed={conversationCollapsed ? "true" : undefined}
            >
              <header>
                <span>
                  <MessageSquareMoreIcon aria-hidden="true" />
                  <span className={styles.conversationTitle}>
                    <strong>{selectedFinding === null ? "Discuss withdrawn finding" : "Discuss finding"}</strong>
                    <small>
                      {selectedFinding === null
                        ? `${conversationFindingId} is no longer in the current deck`
                        : selectedFinding.title}
                    </small>
                  </span>
                </span>
                <button
                  aria-expanded={!conversationCollapsed}
                  onClick={() => setConversationCollapsed((current) => !current)}
                  type="button"
                >
                  {conversationCollapsed ? (
                    <ChevronUpIcon aria-hidden="true" />
                  ) : (
                    <ChevronDownIcon aria-hidden="true" />
                  )}
                  {conversationCollapsed ? "Open" : "Collapse"}
                </button>
              </header>
              {conversationCollapsed ? null : (
                <>
                  <div
                    aria-label={`Conversation history about ${conversationFindingId}`}
                    aria-live="polite"
                    className={styles.conversationHistory}
                    role="log"
                  >
                    {selectedTurns.length === 0 ? (
                      <small>Ask Relay to verify, refine, or withdraw this finding.</small>
                    ) : (
                      <ol>
                        {selectedTurns.map((turn, index) => (
                          <li data-role={turn.role} key={`${turn.role}:${String(index)}`}>
                            <b>{turn.role === "user" ? "You" : "Relay"}</b>
                            {turn.message}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      const submitted = message.trim()
                      if (submitted.length > 0 && !isReviewing) void continueReview(conversationFindingId, submitted)
                    }}
                  >
                    <textarea
                      aria-label="Message Relay"
                      disabled={isReviewing}
                      maxLength={8_000}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Ask Relay about this finding…"
                      rows={2}
                      value={message}
                    />
                    <Button
                      disabled={isReviewing || message.trim().length === 0}
                      size="compact"
                      type="submit"
                      variant="secondary"
                    >
                      Send
                    </Button>
                  </form>
                </>
              )}
            </section>
          )}
        </aside>
      </div>
      <footer className={styles.workspaceFooter}>
        Relay is advisory. Accept posts immediately; acknowledge and reject stay local to this review session.
      </footer>
    </Surface>
  )
}

/** CodeCommit web parity surface for complete diffs and ephemeral Relay reviews. */
export const PullRequestReviewWorkspace = ({
  accountId,
  commentNavigation,
  commentsRefreshGeneration,
  onFindingPosted,
  onNavigateToComment,
  pullRequest,
  refreshGeneration
}: {
  readonly accountId: string
  readonly commentsRefreshGeneration: number
  readonly commentNavigation: ReviewCommentNavigation | null
  readonly onNavigateToComment: (target: ReviewCommentNavigationTarget) => void
  readonly onFindingPosted: (operationId: string) => void
  readonly pullRequest: Domain.PullRequest
  readonly refreshGeneration: number
}): ReactElement => {
  const comments = useComments({
    pullRequestId: pullRequest.id,
    repositoryName: pullRequest.repositoryName,
    profile: pullRequest.account.profile,
    region: pullRequest.account.region,
    refreshGeneration: commentsRefreshGeneration
  })
  const commentTargets = AsyncResult.isSuccess(comments)
    ? comments.value.flatMap((location) =>
        location.comments.flatMap((thread) => {
          if (thread.root.deleted) return []
          const target = reviewCommentNavigationTarget(location, thread.root)
          return target === null ? [] : [target]
        })
      )
    : []
  const diffAtom = useMemo(
    () =>
      ApiClient.query("prs", "diff", {
        params: { awsAccountId: accountId, prId: pullRequest.id },
        serializationKey: `${accountId}:${pullRequest.id}:${pullRequest.lastModifiedDate.toISOString()}:${String(refreshGeneration)}`,
        timeToLive: "30 seconds"
      }),
    [accountId, pullRequest.id, pullRequest.lastModifiedDate, refreshGeneration]
  )
  const diff = useAtomValue(diffAtom)
  const pullRequestIdentity = `${accountId}:${pullRequest.id}`
  const retainedDiffRef = useRef<{ readonly identity: string; readonly value: PullRequestDiffResponse } | null>(null)
  if (AsyncResult.isSuccess(diff)) retainedDiffRef.current = { identity: pullRequestIdentity, value: diff.value }
  const retainedDiff = retainedDiffRef.current?.identity === pullRequestIdentity ? retainedDiffRef.current.value : null
  const visibleDiff = AsyncResult.isSuccess(diff) ? diff.value : retainedDiff

  if ((AsyncResult.isInitial(diff) || AsyncResult.isWaiting(diff)) && visibleDiff === null) {
    return (
      <StatePanel
        announce="polite"
        description="Indexing every changed file."
        title="Loading exact diff"
        tone="progress"
      />
    )
  }
  const diffFailure = AsyncResult.isFailure(diff)
    ? failureMessage(diff.cause, "Refresh this pull request to retry the CodeCommit diff read.")
    : null
  if (AsyncResult.isFailure(diff) && visibleDiff === null) {
    return (
      <StatePanel
        announce="polite"
        description={failureMessage(diff.cause, "Refresh this pull request to retry the CodeCommit diff read.")}
        title="Exact diff unavailable"
        tone="critical"
      />
    )
  }
  return visibleDiff !== null ? (
    <ReadyReviewWorkspace
      accountId={accountId}
      commentNavigation={commentNavigation}
      comments={commentTargets.filter((target) => isCommentOnExactRevision(target, visibleDiff))}
      diff={visibleDiff}
      diffFailure={diffFailure}
      key={`${accountId}:${pullRequest.id}`}
      onFindingPosted={onFindingPosted}
      onNavigateToComment={onNavigateToComment}
      pullRequest={pullRequest}
    />
  ) : (
    <StatePanel description="Refresh this pull request to retry." title="Exact diff unavailable" tone="critical" />
  )
}
