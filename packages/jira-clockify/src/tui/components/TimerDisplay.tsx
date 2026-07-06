/**
 * Compact timer widget showing elapsed time, ticket key, and project.
 *
 * @internal
 */
import { formatDuration, formatElapsed } from "../../utils/time.js"
import { useElapsedTimer } from "../hooks/useElapsedTimer.js"

export function TimerDisplay() {
  const { elapsed, timerState } = useElapsedTimer()

  if (!timerState?.active) {
    return (
      <box
        style={{
          height: 3,
          width: "100%",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f0f1a"
        }}
      >
        <text fg="#555555">No active timer — press s or Enter on a ticket to start</text>
      </box>
    )
  }

  return (
    <box
      style={{
        height: 5,
        width: "100%",
        flexDirection: "column",
        backgroundColor: "#0a1628",
        paddingLeft: 2,
        paddingTop: 1
      }}
    >
      <box style={{ flexDirection: "row", gap: 2 }}>
        <text fg="#00CC66">●</text>
        <text fg="#00CCFF">{formatElapsed(elapsed)}</text>
        <text fg="#888888">{formatDuration(elapsed)}</text>
      </box>
      <box style={{ flexDirection: "row", gap: 1, paddingLeft: 2 }}>
        <text fg="#FFFFFF">{timerState.ticketKey}</text>
        <text fg="#AAAAAA">{timerState.summary ?? ""}</text>
      </box>
      <box style={{ flexDirection: "row", gap: 2, paddingLeft: 2 }}>
        {timerState.projectId ? <text fg="#555555">proj</text> : null}
        {timerState.billable !== null ? (
          <text fg="#555555">{timerState.billable ? "billable" : "non-billable"}</text>
        ) : null}
      </box>
    </box>
  )
}
