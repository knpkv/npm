import { useKeyboard } from "@opentui/react"
import { useRef, useState } from "react"
import { normalizeRelayReviewSkills, relayReviewSkills, type RelayReviewSkillId } from "../../ReviewSkills.js"
import { transitionBoundedMultiSelection } from "../text-filter-input.js"
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
  const initialSelection = normalizeRelayReviewSkills(selected)
  const selectionRef = useRef({ cursor: 0, selection: initialSelection })
  const [cursor, setCursor] = useState(selectionRef.current.cursor)
  const [selection, setSelection] = useState<ReadonlyArray<RelayReviewSkillId>>(selectionRef.current.selection)

  useKeyboard((key) => {
    if (key.name === "escape") dialog.hide()
    else {
      const transition = transitionBoundedMultiSelection(
        selectionRef.current,
        key,
        relayReviewSkills.map((skill) => skill.id),
        1
      )
      selectionRef.current = { cursor: transition.cursor, selection: transition.selection }
      setCursor(transition.cursor)
      setSelection(transition.selection)
      if (transition.submission !== null) {
        onApply(transition.submission)
        dialog.hide()
      }
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
