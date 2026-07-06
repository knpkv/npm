import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"

interface DialogProps {
  readonly title: string
  readonly children: React.ReactNode
  readonly fullscreen?: boolean
}

/**
 * Base dialog wrapper component
 * Renders a modal overlay with title bar and content
 * @category ui
 */
export function Dialog({ children, fullscreen = false, title }: DialogProps) {
  const { theme } = useTheme()

  return (
    <box
      style={{
        position: "absolute",
        top: fullscreen ? 0 : "15%",
        left: fullscreen ? 0 : "15%",
        width: fullscreen ? "100%" : "70%",
        height: fullscreen ? "100%" : "auto",
        flexDirection: "column",
        backgroundColor: theme.backgroundPanel,
        padding: 0
      }}
    >
      <box
        style={{
          height: 1,
          width: "100%",
          backgroundColor: theme.backgroundElement,
          paddingLeft: 2,
          paddingRight: 2
        }}
      >
        <text fg={theme.textWarning}>{`  ${title}`}</text>
      </box>
      <box style={{ flexDirection: "column", padding: 1, flexGrow: 1 }}>{children}</box>
    </box>
  )
}

/**
 * Renders the current dialog from DialogContext if present
 * Place at root level of app
 * @category ui
 */
export function DialogRenderer() {
  const { current: CurrentDialog } = useDialog()

  if (!CurrentDialog) {
    return null
  }

  return <CurrentDialog />
}
