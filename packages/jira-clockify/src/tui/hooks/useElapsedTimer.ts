/**
 * Hook that ticks elapsed seconds while a timer is active.
 *
 * @internal
 */
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useEffect, useRef } from "react"
import type { TimerState } from "../../services/TimerService.js"
import { elapsedAtom, timerStateAtom } from "../atoms/timer.js"

export function useElapsedTimer(): { timerState: TimerState | null; elapsed: number } {
  const timerResult = useAtomValue(timerStateAtom)
  const elapsed = useAtomValue(elapsedAtom)
  const setElapsed = useAtomSet(elapsedAtom)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const timerState: TimerState | null = Result.isSuccess(timerResult) ? timerResult.value : null

  useEffect(() => {
    if (timerState?.active && timerState.startedAt) {
      const startTime = timerState.startedAt.getTime()
      const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000))
      tick()
      intervalRef.current = setInterval(tick, 1000)
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    } else {
      setElapsed(0)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return undefined
  }, [timerState?.active, timerState?.startedAt, setElapsed])

  return { timerState, elapsed }
}
