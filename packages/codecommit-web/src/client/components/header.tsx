/**
 * Control Center-style application navigation and compact operational actions.
 *
 * The centered pill navigation keeps pull requests, sandboxes, activity, and
 * settings stable while refresh, reporting, notifications, theme, session,
 * and command-palette actions remain available from the quiet utility area.
 *
 * @module
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { IconButton } from "@knpkv/rly/primitives"
import {
  BarChart3Icon,
  BellIcon,
  ChevronDownIcon,
  EyeIcon,
  GitPullRequestIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SunIcon
} from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"
import { appStateAtom, notificationsSsoLogoutAtom, refreshAtom } from "../atoms/app.js"
import { commandPaletteAtom } from "../atoms/ui.js"
import styles from "./header.module.css"
import { useTheme } from "./theme-provider.js"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js"
import { Kbd } from "./ui/kbd.js"

interface NavigationItem {
  readonly active: (pathname: string) => boolean
  readonly label: string
  readonly to: string
}

const navigation: ReadonlyArray<NavigationItem> = [
  {
    active: (pathname) => pathname === "/" || pathname.startsWith("/accounts/"),
    label: "Pull requests",
    to: "/"
  },
  {
    active: (pathname) => pathname === "/sandboxes" || pathname.startsWith("/sandbox/"),
    label: "Sandboxes",
    to: "/sandboxes"
  },
  {
    active: (pathname) => pathname === "/notifications" || pathname === "/audit",
    label: "Activity",
    to: "/notifications"
  },
  { active: (pathname) => pathname.startsWith("/settings"), label: "Settings", to: "/settings" }
]

const userInitials = (user: string | undefined): string => {
  if (user === undefined) return ""
  const segments = user.split(/[.@_\s-]+/).filter((segment) => segment.length > 0)
  const initials = segments
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase())
    .join("")
  return initials || "U"
}

type SyncState = "connecting" | "error" | "live" | "loading"

interface SyncStatusProps {
  readonly detail: string
  readonly label: string
  readonly state: SyncState
}

/** Compact live status that keeps failures visible to sighted keyboard and touch users. */
export function SyncStatus({ detail, label, state }: SyncStatusProps) {
  return (
    <span aria-label={`${label}. ${detail}`} className={styles.status} role="status" title={detail}>
      <span aria-hidden="true" className={styles.statusDot} data-state={state} />
      <span className={styles.statusCopy}>{label}</span>
      {state === "error" ? <span className={styles.statusErrorDetail}>{detail}</span> : null}
    </span>
  )
}

