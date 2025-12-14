/**
 * Status bar component with theme support.
 */
import type { Theme } from "../themes/index.js"

interface StatusBarProps {
  readonly width: number
  readonly userEmail: string | null
  readonly loading: boolean
  readonly inActionsPanel: boolean
  readonly theme: Theme
  readonly themeName: string
  readonly statusMessage: string | null
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

export function StatusBar({ inActionsPanel, loading, statusMessage, theme, themeName, userEmail }: StatusBarProps) {
  const currentHints = inActionsPanel ? actionHints : hints

  return (
    <box height={1} backgroundColor={theme.bg.statusBar} paddingLeft={1} paddingRight={1} flexDirection="row">
      {/* Left: Key hints or status message */}
      <box flexGrow={1} flexDirection="row">
        {statusMessage ? (
          <text fg={theme.accent.success}>{`${theme.icons.check} ${statusMessage}`}</text>
        ) : (
          <>
            {currentHints.map((hint, idx) => (
              <box key={idx} flexDirection="row">
                <text fg={theme.accent.primary}>{hint.key}</text>
                <text fg={theme.text.secondary}>{` ${hint.label}`}</text>
                {idx < currentHints.length - 1 ? <text fg={theme.text.muted}>{" │ "}</text> : null}
              </box>
            ))}
            {loading ? (
              <box flexDirection="row">
                <text fg={theme.text.muted}>{" │ "}</text>
                <text fg={theme.status.loading}>{`${theme.icons.loading}`}</text>
              </box>
            ) : null}
          </>
        )}
      </box>

      {/* Center: Theme indicator */}
      <box flexDirection="row" paddingRight={2}>
        <text fg={theme.text.muted}>{"◐ "}</text>
        <text fg={theme.accent.secondary}>{themeName}</text>
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
