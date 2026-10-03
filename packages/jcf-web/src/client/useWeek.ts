import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { useContext, useEffect, useMemo } from "react"
import { rememberScope, rememberWeek, storedScope, storedWeek } from "./weekPreferences.js"
import { makeWeekReview } from "./weekReview.js"

export type { AgentActivity } from "./weekReview.js"

/** React owns mounting and observation; the review owns request and write ordering. */
export const useWeek = () => {
  const registry = useContext(RegistryContext)
  const review = useMemo(() =>
    makeWeekReview(registry, {
      week: storedWeek(),
      scope: storedScope(),
      rememberScope,
      rememberWeek,
      now: () => performance.now()
    }), [registry])
  const state = useAtomValue(review.state)
  useEffect(() => {
    void review.initialize()
    return review.dispose
  }, [review])
  return { state, actions: review }
}
