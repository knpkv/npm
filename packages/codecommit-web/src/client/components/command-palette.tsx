import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { BellIcon, FilterIcon, RefreshCwIcon, SettingsIcon } from "lucide-react"
import { useEffect } from "react"
import { refreshAtom } from "../atoms/app.js"
import {
  commandPaletteAtom,
  quickFilterAtom,
  type QuickFilterType,
  type SettingsTab,
  settingsTabAtom,
  viewAtom
} from "../atoms/ui.js"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "./ui/command.js"

const QUICK_FILTERS: Array<{ key: QuickFilterType; label: string; shortcut: string }> = [
  { key: "all", label: "All", shortcut: "1" },
  { key: "mine", label: "Mine", shortcut: "2" },
  { key: "account", label: "Account", shortcut: "3" },
  { key: "author", label: "Author", shortcut: "4" },
  { key: "scope", label: "Scope", shortcut: "5" },
  { key: "repo", label: "Repo", shortcut: "6" },
  { key: "status", label: "Status", shortcut: "7" }
]

export function CommandPalette() {
  const isOpen = useAtomValue(commandPaletteAtom)
  const setIsOpen = useAtomSet(commandPaletteAtom)
  const setView = useAtomSet(viewAtom)
  const setQuickFilter = useAtomSet(quickFilterAtom)
  const refresh = useAtomSet(refreshAtom)
  const setSettingsTab = useAtomSet(settingsTabAtom)

  const openSettings = (tab?: SettingsTab) => {
    setView("settings")
    if (tab) setSettingsTab(tab)
    setIsOpen(false)
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "p" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setIsOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [setIsOpen])

  return (
    <CommandDialog open={isOpen} onOpenChange={setIsOpen} showCloseButton={false}>
      <CommandInput placeholder="Type a command..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              refresh({})
              setIsOpen(false)
            }}
          >
            <RefreshCwIcon />
            Refresh PRs
            <CommandShortcut>R</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setView("prs")
              setIsOpen(false)
            }}
          >
            <FilterIcon />
            View: PR List
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setView("notifications")
              setIsOpen(false)
            }}
          >
            <BellIcon />
            View: Notifications
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => openSettings()}>
            <SettingsIcon />
            Open Settings
          </CommandItem>
          <CommandItem onSelect={() => openSettings("accounts")}>
            <SettingsIcon />
            Settings: Accounts
          </CommandItem>
          <CommandItem onSelect={() => openSettings("theme")}>
            <SettingsIcon />
            Settings: Theme
          </CommandItem>
          <CommandItem onSelect={() => openSettings("config")}>
            <SettingsIcon />
            Settings: Config
          </CommandItem>
          <CommandItem onSelect={() => openSettings("about")}>
            <SettingsIcon />
            Settings: About
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Filters">
          {QUICK_FILTERS.map((f) => (
            <CommandItem
              key={f.key}
              onSelect={() => {
                if (f.key === "all") {
                  setQuickFilter({ type: "all" })
                } else {
                  setQuickFilter({ type: f.key })
                }
                setIsOpen(false)
              }}
            >
              <FilterIcon />
              Filter: {f.label}
              <CommandShortcut>{f.shortcut}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
