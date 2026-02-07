import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { InboxIcon } from "lucide-react"
import { useMemo } from "react"
import { appStateAtom } from "../atoms/app.js"
import { filterTextAtom, quickFilterAtom, selectedPrAtom, viewAtom } from "../atoms/ui.js"
import { extractScope } from "../utils/extractScope.js"
import { PRRow } from "./pr-row.js"
import { Badge } from "./ui/badge.js"

type PullRequest = Domain.PullRequest

export function PRList() {
  const state = useAtomValue(appStateAtom)
  const filterText = useAtomValue(filterTextAtom)
  const quickFilter = useAtomValue(quickFilterAtom)
  const setSelectedPr = useAtomSet(selectedPrAtom)
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

    const filterByQuick = (pr: PullRequest) => {
      if (quickFilter.type === "all") return true
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

    const result: Array<[string, Array<PullRequest>]> = []
    for (const [accountId, accountPrs] of byAccount) {
      const filtered = accountPrs.filter(filterPR)
      if (filtered.length > 0) {
        result.push([accountId, filtered])
      }
    }

    return result
  }, [prs, currentUser, filterText, quickFilter])

  const handlePRClick = (pr: PullRequest) => {
    setSelectedPr(pr)
    setView("details")
  }

  if (groups.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <InboxIcon className="mb-4 size-10 opacity-50" />
        <p className="text-sm">No pull requests found</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
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
