import type { ReviewClient } from "@knpkv/codecommit-core"
import { useKeyboard } from "@opentui/react"
import { useRef, useState } from "react"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { transitionBoundedSelection } from "../text-filter-input.js"
import { Dialog } from "./Dialog.js"

const strategies: ReadonlyArray<{
  readonly description: string
  readonly id: ReviewClient.CodeCommitMergeStrategy
  readonly label: string
}> = [
  {
    id: "squash",
    label: "Squash",
    description: "Combine the pull request into one destination commit."
  },
  {
    id: "fast-forward",
    label: "Fast-forward",
    description: "Move the destination ref directly to the reviewed head."
  },
  {
    id: "three-way",
    label: "Three-way",
    description: "Pin the reviewed head; CodeCommit may use a newer destination after preflight."
  }
]

export function DialogMergeStrategy({
  onApply
}: {
  readonly onApply: (strategy: ReviewClient.CodeCommitMergeStrategy) => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const cursorRef = useRef(0)
  const [cursor, setCursor] = useState(0)

  useKeyboard((key) => {
    if (key.name === "escape") {
      dialog.hide()
      return
    }
    const transition = transitionBoundedSelection(cursorRef.current, key, strategies.length)
    cursorRef.current = transition.cursor
    setCursor(transition.cursor)
    if (transition.submittedIndex === null) return
    const selected = strategies[transition.submittedIndex]
    if (selected === undefined) return
    onApply(selected.id)
    dialog.hide()
  })

  return (
    <Dialog title="MERGE PULL REQUEST">
      <text fg={theme.textMuted}>Choose the native CodeCommit strategy. You will confirm the exact head next.</text>
      <box flexDirection="column" style={{ paddingBottom: 1, paddingTop: 1 }}>
        {strategies.map((strategy, index) => (
          <box flexDirection="column" key={strategy.id} style={{ paddingBottom: 1 }}>
            <text
              {...(index === cursor ? { bg: theme.selectedBackground } : {})}
              fg={index === cursor ? theme.text : theme.textMuted}
            >{`${index === cursor ? "›" : " "} ${strategy.label}`}</text>
            <text fg={theme.textMuted} style={{ paddingLeft: 2 }}>
              {strategy.description}
            </text>
          </box>
        ))}
      </box>
      <text fg={theme.textAccent}>↑/↓ move · Enter choose · Esc cancel</text>
    </Dialog>
  )
}
