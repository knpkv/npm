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

export function PopupMessage({ lines, onDismiss, title, type = "info" }: PopupMessageProps) {
  const color = typeColors[type]
  const icon = typeIcons[type]

  useKeyboard((key: { name: string; ctrl?: boolean }) => {
    if (key.name === "return" || key.name === "escape" || key.name === "q") {
      onDismiss()
    }
  })

  const height = 4 + lines.length + 2 // border + title + gap + lines + gap + button

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

        {/* OK button */}
        <box style={{ height: 1, justifyContent: "center" } as any}>
          <box style={{ backgroundColor: color, paddingLeft: 2, paddingRight: 2 } as any}>
            <text fg="#000000" style={{ fontWeight: "bold" } as any}>
              OK (enter)
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}
