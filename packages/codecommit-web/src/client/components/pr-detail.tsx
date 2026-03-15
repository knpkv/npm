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
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import type { CommentThreadJsonEncoded } from "@knpkv/codecommit-core/Domain.js"
import { PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import {
  calculateHealthScore,
  type CategoryStatus,
  getScoreTier,
  type HealthScore,
  type HealthScoreCategory
} from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import { Link, useNavigate, useParams } from "react-router"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
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
import { StorageKeys } from "../storage-keys.js"
import { extractScope } from "../utils/extractScope.js"
import { Badge } from "./ui/badge.js"
import { Button, ButtonGroup } from "./ui/button.js"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js"
import { Separator } from "./ui/separator.js"

const tierColor = (tier: "green" | "yellow" | "red") =>
  tier === "green"
    ? "text-green-600 dark:text-green-400"
    : tier === "yellow"
      ? "text-yellow-600 dark:text-yellow-400"
      : "text-red-600 dark:text-red-400"

const tierBorder = (tier: "green" | "yellow" | "red") =>
  tier === "green" ? "border-green-500/30" : tier === "yellow" ? "border-yellow-500/30" : "border-red-500/30"

const categoryBadgeVariant = (status: CategoryStatus) =>
  status === "positive" ? "outline" : status === "neutral" ? "secondary" : "destructive"

const categoryBadgeClass = (status: CategoryStatus) =>
  status === "positive" ? "border-green-500/30 text-green-600 dark:text-green-400" : ""

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

const countThread = (t: CommentThreadJsonEncoded): number => 1 + t.replies.reduce((sum, r) => sum + countThread(r), 0)

function ScoreBadge({ score }: { readonly score: HealthScore | undefined }) {
  if (!score) return null
  const tier = getScoreTier(score.total)

  return (
    <Badge variant="outline" className={`${tierBorder(tier)} ${tierColor(tier)} tabular-nums font-semibold`}>
      {score.total.toFixed(1)}
    </Badge>
  )
}

function ScoreBreakdown({ score }: { readonly score: HealthScore | undefined }) {
  if (!score) return <p className="text-xs text-muted-foreground pt-2">Waiting for comment count...</p>
  const tier = getScoreTier(score.total)

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-baseline gap-2">
        <span className={`text-lg font-bold tabular-nums ${tierColor(tier)}`}>{score.total.toFixed(1)}</span>
        <span className="text-xs text-muted-foreground">/ 10</span>
        <div className="ml-2 h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${
              tier === "green" ? "bg-green-500" : tier === "yellow" ? "bg-yellow-500" : "bg-red-500"
            }`}
            style={{ width: `${score.total * 10}%` }}
          />
        </div>
      </div>
      <div className="space-y-2">
        {score.categories.map((cat: HealthScoreCategory) => (
          <div key={cat.label} className="flex items-start gap-3 rounded border px-3 py-2">
            <span
              className={`w-8 text-right text-xs font-semibold tabular-nums ${
                cat.value > 0
                  ? "text-green-600 dark:text-green-400"
                  : cat.value < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground"
              }`}
            >
              {cat.value > 0 ? `+${cat.value}` : cat.value}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{cat.label}</span>
                <Badge
                  variant={categoryBadgeVariant(cat.status) as "outline" | "secondary" | "destructive"}
                  className={`text-[10px] px-1.5 py-0 ${categoryBadgeClass(cat.status)}`}
                >
                  {cat.statusLabel}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{cat.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CommentThread({ depth, thread }: { readonly thread: CommentThreadJsonEncoded; readonly depth: number }) {
  if (thread.root.deleted) return null

  return (
    <div className={depth > 0 ? "ml-4 border-l-2 border-muted pl-3" : ""}>
      <div className="space-y-1 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium">{thread.root.author}</span>
          <span>·</span>
          <span>{formatRelativeDate(thread.root.creationDate)}</span>
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_a]:text-primary [&_img]:inline [&_img]:h-5 [&_img]:w-auto">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {thread.root.content}
          </Markdown>
        </div>
      </div>
      {thread.replies.map((reply) => (
        <CommentThread key={reply.root.id} thread={reply} depth={depth + 1} />
      ))}
    </div>
  )
}

function CommentsSection({ pr }: { readonly pr: Domain.PullRequest }) {
  const commentsResult = useComments({
    pullRequestId: pr.id,
    repositoryName: pr.repositoryName,
    profile: pr.account.profile,
    region: pr.account.region
  })

  return Result.builder(commentsResult)
    .onInitialOrWaiting(() => (
      <div className="pt-2">
        <p className="text-xs text-muted-foreground">Loading comments...</p>
      </div>
    ))
    .onError(() => (
      <div className="pt-2">
        <p className="text-xs text-destructive">Failed to load comments</p>
      </div>
    ))
    .onDefect(() => (
      <div className="pt-2">
        <p className="text-xs text-destructive">Failed to load comments</p>
      </div>
    ))
    .onSuccess((comments) => {
      const totalCount = comments.reduce((sum, loc) => sum + loc.comments.reduce((s, t) => s + countThread(t), 0), 0)

      return (
        <div className="pt-2">
          {comments.length === 0 && <p className="text-xs text-muted-foreground">No comments</p>}
          {totalCount > 0 && (
            <div className="space-y-1">
              {[...comments]
                .sort((a, b) => earliestDate(b) - earliestDate(a))
                .map((loc, i) => (
                  <div key={loc.filePath ?? `loc-${i}`}>
                    {loc.filePath && <p className="font-mono text-xs text-muted-foreground">{loc.filePath}</p>}
                    {loc.comments.map((thread) => (
                      <CommentThread key={thread.root.id} thread={thread} depth={0} />
                    ))}
                    {i < comments.length - 1 && <Separator className="my-2" />}
                  </div>
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
    if (!Result.isSuccess(commentsResult)) return { timeToFirstReview: null, timeToAddressFeedback: null }
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
    const commentMs = firstComment ? firstComment.date.getTime() - pr.creationDate.getTime() : null
    // Approval as review fallback: use lastModifiedDate as proxy for approval time
    const hasNonAuthorApproval = pr.isApproved && pr.approvedBy.some((a) => a !== pr.author)
    const approvalMs = hasNonAuthorApproval ? pr.lastModifiedDate.getTime() - pr.creationDate.getTime() : null
    const ttfr = commentMs != null && approvalMs != null ? Math.min(commentMs, approvalMs) : (commentMs ?? approvalMs)

    const feedbackDeltas: Array<number> = []
    for (let i = 0; i < allComments.length; i++) {
      if (allComments[i]!.author !== pr.author) {
        const reply = allComments.slice(i + 1).find((c) => c.author === pr.author)
        if (reply) feedbackDeltas.push(reply.date.getTime() - allComments[i]!.date.getTime())
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
          <span className="text-muted-foreground">Time to Merge</span>
          <span className="text-xs font-medium tabular-nums">{DateUtils.formatDuration(timeToMerge)}</span>
        </>
      )}
      {timeToFirstReview != null && (
        <>
          <span className="text-muted-foreground">Time to First Review</span>
          <span className="text-xs font-medium tabular-nums">{DateUtils.formatDuration(timeToFirstReview)}</span>
        </>
      )}
      {timeToAddressFeedback != null && (
        <>
          <span className="text-muted-foreground">Time to Address Feedback</span>
          <span className="text-xs font-medium tabular-nums">{DateUtils.formatDuration(timeToAddressFeedback)}</span>
        </>
      )}
    </>
  )
}

function CollapsibleSection({
  children,
  count,
  title
}: {
  readonly title: string
  readonly count?: number
  readonly children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border bg-card">
      <button
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-accent/50"
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon className={`size-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        {title}
        {count !== undefined && <span className="text-xs text-muted-foreground">({count})</span>}
      </button>
      {open && <div className="border-t px-4 pb-3">{children}</div>}
    </div>
  )
}

