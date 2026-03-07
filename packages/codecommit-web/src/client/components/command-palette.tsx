import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { BellIcon, FilterIcon, FlameIcon, RefreshCwIcon, SettingsIcon } from "lucide-react"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { refreshAtom } from "../atoms/app.js"
import { commandPaletteAtom, FILTER_KEYS, type FilterKey, type SettingsTab } from "../atoms/ui.js"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from "./ui/command.js"

const FILTER_LABELS: Record<FilterKey, string> = {
  account: "Account",
  author: "Author",
  approver: "Approver",
  commenter: "Commenter",
  scope: "Scope",
  repo: "Repo",
  status: "Status",
  size: "Size"
}

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
          <CommandItem
            onSelect={() => {
              navigate("/?hot=1")
              setIsOpen(false)
            }}
          >
            <FlameIcon />
            Hot
          </CommandItem>
          {FILTER_KEYS.map((key) => (
            <CommandItem
              key={key}
              onSelect={() => {
                navigate(`/?f=${key}:`)
                setIsOpen(false)
              }}
            >
              <FilterIcon />
              Filter: {FILTER_LABELS[key]}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
