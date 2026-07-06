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

export function PopupInput({ onCancel: _onCancel, onSubmit, placeholder, title }: PopupInputProps) {
  function handleSubmit(value: string): void
  function handleSubmit(_event: object): void
  function handleSubmit(valueOrEvent: string | object): void {
    if (typeof valueOrEvent === "string") {
      onSubmit(valueOrEvent)
    }
  }

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center"
      }}
    >
      {/* Overlay background */}
      <box
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundColor: "rgba(0,0,0,0.6)"
        }}
      />

      {/* Dialog box */}
      <box
        style={{
          width: 60,
          height: 7,
          flexDirection: "column",
          backgroundColor: "#1a1a2e",
          border: true,
          borderColor: "#444466",
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1
        }}
      >
        {/* Title */}
        <box style={{ height: 1 }}>
          <text fg="#FFCC00">{title}</text>
        </box>

        {/* Input field */}
        <box style={{ height: 1, marginTop: 1 }}>
          <input
            focused
            placeholder={placeholder ?? ""}
            onSubmit={handleSubmit}
            style={{ width: "100%", backgroundColor: "#0f0f1a", textColor: "#FFFFFF" }}
          />
        </box>

        {/* Hints */}
        <box style={{ height: 1, marginTop: 1 }}>
          <text fg="#888888">enter: confirm esc: cancel</text>
        </box>
      </box>
    </box>
  )
}
