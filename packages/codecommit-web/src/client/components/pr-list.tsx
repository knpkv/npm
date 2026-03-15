/**
 * PR list — filtered, sorted by lastModifiedDate.
 *
 * Applies multi-axis filters (status axis-based grouping, date range,
 * text search, review filter via {@link needsMyReview}), then renders
 * a flat list sorted by lastModifiedDate desc. Shows SSO login prompt
 * when no PRs are available.
 *
 * @module
 */
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { needsMyReview } from "@knpkv/codecommit-core/Domain.js"
import { LoaderIcon, LogInIcon } from "lucide-react"
import { useMemo } from "react"
import { appStateAtom, notificationsSsoLoginAtom } from "../atoms/app.js"
import type { FilterEntry } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { extractScope } from "../utils/extractScope.js"
import { PRRow } from "./pr-row.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"

type PullRequest = Domain.PullRequest

const matchesFilter = (pr: PullRequest, entry: FilterEntry): boolean => {
  switch (entry.key) {
    case "account":
      return pr.account?.profile === entry.value
    case "author":
      return pr.author === entry.value
    case "scope":
      return extractScope(pr.title) === entry.value
    case "repo":
      return pr.repositoryName === entry.value
    case "approver":
      return pr.approvedBy.some((n) => n === entry.value)
    case "commenter":
      return pr.commentedBy.some((n) => n === entry.value)
    case "size": {
      const fc = pr.filesChanged
      if (fc == null) return false
      switch (entry.value) {
        case "small":
          return fc < 5
        case "medium":
          return fc >= 5 && fc <= 15
        case "large":
          return fc >= 16 && fc <= 30
        case "xlarge":
          return fc > 30
        default:
          return true
      }
    }
    case "status":
      switch (entry.value) {
        case "approved":
          return pr.status === "OPEN" && pr.isApproved
        case "pending":
          return pr.status === "OPEN" && !pr.isApproved
        case "mergeable":
          return pr.status === "OPEN" && pr.isMergeable
        case "conflicts":
          return pr.status === "OPEN" && !pr.isMergeable
        case "merged":
          return pr.status === "MERGED"
        case "closed":
          return pr.status === "CLOSED"
        case "open":
          return pr.status === "OPEN"
        default:
          return true
      }
    default:
      return true
  }
}

