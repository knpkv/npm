import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { LoaderIcon, LogInIcon } from "lucide-react"
import { useEffect, useMemo } from "react"
import { appStateAtom, notificationsSsoLoginAtom } from "../atoms/app.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { extractScope } from "../utils/extractScope.js"
import { PRRow } from "./pr-row.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"

type PullRequest = Domain.PullRequest

export function PRList() {
  const state = useAtomValue(appStateAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const { filterText, quickFilter } = useFilterParams()
  const [animateRef, enableAnimate] = useAutoAnimate()

  const isLoading = state.status === "loading"
  const prs = state.pullRequests
  const currentUser = state.currentUser
  const isHot = quickFilter.type === "hot"

  useEffect(() => {
    enableAnimate(isHot)
  }, [isHot, enableAnimate])

  const { flat, grouped } = useMemo(() => {
    if (prs.length === 0) return { flat: [], grouped: [] }

    const filterLower = filterText.toLowerCase()
    const filterByText = (pr: PullRequest) => {
      if (!filterText) return true
      return (
        pr.repositoryName.toLowerCase().includes(filterLower) ||
        pr.title.toLowerCase().includes(filterLower) ||
        pr.author.toLowerCase().includes(filterLower) ||
        pr.sourceBranch.toLowerCase().includes(filterLower) ||
        (pr.description?.toLowerCase().includes(filterLower) ?? false)
      )
    }

    const filterByQuick = (pr: PullRequest) => {
      if (quickFilter.type === "all") return true
      if (quickFilter.type === "hot") return true
      if (quickFilter.type === "mine") {
        if (currentUser && pr.author !== currentUser) return false
        if (quickFilter.value === undefined) return true
        return extractScope(pr.title) === quickFilter.value
      }
      if (quickFilter.type === "account") return pr.account?.profile === quickFilter.value
      if (quickFilter.type === "author") return pr.author === quickFilter.value
      if (quickFilter.type === "scope") return extractScope(pr.title) === quickFilter.value
      if (quickFilter.type === "repo") return pr.repositoryName === quickFilter.value
      if (quickFilter.type === "status") {
        switch (quickFilter.value) {
          case "approved":
            return pr.isApproved
          case "pending":
            return !pr.isApproved
          case "mergeable":
            return pr.isMergeable
          case "conflicts":
            return !pr.isMergeable
          default:
            return true
        }
      }
      return true
    }

    const filtered = prs.filter((pr) => pr.status !== "MERGED" && filterByText(pr) && filterByQuick(pr))

    // Hot mode: flat list sorted by lastModifiedDate desc
    if (quickFilter.type === "hot") {
      const sorted = [...filtered].sort((a, b) => b.lastModifiedDate.getTime() - a.lastModifiedDate.getTime())
      return { flat: sorted, grouped: [] }
    }

    // Other modes: group by account
    const byAccount = new Map<string, Array<PullRequest>>()
    for (const pr of filtered) {
      const accountId = pr.account?.profile ?? "unknown"
      if (!byAccount.has(accountId)) {
        byAccount.set(accountId, [])
      }
      byAccount.get(accountId)!.push(pr)
    }

    const result: Array<[string, Array<PullRequest>]> = []
    for (const [accountId, accountPrs] of byAccount) {
      if (accountPrs.length > 0) {
        result.push([accountId, accountPrs])
      }
    }

    return { flat: [], grouped: result }
  }, [prs, currentUser, filterText, quickFilter])

  const prHref = (pr: PullRequest) => {
    const accountKey = pr.account.awsAccountId ?? pr.account.profile
    return `/accounts/${encodeURIComponent(accountKey)}/prs/${pr.id}`
  }

  const isEmpty = flat.length === 0 && grouped.length === 0
  if (isEmpty) {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
          <LoaderIcon className="size-8 animate-spin opacity-40" />
          <p className="text-sm font-medium">Loading pull requests...</p>
          {prs.length > 0 && <p className="text-xs opacity-50">{prs.length} PRs fetched (filter hides all)</p>}
        </div>
      )
    }

    const profiles = [...new Set(state.accounts.filter((a) => a.enabled).map((a) => a.profile))]
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
        <p className="text-sm">No pull requests found</p>
        {prs.length > 0 && <p className="text-xs opacity-50">{prs.length} PRs loaded — try a different filter</p>}
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

  if (isHot) {
    return (
      <div key="hot" ref={animateRef} className="divide-y rounded-lg border bg-card">
        {flat.map((pr) => (
          <PRRow key={pr.id} pr={pr} to={prHref(pr)} showUpdated />
        ))}
      </div>
    )
  }

  return (
    <div key="grouped" className="space-y-6">
      {grouped.map(([accountId, accountPrs]) => (
        <section key={accountId}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{accountId}</span>
            <Badge variant="secondary">{accountPrs.length}</Badge>
          </div>
          <div className="divide-y rounded-lg border bg-card">
            {accountPrs.map((pr) => (
              <PRRow key={pr.id} pr={pr} to={prHref(pr)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
