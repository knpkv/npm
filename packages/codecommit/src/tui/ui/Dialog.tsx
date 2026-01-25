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

  const containerStyle = fullscreen
    ? ({ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" } as const)
    : ({ position: "absolute", top: "15%", left: "15%", width: "70%", height: "auto" } as const)

  return (
    <box
      style={{
        ...containerStyle,
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
