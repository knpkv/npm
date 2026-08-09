import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { RelayReviewConversationTurn, RelayReviewFinding } from "../../RelayReview.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { terminalSafeCompactText, terminalSafeMultilineText } from "../details-model.js"
import { textFromKeyboardKey } from "../keyboard-text.js"
import { Dialog } from "./Dialog.js"

const MAX_FOLLOW_UP_CHARACTERS = 2_000

export function DialogFindingConversation({
  finding,
  onSubmit,
  turns
}: {
  readonly finding: RelayReviewFinding
  readonly onSubmit: (message: string) => void
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [draft, setDraft] = useState("")
  const relevantTurns = turns.filter((turn) => turn.findingId === finding.id).slice(-6)

  useKeyboard((key) => {
    if (key.name === "escape") {
      dialog.hide()
      return
    }
    if (key.name === "return") {
      const message = draft.trim()
      if (message.length === 0) return
      onSubmit(message)
      dialog.hide()
      return
    }
    if (key.name === "backspace") {
      setDraft((current) => current.slice(0, -1))
      return
    }
    const text = textFromKeyboardKey(key)
    if (text === undefined) return
    setDraft((current) => `${current}${text}`.slice(0, MAX_FOLLOW_UP_CHARACTERS))
  })

  return (
    <Dialog title={`DISCUSS ${terminalSafeCompactText(finding.id, 32)}`}>
      <text fg={theme.textAccent}>{terminalSafeCompactText(finding.title, 70)}</text>
      <text fg={theme.textMuted}>
        This thread is attached here, but the agent will reconcile the whole finding deck.
      </text>
      <box flexDirection="column" style={{ height: 10, paddingBottom: 1, paddingTop: 1 }}>
        {relevantTurns.length === 0 ? (
          <text fg={theme.textMuted}>No follow-up yet.</text>
        ) : (
          relevantTurns.map((turn, index) => (
            <box flexDirection="column" key={`${turn.role}-${index}`}>
              <text fg={turn.role === "user" ? theme.textAccent : theme.textSuccess}>
                {turn.role === "user" ? "YOU" : "RELAY"}
              </text>
              <text fg={theme.text}>{terminalSafeMultilineText(turn.message)}</text>
            </box>
          ))
        )}
      </box>
      <box
        border={["left"]}
        borderColor={theme.primary}
        style={{ backgroundColor: theme.backgroundRaised, paddingLeft: 1 }}
      >
        <text fg={draft.length === 0 ? theme.textMuted : theme.text}>
          {draft.length === 0 ? "Ask about this finding…" : terminalSafeMultilineText(draft)}
        </text>
      </box>
      <text fg={theme.textAccent}>Enter send · Esc cancel</text>
    </Dialog>
  )
}
