import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import type { CommentThreadJsonEncoded } from "@knpkv/codecommit-core/Domain.js"
import {
  calculateHealthScore,
  getScoreTier,
  type CategoryStatus,
  type HealthScore,
  type HealthScoreCategory
} from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ExternalLinkIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { appStateAtom, commentsAtom, openPrAtom } from "../atoms/app.js"
import { selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { useDismissable } from "../hooks/useDismissable.js"
import { StorageKeys } from "../storage-keys.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
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
            className={`h-full rounded-full ${tier === "green" ? "bg-green-500" : tier === "yellow" ? "bg-yellow-500" : "bg-red-500"}`}
            style={{ width: `${score.total * 10}%` }}
          />
        </div>
      </div>
      <div className="space-y-2">
        {score.categories.map((cat: HealthScoreCategory) => (
          <div key={cat.label} className="flex items-start gap-3 rounded border px-3 py-2">
            <span
              className={`w-8 text-right text-xs font-semibold tabular-nums ${cat.value > 0 ? "text-green-600 dark:text-green-400" : cat.value < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
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

function CommentThread({ thread, depth }: { readonly thread: CommentThreadJsonEncoded; readonly depth: number }) {
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
          <Markdown remarkPlugins={[remarkGfm]}>{thread.root.content}</Markdown>
        </div>
      </div>
      {thread.replies.map((reply) => (
        <CommentThread key={reply.root.id} thread={reply} depth={depth + 1} />
      ))}
    </div>
  )
}

function CommentsSection({ pr }: { readonly pr: Domain.PullRequest }) {
  const fetchComments = useAtomSet(commentsAtom)
  const commentsResult = useAtomValue(commentsAtom)
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    if (fetchedRef.current === pr.id) return
    fetchedRef.current = pr.id
    fetchComments({
      payload: {
        pullRequestId: pr.id,
        repositoryName: pr.repositoryName,
        account: { id: pr.account.id, region: pr.account.region }
      }
    })
  }, [pr.id, pr.repositoryName, pr.account.id, pr.account.region, fetchComments])

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
                  <div key={i}>
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

function CollapsibleSection({
  title,
  count,
  children
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

export function PRDetail() {
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const state = useAtomValue(appStateAtom)
  const pr = useMemo(
    () => (selectedPrId ? (state.pullRequests.find((p) => p.id === selectedPrId) ?? null) : null),
    [selectedPrId, state.pullRequests]
  )
  const score: HealthScore | undefined = useMemo(
    () => (pr ? Option.getOrUndefined(calculateHealthScore(pr, new Date())) : undefined),
    [pr]
  )
  const setView = useAtomSet(viewAtom)
  const openPr = useAtomSet(openPrAtom)
  const granted = useDismissable(StorageKeys.grantedDismissed)

  const proceedOpen = useCallback(() => {
    if (!pr) return
    openPr({ payload: { profile: pr.account.id, link: pr.link } })
  }, [openPr, pr])

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
      if (e.key === "Escape") {
        e.preventDefault()
        setView("prs")
      } else if ((e.key === "Enter" || e.key === "o") && pr?.link) {
        handleOpen()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleOpen, pr, setView])

  if (!pr) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <p className="text-sm">No PR selected</p>
      </div>
    )
  }

  const mergeBadge = !pr.isMergeable ? (
    <Badge variant="destructive">Conflict</Badge>
  ) : (
    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
      Mergeable
    </Badge>
  )

  const approvalBadge = pr.isApproved ? (
    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
      Approved
    </Badge>
  ) : (
    <Badge variant="secondary">Pending</Badge>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setView("prs")}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="ml-auto">
          <Button size="sm" onClick={handleOpen}>
            <ExternalLinkIcon className="size-4" />
            Open in Console
          </Button>
        </div>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">{pr.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mergeBadge}
          {approvalBadge}
          <Badge variant="outline">{pr.status}</Badge>
          <ScoreBadge score={score} />
          <span className="text-sm text-muted-foreground">
            {pr.author} · {DateUtils.formatDate(pr.creationDate)}
          </span>
        </div>
      </div>

      <Separator />

      <Card>
        <CardContent className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-4 text-sm">
          <span className="text-muted-foreground">Repository</span>
          <span className="font-mono text-xs">{pr.repositoryName}</span>

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

          <span className="text-muted-foreground">ID</span>
          <span className="font-mono text-xs">{pr.id}</span>
        </CardContent>
      </Card>

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
              <Markdown remarkPlugins={[remarkGfm]}>{pr.description}</Markdown>
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
    </div>
  )
}
