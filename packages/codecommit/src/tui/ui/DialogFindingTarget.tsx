import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import {
  relayFindingPublicationLabel,
  relayFindingPublicationOptions,
  type RelayReviewFinding,
  type RelayFindingPublicationTarget
} from "../../RelayReview.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { terminalSafeCompactText } from "../details-model.js"
import { Dialog } from "./Dialog.js"

export function DialogFindingTarget({
  finding,
  onApply
}: {
  readonly finding: RelayReviewFinding
  readonly onApply: (target: RelayFindingPublicationTarget) => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const options = relayFindingPublicationOptions(finding)
  const initialIndex = Math.max(0, options.indexOf(finding.publicationTarget))
  const [cursor, setCursor] = useState(initialIndex)

  useKeyboard((key) => {
    if (key.name === "escape") dialog.hide()
    else if (key.name === "up") setCursor((index) => Math.max(0, index - 1))
    else if (key.name === "down") setCursor((index) => Math.min(options.length - 1, index + 1))
    else if (key.name === "return") {
      const target = options[cursor]
      if (target === undefined) return
      onApply(target)
      dialog.hide()
    }
  })

  return (
    <Dialog title={`PUBLISH ${terminalSafeCompactText(finding.id, 32)}`}>
      <text fg={theme.textMuted}>Choose where this finding belongs. No AWS write happens here.</text>
      <box flexDirection="column" style={{ paddingBottom: 1, paddingTop: 1 }}>
        {options.map((target, index) => (
          <text
            {...(index === cursor ? { bg: theme.selectedBackground } : {})}
            fg={index === cursor ? theme.text : theme.textMuted}
            key={target}
          >{`${index === cursor ? "›" : " "} ${target === finding.publicationTarget ? "◉" : "○"} ${relayFindingPublicationLabel(target)}`}</text>
        ))}
      </box>
      <text fg={theme.textMuted}>
        File and line targets appear only when the finding has that exact evidence anchor.
      </text>
      <text fg={theme.textAccent}>↑/↓ move · Enter apply · Esc cancel</text>
    </Dialog>
  )
}
