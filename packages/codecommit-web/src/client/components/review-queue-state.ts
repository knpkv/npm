import type { FilterEntry } from "../atoms/ui.js"

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

const openSubStatuses: ReadonlySet<string> = new Set(["approved", "pending", "mergeable", "conflicts"])
const recognizedStatuses: ReadonlySet<string> = new Set(["open", "merged", "closed", ...openSubStatuses])

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
