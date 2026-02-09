import { useAtomValue } from "@effect-atom/atom-react"
import { settingsTabAtom, SettingsTabs } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import type { ListItem } from "../ListBuilder.js"
import { SettingsAboutTab } from "./SettingsAboutTab.js"
import { SettingsAccountsTab } from "./SettingsAccountsTab.js"
import { SettingsConfigTab } from "./SettingsConfigTab.js"
import { SettingsThemeTab } from "./SettingsThemeTab.js"

const TabLabels: Record<string, string> = {
  accounts: "Accounts",
  theme: "Theme",
  config: "Config",
  about: "About"
}

interface SettingsViewProps {
  readonly items: ReadonlyArray<ListItem>
  readonly selectedIndex: number
}

export function SettingsView({ items, selectedIndex }: SettingsViewProps) {
  const { theme } = useTheme()
  const activeTab = useAtomValue(settingsTabAtom)

  return (
    <box style={{ flexDirection: "row", flexGrow: 1, width: "100%" }}>
      {/* Left: vertical tab list */}
      <box
        style={{
          width: 20,
          flexDirection: "column",
          backgroundColor: theme.backgroundPanel,
          paddingTop: 1
        }}
      >
        {SettingsTabs.map((id, i) => {
          const isActive = id === activeTab
          return (
            <box
              key={id}
              style={{
                height: 1,
                paddingLeft: 1,
                paddingRight: 1,
                ...(isActive && { backgroundColor: theme.primary })
              }}
            >
              <text fg={isActive ? theme.selectedText : theme.textMuted}>{`${i + 1}. ${TabLabels[id] ?? id}`}</text>
            </box>
          )
        })}
      </box>
      {/* Right: active tab content */}
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1 }}>
        {activeTab === "accounts" && <SettingsAccountsTab items={items} selectedIndex={selectedIndex} />}
        {activeTab === "theme" && <SettingsThemeTab />}
        {activeTab === "config" && <SettingsConfigTab />}
        {activeTab === "about" && <SettingsAboutTab />}
      </box>
    </box>
  )
}
