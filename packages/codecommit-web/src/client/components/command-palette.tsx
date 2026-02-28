import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { BellIcon, FilterIcon, RefreshCwIcon, SettingsIcon } from "lucide-react"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { refreshAtom } from "../atoms/app.js"
import { commandPaletteAtom, type QuickFilterType, type SettingsTab } from "../atoms/ui.js"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from "./ui/command.js"

const QUICK_FILTERS: Array<{ key: QuickFilterType; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "account", label: "Account" },
  { key: "author", label: "Author" },
  { key: "scope", label: "Scope" },
  { key: "repo", label: "Repo" },
  { key: "status", label: "Status" }
]

export function CommandPalette() {
  const isOpen = useAtomValue(commandPaletteAtom)
  const setIsOpen = useAtomSet(commandPaletteAtom)
  const navigate = useNavigate()
  const refresh = useAtomSet(refreshAtom)

  const openSettings = (tab?: SettingsTab) => {
    navigate(tab ? `/settings/${tab}` : "/settings")
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
          </CommandItem>
          <CommandItem
            onSelect={() => {
              navigate("/")
              setIsOpen(false)
            }}
          >
            <FilterIcon />
            View: PR List
          </CommandItem>
          <CommandItem
            onSelect={() => {
              navigate("/notifications")
              setIsOpen(false)
            }}
          >
            <BellIcon />
            View: Notifications
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
                navigate(f.key === "all" ? "/" : `/?filter=${f.key}`)
                setIsOpen(false)
              }}
            >
              <FilterIcon />
              Filter: {f.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
