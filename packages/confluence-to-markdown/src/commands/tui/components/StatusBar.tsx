/**
 * Status bar component with operation progress.
 */
import type { Theme } from "../themes/index.js"

export type StatusType = "info" | "loading" | "success" | "error"

export interface StatusInfo {
  readonly type: StatusType
  readonly message: string
}

interface StatusBarProps {
  readonly width: number
  readonly userEmail: string | null
  readonly inActionsPanel: boolean
  readonly theme: Theme
  readonly status: StatusInfo | null
}

interface KeyHint {
  readonly key: string
  readonly label: string
}

const hints: ReadonlyArray<KeyHint> = [
  { key: "↑↓", label: "nav" },
  { key: "←→", label: "move" },
  { key: "␣", label: "select" },
  { key: "q", label: "quit" }
]

const actionHints: ReadonlyArray<KeyHint> = [
  { key: "↑↓", label: "nav" },
  { key: "←", label: "back" },
  { key: "⏎", label: "run" },
  { key: "q", label: "quit" }
]

/** Get icon and color for status type */
const getStatusStyle = (type: StatusType, theme: Theme) => {
  switch (type) {
    case "loading":
      return { icon: theme.icons.loading, color: theme.status.loading }
    case "success":
      return { icon: theme.icons.check, color: theme.accent.success }
    case "error":
      return { icon: theme.icons.cross, color: theme.status.unsynced }
    case "info":
    default:
      return { icon: theme.icons.bullet, color: theme.text.secondary }
  }
}

export function StatusBar({ inActionsPanel, status, theme, userEmail }: StatusBarProps) {
  const currentHints = inActionsPanel ? actionHints : hints

  return (
    <box height={1} backgroundColor={theme.bg.statusBar} paddingLeft={1} paddingRight={1} flexDirection="row">
      {/* Left: Key hints */}
      <box flexDirection="row">
        {currentHints.map((hint, idx) => (
          <box key={idx} flexDirection="row">
            <text fg={theme.accent.primary}>{hint.key}</text>
            <text fg={theme.text.secondary}>{` ${hint.label}`}</text>
            {idx < currentHints.length - 1 ? <text fg={theme.text.muted}>{" │ "}</text> : null}
          </box>
        ))}
      </box>

      {/* Center: Operation status */}
      <box flexGrow={1} flexDirection="row" paddingLeft={2}>
        {status ? (
          <>
            <text fg={getStatusStyle(status.type, theme).color}>{`${getStatusStyle(status.type, theme).icon} `}</text>
            <text fg={getStatusStyle(status.type, theme).color}>{status.message}</text>
          </>
        ) : null}
      </box>

      {/* Right: User info */}
      {userEmail ? (
        <box flexDirection="row">
          <text fg={theme.text.muted}>{"‹ "}</text>
          <text fg={theme.status.online}>{theme.icons.dot}</text>
          <text fg={theme.text.secondary}>{` ${userEmail}`}</text>
          <text fg={theme.text.muted}>{" ›"}</text>
        </box>
      ) : null}
    </box>
  )
}
