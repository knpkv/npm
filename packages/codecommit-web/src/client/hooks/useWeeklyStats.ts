import { useAtomValue } from "@effect-atom/atom-react"
import { useMemo } from "react"
import { ApiClient } from "../atoms/runtime.js"

const makeStatsQuery = (
  week: string,
  filters: { repo?: string | undefined; author?: string | undefined; account?: string | undefined }
) =>
  ApiClient.query("stats", "get", {
    urlParams: { week, ...filters },
    timeToLive: "30 seconds"
  })

export function useWeeklyStats(
  week: string,
  filters: { repo?: string | undefined; author?: string | undefined; account?: string | undefined }
) {
  const queryAtom = useMemo(
    () => makeStatsQuery(week, filters),
    [week, filters.repo, filters.author, filters.account]
  )
  return useAtomValue(queryAtom)
}
