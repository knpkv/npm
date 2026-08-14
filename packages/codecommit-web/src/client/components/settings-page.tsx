/**
 * Settings page — tabbed layout for all app settings.
 *
 * Renders a side navigation driven by {@link SettingsTabs} (accounts,
 * refresh, sandbox, notifications, permissions, audit, theme, config,
 * about) with URL-based tab routing (`/settings/:tab`). Each tab
 * renders its corresponding settings component.
 *
 * @module
 */
import {
  ArrowLeftIcon,
  BellIcon,
  BoxIcon,
  FileIcon,
  InfoIcon,
  PaletteIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  UserIcon
} from "lucide-react"
import type { ReactNode } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { type SettingsTab, SettingsTabs } from "../atoms/ui.js"
import { SettingsAbout } from "./settings-about.js"
import { SettingsAccounts } from "./settings-accounts.js"
import { SettingsAudit } from "./settings-audit.js"
import { SettingsConfig } from "./settings-config.js"
import { SettingsNotifications } from "./settings-notifications.js"
import { SettingsPermissions } from "./settings-permissions.js"
import { SettingsRefresh } from "./settings-refresh.js"
import { SettingsSandbox } from "./settings-sandbox.js"
import { SettingsTheme } from "./settings-theme.js"
import styles from "./settings-page.module.css"
import { Button } from "./ui/button.js"

const TabIcons = {
  accounts: <UserIcon className="size-4" />,
  refresh: <RefreshCwIcon className="size-4" />,
  sandbox: <BoxIcon className="size-4" />,
  notifications: <BellIcon className="size-4" />,
  permissions: <ShieldCheckIcon className="size-4" />,
  audit: <ScrollTextIcon className="size-4" />,
  theme: <PaletteIcon className="size-4" />,
  config: <FileIcon className="size-4" />,
  about: <InfoIcon className="size-4" />
} satisfies Record<SettingsTab, ReactNode>

const TabLabels = {
  accounts: "Accounts",
  refresh: "Refresh",
  sandbox: "Sandbox",
  notifications: "Notifications",
  permissions: "Permissions",
  audit: "Audit",
  theme: "Theme",
  config: "Config",
  about: "About"
} satisfies Record<SettingsTab, string>

const isSettingsTab = (v: string | undefined): v is SettingsTab => SettingsTabs.some((tab) => tab === v)

export function SettingsPage() {
  const { tab } = useParams<{ tab: string }>()
  const activeTab: SettingsTab = isSettingsTab(tab) ? tab : "accounts"
  const navigate = useNavigate()

  return (
    <div className={styles.layout}>
      <nav aria-label="Settings" className={styles.sidebar}>
        <Button className={styles.backButton} onClick={() => navigate("/")} size="sm" variant="ghost">
          <ArrowLeftIcon className="size-4" />
          Back to PRs
        </Button>
        <div className={styles.tabList}>
          {SettingsTabs.map((id) => (
            <Link
              aria-current={activeTab === id ? "page" : undefined}
              className={styles.tab}
              data-active={activeTab === id ? "true" : undefined}
              key={id}
              to={`/settings/${id}`}
            >
              {TabIcons[id]}
              <span>{TabLabels[id]}</span>
            </Link>
          ))}
        </div>
      </nav>
      <section aria-label={`${TabLabels[activeTab]} settings`} className={styles.content}>
        {activeTab === "accounts" && <SettingsAccounts />}
        {activeTab === "refresh" && <SettingsRefresh />}
        {activeTab === "sandbox" && <SettingsSandbox />}
        {activeTab === "notifications" && <SettingsNotifications />}
        {activeTab === "permissions" && <SettingsPermissions />}
        {activeTab === "audit" && <SettingsAudit />}
        {activeTab === "theme" && <SettingsTheme />}
        {activeTab === "config" && <SettingsConfig />}
        {activeTab === "about" && <SettingsAbout />}
      </section>
    </div>
  )
}
