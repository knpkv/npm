import { Result, useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import { Chunk } from "effect"
import { useMemo } from "react"
import type { PullRequest } from "@knpkv/codecommit-core"
import { prsQueryAtom, configQueryAtom } from "../../atoms/app.js"
import { filterTextAtom, selectedPrAtom, viewAtom, quickFilterAtom } from "../../atoms/ui.js"
import { useTheme } from "../../theme/index.js"
import { extractScope } from "../../utils/extractScope.js"
import { ListItemRow, type ListItem } from "../ListItemRow/index.js"
import styles from "./MainList.module.css"

export function MainList() {
  const { theme } = useTheme()
  const prsResult = useAtomValue(prsQueryAtom)
  const configResult = useAtomValue(configQueryAtom)
  const filterText = useAtomValue(filterTextAtom)
  const quickFilter = useAtomValue(quickFilterAtom)
  const setSelectedPr = useAtomSet(selectedPrAtom)
  const setView = useAtomSet(viewAtom)

  const isLoading = Result.isInitial(prsResult) || Result.isWaiting(prsResult)
  const prs = Result.getOrElse(prsResult, () => Chunk.empty())
  const config = Result.getOrElse(configResult, () => ({ accounts: [] }))

  // Build list items grouped by account
  const items = useMemo(() => {
    const prArray = Chunk.toArray(prs)
    const accounts = config.accounts ?? []
    const enabledAccounts = accounts.filter((a: { enabled: boolean }) => a.enabled)

    if (enabledAccounts.length === 0 && prArray.length === 0) {
      return []
    }

    const result: ListItem[] = []

    // Group PRs by account
    const prsByAccount = new Map<string, PullRequest[]>()
    for (const pr of prArray) {
      const accountId = pr.account?.id ?? "unknown"
      if (!prsByAccount.has(accountId)) {
        prsByAccount.set(accountId, [])
      }
      prsByAccount.get(accountId)!.push(pr)
    }

    // Filter by text
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

    // Filter by quick filter
    const filterByQuick = (pr: PullRequest) => {
      if (quickFilter.type === "all") return true
      if (quickFilter.type === "mine") {
        // TODO: Need current user info
        return true
      }
      if (quickFilter.type === "account") {
        return pr.account?.id === quickFilter.value
      }
      if (quickFilter.type === "author") {
        return pr.author === quickFilter.value
      }
      if (quickFilter.type === "scope") {
        return extractScope(pr.title) === quickFilter.value
      }
      if (quickFilter.type === "repo") {
        return pr.repositoryName === quickFilter.value
      }
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

    // Combined filter
    const filterPR = (pr: PullRequest) => filterByText(pr) && filterByQuick(pr)

    // Build items for each account
    for (const [accountId, accountPrs] of prsByAccount) {
      const filtered = accountPrs.filter(filterPR)
      result.push({ type: "header", label: accountId, count: filtered.length })
      if (filtered.length === 0) {
        result.push({ type: "empty" })
      } else {
        for (const pr of filtered) {
          result.push({ type: "pr", pr })
        }
      }
    }

    return result
  }, [prs, config, filterText, quickFilter])

  const handlePRClick = (pr: PullRequest) => {
    setSelectedPr(pr)
    setView("details")
  }

  if (items.length === 0 && !isLoading) {
    return (
      <div className={styles.container} style={{ backgroundColor: theme.backgroundPanel }}>
        <div className={styles.empty} style={{ color: theme.textMuted }}>
          <p>No pull requests found</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container} style={{ backgroundColor: theme.backgroundPanel }}>
      <div className={styles.list}>
        {items.map((item, i) => (
          <ListItemRow
            key={i}
            item={item}
            selected={false}
            onClick={item.type === "pr" ? () => handlePRClick(item.pr) : undefined}
          />
        ))}
      </div>
    </div>
  )
}