const REQUIRED_RULE_NAME = "Required approvers"
const OPTIONAL_RULE_NAME = "Optional approvers"

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
      if (rule.fromTemplate || rule.ruleName === ruleName) {
        for (const m of rule.poolMembers) set.add(m)
      }
    }
    return [...set]
  }, [approvalRules, ruleName])

  // Find the managed rule by name (non-template rule we can edit)
  const managedRule = approvalRules.find((r) => r.ruleName === ruleName && !r.fromTemplate)
  const managedArns = managedRule?.poolMemberArns ?? []
  const managedMembers = managedRule?.poolMembers ?? []

  // Users available to add (have known ARN + not already in pool)
  const addable = useMemo(
    () => [...knownUserArns.entries()].filter(([name]) => !allPoolMembers.includes(name) && name !== pendingAdd),
    [knownUserArns, allPoolMembers, pendingAdd]
  )

  const prefix = repoAccountId ? `CodeCommitApprovers:${repoAccountId}:` : ""

  const handleAdd = (input: string) => {
    // If user typed just a username, prepend the CodeCommitApprovers prefix
    const value = input.startsWith("CodeCommitApprovers:") ? input : `${prefix}${input}`
    const nameMatch = /^CodeCommitApprovers:[^:]*:(.+)$/.exec(value)
    optimistic.add(nameMatch ? nameMatch[1]! : input)
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {required &&
            approvalRules.length > 0 &&
            (isSatisfied ? (
              <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
                Satisfied
              </Badge>
            ) : (
              <Badge variant="secondary">Pending</Badge>
            ))}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowPicker(!showPicker)}>
          <PlusIcon className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {showPicker && (
          <div className="flex flex-col gap-2 rounded-md border p-2 bg-muted/30">
            {addable.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {addable.map(([name, arn]) => (
                  <Button
                    key={name}
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs gap-1"
                    onClick={() => setManualArn(name)}
                  >
                    {name}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <input
                placeholder={prefix ? `${prefix}USERNAME` : "username"}
                className="flex-1 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                value={manualArn}
                onChange={(e) => setManualArn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && manualArn.trim()) {
                    handleAdd(manualArn.trim())
                    setManualArn("")
                  }
                }}
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!manualArn.trim() || !prefix}
                onClick={() => {
                  handleAdd(manualArn.trim())
                  setManualArn("")
                }}
              >
                Add
              </Button>
            </div>
          </div>
        )}
        {!showPicker && addable.length > 0 && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Suggested</span>
            {addable.slice(0, 5).map(([name, arn]) => (
              <button
                key={name}
                className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/60 hover:border-primary/50 hover:text-foreground transition-colors"
                onClick={() => handleAdd(arn)}
              >
                <PlusIcon className="size-2.5" />
                {name}
              </button>
            ))}
          </div>
        )}
        {(allPoolMembers.length > 0 || pendingAdd) && (
          <div className="flex flex-wrap gap-1">
            {allPoolMembers.map((member) => {
              const hasApproved = approvedBy.includes(member)
              const isManaged = managedMembers.includes(member)
              const isRemoving = member === pendingRemove
              return (
                <Badge
                  key={member}
                  variant={member === currentUser ? "default" : hasApproved ? "outline" : "secondary"}
                  className={`text-xs gap-1 ${
                    hasApproved ? "border-green-500/30 text-green-600 dark:text-green-400" : ""
                  } ${isRemoving ? "opacity-50" : ""}`}
                >
                  {isRemoving && <LoaderIcon className="size-3 animate-spin" />}
                  {!isRemoving && hasApproved && <CheckIcon className="size-3" />}
                  {member}
                  {isManaged && !isRemoving && (
                    <button className="ml-0.5 hover:text-destructive" onClick={() => handleRemove(member)}>
                      <TrashIcon className="size-3" />
                    </button>
                  )}
                </Badge>
              )
            })}
            {pendingAdd && !allPoolMembers.includes(pendingAdd) && (
              <Badge variant="secondary" className="text-xs gap-1 opacity-70">
                <LoaderIcon className="size-3 animate-spin" />
                {pendingAdd}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function PRDetail() {
  const { accountId, prId } = useParams<{ accountId: string; prId: string }>()
  const state = useAtomValue(appStateAtom)
  const refreshSingle = useAtomSet(refreshSinglePrAtom)
  const createRule = useAtomSet(createApprovalRuleAtom)
  const updateRule = useAtomSet(updateApprovalRuleAtom)
  const fetchedRef = useRef<string | null>(null)
  const pr = useMemo(
    () =>
      prId
        ? (state.pullRequests.find(
            (p) => p.id === prId && (p.account.awsAccountId === accountId || p.account.profile === accountId)
          ) ?? null)
        : null,
    [accountId, prId, state.pullRequests]
  )

  // Collect ALL known users from all PRs (authors, approvers, commenters, pool members)
  // Build CodeCommitApprovers:REPO_ACCT:username directly — no ARN needed
  const currentAcct = pr?.account?.repoAccountId || ""
  const knownUserArns = useMemo(() => {
    const map = new Map<string, string>()
    // All users stamped with currentAcct — approval pools reference the PR's repo account.
    // If same username exists across accounts, first-seen wins (acceptable for single-org use).
    const addUser = (name: string) => {
      if (!name || name === "*") return
      if (!map.has(name)) {
        map.set(name, currentAcct ? `CodeCommitApprovers:${currentAcct}:${name}` : name)
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
    if (pr || !accountId || !prId) return
    const key = `${accountId}:${prId}`
    if (fetchedRef.current === key) return
    fetchedRef.current = key
    refreshSingle({ path: { awsAccountId: accountId, prId: PullRequestId.make(prId) } })
  }, [pr, accountId, prId, refreshSingle])

  const score: HealthScore | undefined = useMemo(
    () => (pr ? Option.getOrUndefined(calculateHealthScore(pr, new Date())) : undefined),
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
  const serverSubscribed = useMemo(
    () =>
      Result.isSuccess(subscriptionsResult) && accountKey
        ? subscriptionsResult.value.some((s) => s.awsAccountId === accountKey && s.pullRequestId === prId)
        : false,
    [subscriptionsResult, accountKey, prId]
  )
  const [isSubscribed, setOptimistic] = useOptimistic(serverSubscribed)
  const handleSubscriptionToggle = useCallback(() => {
    if (!accountKey || !pr) return
    const payload = { awsAccountId: accountKey, pullRequestId: pr.id }
    setOptimistic(!isSubscribed)
    if (isSubscribed) {
      unsubscribe({ payload })
    } else {
      subscribe({ payload })
    }
  }, [accountKey, isSubscribed, pr, subscribe, unsubscribe])

  // Refresh single PR
  const [isRefreshing, setIsRefreshing] = useState(false)
  const refreshFetchedAtRef = useRef(pr?.fetchedAt)
  useEffect(() => {
    if (isRefreshing && pr?.fetchedAt && pr.fetchedAt !== refreshFetchedAtRef.current) {
      setIsRefreshing(false)
    }
    refreshFetchedAtRef.current = pr?.fetchedAt
  }, [isRefreshing, pr?.fetchedAt])
  const handleRefresh = useCallback(() => {
    if (!accountKey || !prId || isRefreshing) return
    setIsRefreshing(true)
    refreshSingle({ path: { awsAccountId: accountKey, prId: PullRequestId.make(prId) } })
  }, [accountKey, isRefreshing, prId, refreshSingle])

  // Copy console URL
  const consoleUrl = pr
    ? pr.link ||
      `https://${pr.account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${pr.repositoryName}/pull-requests/${pr.id}?region=${pr.account.region}`
    : ""
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    if (!consoleUrl) return
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
      state.sandboxes?.find(
        (s) =>
          s.pullRequestId === prId && s.awsAccountId === accountId && s.status !== "stopped" && s.status !== "error"
      ),
    [state.sandboxes, prId, accountId]
  )

  const [sandboxCreating, setSandboxCreating] = useState(false)

  useEffect(() => {
    if (sandboxCreating && existingSandbox) {
      setSandboxCreating(false)
      navigate(`/sandbox/${existingSandbox.id}`)
    }
  }, [sandboxCreating, existingSandbox, navigate])

  const proceedSandbox = useCallback(() => {
    if (!pr) return
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
    if (!pr) return
    if (existingSandbox) {
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
    if (!pr || !consoleUrl) return
    openPr({ payload: { profile: pr.account.profile, link: consoleUrl } })
  }, [consoleUrl, openPr, pr])

  const handleOpen = useCallback(() => {
    if (!pr) return
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === "Escape") {
        e.preventDefault()
        navigate("/")
      } else if ((e.key === "Enter" || e.key === "o") && pr?.link) {
        handleOpen()
      } else if (e.key === "." && pr) {
        e.preventDefault()
        handleSandbox()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleOpen, handleSandbox, navigate, pr])

  if (!pr) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
        <LoaderIcon className="size-6 animate-spin opacity-40" />
        <p className="text-sm">Loading pull request...</p>
      </div>
    )
  }

  const isOpen = pr.status === "OPEN"

  const mergeBadge = isOpen ? (
    !pr.isMergeable ? (
      <Badge variant="destructive">Conflict</Badge>
    ) : (
      <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
        Mergeable
      </Badge>
    )
  ) : null

  const approvalBadge = isOpen ? (
    pr.isApproved ? (
      <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
        Approved
      </Badge>
    ) : (
      <Badge variant="secondary">Pending</Badge>
    )
  ) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <ButtonGroup className="ml-auto">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCwIcon className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleSubscriptionToggle}>
            {isSubscribed ? <BellOffIcon className="size-3.5" /> : <BellIcon className="size-3.5" />}
            {isSubscribed ? "Unsubscribe" : "Subscribe"}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleSandbox}>
            <CodeIcon className="size-3.5" />
            {existingSandbox ? "Open Sandbox" : "Sandbox"}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCopy}>
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? "Copied" : "Copy Link"}
          </Button>
          <Button variant="default" size="sm" className="h-7 text-xs" onClick={handleOpen}>
            <ExternalLinkIcon className="size-3.5" />
            Open in Console
          </Button>
        </ButtonGroup>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{pr.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mergeBadge}
          {approvalBadge}
          <Badge variant="outline">{pr.status}</Badge>
          <ScoreBadge score={score} />
          <Link
            to={`/?f=author:${encodeURIComponent(pr.author)}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            {pr.author}
          </Link>
          <span className="text-sm text-muted-foreground">·</span>
          <span className="text-sm text-muted-foreground">{DateUtils.formatDate(pr.creationDate)}</span>
          {pr.fetchedAt && (
            <>
              <span className="text-sm text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">
                {DateUtils.formatRelativeTime(pr.fetchedAt, new Date(), "Fetched")}
              </span>
            </>
          )}
        </div>
      </div>

      <Separator />

      <Card>
        <CardContent className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-4 text-sm">
          <span className="text-muted-foreground">Account</span>
          <Link
            to={`/?f=account:${encodeURIComponent(pr.account.profile)}`}
            className="font-mono text-xs hover:underline"
          >
            {pr.account.profile}
          </Link>

          <span className="text-muted-foreground">Repository</span>
          <Link to={`/?f=repo:${encodeURIComponent(pr.repositoryName)}`} className="font-mono text-xs hover:underline">
            {pr.repositoryName}
          </Link>

          <span className="text-muted-foreground">Branch</span>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {pr.sourceBranch}
            </Badge>
            <ArrowRightIcon className="size-3 text-muted-foreground" />
            <Badge variant="outline" className="font-mono text-xs">
              {pr.destinationBranch}
            </Badge>
          </div>

          <span className="text-muted-foreground">Author</span>
          <Link to={`/?f=author:${encodeURIComponent(pr.author)}`} className="text-xs hover:underline">
            {pr.author}
          </Link>

          {extractScope(pr.title) && (
            <>
              <span className="text-muted-foreground">Scope</span>
              <Link to={`/?f=scope:${encodeURIComponent(extractScope(pr.title)!)}`} className="text-xs hover:underline">
                {extractScope(pr.title)}
              </Link>
            </>
          )}

          <span className="text-muted-foreground">Status</span>
          <div className="flex items-center gap-2">
            {pr.status === "MERGED" ? (
              <Link to="/?f=status:merged" className="hover:underline">
                <Badge variant="outline" className="border-purple-500/30 text-purple-600 dark:text-purple-400">
                  Merged
                </Badge>
              </Link>
            ) : pr.status === "CLOSED" ? (
              <Link to="/?f=status:closed" className="hover:underline">
                <Badge variant="outline" className="border-red-500/30 text-red-600 dark:text-red-400">
                  Closed
                </Badge>
              </Link>
            ) : (
              <>
                <Link to={`/?f=status:${pr.isApproved ? "approved" : "pending"}`} className="hover:underline">
                  {pr.isApproved ? (
                    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
                      Approved
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Pending</Badge>
                  )}
                </Link>
                <Link to={`/?f=status:${pr.isMergeable ? "mergeable" : "conflicts"}`} className="hover:underline">
                  {pr.isMergeable ? (
                    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
                      Mergeable
                    </Badge>
                  ) : (
                    <Badge variant="destructive">Conflict</Badge>
                  )}
                </Link>
              </>
            )}
          </div>

          <span className="text-muted-foreground">ID</span>
          <span className="font-mono text-xs">{pr.id}</span>

          <LifecycleInfo pr={pr} />
        </CardContent>
      </Card>

      {[
        { title: "Required Approvers", ruleName: REQUIRED_RULE_NAME, required: true },
        { title: "Optional Approvers", ruleName: OPTIONAL_RULE_NAME, required: false }
      ].map((card) => (
        <ApproversCard
          key={card.ruleName}
          title={card.title}
          ruleName={card.ruleName}
          required={card.required}
          approvalRules={pr.approvalRules}
          approvedBy={pr.approvedBy}
          knownUserArns={knownUserArns}
          repoAccountId={currentAcct}
          currentUser={state.currentUser}
          permissionPrompt={!!state.permissionPrompt}
          onSetApprovers={(arns) => {
            const existing = pr.approvalRules.find((r) => r.ruleName === card.ruleName && !r.fromTemplate)
            if (existing) {
              updateRule({
                payload: {
                  pullRequestId: pr.id,
                  approvalRuleName: existing.ruleName,
                  requiredApprovals: card.required ? (arns.length > 0 ? arns.length : 0) : 0,
                  poolMembers: arns.length > 0 ? arns : ["*"],
                  account: pr.account
                }
              })
            } else if (arns.length > 0) {
              createRule({
                payload: {
                  pullRequestId: pr.id,
                  approvalRuleName: card.ruleName,
                  requiredApprovals: card.required ? arns.length : 0,
                  poolMembers: arns,
                  account: pr.account
                }
              })
            }
          }}
          onRefresh={() => refreshSingle({ path: { awsAccountId: accountId!, prId: PullRequestId.make(pr.id) } })}
        />
      ))}

      <CollapsibleSection title="Health Score Breakdown">
        <ScoreBreakdown score={score} />
      </CollapsibleSection>

      {pr.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {pr.description}
              </Markdown>
            </div>
          </CardContent>
        </Card>
      )}

      <CollapsibleSection title="Comments" {...(pr.commentCount !== undefined ? { count: pr.commentCount } : {})}>
        <CommentsSection key={pr.id} pr={pr} />
      </CollapsibleSection>

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
    </div>
  )
}
