/**
 * Centered popup dialog showing a result message with OK button.
 *
 * @internal
 */
import { useKeyboard } from "@opentui/react"

interface PopupMessageProps {
  readonly title: string
  readonly lines: ReadonlyArray<{ text: string; color?: string }>
  readonly type?: "success" | "error" | "info"
  readonly onDismiss: () => void
  /** When provided, shows a "Retry (r)" action — used to re-run a failed call. */
  readonly onRetry?: (() => void) | undefined
  /** Disables the retry action while a retry is in flight. */
  readonly retrying?: boolean
  /** When provided, shows an "Edit (e)" action — e.g. correct a timer's end before stopping. */
  readonly onEdit?: (() => void) | undefined
  /** Label for the dismiss action (defaults to "OK"). */
  readonly dismissLabel?: string
}

const typeColors = {
  success: "#00CC66",
  error: "#FF4444",
  info: "#00CCFF"
}

const typeIcons = {
  success: "✓",
  error: "✗",
  info: "●"
}

export function PopupMessage({
  dismissLabel = "OK",
  lines,
  onDismiss,
  onEdit,
  onRetry,
  retrying = false,
  title,
  type = "info"
}: PopupMessageProps) {
  const color = typeColors[type]
  const icon = typeIcons[type]

  useKeyboard((key: { name: string; ctrl?: boolean; char?: string }) => {
    if (onRetry && !retrying && (key.name === "r" || key.char === "r")) {
      onRetry()
      return
    }
    if (onEdit && (key.name === "e" || key.char === "e")) {
      onEdit()
      return
    }
    if (key.name === "return" || key.name === "escape" || key.name === "q") {
      onDismiss()
    }
  })

  const height = 4 + lines.length + 2 // border + title + gap + lines + gap + button
  const retryBg = retrying ? "#555555" : "#FFAA00"

  return (
    <box
      style={
        {
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          justifyContent: "center",
          alignItems: "center"
        } as any
      }
    >
      <box
        style={
          {
            width: 56,
            height,
            flexDirection: "column",
            backgroundColor: "#1a1a2e",
            border: 1,
            borderColor: color,
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 1
          } as any
        }
      >
        {/* Title */}
        <box style={{ height: 1 }}>
          <text fg={color} style={{ fontWeight: "bold" } as any}>
            {`${icon} ${title}`}
          </text>
        </box>

        <box style={{ height: 1 } as any} />

        {/* Result lines */}
        {lines.map((line, i) => (
          <box key={i} style={{ height: 1 }}>
            <text fg={line.color ?? "#CCCCCC"}>{`  ${line.text}`}</text>
          </box>
        ))}

        <box style={{ height: 1 } as any} />

        {/* Action buttons */}
        <box style={{ height: 1, justifyContent: "center", gap: 2 } as any}>
          {onRetry ? (
            <box style={{ backgroundColor: retryBg, paddingLeft: 2, paddingRight: 2 } as any}>
              <text fg="#000000" style={{ fontWeight: "bold" } as any}>
                {retrying ? "Retrying…" : "Retry (r)"}
              </text>
            </box>
          ) : null}
          {onEdit ? (
            <box style={{ backgroundColor: "#FFAA00", paddingLeft: 2, paddingRight: 2 } as any}>
              <text fg="#000000" style={{ fontWeight: "bold" } as any}>
                Edit end (e)
              </text>
            </box>
          ) : null}
          <box style={{ backgroundColor: color, paddingLeft: 2, paddingRight: 2 } as any}>
            <text fg="#000000" style={{ fontWeight: "bold" } as any}>
              {`${dismissLabel} (enter)`}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}
