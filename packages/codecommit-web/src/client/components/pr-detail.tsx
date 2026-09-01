/**
 * PR detail page — full PR view with approval management.
 *
 * Renders PR metadata, status badges, health score breakdown, description,
 * comments (collapsible with Markdown), lifecycle metrics (time to merge,
 * first review, address feedback), and the {@link ApproversCard} for
 * managing approval pool membership.
 *
 * **Mental model**
 *
 * - ApproversCard: manages non-template approval rules (Required + Optional);
 *   remove = update rule (SSO roles lack delete permission),
 *   remove all = update to requiredApprovals:0, poolMembers:["*"]
 * - knownUserArns: all users (authors, approvers, commenters, pool members)
 *   → `CodeCommitApprovers:REPO_ACCT:username` format. Typing just a username auto-prefixes.
 * - Keyboard shortcuts: Enter/o = open, . = sandbox, Esc = back
 *
 * **Common tasks**
 *
 * - Show approvers: {@link ApproversCard}
 * - Managed rule names: {@link REQUIRED_RULE_NAME}, {@link OPTIONAL_RULE_NAME}
 *
 * @module
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import type { CommentThreadJsonEncoded } from "@knpkv/codecommit-core/Domain.js"
import { AwsRegion, PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import {
  calculateHealthScore,
  type CategoryStatus,
  getScoreTier,
  type HealthScore,
  type HealthScoreCategory
} from "@knpkv/codecommit-core/HealthScore.js"
import { ServiceMark, Verdict, type RlyVerdictTone } from "@knpkv/rly/patterns"
import {
  Button as RlyButton,
  Field,
  StateLabel,
  StatePanel,
  Surface,
  Text,
  type RlyStateTone
} from "@knpkv/rly/primitives"
import { Option } from "effect"
import * as Predicate from "effect/Predicate"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import {
  ArrowRightIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon
} from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import {
  appStateAtom,
  createApprovalRuleAtom,
  createSandboxAtom,
  openPrAtom,
  refreshSinglePrAtom,
  subscribeAtom,
  subscriptionsQueryAtom,
  unsubscribeAtom,
  updateApprovalRuleAtom
} from "../atoms/app.js"
import { useComments } from "../hooks/useComments.js"
import { useDismissable } from "../hooks/useDismissable.js"
import { useOptimistic } from "../hooks/useOptimistic.js"
import { useOptimisticSet } from "../hooks/useOptimisticSet.js"
import { matchesCodeCommitPullRequestRoute, type CodeCommitPullRequestRouteCoordinates } from "../codecommit-route.js"
import { encodePullRequestCoordinates } from "../../pull-request-coordinates.js"
import {
  type ReviewCommentNavigation,
  type ReviewCommentNavigationTarget,
  reviewCommentNavigationTarget
} from "../review-comment-navigation.js"
import { StorageKeys } from "../storage-keys.js"
import { extractScope } from "../utils/extractScope.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"
import { Separator } from "./ui/separator.js"
import styles from "./pr-detail.module.css"

const PullRequestReviewWorkspace = lazy(() =>
  import("./pr-review-workspace.js").then((module) => ({
    default: module.PullRequestReviewWorkspace
  }))
)

/** Match a persisted sandbox to every coordinate of the selected pull request. */
export const sandboxMatchesPullRequest = (
  sandbox: {
    readonly awsAccountId: string
    readonly pullRequestId: string
    readonly repositoryName: string
    readonly region?: string | null
  },
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean =>
  sandbox.awsAccountId === (pullRequest.account.awsAccountId ?? pullRequest.account.profile) &&
  sandbox.pullRequestId === String(pullRequest.id) &&
  sandbox.repositoryName === String(pullRequest.repositoryName) &&
  sandbox.region === String(pullRequest.account.region)

/** Keep review API requests bound to the exact PR shown by this page. */
export const reviewApiAccountId = (
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): string =>
  encodePullRequestCoordinates({
    accountId: pullRequest.account.awsAccountId ?? pullRequest.account.profile,
    pullRequestId: pullRequest.id,
    repositoryName: pullRequest.repositoryName,
    region: pullRequest.account.region
  })

/** Select a cached PR only when the route identifies exactly one coordinate. */
export const selectCodeCommitPullRequest = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  route: CodeCommitPullRequestRouteCoordinates
) => {
  const matches = pullRequests.filter((candidate) => matchesCodeCommitPullRequestRoute(candidate, route))
  return {
    pullRequest: matches.length === 1 ? (matches[0] ?? null) : null,
    ambiguous: matches.length > 1
  }
}

const healthTone = (tier: ReturnType<typeof getScoreTier>): RlyStateTone =>
  tier === "green" ? "positive" : tier === "yellow" ? "caution" : "critical"

const categoryTone = (status: CategoryStatus): RlyStateTone =>
  status === "positive" ? "positive" : status === "neutral" ? "neutral" : "critical"

export const refreshFailureDescription = (cause: unknown): string => {
  const message = Predicate.isError(cause) ? cause.message.trim() : ""
  return message.length > 0 ? message : "Try the refresh again."
}

const isTextInputTarget = (target: EventTarget | null): boolean => {
  const tagName = Predicate.hasProperty(target, "tagName") ? target.tagName : undefined
  return tagName === "INPUT" || tagName === "TEXTAREA"
}

const formatRelativeDate = (dateStr: string): string => {
  const date = new Date(dateStr)
  const abs = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return `${abs} · just now`
  if (diffMins < 60) return `${abs} · ${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${abs} · ${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${abs} · ${diffDays}d ago`
}

const earliestDate = (loc: { readonly comments: ReadonlyArray<CommentThreadJsonEncoded> }): number => {
  if (loc.comments.length === 0) return 0
  return Math.min(...loc.comments.map((t) => new Date(t.root.creationDate).getTime()))
}

const countThread = (thread: CommentThreadJsonEncoded): number =>
  1 + thread.replies.reduce((sum, reply) => sum + countThread(reply), 0)

const countVisibleThread = (thread: CommentThreadJsonEncoded): number =>
  thread.root.deleted ? 0 : 1 + thread.replies.reduce((sum, reply) => sum + countVisibleThread(reply), 0)

const commentIdsInThread = (thread: CommentThreadJsonEncoded): ReadonlyArray<string> => [
  thread.root.id,
  ...thread.replies.flatMap(commentIdsInThread)
]

interface CommentCountSnapshot {
  readonly commentIds: ReadonlyArray<string>
  readonly count: number
}

function CommentsCountReporter({
  onCountChange,
  snapshot
}: {
  readonly snapshot: CommentCountSnapshot
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
}) {
  const lastSnapshotKeyRef = useRef("")
  useEffect(() => {
    const snapshotKey = `${String(snapshot.count)}:${snapshot.commentIds.join("\u0000")}`
    if (lastSnapshotKeyRef.current === snapshotKey) return
    lastSnapshotKeyRef.current = snapshotKey
    onCountChange(snapshot)
  })
  return null
}