export function PRList() {
  const appState = useAtomValue(appStateAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const { state: filterState, toggleFilter } = useFilterParams()

  const isLoading = appState.status === "loading"
  const prs = appState.pullRequests

  const sorted = useMemo(() => {
    if (prs.length === 0) return []

    const { filters, from, q, review, to } = filterState

    // Text search
    const filterLower = q.toLowerCase()
    const filterByText = (pr: PullRequest) => {
      if (!q) return true
      return (
        pr.repositoryName.toLowerCase().includes(filterLower) ||
        pr.title.toLowerCase().includes(filterLower) ||
        pr.author.toLowerCase().includes(filterLower) ||
        pr.sourceBranch.toLowerCase().includes(filterLower) ||
        (pr.description?.toLowerCase().includes(filterLower) ?? false)
      )
    }

    // Group filters by key, then AND across keys, OR within same key.
    const STATUS_AXIS: Record<string, string> = {
      open: "lifecycle",
      merged: "lifecycle",
      closed: "lifecycle",
      approved: "approval",
      pending: "approval",
      mergeable: "merge",
      conflicts: "merge"
    }
    const byGroup = new Map<string, Array<FilterEntry>>()
    for (const f of filters) {
      const groupKey = f.key === "status" ? `status:${STATUS_AXIS[f.value] ?? f.value}` : f.key
      const arr = byGroup.get(groupKey)
      if (arr) arr.push(f)
      else byGroup.set(groupKey, [f])
    }

    // When open sub-statuses are active but no lifecycle filter, require OPEN
    const hasOpenSubStatus = filters.some(
      (f) => f.key === "status" && ["approved", "pending", "mergeable", "conflicts"].includes(f.value)
    )
    const hasLifecycle = filters.some((f) => f.key === "status" && ["open", "merged", "closed"].includes(f.value))
    const requireOpen = hasOpenSubStatus && !hasLifecycle

    const filterByEntries = (pr: PullRequest) => {
      if (requireOpen && pr.status !== "OPEN") return false
      return [...byGroup.values()].every((group) => group.some((f) => matchesFilter(pr, f)))
    }

    // Date filter
    const fromMs = from ? new Date(from).getTime() : undefined
    const toMs = to ? new Date(to).getTime() : undefined
    const statusFilter = filters.find((f) => f.key === "status")
    const filterByDate = (pr: PullRequest) => {
      if (!fromMs || !toMs) return true
      const ts =
        statusFilter?.value === "merged" || statusFilter?.value === "closed"
          ? pr.lastModifiedDate.getTime()
          : pr.creationDate.getTime()
      return ts >= fromMs && ts < toMs
    }

    const filterByReview = (pr: PullRequest) => !review || needsMyReview(pr, appState.currentUser)

    return prs
      .filter((pr) => filterByText(pr) && filterByEntries(pr) && filterByDate(pr) && filterByReview(pr))
      .sort((a, b) => b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime())
  }, [prs, filterState, appState.currentUser])

  const prHref = (pr: PullRequest) => {
    const accountKey = pr.account.awsAccountId ?? pr.account.profile
    return `/accounts/${encodeURIComponent(accountKey)}/prs/${pr.id}`
  }

  if (sorted.length === 0) {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
          <LoaderIcon className="size-8 animate-spin opacity-40" />
          <p className="text-sm font-medium">Loading pull requests...</p>
          {prs.length > 0 && <p className="text-xs opacity-50">{prs.length} PRs fetched (filter hides all)</p>}
        </div>
      )
    }

    const profiles = [...new Set(appState.accounts.filter((a) => a.enabled).map((a) => a.profile))]
    const needsLogin = prs.length === 0 && profiles.length > 0

    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
        <svg className="size-16 opacity-30" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" strokeWidth="2" />
          <path d="M8 24h48" stroke="currentColor" strokeWidth="2" />
          <circle cx="16" cy="18" r="2" fill="currentColor" />
          <circle cx="22" cy="18" r="2" fill="currentColor" />
          <circle cx="28" cy="18" r="2" fill="currentColor" />
          <path d="M24 36h16M28 42h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="text-sm">No open pull requests</p>
        {prs.length > 0 && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs opacity-50">{prs.length} PRs in cache (all merged or closed)</p>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" onClick={() => toggleFilter("status", "merged")}>
                Show merged
              </Button>
              <Button variant="outline" size="sm" onClick={() => toggleFilter("status", "closed")}>
                Show closed
              </Button>
            </div>
          </div>
        )}
        {needsLogin && (
          <Card className="mt-4 w-full max-w-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">SSO Login</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground mb-1">Session may have expired. Log in to fetch PRs.</p>
              {profiles.map((profile) => (
                <Button
                  key={profile}
                  variant="outline"
                  size="sm"
                  className="justify-start gap-2"
                  onClick={() => ssoLogin({ payload: { profile } })}
                >
                  <LogInIcon className="size-3.5" />
                  {profile}
                </Button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  const isGrouped = filterState.groupBy === "account"

  // Flat sorted list (default / Hot)
  if (!isGrouped) {
    return (
      <div className="flex flex-col gap-2">
        {sorted.map((pr) => (
          <div key={pr.id} className="rounded-lg border bg-card">
            <PRRow pr={pr} to={prHref(pr)} showUpdated currentUser={appState.currentUser} />
          </div>
        ))}
      </div>
    )
  }

  // Grouped by account
  const byAccount = new Map<string, Array<PullRequest>>()
  for (const pr of sorted) {
    const accountId = pr.account?.profile ?? "unknown"
    if (!byAccount.has(accountId)) byAccount.set(accountId, [])
    byAccount.get(accountId)!.push(pr)
  }

  return (
    <div className="space-y-8">
      {[...byAccount.entries()].map(([accountId, accountPrs]) => (
        <section key={accountId}>
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{accountId}</span>
            <Badge variant="secondary">{accountPrs.length}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            {accountPrs.map((pr) => (
              <div key={pr.id} className="rounded-lg border bg-card">
                <PRRow pr={pr} to={prHref(pr)} currentUser={appState.currentUser} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
