import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useMemo } from "react"
import { ApiClient } from "../atoms/runtime.js"

const makeStatsQuery = (
  week: string,
  filters: { repo?: string | undefined; author?: string | undefined; account?: string | undefined }
) =>
  ApiClient.query("stats", "get", {
    query: { week, ...filters },
    timeToLive: "30 seconds"
  })

/** The week's stats and a retry that re-runs the same query. */
export function useWeeklyStats(
  week: string,
  filters: { repo?: string | undefined; author?: string | undefined; account?: string | undefined }
) {
  const queryAtom = useMemo(
    () => makeStatsQuery(week, filters),
    [week, filters.repo, filters.author, filters.account]
  )
  return { result: useAtomValue(queryAtom), retry: useAtomRefresh(queryAtom) }
}
