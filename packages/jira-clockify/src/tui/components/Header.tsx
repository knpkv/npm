/**
 * Status bar showing active ticket, timer state, and project.
 *
 * @internal
 */
import { Result, useAtomValue } from "@effect-atom/atom-react"
import type { TimerState } from "../../services/TimerService.js"
import { timerStateAtom } from "../atoms/timer.js"

export function Header() {
  const timerResult = useAtomValue(timerStateAtom)
  const timerState: TimerState | null = Result.isSuccess(timerResult) ? timerResult.value : null

  const statusIcon = timerState?.active ? "●" : "○"
  const statusColor = timerState?.active ? "#00CC66" : "#888888"

  return (
    <box style={{ height: 1, width: "100%", backgroundColor: "#1a1a2e", flexDirection: "row" } as any}>
      <text fg={statusColor} style={{ fontWeight: "bold" } as any}>
        {`  ${statusIcon} `}
      </text>
      {timerState?.active && timerState.ticketKey ? (
        <text fg="#00CCFF" style={{ fontWeight: "bold" } as any}>
          {timerState.ticketKey}
        </text>
      ) : (
        <text fg="#888888">jcf</text>
      )}
      {timerState?.active && timerState.summary ? (
        <text fg="#888888">{`  ${timerState.summary.slice(0, 50)}`}</text>
      ) : null}
      {timerState?.active && timerState.projectName ? (
        <text fg="#555555">{`  [${timerState.projectName}]`}</text>
      ) : null}
    </box>
  )
}
