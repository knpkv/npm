/**
 * New page prompt modal component.
 */
import type { Theme } from "../themes/index.js"

interface NewPageModalProps {
  readonly title: string
  readonly theme: Theme
  readonly width: number
  readonly height: number
}

export function NewPageModal({ height, theme, title, width }: NewPageModalProps) {
  const modalWidth = 50
  const modalHeight = 7
  const left = Math.floor((width - modalWidth) / 2)
  const top = Math.floor((height - modalHeight) / 2)

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={modalWidth}
      height={modalHeight}
      backgroundColor={theme.bg.secondary}
      border={true}
      borderColor={theme.accent.primary}
      flexDirection="column"
    >
      <box paddingLeft={1} paddingTop={1}>
        <text fg={theme.accent.primary}>{"◈ "}</text>
        <text fg={theme.text.primary}>{"New Page"}</text>
      </box>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={theme.text.muted}>{"Title: "}</text>
        <text fg={theme.text.primary}>{title}</text>
        <text fg={theme.accent.primary}>{"█"}</text>
      </box>
      <box flexGrow={1} />
      <box paddingLeft={1} paddingBottom={1} flexDirection="row">
        <text fg={theme.text.muted}>{"⏎ create"}</text>
        <text fg={theme.text.muted}>{" │ "}</text>
        <text fg={theme.text.muted}>{"esc cancel"}</text>
      </box>
    </box>
  )
}
