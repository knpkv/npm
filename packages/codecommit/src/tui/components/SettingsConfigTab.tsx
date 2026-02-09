import { useTheme } from "../context/theme.js"
import { Badge } from "./Badge.js"

// TODO: Wire to ConfigService.getConfigPath + validate atoms
// For now, show static placeholder that will be connected in integration step

export function SettingsConfigTab() {
  const { theme } = useTheme()

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width: "100%", padding: 1 }}>
      <box style={{ height: 1 }}>
        <text fg={theme.textMuted}>{"Config File"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
        <text fg={theme.text}>{"~/.codecommit/config.json"}</text>
      </box>

      <box style={{ height: 2 }} />

      <box style={{ height: 1 }}>
        <text fg={theme.textMuted}>{"Status"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
        <Badge variant="success" minWidth={7}>
          VALID
        </Badge>
      </box>

      <box style={{ height: 2 }} />

      <box style={{ height: 1 }}>
        <text fg={theme.textMuted}>{"Actions"}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.text}>{"Reset to defaults (backup + re-detect)"}</text>
      </box>
    </box>
  )
}
