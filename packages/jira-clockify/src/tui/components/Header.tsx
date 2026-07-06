/**
 * Status bar showing active ticket, timer state, and project.
 *
 * @internal
 */
import { useAtomValue } from "@effect/atom-react"
import type { JSX } from "@opentui/react/jsx-runtime"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { TimerState } from "../../services/TimerService.js"
import { timerStateAtom } from "../atoms/timer.js"

type BoxStyle = NonNullable<JSX.IntrinsicElements["box"]["style"]>

const headerStyle = { height: 1, width: "100%", backgroundColor: "#1a1a2e", flexDirection: "row" } satisfies BoxStyle

export function Header() {
  const timerResult = useAtomValue(timerStateAtom)
  const timerState: TimerState | null = AsyncResult.isSuccess(timerResult) ? timerResult.value : null

  const statusIcon = timerState?.active ? "●" : "○"
  const statusColor = timerState?.active ? "#00CC66" : "#888888"

  return (
    <box style={headerStyle}>
      <text fg={statusColor}>{`  ${statusIcon} `}</text>
      {timerState?.active && timerState.ticketKey ? (
        <text fg="#00CCFF">{timerState.ticketKey}</text>
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
