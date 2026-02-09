import { useTheme } from "../context/theme.js"

export function SettingsAboutTab() {
  const { theme } = useTheme()

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width: "100%", padding: 1 }}>
      <box style={{ height: 1 }}>
        <text fg={theme.text}>{"codecommit"}</text>
      </box>

      <box style={{ height: 2 }} />

      <box style={{ height: 1 }}>
        <text fg={theme.textMuted}>{"Keybindings"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"r         Refresh"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"/ f       Filter"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"1-9       Quick filters"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"o         Open in browser"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"n         Notifications"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"Enter     Details"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"Tab       Cycle settings tabs"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"Esc       Back"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"Ctrl+C x2 Quit"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{":         Command panel"}</text>
      </box>

      <box style={{ height: 2 }} />

      <box style={{ height: 1 }}>
        <text fg={theme.textMuted}>{"[:] Open command panel for all actions"}</text>
      </box>
    </box>
  )
}
