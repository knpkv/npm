import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react"
import { appStateAtom, refreshAtom } from "../atoms/app.js"
import { cn } from "../lib/utils.js"
import { useTheme } from "./theme-provider.js"
import { Button } from "./ui/button.js"
import { Kbd } from "./ui/kbd.js"
import { Separator } from "./ui/separator.js"

export function Header() {
  const state = useAtomValue(appStateAtom)
  const refresh = useAtomSet(refreshAtom)
  const { setTheme, theme } = useTheme()
  const isLoading = state.status === "loading"
  const hasError = state.status === "error"

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
        <span className="text-sm font-semibold tracking-tight">codecommit</span>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm text-muted-foreground">{state.pullRequests.length} PRs</span>
        {hasError && <span className="text-sm text-destructive">{state.error ?? "Error loading PRs"}</span>}
        {state.lastUpdated && !hasError && (
          <span className="text-xs text-muted-foreground">
            {DateUtils.formatRelativeTime(state.lastUpdated, new Date())}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => refresh({})} disabled={isLoading}>
            <RefreshCwIcon className={cn("size-4", isLoading && "animate-spin")} />
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