function ScoreBadge({ score }: { readonly score: HealthScore | undefined }) {
  if (score === undefined) return null
  const tier = getScoreTier(score.total)

  return <StateLabel label={`Health ${score.total.toFixed(1)} / 10`} size="compact" tone={healthTone(tier)} />
}

function ScoreBreakdown({ score }: { readonly score: HealthScore | undefined }) {
  if (score === undefined) {
    return (
      <Text tone="secondary" variant="meta">
        Waiting for comment count…
      </Text>
    )
  }
  const tier = getScoreTier(score.total)

  return (
    <div className={styles.scoreBreakdown}>
      <div className={styles.scoreSummary}>
        <strong data-tone={healthTone(tier)}>{score.total.toFixed(1)}</strong>
        <span>/ 10</span>
        <div
          aria-label={`Health score ${score.total.toFixed(1)} out of 10`}
          aria-valuemax={10}
          aria-valuemin={0}
          aria-valuenow={score.total}
          className={styles.scoreTrack}
          role="progressbar"
        >
          <div className={styles.scoreFill} data-tone={healthTone(tier)} style={{ width: `${score.total * 10}%` }} />
        </div>
      </div>
      <ul className={styles.scoreCategories}>
        {score.categories.map((cat: HealthScoreCategory) => (
          <li key={cat.label} className={styles.scoreCategory}>
            <span className={styles.scoreDelta} data-direction={cat.value > 0 ? "up" : cat.value < 0 ? "down" : "flat"}>
              {cat.value > 0 ? `+${cat.value}` : cat.value}
            </span>
            <div className={styles.scoreCategoryCopy}>
              <div>
                <Text as="strong" variant="label">
                  {cat.label}
                </Text>
                <StateLabel label={cat.statusLabel} size="compact" tone={categoryTone(cat.status)} />
              </div>
              <Text tone="secondary" variant="meta">
                {cat.description}
              </Text>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface CommentLocationCoordinates {
  readonly afterCommitId?: string | undefined
  readonly beforeCommitId?: string | undefined
  readonly filePath?: string | undefined
  readonly relativeFileVersion?: "AFTER" | "BEFORE" | undefined
}

function CommentThread({
  depth,
  location,
  navigation,
  onNavigateToDiff,
  thread,
  visible
}: {
  readonly thread: CommentThreadJsonEncoded
  readonly depth: number
  readonly location: CommentLocationCoordinates
  readonly navigation: ReviewCommentNavigation | null
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
  readonly visible: boolean
}) {
  const target = depth === 0 ? reviewCommentNavigationTarget(location, thread.root) : null
  const active = navigation?.destination === "comment" && navigation.target.commentId === thread.root.id
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!active || !visible || articleRef.current === null) return
    articleRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    articleRef.current.focus({ preventScroll: true })
  }, [active, visible])

  if (thread.root.deleted) return null

  return (
    <article
      className={depth > 0 ? styles.commentReply : styles.comment}
      data-active={active ? "true" : undefined}
      ref={articleRef}
      tabIndex={active ? -1 : undefined}
    >
      <div className={styles.commentBody}>
        <div className={styles.commentMeta}>
          <strong>{thread.root.author}</strong>
          <span aria-hidden="true">·</span>
          <time dateTime={thread.root.creationDate}>{formatRelativeDate(thread.root.creationDate)}</time>
          {target === null ? null : (
            <button className={styles.commentJump} onClick={() => onNavigateToDiff(target)} type="button">
              <CodeIcon aria-hidden="true" /> View in diff
            </button>
          )}
        </div>
        <div
          className={`${styles.markdown ?? ""} prose prose-sm dark:prose-invert max-w-none break-words [&_a]:text-primary [&_img]:inline [&_img]:h-5 [&_img]:w-auto`}
        >
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {thread.root.content}
          </Markdown>
        </div>
      </div>
      {thread.replies.map((reply) => (
        <CommentThread
          depth={depth + 1}
          key={reply.root.id}
          location={location}
          navigation={navigation}
          onNavigateToDiff={onNavigateToDiff}
          thread={reply}
          visible={visible}
        />
      ))}
    </article>
  )
}

function CommentsSection({
  commentsRefreshGeneration,
  navigation,
  onCountChange,
  onNavigateToDiff,
  pr,
  visible
}: {
  readonly commentsRefreshGeneration: number
  readonly navigation: ReviewCommentNavigation | null
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
  readonly pr: Domain.PullRequest
  readonly visible: boolean
}) {
  const commentsResult = useComments({
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName,
    profile: pr.account.profile,
    region: pr.account.region,
    refreshGeneration: commentsRefreshGeneration
  })

  return AsyncResult.builder(commentsResult)
    .onInitialOrWaiting(() => (
      <StatePanel
        announce="polite"
        description="Reading the current CodeCommit conversation."
        title="Loading comments"
        tone="progress"
      />
    ))
    .onError(() => (
      <StatePanel
        announce="polite"
        description="Refresh the pull request to try reading the conversation again."
        title="Comments unavailable"
        tone="critical"
      />
    ))
    .onDefect(() => (
      <StatePanel
        announce="polite"
        description="Refresh the pull request to try reading the conversation again."
        title="Comments unavailable"
        tone="critical"
      />
    ))
    .onSuccess((comments) => {
      const totalCount = comments.reduce((sum, loc) => sum + loc.comments.reduce((s, t) => s + countThread(t), 0), 0)
      const commentIds = comments.flatMap((location) => location.comments.flatMap(commentIdsInThread)).sort()
      const visibleCount = comments.reduce(
        (sum, loc) => sum + loc.comments.reduce((locationSum, thread) => locationSum + countVisibleThread(thread), 0),
        0
      )

      return (
        <div className={styles.comments}>
          <CommentsCountReporter onCountChange={onCountChange} snapshot={{ commentIds, count: totalCount }} />
          {comments.length === 0 && (
            <Text tone="secondary" variant="meta">
              No comments
            </Text>
          )}
          {visibleCount > 0 && (
            <div className={styles.commentLocations}>
              {[...comments]
                .sort((a, b) => earliestDate(b) - earliestDate(a))
                .map((loc, i) => (
                  <section className={styles.commentLocation} key={loc.filePath ?? `loc-${i}`}>
                    {loc.filePath && <code className={styles.commentPath}>{loc.filePath}</code>}
                    {loc.comments.map((thread) => (
                      <CommentThread
                        depth={0}
                        key={thread.root.id}
                        location={loc}
                        navigation={navigation}
                        onNavigateToDiff={onNavigateToDiff}
                        thread={thread}
                        visible={visible}
                      />
                    ))}
                    {i < comments.length - 1 && <Separator className="my-2" />}
                  </section>
                ))}
            </div>
          )}
        </div>
      )
    })
    .render()
}

function LifecycleInfo({ pr }: { readonly pr: Domain.PullRequest }) {
  const commentsResult = useComments({
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName,
    profile: pr.account.profile,
    region: pr.account.region
  })

  const timeToMerge = pr.status === "MERGED" ? pr.lastModifiedDate.getTime() - pr.creationDate.getTime() : null

  const { timeToAddressFeedback, timeToFirstReview } = useMemo(() => {
    if (!AsyncResult.isSuccess(commentsResult)) return { timeToFirstReview: null, timeToAddressFeedback: null }
    const allComments: Array<{ author: string; date: Date }> = []
    for (const loc of commentsResult.value) {
      const walk = (threads: ReadonlyArray<CommentThreadJsonEncoded>) => {
        for (const t of threads) {
          allComments.push({ author: t.root.author, date: new Date(t.root.creationDate) })
          walk(t.replies)
        }
      }
      walk(loc.comments)
    }
    allComments.sort((a, b) => a.date.getTime() - b.date.getTime())

    const firstComment = allComments.find((c) => c.author !== pr.author)
    const commentMs = firstComment !== undefined ? firstComment.date.getTime() - pr.creationDate.getTime() : null
    // Approval as review fallback: use lastModifiedDate as proxy for approval time
    const hasNonAuthorApproval = pr.isApproved && pr.approvedBy.some((a) => a !== pr.author)
    const approvalMs = hasNonAuthorApproval ? pr.lastModifiedDate.getTime() - pr.creationDate.getTime() : null
    const ttfr = commentMs != null && approvalMs != null ? Math.min(commentMs, approvalMs) : (commentMs ?? approvalMs)

    const feedbackDeltas: Array<number> = []
    for (let i = 0; i < allComments.length; i++) {
      if (allComments[i]!.author !== pr.author) {
        const reply = allComments.slice(i + 1).find((c) => c.author === pr.author)
        if (reply !== undefined) feedbackDeltas.push(reply.date.getTime() - allComments[i]!.date.getTime())
      }
    }
    const ttaf = feedbackDeltas.length > 0 ? feedbackDeltas.reduce((a, b) => a + b, 0) / feedbackDeltas.length : null

    return { timeToFirstReview: ttfr, timeToAddressFeedback: ttaf }
  }, [commentsResult, pr.author, pr.creationDate, pr.lastModifiedDate, pr.isApproved, pr.approvedBy])

  const hasAny = timeToMerge != null || timeToFirstReview != null || timeToAddressFeedback != null
  if (!hasAny) return null

  return (
    <>
      {timeToMerge != null && (
        <>
          <dt>Time to merge</dt>
          <dd>{DateUtils.formatDuration(timeToMerge)}</dd>
        </>
      )}
      {timeToFirstReview != null && (
        <>
          <dt>Time to first review</dt>
          <dd>{DateUtils.formatDuration(timeToFirstReview)}</dd>
        </>
      )}
      {timeToAddressFeedback != null && (
        <>
          <dt>Time to address feedback</dt>
          <dd>{DateUtils.formatDuration(timeToAddressFeedback)}</dd>
        </>
      )}
    </>
  )
}

function CollapsibleSection({
  children,
  count,
  keepMounted = false,
  openRequestKey,
  title
}: {
  readonly title: string
  readonly count?: number
  readonly keepMounted?: boolean
  readonly openRequestKey?: string
  readonly children: (open: boolean) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (openRequestKey !== undefined) setOpen(true)
  }, [openRequestKey])
  const content = children(open)
  return (
    <Surface as="section" className={styles.disclosure} padding="none" form="grouped">
      <button aria-expanded={open} className={styles.disclosureTrigger} onClick={() => setOpen(!open)} type="button">
        <ChevronDownIcon aria-hidden="true" className={styles.disclosureIcon} data-open={open ? "true" : "false"} />
        <span>{title}</span>
        {count !== undefined && <small>{count}</small>}
      </button>
      {(open || keepMounted) && (
        <div className={styles.disclosureContent} hidden={!open}>
          {content}
        </div>
      )}
    </Surface>
  )
}

const REQUIRED_RULE_NAME = "Required approvers"
const OPTIONAL_RULE_NAME = "Optional approvers"

export const normalizeApproverIdentity = (input: string, repoAccountId: string): string | undefined => {
  const trimmed = input.trim()
  if (trimmed.length === 0 || repoAccountId.length === 0) return undefined
  return trimmed.startsWith("CodeCommitApprovers:") ? trimmed : `CodeCommitApprovers:${repoAccountId}:${trimmed}`
}

interface ApproversCardProps {
  readonly title: string
  readonly ruleName: string
  readonly required: boolean
  readonly approvalRules: ReadonlyArray<{
    readonly ruleName: string
    readonly requiredApprovals: number
    readonly poolMembers: ReadonlyArray<string>
    readonly poolMemberArns: ReadonlyArray<string>
    readonly satisfied: boolean
    readonly fromTemplate?: string | undefined
  }>
  readonly approvedBy: ReadonlyArray<string>
  readonly knownUserArns: ReadonlyMap<string, string>
  readonly currentUser: string | undefined
  readonly repoAccountId: string
  readonly onSetApprovers: (arns: ReadonlyArray<string>) => void
  readonly onRefresh: () => void
  readonly permissionPrompt: boolean
}

function ApproversCard({
  approvalRules,
  approvedBy,
  currentUser,
  knownUserArns,
  onRefresh,
  onSetApprovers,
  permissionPrompt,
  repoAccountId,
  required,
  ruleName,
  title
}: ApproversCardProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [manualArn, setManualArn] = useState("")
  const poolKey = approvalRules.flatMap((r) => r.poolMembers).join(",")
  const optimistic = useOptimisticSet({
    items: approvalRules.flatMap((r) => r.poolMembers),
    stableKey: poolKey,
    permissionPrompt,
    onRefresh
  })
  const { pendingAdd, pendingRemove } = optimistic

  // Pool members for THIS card: template rules + this card's managed rule (not other managed rules)
  const allPoolMembers = useMemo(() => {
    const set = new Set<string>()
    for (const rule of approvalRules) {
      if (rule.fromTemplate !== undefined || rule.ruleName === ruleName) {
        for (const m of rule.poolMembers) set.add(m)
      }
    }
    return [...set]
  }, [approvalRules, ruleName])

  // Find the managed rule by name (non-template rule we can edit)
  const managedRule = approvalRules.find((r) => r.ruleName === ruleName && r.fromTemplate === undefined)
  const managedArns = managedRule?.poolMemberArns ?? []
  const managedMembers = managedRule?.poolMembers ?? []

  // Users available to add (have known ARN + not already in pool)
  const addable = useMemo(
    () => [...knownUserArns.entries()].filter(([name]) => !allPoolMembers.includes(name) && name !== pendingAdd),
    [knownUserArns, allPoolMembers, pendingAdd]
  )

  const prefix = repoAccountId.length > 0 ? `CodeCommitApprovers:${repoAccountId}:` : ""

  const handleAdd = (input: string) => {
    const value = normalizeApproverIdentity(input, repoAccountId)
    if (value === undefined) return
    const nameMatch = /^CodeCommitApprovers:[^:]*:(.+)$/.exec(value)
    optimistic.add(nameMatch !== null ? nameMatch[1]! : input)
    onSetApprovers([...managedArns, value])
    setShowPicker(false)
  }

  const handleRemove = (user: string) => {
    optimistic.remove(user)
    const idx = managedMembers.indexOf(user)
    if (idx >= 0) {
      onSetApprovers(managedArns.filter((_, i) => i !== idx))
    }
  }

  const isSatisfied = approvalRules.length > 0 && approvalRules.every((r) => r.satisfied)

  return (
    <Surface as="section" className={styles.approverCard} padding="default" form="grouped" tone="secondary">
      <header className={styles.approverHeading}>
        <div className={styles.approverTitle}>
          <Text as="h3" variant="card-title">
            {title}
          </Text>
          {required &&
            approvalRules.length > 0 &&
            (isSatisfied ? (
              <StateLabel label="Satisfied" size="compact" tone="positive" />
            ) : (
              <StateLabel label="Pending" size="compact" tone="caution" />
            ))}
        </div>
        <Button
          aria-expanded={showPicker}
          aria-label={showPicker ? `Close ${title.toLocaleLowerCase()} editor` : `Add ${title.toLocaleLowerCase()}`}
          className={styles.iconAction}
          onClick={() => setShowPicker(!showPicker)}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
        </Button>
      </header>
      <div className={styles.approverBody}>
        {showPicker && (
          <div className={styles.approverPicker}>
            {addable.length > 0 && (
              <div className={styles.approverSuggestions}>
                {addable.map(([name]) => (
                  <Button
                    className={styles.suggestionChoice}
                    key={name}
                    onClick={() => setManualArn(name)}
                    size="sm"
                    variant="outline"
                  >
                    {name}
                  </Button>
                ))}
              </div>
            )}
            <div className={styles.approverPickerActions}>
              <Field
                className={styles.approverField}
                description="Enter a known user or the complete CodeCommit approver identity."
                label="Approver"
                size="compact"
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    className={`${controlProps.className} ${styles.approverInput ?? ""}`}
                    onChange={(event) => setManualArn(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && manualArn.trim().length > 0 && prefix.length > 0) {
                        handleAdd(manualArn.trim())
                        setManualArn("")
                      }
                    }}
                    placeholder={prefix.length > 0 ? `${prefix}USERNAME` : "username"}
                    value={manualArn}
                  />
                )}
              </Field>
              <RlyButton
                disabled={manualArn.trim().length === 0 || prefix.length === 0}
                onClick={() => {
                  handleAdd(manualArn.trim())
                  setManualArn("")
                }}
                size="compact"
                variant="primary"
              >
                Add
              </RlyButton>
            </div>
          </div>
        )}
        {!showPicker && prefix.length > 0 && addable.length > 0 && (
          <div className={styles.suggestedApprovers}>
            <Text tone="tertiary" variant="meta">
              Suggested
            </Text>
            {addable.slice(0, 5).map(([name, arn]) => (
              <button className={styles.suggestedApprover} key={name} onClick={() => handleAdd(arn)} type="button">
                <PlusIcon aria-hidden="true" />
                {name}
              </button>
            ))}
          </div>
        )}
        {(allPoolMembers.length > 0 || pendingAdd) && (
          <div className={styles.approverMembers}>
            {allPoolMembers.map((member) => {
              const hasApproved = approvedBy.includes(member)
              const isManaged = managedMembers.includes(member)
              const isRemoving = member === pendingRemove
              return (
                <Badge
                  className={`${styles.approverMember ?? ""} ${
                    hasApproved ? "border-green-500/30 text-green-600 dark:text-green-400" : ""
                  } ${isRemoving ? "opacity-50" : ""}`}
                  key={member}
                  variant={member === currentUser ? "default" : hasApproved ? "outline" : "secondary"}
                >
                  {isRemoving && <LoaderIcon className="size-3 animate-spin" />}
                  {!isRemoving && hasApproved && <CheckIcon className="size-3" />}
                  {member}
                  {isManaged && !isRemoving && (
                    <button
                      aria-label={`Remove ${member} from ${title.toLocaleLowerCase()}`}
                      className={styles.removeApprover}
                      onClick={() => handleRemove(member)}
                      type="button"
                    >
                      <TrashIcon className="size-3" />
                    </button>
                  )}
                </Badge>
              )
            })}
            {pendingAdd && !allPoolMembers.includes(pendingAdd) && (
              <Badge className={`${styles.approverMember ?? ""} opacity-70`} variant="secondary">
                <LoaderIcon className="size-3 animate-spin" />
                {pendingAdd}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Surface>
  )
}

interface PullRequestDecisionPresentation {
  readonly reason: string
  readonly tone: RlyVerdictTone
  readonly verdict: string
}

interface OptimisticCommentCount {
  readonly baseCount: number
  readonly count: number
  readonly identity: string
  readonly pendingCommentIds: ReadonlyArray<string>
}

const pullRequestDecision = (pr: Domain.PullRequest): PullRequestDecisionPresentation => {
  switch (pr.status) {
    case "MERGED":
      return {
        reason: `CodeCommit reports this pull request merged into ${pr.destinationBranch}.`,
        tone: "positive",
        verdict: "Merged."
      }
    case "CLOSED":
      return {
        reason: "CodeCommit reports this pull request closed without a merge.",
        tone: "neutral",
        verdict: "Closed."
      }
    case "OPEN":
      if (!pr.isMergeable) {
        return {
          reason: `Resolve the conflict between ${pr.sourceBranch} and ${pr.destinationBranch} before merging.`,
          tone: "critical",
          verdict: "Resolve conflicts."
        }
      }
      if (!pr.isApproved) {
        return {
          reason: "The branch is mergeable, but its provider approval is still pending.",
          tone: "caution",
          verdict: "Review pending."
        }
      }
      return {
        reason: "CodeCommit reports a clean merge and the provider approval is satisfied.",
        tone: "positive",
        verdict: "Ready to merge."
      }
  }
}

const pullRequestStatusTone = (status: Domain.PullRequest["status"]): RlyStateTone =>
  status === "MERGED" ? "positive" : status === "CLOSED" ? "neutral" : "progress"

export function PRDetail() {
  const { accountId, prId } = useParams<{ accountId: string; prId: string }>()
  const [searchParams] = useSearchParams()
  const state = useAtomValue(appStateAtom)
  const refreshSingle = useAtomSet(refreshSinglePrAtom)
  const refreshSingleWithResult = useAtomSet(refreshSinglePrAtom, { mode: "promise" })
  const createRule = useAtomSet(createApprovalRuleAtom)
  const updateRule = useAtomSet(updateApprovalRuleAtom)
  const fetchedRef = useRef<string | null>(null)
  const routeSelection = useMemo(() => {
    if (prId === undefined || prId.length === 0) return { pullRequest: null, ambiguous: false }
    let route: CodeCommitPullRequestRouteCoordinates = { pullRequestId: prId }
    if (accountId !== undefined) route = { ...route, accountId }
    if (searchParams.has("region")) route = { ...route, region: searchParams.get("region") ?? "" }
    if (searchParams.has("repository")) {
      route = { ...route, repositoryName: searchParams.get("repository") ?? "" }
    }
    return selectCodeCommitPullRequest(state.pullRequests, route)
  }, [accountId, prId, searchParams, state.pullRequests])
  const pr = routeSelection.pullRequest
  const routeHasPartialCoordinates = searchParams.has("repository") !== searchParams.has("region")
  const routeAmbiguous = routeHasPartialCoordinates || routeSelection.ambiguous
  const refreshAccountId = pr === null ? accountId : reviewApiAccountId(pr)
  const refreshRepositoryName = pr === null ? (searchParams.get("repository") ?? undefined) : String(pr.repositoryName)
  const refreshRegion = pr === null ? (searchParams.get("region") ?? undefined) : String(pr.account.region)

  // Collect ALL known users from all PRs (authors, approvers, commenters, pool members)
  // Build CodeCommitApprovers:REPO_ACCT:username directly — no ARN needed
  const currentAcct = pr?.account?.repoAccountId || ""
  const knownUserArns = useMemo(() => {
    const map = new Map<string, string>()
    // All users stamped with currentAcct — approval pools reference the PR's repo account.
    // If same username exists across accounts, first-seen wins (acceptable for single-org use).
    const addUser = (name: string) => {
      if (name.length === 0 || name === "*") return
      if (!map.has(name)) {
        map.set(name, currentAcct.length > 0 ? `CodeCommitApprovers:${currentAcct}:${name}` : name)
      }
    }
    for (const p of state.pullRequests) {
      addUser(p.author)
      for (const name of p.approvedBy) addUser(name)
      for (const name of p.commentedBy) addUser(name)
      for (const rule of p.approvalRules) {
        for (const name of rule.poolMembers) addUser(name)
      }
    }
    return map
  }, [state.pullRequests, currentAcct])

  // Fetch from AWS when PR not in cache (e.g. merged/closed)
  useEffect(() => {
    if (
      routeAmbiguous ||
      pr !== null ||
      refreshAccountId === undefined ||
      refreshAccountId.length === 0 ||
      prId === undefined ||
      prId.length === 0
    )
      return
    const key = `${refreshAccountId}:${prId}:${refreshRepositoryName ?? ""}:${refreshRegion ?? ""}`
    if (fetchedRef.current === key) return
    fetchedRef.current = key
    refreshSingle({
      params: { awsAccountId: refreshAccountId, prId: PullRequestId.make(prId) },
      query:
        refreshRepositoryName !== undefined && refreshRegion !== undefined
          ? { repositoryName: refreshRepositoryName, region: AwsRegion.make(refreshRegion) }
          : {}
    })
  }, [pr, prId, refreshAccountId, refreshRegion, refreshRepositoryName, refreshSingle, routeAmbiguous])

  const score: HealthScore | undefined = useMemo(
    () => (pr !== null ? Option.getOrUndefined(calculateHealthScore(pr, new Date())) : undefined),
    [pr]
  )
  const navigate = useNavigate()
  const openPr = useAtomSet(openPrAtom)
  const granted = useDismissable(StorageKeys.grantedDismissed)
  const docker = useDismissable(StorageKeys.dockerDismissed)

  // Subscriptions
  const subscriptionsResult = useAtomValue(subscriptionsQueryAtom)
  const subscribe = useAtomSet(subscribeAtom)
  const unsubscribe = useAtomSet(unsubscribeAtom)
  const accountKey = pr?.account.awsAccountId ?? pr?.account.profile
  const subscriptionCoordinates =
    pr === null ? undefined : { repositoryName: String(pr.repositoryName), region: pr.account.region }
  const serverSubscribed = useMemo(
    () =>
      AsyncResult.isSuccess(subscriptionsResult) && accountKey !== undefined && accountKey.length > 0
        ? subscriptionsResult.value.some(
            (s) =>
              s.awsAccountId === accountKey &&
              s.pullRequestId === prId &&
              s.repositoryName === subscriptionCoordinates?.repositoryName &&
              s.accountRegion === subscriptionCoordinates?.region
          )
        : false,
    [subscriptionsResult, accountKey, prId, subscriptionCoordinates]
  )
  const [isSubscribed, setOptimistic] = useOptimistic(serverSubscribed)
  const handleSubscriptionToggle = useCallback(() => {
    if (accountKey === undefined || accountKey.length === 0 || pr === null) return
    const payload = {
      awsAccountId: accountKey,
      pullRequestId: pr.id,
      repositoryName: String(pr.repositoryName),
      region: pr.account.region
    }
    setOptimistic(!isSubscribed)
    if (isSubscribed) {
      unsubscribe({ payload })
    } else {
      subscribe({ payload })
    }
  }, [accountKey, isSubscribed, pr, subscribe, unsubscribe])

  // Refresh single PR
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [reviewRefreshGeneration, setReviewRefreshGeneration] = useState(0)
  const [commentsRefreshGeneration, setCommentsRefreshGeneration] = useState(0)
  const commentRefreshTimersRef = useRef<Set<number>>(new Set())
  const commentNavigationIdentity = `${accountKey ?? ""}:${prId ?? ""}`
  const [commentCountState, setCommentCountState] = useState<OptimisticCommentCount | null>(null)
  const authoritativeCommentCount = pr?.commentCount
  const commentCount = (() => {
    if (authoritativeCommentCount === undefined || commentCountState?.identity !== commentNavigationIdentity) {
      return authoritativeCommentCount
    }
    return Math.max(authoritativeCommentCount, commentCountState.count)
  })()
  const [commentNavigationState, setCommentNavigationState] = useState<{
    readonly identity: string
    readonly navigation: ReviewCommentNavigation
  } | null>(null)
  const commentNavigation =
    commentNavigationState?.identity === commentNavigationIdentity ? commentNavigationState.navigation : null
  const commentNavigationRequestRef = useRef(0)
  const requestCommentNavigation = useCallback(
    (destination: ReviewCommentNavigation["destination"], target: ReviewCommentNavigationTarget) => {
      commentNavigationRequestRef.current += 1
      setCommentNavigationState({
        identity: commentNavigationIdentity,
        navigation: { destination, requestId: commentNavigationRequestRef.current, target }
      })
    },
    [commentNavigationIdentity]
  )
  const reviewedRevisionRef = useRef<string | null>(null)
  const invalidateReview = useCallback(
    (refreshed: { readonly revisionId: string; readonly headCommit: string }, force: boolean) => {
      const revision = `${accountKey ?? ""}:${prId ?? ""}:${refreshed.revisionId}:${refreshed.headCommit}`
      const changed = reviewedRevisionRef.current !== revision
      reviewedRevisionRef.current = revision
      if (force || changed) {
        setReviewRefreshGeneration((current) => current + 1)
      }
    },
    [accountKey, prId]
  )
  useEffect(
    () => () => {
      for (const timer of commentRefreshTimersRef.current) window.clearTimeout(timer)
      commentRefreshTimersRef.current.clear()
    },
    []
  )
  useEffect(() => {
    if (authoritativeCommentCount === undefined) return
    setCommentCountState((current) => {
      if (current?.identity !== commentNavigationIdentity || authoritativeCommentCount === current.baseCount)
        return current
      if (current.pendingCommentIds.length > 0) {
        return {
          ...current,
          baseCount: authoritativeCommentCount,
          count: Math.max(current.count, authoritativeCommentCount)
        }
      }
      return authoritativeCommentCount < current.count ? { ...current, baseCount: authoritativeCommentCount } : null
    })
  }, [authoritativeCommentCount, commentNavigationIdentity])
  const reconcileCommentCount = useCallback(
    (snapshot: CommentCountSnapshot) => {
      const baseCount = pr?.commentCount ?? 0
      setCommentCountState((current) => {
        if (current?.identity !== commentNavigationIdentity) return current
        const observedCommentIds = new Set(snapshot.commentIds)
        const pendingCommentIds = current.pendingCommentIds.filter((commentId) => !observedCommentIds.has(commentId))
        const count = snapshot.count + pendingCommentIds.length
        return pendingCommentIds.length === 0 && count <= baseCount
          ? null
          : { ...current, baseCount, count: Math.max(baseCount, count), pendingCommentIds }
      })
    },
    [commentNavigationIdentity, pr?.commentCount]
  )
  const refreshCommentsAfterPublication = useCallback(
    (operationId: string) => {
      const commentId = operationId.startsWith("comment:") ? operationId.slice("comment:".length) : operationId
      setCommentCountState((current) => {
        const baseCount = pr?.commentCount ?? 0
        return current?.identity === commentNavigationIdentity
          ? {
              ...current,
              baseCount,
              count: Math.max(current.count, baseCount) + 1,
              pendingCommentIds: [...current.pendingCommentIds, commentId]
            }
          : {
              baseCount,
              count: baseCount + 1,
              identity: commentNavigationIdentity,
              pendingCommentIds: [commentId]
            }
      })
      setCommentsRefreshGeneration((current) => current + 1)
      for (const delay of [1_500, 5_000]) {
        const timer = window.setTimeout(() => {
          commentRefreshTimersRef.current.delete(timer)
          setCommentsRefreshGeneration((current) => current + 1)
        }, delay)
        commentRefreshTimersRef.current.add(timer)
      }
    },
    [commentNavigationIdentity, pr?.commentCount]
  )
  const refreshAfterApprovalMutation = useCallback(() => {
    if (refreshAccountId === undefined || refreshAccountId.length === 0 || prId === undefined || prId.length === 0)
      return
    void refreshSingleWithResult({
      params: { awsAccountId: refreshAccountId, prId: PullRequestId.make(prId) },
      query:
        refreshRepositoryName !== undefined && refreshRegion !== undefined
          ? { repositoryName: refreshRepositoryName, region: AwsRegion.make(refreshRegion) }
          : {}
    }).then(
      (refreshed) => invalidateReview(refreshed, false),
      () => {}
    )
  }, [invalidateReview, prId, refreshAccountId, refreshRegion, refreshRepositoryName, refreshSingleWithResult])
  const handleRefresh = useCallback(() => {
    if (
      refreshAccountId === undefined ||
      refreshAccountId.length === 0 ||
      prId === undefined ||
      prId.length === 0 ||
      isRefreshing
    )
      return
    setIsRefreshing(true)
    void refreshSingleWithResult({
      params: { awsAccountId: refreshAccountId, prId: PullRequestId.make(prId) },
      query:
        refreshRepositoryName !== undefined && refreshRegion !== undefined
          ? { repositoryName: refreshRepositoryName, region: AwsRegion.make(refreshRegion) }
          : {}
    }).then(
      (refreshed) => {
        invalidateReview(refreshed, true)
        setIsRefreshing(false)
      },
      (cause: unknown) => {
        setIsRefreshing(false)
        toast.error("Unable to refresh pull request", {
          description: refreshFailureDescription(cause)
        })
      }
    )
  }, [
    invalidateReview,
    isRefreshing,
    prId,
    refreshAccountId,
    refreshRegion,
    refreshRepositoryName,
    refreshSingleWithResult
  ])

  // Copy console URL
  const consoleUrl =
    pr !== null
      ? pr.link.length > 0
        ? pr.link
        : `https://${pr.account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${pr.repositoryName}/pull-requests/${pr.id}?region=${pr.account.region}`
      : ""
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    if (consoleUrl.length === 0) return
    navigator.clipboard.writeText(consoleUrl).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {
        /* clipboard denied — noop */
      }
    )
  }, [consoleUrl])

  // Sandbox
  const createSandbox = useAtomSet(createSandboxAtom)
  const existingSandbox = useMemo(
    () =>
      pr === null
        ? undefined
        : state.sandboxes?.find(
            (sandbox) =>
              sandbox.status !== "stopped" && sandbox.status !== "error" && sandboxMatchesPullRequest(sandbox, pr)
          ),
    [pr, state.sandboxes]
  )

  const [sandboxCreating, setSandboxCreating] = useState(false)

  useEffect(() => {
    if (sandboxCreating && existingSandbox !== undefined) {
      setSandboxCreating(false)
      navigate(`/sandbox/${existingSandbox.id}`)
    }
  }, [sandboxCreating, existingSandbox, navigate])

  const proceedSandbox = useCallback(() => {
    if (pr === null) return
    const sandboxAccountKey = pr.account.awsAccountId ?? pr.account.profile
    createSandbox({
      payload: {
        pullRequestId: pr.id,
        awsAccountId: sandboxAccountKey,
        repositoryName: pr.repositoryName,
        sourceBranch: pr.sourceBranch,
        profile: pr.account.profile,
        region: pr.account.region
      }
    })
    setSandboxCreating(true)
  }, [pr, createSandbox])

  const handleSandbox = useCallback(() => {
    if (pr === null) return
    if (existingSandbox !== undefined) {
      navigate(`/sandbox/${existingSandbox.id}`)
      return
    }
    if (!docker.show()) {
      proceedSandbox()
    }
  }, [pr, existingSandbox, docker, proceedSandbox, navigate])

  const handleDockerContinue = () => {
    docker.dismiss()
    proceedSandbox()
  }

  const proceedOpen = useCallback(() => {
    if (pr === null || consoleUrl.length === 0) return
    openPr({ payload: { profile: pr.account.profile, link: consoleUrl } })
  }, [consoleUrl, openPr, pr])

  const handleOpen = useCallback(() => {
    if (pr === null) return
    if (!granted.show()) {
      proceedOpen()
    }
  }, [granted, pr, proceedOpen])

  const handleGrantedContinue = () => {
    granted.dismiss()
    proceedOpen()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return
      if (e.key === "Escape") {
        e.preventDefault()
        navigate("/")
      } else if ((e.key === "Enter" || e.key === "o") && consoleUrl.length > 0) {
        handleOpen()
      } else if (e.key === "." && pr !== null) {
        e.preventDefault()
        handleSandbox()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [consoleUrl, handleOpen, handleSandbox, navigate, pr])

  if (routeAmbiguous) {
    return (
      <section className={styles.loadingState}>
        <StatePanel
          announce="assertive"
          description="Choose both repository and region to identify this pull request."
          title="Pull request coordinates are ambiguous"
          tone="critical"
        />
      </section>
    )
  }

  if (pr === null) {
    return (
      <section className={styles.loadingState}>
        <StatePanel
          announce="polite"
          description="Reading the current provider facts and approval state from CodeCommit."
          title="Loading pull request"
          tone="progress"
        />
      </section>
    )
  }

  const decision = pullRequestDecision(pr)
  const scope = extractScope(pr.title)
  const statusLabel = pr.status === "OPEN" ? "Open" : pr.status === "MERGED" ? "Merged" : "Closed"

  return (
    <article className={styles.page}>
      <nav aria-label="Pull request navigation" className={styles.backNavigation}>
        <RlyButton leadingIcon="arrow-left" onClick={() => navigate("/")} size="compact" variant="quiet">
          Back
        </RlyButton>
      </nav>

      <header className={styles.hero}>
        <div className={styles.eyebrow}>
          <ServiceMark service="codecommit" size="compact" />
          <Text tone="secondary" variant="label">
            Pull request {pr.id}
          </Text>
        </div>
        <Text as="h1" className={styles.title} variant="page-title">
          {pr.title}
        </Text>
        <div className={styles.heroMeta}>
          <Link className={styles.textLink} to={`/?f=author:${encodeURIComponent(pr.author)}`}>
            {pr.author}
          </Link>
          <span aria-hidden="true">·</span>
          <time dateTime={pr.creationDate.toISOString()}>{DateUtils.formatDate(pr.creationDate)}</time>
          {pr.fetchedAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>{DateUtils.formatRelativeTime(pr.fetchedAt, new Date(), "Fetched")}</span>
            </>
          )}
        </div>
      </header>

      <section aria-label="Pull request decision and actions" className={styles.decisionWorkspace}>
        <Verdict className={styles.verdict} reason={decision.reason} tone={decision.tone} verdict={decision.verdict} />
        <aside className={styles.actionRail}>
          <div className={styles.actionHeading}>
            <Text tone="secondary" variant="label">
              Actions
            </Text>
            <StateLabel label={statusLabel} size="compact" tone={pullRequestStatusTone(pr.status)} />
          </div>
          <div className={styles.actionGroup}>
            <Button
              className={styles.actionButton}
              disabled={isRefreshing}
              onClick={handleRefresh}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button className={styles.actionButton} onClick={handleSubscriptionToggle} size="sm" variant="outline">
              {isSubscribed ? <BellOffIcon className="size-3.5" /> : <BellIcon className="size-3.5" />}
              {isSubscribed ? "Unsubscribe" : "Subscribe"}
            </Button>
            <Button className={styles.actionButton} onClick={handleSandbox} size="sm" variant="outline">
              <CodeIcon className="size-3.5" />
              {existingSandbox !== undefined ? "Open Sandbox" : "Sandbox"}
            </Button>
            <RlyButton
              className={styles.actionButton}
              leadingIcon={copied ? "check" : "link"}
              onClick={handleCopy}
              size="compact"
              variant="secondary"
            >
              {copied ? "Copied" : "Copy Link"}
            </RlyButton>
            <RlyButton
              className={styles.actionButton}
              leadingIcon="external-link"
              onClick={handleOpen}
              size="compact"
              variant="primary"
            >
              Open in Console
            </RlyButton>
          </div>
          <Text tone="tertiary" variant="meta">
            Enter or O opens CodeCommit · . opens the sandbox · Esc returns to the list
          </Text>
        </aside>
      </section>

      <Surface as="section" className={styles.revisionCard} padding="spacious" form="grouped" tone="secondary">
        <header className={styles.revisionHeading}>
          <div>
            <Text tone="secondary" variant="label">
              Current revision
            </Text>
            <Text as="h2" variant="section-title">
              {pr.repositoryName}
            </Text>
          </div>
          <ScoreBadge score={score} />
        </header>

        <div aria-label={`${pr.sourceBranch} into ${pr.destinationBranch}`} className={styles.branchPair}>
          <div>
            <Text tone="secondary" variant="meta">
              Source
            </Text>
            <code>{pr.sourceBranch}</code>
          </div>
          <ArrowRightIcon aria-hidden="true" />
          <div>
            <Text tone="secondary" variant="meta">
              Destination
            </Text>
            <code>{pr.destinationBranch}</code>
          </div>
        </div>

        <dl className={styles.facts}>
          <dt>Account</dt>
          <dd>
            <Link className={styles.codeLink} to={`/?f=account:${encodeURIComponent(pr.account.profile)}`}>
              {pr.account.profile}
            </Link>
          </dd>

          <dt>Repository</dt>
          <dd>
            <Link className={styles.codeLink} to={`/?f=repo:${encodeURIComponent(pr.repositoryName)}`}>
              {pr.repositoryName}
            </Link>
          </dd>

          <dt>Author</dt>
          <dd>
            <Link className={styles.textLink} to={`/?f=author:${encodeURIComponent(pr.author)}`}>
              {pr.author}
            </Link>
          </dd>

          {scope && (
            <>
              <dt>Scope</dt>
              <dd>
                <Link className={styles.textLink} to={`/?f=scope:${encodeURIComponent(scope)}`}>
                  {scope}
                </Link>
              </dd>
            </>
          )}

          <dt>Status</dt>
          <dd className={styles.factStates}>
            {pr.status === "MERGED" ? (
              <Link className={styles.stateLink} to="/?f=status:merged">
                <StateLabel label="Merged" size="compact" tone="positive" />
              </Link>
            ) : pr.status === "CLOSED" ? (
              <Link className={styles.stateLink} to="/?f=status:closed">
                <StateLabel label="Closed" size="compact" tone="neutral" />
              </Link>
            ) : (
              <>
                <Link className={styles.stateLink} to={`/?f=status:${pr.isApproved ? "approved" : "pending"}`}>
                  <StateLabel
                    label={pr.isApproved ? "Approved" : "Pending approval"}
                    size="compact"
                    tone={pr.isApproved ? "positive" : "caution"}
                  />
                </Link>
                <Link className={styles.stateLink} to={`/?f=status:${pr.isMergeable ? "mergeable" : "conflicts"}`}>
                  <StateLabel
                    label={pr.isMergeable ? "Mergeable" : "Conflict"}
                    size="compact"
                    tone={pr.isMergeable ? "positive" : "critical"}
                  />
                </Link>
              </>
            )}
          </dd>

          <dt>Pull request ID</dt>
          <dd>
            <code>{pr.id}</code>
          </dd>

          <dt>Last activity</dt>
          <dd>
            <time dateTime={pr.lastModifiedDate.toISOString()}>{DateUtils.formatDate(pr.lastModifiedDate)}</time>
          </dd>

          <LifecycleInfo pr={pr} />
        </dl>
      </Surface>

      <Suspense
        fallback={
          <StatePanel
            announce="polite"
            description="Preparing the exact-revision review workbench."
            title="Loading diff tools"
            tone="progress"
          />
        }
      >
        <PullRequestReviewWorkspace
          accountId={reviewApiAccountId(pr)}
          commentsRefreshGeneration={commentsRefreshGeneration}
          commentNavigation={commentNavigation}
          onFindingPosted={refreshCommentsAfterPublication}
          onNavigateToComment={(target) => requestCommentNavigation("comment", target)}
          pullRequest={pr}
          refreshGeneration={reviewRefreshGeneration}
        />
      </Suspense>

      <div className={styles.reviewWorkspace}>
        <section aria-label="Pull request narrative and comments" className={styles.contentColumn}>
          {pr.description && (
            <Surface as="section" className={styles.contentSection} padding="spacious" form="grouped">
              <header className={styles.sectionHeading}>
                <Text as="h2" variant="section-title">
                  Description
                </Text>
                <Text tone="secondary" variant="meta">
                  What the author says this revision changes
                </Text>
              </header>
              <div className={`${styles.description ?? ""} prose prose-sm dark:prose-invert max-w-none`}>
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {pr.description}
                </Markdown>
              </div>
            </Surface>
          )}

          <CollapsibleSection
            {...(commentNavigation?.destination === "comment"
              ? { openRequestKey: `${commentNavigation.target.commentId}:${String(commentNavigation.requestId)}` }
              : {})}
            keepMounted
            title="Comments"
            {...(commentCount !== undefined ? { count: commentCount } : {})}
          >
            {(commentsVisible) => (
              <CommentsSection
                commentsRefreshGeneration={commentsRefreshGeneration}
                key={pr.id}
                navigation={commentNavigation}
                onCountChange={reconcileCommentCount}
                onNavigateToDiff={(target) => requestCommentNavigation("diff", target)}
                pr={pr}
                visible={commentsVisible}
              />
            )}
          </CollapsibleSection>
        </section>

        <aside className={styles.evidenceColumn}>
          <section className={styles.approvalSection}>
            <header className={styles.sectionHeading}>
              <Text as="h2" variant="section-title">
                Decision evidence
              </Text>
              <Text tone="secondary" variant="meta">
                Provider approval rules for this pull request
              </Text>
            </header>
            {[
              { title: "Required Approvers", ruleName: REQUIRED_RULE_NAME, required: true },
              { title: "Optional Approvers", ruleName: OPTIONAL_RULE_NAME, required: false }
            ].map((card) => (
              <ApproversCard
                approvalRules={pr.approvalRules}
                approvedBy={pr.approvedBy}
                currentUser={state.currentUser}
                key={card.ruleName}
                knownUserArns={knownUserArns}
                onRefresh={refreshAfterApprovalMutation}
                onSetApprovers={(arns) => {
                  const existing = pr.approvalRules.find(
                    (rule) => rule.ruleName === card.ruleName && rule.fromTemplate === undefined
                  )
                  if (existing !== undefined) {
                    updateRule({
                      payload: {
                        account: pr.account,
                        approvalRuleName: existing.ruleName,
                        poolMembers: arns.length > 0 ? arns : ["*"],
                        pullRequestId: pr.id,
                        requiredApprovals: card.required ? (arns.length > 0 ? arns.length : 0) : 0
                      }
                    })
                  } else if (arns.length > 0) {
                    createRule({
                      payload: {
                        account: pr.account,
                        approvalRuleName: card.ruleName,
                        poolMembers: arns,
                        pullRequestId: pr.id,
                        requiredApprovals: card.required ? arns.length : 0
                      }
                    })
                  }
                }}
                permissionPrompt={state.permissionPrompt !== undefined}
                repoAccountId={currentAcct}
                required={card.required}
                ruleName={card.ruleName}
                title={card.title}
              />
            ))}
          </section>

          <CollapsibleSection title="Health Score Breakdown">
            {() => <ScoreBreakdown score={score} />}
          </CollapsibleSection>
        </aside>
      </div>

      <Dialog open={granted.visible} onOpenChange={granted.cancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Granted CLI Required</DialogTitle>
            <DialogDescription>
              "Open in Console" uses{" "}
              <a
                href="https://docs.commonfate.io/granted/introduction"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Granted
              </a>{" "}
              to assume the AWS role for this account. Make sure the{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">assume</code> CLI is installed and
              configured before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
              <input
                type="checkbox"
                checked={granted.dontRemind}
                onChange={(e) => granted.setDontRemind(e.target.checked)}
                className="accent-primary"
              />
              Don't remind again
            </label>
            <Button variant="ghost" onClick={granted.cancel}>
              Cancel
            </Button>
            <Button onClick={handleGrantedContinue}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={docker.visible} onOpenChange={docker.cancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Docker Required</DialogTitle>
            <DialogDescription>
              Sandbox uses Docker to run a code-server container. Make sure Docker is started before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
              <input
                type="checkbox"
                checked={docker.dontRemind}
                onChange={(e) => docker.setDontRemind(e.target.checked)}
                className="accent-primary"
              />
              Don't show again
            </label>
            <Button onClick={handleDockerContinue}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}
