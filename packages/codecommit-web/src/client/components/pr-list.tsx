import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { calculateHealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { LoaderIcon } from "lucide-react"
import { useMemo } from "react"
import { appStateAtom } from "../atoms/app.js"
import { filterTextAtom, quickFilterAtom, selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { extractScope } from "../utils/extractScope.js"
import { PRRow } from "./pr-row.js"
import { Badge } from "./ui/badge.js"

type PullRequest = Domain.PullRequest

export function PRList() {
  const state = useAtomValue(appStateAtom)
  const filterText = useAtomValue(filterTextAtom)
  const quickFilter = useAtomValue(quickFilterAtom)
  const setSelectedPrId = useAtomSet(selectedPrIdAtom)
  const setView = useAtomSet(viewAtom)

  const isLoading = state.status === "loading"
  const prs = state.pullRequests
  const currentUser = state.currentUser

  const groups = useMemo(() => {
    if (prs.length === 0) return []

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

    const now = new Date()

    const filterByQuick = (pr: PullRequest) => {
      if (quickFilter.type === "all") return true
      if (quickFilter.type === "hot") {
        return Option.exists(calculateHealthScore(pr, now), (s) => s.total >= 7)
      }
      if (quickFilter.type === "mine") {
        if (currentUser && pr.author !== currentUser) return false
        return extractScope(pr.title) === quickFilter.value
      }
      if (quickFilter.type === "account") return pr.account?.id === quickFilter.value
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

    const filterPR = (pr: PullRequest) => filterByText(pr) && filterByQuick(pr)

    const byAccount = new Map<string, Array<PullRequest>>()
    for (const pr of prs) {
      const accountId = pr.account?.id ?? "unknown"
      if (!byAccount.has(accountId)) {
        byAccount.set(accountId, [])
      }
      byAccount.get(accountId)!.push(pr)
    }

    const sortPrs = (list: Array<PullRequest>): Array<PullRequest> => {
      if (quickFilter.type !== "hot") return list
      const scoreMap = new Map(
        list.map((pr) => [
          pr.id,
          Option.getOrElse(calculateHealthScore(pr, now).pipe(Option.map((s) => s.total)), () => -1)
        ])
      )
      return [...list].sort((a, b) => (scoreMap.get(b.id) ?? -1) - (scoreMap.get(a.id) ?? -1))
    }

    const result: Array<[string, Array<PullRequest>]> = []
    for (const [accountId, accountPrs] of byAccount) {
      const filtered = accountPrs.filter(filterPR)
      if (filtered.length > 0) {
        result.push([accountId, sortPrs(filtered)])
      }
    }

    return result
  }, [prs, currentUser, filterText, quickFilter])

  const handlePRClick = (pr: PullRequest) => {
    setSelectedPrId(pr.id)
    setView("details")
  }

  const enrichedCount = prs.filter((p) => p.commentCount !== undefined).length

  if (groups.length === 0) {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
          <LoaderIcon className="size-8 animate-spin opacity-40" />
          <p className="text-sm font-medium">Loading pull requests...</p>
          {state.statusDetail && <p className="font-mono text-xs opacity-60">{state.statusDetail}</p>}
          {prs.length > 0 && <p className="text-xs opacity-50">{prs.length} PRs fetched (filter hides all)</p>}
        </div>
      )
    }

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
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {(isLoading || (enrichedCount < prs.length && prs.length > 0)) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" />
          {isLoading ? (
            <span>
              Loading... {state.statusDetail && <span className="font-mono opacity-60">{state.statusDetail}</span>}
            </span>
          ) : (
            <span>
              Enriching details ({enrichedCount}/{prs.length})
            </span>
          )}
        </div>
      )}
      {groups.map(([accountId, accountPrs]) => (
        <section key={accountId}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{accountId}</span>
            <Badge variant="secondary">{accountPrs.length}</Badge>
          </div>
          <div className="divide-y rounded-lg border bg-card">
            {accountPrs.map((pr) => (
              <PRRow key={pr.id} pr={pr} onClick={() => handlePRClick(pr)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
