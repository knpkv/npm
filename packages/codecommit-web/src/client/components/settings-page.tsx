import { ArrowLeftIcon, BoxIcon, FileIcon, InfoIcon, PaletteIcon, RefreshCwIcon, UserIcon } from "lucide-react"
import { useNavigate, useParams } from "react-router"
import { type SettingsTab, SettingsTabs } from "../atoms/ui.js"
import { cn } from "../lib/utils.js"
import { SettingsAbout } from "./settings-about.js"
import { SettingsAccounts } from "./settings-accounts.js"
import { SettingsConfig } from "./settings-config.js"
import { SettingsRefresh } from "./settings-refresh.js"
import { SettingsSandbox } from "./settings-sandbox.js"
import { SettingsTheme } from "./settings-theme.js"
import { Button } from "./ui/button.js"

const TabIcons: Record<SettingsTab, React.ReactNode> = {
  accounts: <UserIcon className="size-4" />,
  refresh: <RefreshCwIcon className="size-4" />,
  sandbox: <BoxIcon className="size-4" />,
  theme: <PaletteIcon className="size-4" />,
  config: <FileIcon className="size-4" />,
  about: <InfoIcon className="size-4" />
}

const TabLabels: Record<SettingsTab, string> = {
  accounts: "Accounts",
  refresh: "Refresh",
  sandbox: "Sandbox",
  theme: "Theme",
  config: "Config",
  about: "About"
}

const isSettingsTab = (v: string | undefined): v is SettingsTab => SettingsTabs.includes(v as SettingsTab)

export function SettingsPage() {
  const { tab } = useParams<{ tab: string }>()
  const activeTab: SettingsTab = isSettingsTab(tab) ? tab : "accounts"
  const navigate = useNavigate()

  return (
    <div className="flex gap-6">
      <nav className="w-48 shrink-0">
        <Button variant="ghost" size="sm" className="mb-4 gap-2" onClick={() => navigate("/")}>
          <ArrowLeftIcon className="size-4" />
          Back to PRs
        </Button>
        <div className="flex flex-col gap-1" role="tablist">
          {SettingsTabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => navigate(`/settings/${id}`, { replace: true })}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors",
                activeTab === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {TabIcons[id]}
              {TabLabels[id]}
            </button>
          ))}
        </div>
      </nav>
      <div className="flex-1 min-w-0">
        {activeTab === "accounts" && <SettingsAccounts />}
        {activeTab === "refresh" && <SettingsRefresh />}
        {activeTab === "sandbox" && <SettingsSandbox />}
        {activeTab === "theme" && <SettingsTheme />}
        {activeTab === "config" && <SettingsConfig />}
        {activeTab === "about" && <SettingsAbout />}
      </div>
    </div>
  )
}
