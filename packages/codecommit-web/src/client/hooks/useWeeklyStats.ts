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

/** The week's statistics, and a retry that reads them again. */
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
