import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import {
  BellIcon,
  LoaderIcon,
  LogOutIcon,
  MoonIcon,
  RefreshCwIcon,
  SettingsIcon,
  SunIcon,
  UserIcon
} from "lucide-react"
import { useNavigate } from "react-router"
import { appStateAtom, notificationsSsoLogoutAtom, refreshAtom } from "../atoms/app.js"
import { cn } from "../lib/utils.js"
import { useTheme } from "./theme-provider.js"
import { Button } from "./ui/button.js"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js"
import { Kbd } from "./ui/kbd.js"
import { Separator } from "./ui/separator.js"

export function Header() {
  const state = useAtomValue(appStateAtom)
  const refresh = useAtomSet(refreshAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const navigate = useNavigate()
  const { setTheme, theme } = useTheme()
  const isLoading = state.status === "loading"
  const hasError = state.status === "error"
  const notifCount = state.unreadNotificationCount ?? 0

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
        <button className="text-sm font-semibold tracking-tight hover:text-foreground/80" onClick={() => navigate("/")}>
          codecommit
        </button>
        <Separator orientation="vertical" className="h-4" />
        {hasError && <span className="text-sm text-destructive">{state.error ?? "Error loading PRs"}</span>}
        {isLoading && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" />
            {state.statusDetail && <span className="font-mono opacity-60">{state.statusDetail}</span>}
          </span>
        )}
        {state.lastUpdated && !hasError && !isLoading && (
          <span className="text-xs text-muted-foreground">
            {DateUtils.formatRelativeTime(state.lastUpdated, new Date())}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {state.currentUser && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                  <UserIcon className="size-3" />
                  {state.currentUser}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => ssoLogout({})}>
                  <LogOutIcon className="size-3" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => refresh({})} disabled={isLoading}>
            <RefreshCwIcon className={cn("size-4", isLoading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon-sm" className="relative" onClick={() => navigate("/notifications")}>
            <BellIcon className="size-4" />
            {notifCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
                {notifCount > 9 ? "9+" : notifCount}
              </span>
            )}
            <span className="sr-only">Notifications</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/settings")}>
            <SettingsIcon className="size-4" />
            <span className="sr-only">Settings</span>
          </Button>
          <Kbd>⌘P</Kbd>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")}
          >
            <SunIcon className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <MoonIcon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>
        </div>
      </div>
    </header>
  )
}
