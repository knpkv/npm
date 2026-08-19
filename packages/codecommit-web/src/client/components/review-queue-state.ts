import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Predicate from "effect/Predicate"
import type { FilterEntry, FilterKey } from "../atoms/ui.js"
import { extractScope } from "../utils/extractScope.js"

export type QueueMode = "hot" | "all" | "mine" | "review"
export type QueueFacet = "review" | "pending" | "approved" | "open"

interface QueueModeState {
  readonly filters: ReadonlyArray<FilterEntry>
  readonly hot: boolean
  readonly review: boolean
}

/** Resolve the one visible queue mode when URL flags from older links overlap. */
export const resolveQueueMode = (state: QueueModeState, currentUser: string | undefined): QueueMode => {
  if (state.review) return "review"
  if (state.hot) return "hot"
  if (
    currentUser !== undefined &&
    state.filters.some((filter) => filter.key === "author" && filter.value === currentUser)
  ) {
    return "mine"
  }
  return "all"
}

export const openSubStatuses: ReadonlySet<string> = new Set(["approved", "pending", "mergeable", "conflicts"])
const recognizedStatuses: ReadonlySet<string> = new Set(["open", "merged", "closed", ...openSubStatuses])

interface StatusAxisLookup extends Readonly<Record<string, string>> {}

export const statusAxis: StatusAxisLookup = {
  open: "lifecycle",
  merged: "lifecycle",
  closed: "lifecycle",
  approved: "approval",
  pending: "approval",
  mergeable: "merge",
  conflicts: "merge"
}

export const filterLabels = {
  account: "Account",
  author: "Author",
  approver: "Approver",
  commenter: "Commenter",
  scope: "Scope",
  repo: "Repository",
  status: "Status",
  size: "Size"
} satisfies Readonly<Record<FilterKey, string>>

export const matchesQueueFilter = (pr: Domain.PullRequest, entry: FilterEntry): boolean => {
  switch (entry.key) {
    case "account":
      return pr.account.profile === entry.value
    case "author":
      return pr.author === entry.value
    case "scope":
      return extractScope(pr.title) === entry.value
    case "repo":
      return pr.repositoryName === entry.value
    case "approver":
      return pr.approvedBy.some((name) => name === entry.value)
    case "commenter":
      return pr.commentedBy.some((name) => name === entry.value)
    case "size": {
      const filesChanged = pr.filesChanged
      if (filesChanged == null) return false
      switch (entry.value) {
        case "small":
          return filesChanged < 5
        case "medium":
          return filesChanged >= 5 && filesChanged <= 15
        case "large":
          return filesChanged >= 16 && filesChanged <= 30
        case "xlarge":
          return filesChanged > 30
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

export const groupQueueFilters = (
  filters: ReadonlyArray<FilterEntry>
): ReadonlyMap<string, ReadonlyArray<FilterEntry>> => {
  const groups = new Map<string, Array<FilterEntry>>()
  for (const filter of filters) {
    const groupKey = filter.key === "status" ? `status:${statusAxis[filter.value] ?? filter.value}` : filter.key
    const group = groups.get(groupKey)
    if (group) group.push(filter)
    else groups.set(groupKey, [filter])
  }
  return groups
}

export const queueFilterOptions = (
  prs: ReadonlyArray<Domain.PullRequest>
) => {
  const authors = new Set<string>()
  const accounts = new Set<string>()
  const scopes = new Set<string>()
  const repositories = new Set<string>()
  const commenters = new Set<string>()
  const approvers = new Set<string>()

  for (const pr of prs) {
    authors.add(pr.author)
    accounts.add(pr.account.profile)
    repositories.add(pr.repositoryName)
    const scope = extractScope(pr.title)
    if (scope) scopes.add(scope)
    for (const name of pr.commentedBy) if (name) commenters.add(name)
    for (const name of pr.approvedBy) if (name) approvers.add(name)
  }

  return {
    account: [...accounts].sort(),
    author: [...authors].sort(),
    approver: [...approvers].sort(),
    commenter: [...commenters].sort(),
    scope: [...scopes].sort(),
    repo: [...repositories].sort(),
    status: ["open", "approved", "pending", "mergeable", "conflicts", "merged", "closed"],
    size: ["small", "medium", "large", "xlarge"]
  }
}

interface QueueFacetState {
  readonly filters: ReadonlyArray<FilterEntry>
  readonly review: boolean
}

/** Resolve a summary facet only when the URL describes that exact status group. */
export const resolveQueueFacet = ({ filters, review }: QueueFacetState): QueueFacet | undefined => {
  if (review) return "review"
  const statuses = new Set(
    filters
      .filter((filter) => filter.key === "status")
      .map((filter) => filter.value)
      .filter((status) => recognizedStatuses.has(status))
  )
  if (statuses.size === 1) {
    if (statuses.has("open")) return "open"
    if (statuses.has("approved")) return "approved"
    if (statuses.has("pending")) return "pending"
  }
  if (statuses.size === openSubStatuses.size && [...openSubStatuses].every((status) => statuses.has(status))) {
    return "open"
  }
  return undefined
}

/** Apply each valid date bound independently and ignore malformed URL dates. */
export const isWithinQueueDateBounds = (
  timestamp: number,
  fromMs: number | undefined,
  toMs: number | undefined
): boolean => {
  if (Predicate.isNumber(fromMs) && Number.isFinite(fromMs) && timestamp < fromMs) return false
  if (Predicate.isNumber(toMs) && Number.isFinite(toMs) && timestamp >= toMs) return false
  return true
}
