import type { NotificationItem } from "@knpkv/codecommit-core"
import type { PullRequest } from "@knpkv/codecommit-core"
import type { AppState } from "@knpkv/codecommit-core"
import type { QuickFilterType } from "./atoms/ui.js"

export type TuiView = "prs" | "settings" | "notifications" | "details"

/**
 * Extract scope from title. Supports:
 * - Conventional commit: feat(scope): message -> scope
 * - Jira-style ticket: RPS-123: message -> RPS-123
 */
export const extractScope = (title: string): string | null => {
  // Conventional commit: feat(scope): message
  const conventional = title.match(/^\w+\(([^)]+)\):/)
  if (conventional?.[1]) return conventional[1]

  // Jira-style: ABC-123: message
  const jira = title.match(/^([A-Z]+-\d+):/)
  if (jira?.[1]) return jira[1]

  return null
}

/**
 * Check if date matches filter value (using relative days)
 */
const matchesDateFilter = (date: Date, filterValue: string): boolean => {
  const now = Date.now()
  const dateMs = date.getTime()
  const dayMs = 24 * 60 * 60 * 1000

  switch (filterValue) {
    case "today":
      return now - dateMs < dayMs
    case "week":
      return now - dateMs < 7 * dayMs
    case "month":
      return now - dateMs < 30 * dayMs
    case "older":
      return now - dateMs >= 30 * dayMs
    default:
      return true
  }
}

export type ListItem =
  | { type: "header"; label: string; count: number }
  | { type: "pr"; pr: PullRequest }
  | { type: "empty" }
  | { type: "account"; account: AppState["accounts"][number] }
  | { type: "notification"; notification: NotificationItem }

export interface QuickFilter {
  readonly type: QuickFilterType
  readonly value: string
  readonly currentUser: string
}

const applyTextFilter = (prs: ReadonlyArray<PullRequest>, filterText: string): Array<PullRequest> => {
  if (!filterText) return [...prs]
  const search = filterText.toLowerCase()
  return prs.filter((pr) =>
    pr.repositoryName.toLowerCase().includes(search) ||
    pr.title.toLowerCase().includes(search) ||
    pr.author.toLowerCase().includes(search) ||
    pr.sourceBranch.toLowerCase().includes(search) ||
    pr.destinationBranch.toLowerCase().includes(search) ||
    pr.id.toLowerCase().includes(search) ||
    (pr.description?.toLowerCase().includes(search) ?? false) ||
    pr.account.id.toLowerCase().includes(search) ||
    pr.account.region.toLowerCase().includes(search)
  )
}

export const buildListItems = (
  state: AppState,
  view: TuiView,
  filterText: string,
  notifications: ReadonlyArray<NotificationItem> = [],
  quickFilter?: QuickFilter
): Array<ListItem> => {
  if (view === "prs" || view === "details") {
    const enabledAccounts = state.accounts.filter((a) => a.enabled)

    const prsByAccount = enabledAccounts.map((acc) => {
      const prs = state.pullRequests.filter((pr) => pr.account.id === acc.profile)
      const mostRecent = prs.length > 0
        ? Math.max(...prs.map((p) => p.creationDate.getTime()))
        : 0
      return { acc, prs, mostRecent }
    })

    const filteredGroups = prsByAccount.map((group) => {
      let filteredPRs = group.prs

      // Apply quick filter first
      if (quickFilter && quickFilter.type !== "all") {
        filteredPRs = filteredPRs.filter((pr) => {
          switch (quickFilter.type) {
            case "mine":
              // Filter by current user AND selected scope
              if (pr.author !== quickFilter.currentUser) return false
              return extractScope(pr.title) === quickFilter.value
            case "account":
              return pr.account.id === quickFilter.value
            case "author":
              return pr.author === quickFilter.value
            case "scope":
              return extractScope(pr.title) === quickFilter.value
            case "date":
              return matchesDateFilter(pr.creationDate, quickFilter.value)
            case "repo":
              return pr.repositoryName === quickFilter.value
            case "status":
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
            default:
              return true
          }
        })
      }

      // Apply text filter
      filteredPRs = applyTextFilter(filteredPRs, filterText)

      return { ...group, prs: filteredPRs }
    })

    const sortedGroups = [...filteredGroups].sort((a, b) => {
      if (a.prs.length > 0 && b.prs.length === 0) return -1
      if (a.prs.length === 0 && b.prs.length > 0) return 1
      if (a.prs.length > 0 && b.prs.length > 0) return b.mostRecent - a.mostRecent
      return a.acc.profile.localeCompare(b.acc.profile)
    })

    const items: Array<ListItem> = []
    for (const group of sortedGroups) {
      items.push({
        type: "header",
        label: group.acc.profile,
        count: group.prs.length
      })

      if (group.prs.length === 0) {
        items.push({ type: "empty" })
      }

      for (const pr of group.prs) {
        items.push({ type: "pr", pr })
      }
    }
    return items
  }

  if (view === "settings") {
    return state.accounts.map((acc) => {
      return {
        type: "account",
        account: acc
      }
    })
  }

  if (view === "notifications") {
    return notifications.map((n) => ({
      type: "notification",
      notification: n
    }))
  }

  return []
}
