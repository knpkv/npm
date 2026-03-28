/**
 * Centered popup dialog with a text input field.
 *
 * @internal
 */
interface PopupInputProps {
  readonly title: string
  readonly placeholder?: string
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}

export function PopupInput({ onCancel, onSubmit, placeholder, title }: PopupInputProps) {
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
      {/* Overlay background */}
      <box
        style={
          {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundColor: "rgba(0,0,0,0.6)"
          } as any
        }
      />

      {/* Dialog box */}
      <box
        style={
          {
            width: 60,
            height: 7,
            flexDirection: "column",
            backgroundColor: "#1a1a2e",
            border: 1,
            borderColor: "#444466",
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 1
          } as any
        }
      >
        {/* Title */}
        <box style={{ height: 1 }}>
          <text fg="#FFCC00" style={{ fontWeight: "bold" } as any}>
            {title}
          </text>
        </box>

        {/* Input field */}
        <box style={{ height: 1, marginTop: 1 } as any}>
          <input
            focused
            placeholder={placeholder ?? ""}
            onSubmit={((value: string) => onSubmit(value)) as any}
            style={{ width: "100%", backgroundColor: "#0f0f1a", fg: "#FFFFFF" } as any}
          />
        </box>

        {/* Hints */}
        <box style={{ height: 1, marginTop: 1 } as any}>
          <text fg="#888888">enter: confirm esc: cancel</text>
        </box>
      </box>
    </box>
  )
}
