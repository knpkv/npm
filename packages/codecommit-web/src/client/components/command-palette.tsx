import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { FilterIcon, RefreshCwIcon } from "lucide-react"
import { useEffect } from "react"
import { refreshAtom } from "../atoms/app.js"
import { commandPaletteAtom, quickFilterAtom, type QuickFilterType, viewAtom } from "../atoms/ui.js"
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