export function Header() {
  const state = useAtomValue(appStateAtom)
  const refresh = useAtomSet(refreshAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const setCommandPaletteOpen = useAtomSet(commandPaletteAtom)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { setTheme, theme } = useTheme()
  const isLoading = state.status === "loading"
  const hasError = state.status === "error"
  const notifCount = state.unreadNotificationCount ?? 0
  const reviewCount = state.pendingReviewCount ?? 0
  const activeSandboxCount = (state.sandboxes ?? []).filter(
    (sandbox) =>
      sandbox.status === "running" ||
      sandbox.status === "creating" ||
      sandbox.status === "cloning" ||
      sandbox.status === "starting"
  ).length
  const updatedLabel = state.lastUpdated
    ? DateUtils.formatRelativeTime(state.lastUpdated, new Date())
    : "No completed sync yet"
  const status = hasError ? "error" : isLoading ? "loading" : state.lastUpdated ? "live" : "connecting"
  const statusLabel = hasError ? "Sync issue" : isLoading ? "Syncing" : state.lastUpdated ? "Live" : "Connecting"
  const statusDetail = hasError
    ? (state.error ?? "Unable to refresh pull requests")
    : (state.statusDetail ?? updatedLabel)
  const nextTheme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark"
  const ThemeIcon = theme === "dark" ? MoonIcon : theme === "light" ? SunIcon : MonitorIcon

  return (
    <header className={styles.header}>
      <Link aria-label="CodeCommit pull requests" className={styles.brand} to="/">
        <span aria-hidden="true" className={styles.brandMark}>
          <GitPullRequestIcon />
        </span>
        <span className={styles.brandName}>CodeCommit</span>
      </Link>

      <nav aria-label="Primary" className={styles.navigation}>
        {navigation.map((item) => {
          const active = item.active(pathname)
          const count = item.to === "/" ? reviewCount : item.to === "/sandboxes" ? activeSandboxCount : 0
          const countLabel = item.to === "/" ? "needing your review" : "active"
          return (
            <Link
              aria-current={active ? "page" : undefined}
              aria-label={count > 0 ? `${item.label}, ${count} ${countLabel}` : undefined}
              className={styles.navLink}
              key={item.label}
              to={item.to}
            >
              <span>{item.label}</span>
              {count > 0 ? (
                <span aria-hidden="true" className={styles.navCount}>
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>

      <div className={styles.utilities}>
        <SyncStatus detail={statusDetail} label={statusLabel} state={status} />

        <IconButton
          className={styles.commandButton}
          icon="search"
          label="Open command palette"
          onClick={() => setCommandPaletteOpen(true)}
          size="compact"
          variant="quiet"
        />

        <button
          aria-label={notifCount > 0 ? `Notifications, ${notifCount} unread` : "Notifications"}
          className={styles.iconButton}
          onClick={() => navigate("/notifications")}
          title="Notifications"
          type="button"
        >
          <BellIcon aria-hidden="true" />
          {notifCount > 0 ? (
            <span aria-hidden="true" className={styles.notificationCount}>
              {notifCount > 99 ? "99+" : notifCount}
            </span>
          ) : null}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={state.currentUser ? `Open account menu for ${state.currentUser}` : "Open application menu"}
              className={styles.userButton}
              type="button"
            >
              {state.currentUser ? (
                <>
                  <span aria-hidden="true" className={styles.avatar}>
                    {userInitials(state.currentUser)}
                  </span>
                  <span className={styles.userName}>{state.currentUser}</span>
                  <ChevronDownIcon aria-hidden="true" className={styles.userChevron} />
                </>
              ) : (
                <MoreHorizontalIcon aria-hidden="true" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent aria-label="Application actions" className={styles.menu} sideOffset={10}>
            {state.currentUser ? (
              <div className={styles.menuIdentity}>
                <span>Signed in as</span>
                <strong>{state.currentUser}</strong>
              </div>
            ) : null}
            <DropdownMenuItem onSelect={() => setCommandPaletteOpen(true)}>
              <span className={styles.menuIcon} aria-hidden="true">
                ⌘
              </span>
              Command palette
              <Kbd className={styles.shortcut}>⌘P</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isLoading} onSelect={() => refresh({})}>
              <RefreshCwIcon className={isLoading ? styles.spinning : undefined} />
              {isLoading ? "Refreshing…" : "Refresh pull requests"}
            </DropdownMenuItem>
            {reviewCount > 0 ? (
              <DropdownMenuItem onSelect={() => navigate("/?review=1")}>
                <EyeIcon />
                Needs my review
                <span className={styles.menuCount}>{reviewCount}</span>
              </DropdownMenuItem>
            ) : null}
            <div className={styles.menuSeparator} role="separator" />
            <DropdownMenuItem onSelect={() => navigate("/stats")}>
              <BarChart3Icon />
              Statistics
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate("/audit")}>
              <ScrollTextIcon />
              Audit log
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-label={`Cycle theme. Current theme: ${theme}. Next theme: ${nextTheme}.`}
              onSelect={() => setTheme(nextTheme)}
            >
              <ThemeIcon />
              Theme: {theme}
            </DropdownMenuItem>
            {state.currentUser ? (
              <>
                <div className={styles.menuSeparator} role="separator" />
                <DropdownMenuItem onSelect={() => ssoLogout({})}>
                  <LogOutIcon />
                  Log out
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
