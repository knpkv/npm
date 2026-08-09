import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { normalizeRelayReviewSkills, relayReviewSkills, type RelayReviewSkillId } from "../../ReviewSkills.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { Dialog } from "./Dialog.js"

export function DialogReviewSkills({
  onApply,
  selected
}: {
  readonly onApply: (selected: ReadonlyArray<RelayReviewSkillId>) => void
  readonly selected: ReadonlyArray<RelayReviewSkillId>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [cursor, setCursor] = useState(0)
  const [selection, setSelection] = useState<ReadonlyArray<RelayReviewSkillId>>(() =>
    normalizeRelayReviewSkills(selected)
  )

  const toggleCurrent = () => {
    const skill = relayReviewSkills[cursor]
    if (skill === undefined) return
    const isSelected = selection.includes(skill.id)
    if (isSelected && selection.length === 1) return
    setSelection(isSelected ? selection.filter((id) => id !== skill.id) : [...selection, skill.id])
  }

  useKeyboard((key) => {
    if (key.name === "escape") dialog.hide()
    else if (key.name === "up") setCursor((index) => Math.max(0, index - 1))
    else if (key.name === "down") setCursor((index) => Math.min(relayReviewSkills.length - 1, index + 1))
    else if (key.name === "space") toggleCurrent()
    else if (key.name === "return") {
      onApply(selection)
      dialog.hide()
    }
  })

  return (
    <Dialog title="REVIEW SKILLS">
      <text fg={theme.textMuted}>Choose one or more trusted playbooks for the next Relay review.</text>
      <box flexDirection="column" style={{ paddingTop: 1, paddingBottom: 1 }}>
        {relayReviewSkills.map((skill, index) => {
          const active = selection.includes(skill.id)
          return (
            <box flexDirection="column" key={skill.id} style={{ paddingBottom: 1 }}>
              <text
                {...(index === cursor ? { bg: theme.selectedBackground } : {})}
                fg={index === cursor ? theme.text : theme.textMuted}
              >{`${index === cursor ? "›" : " "} ${active ? "◉" : "○"} ${skill.label}`}</text>
              <text fg={theme.textMuted} style={{ paddingLeft: 4 }}>
                {skill.description}
              </text>
            </box>
          )
        })}
      </box>
      <text fg={theme.textAccent}>↑/↓ move · Space toggle · Enter apply · Esc cancel</text>
    </Dialog>
  )
}
