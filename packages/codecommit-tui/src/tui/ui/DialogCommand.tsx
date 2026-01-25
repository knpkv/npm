import { useAtomSet } from "@effect-atom/atom-react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { clearNotificationsAtom, refreshAtom, setAllAccountsAtom } from "../atoms/app.js"
import {
  filterTextAtom,
  isFilteringAtom,
  isSettingsFilteringAtom,
  quickFilterTypeAtom,
  viewAtom
} from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { DialogCreatePR } from "./DialogCreatePR.js"
import { DialogTheme } from "./DialogTheme.js"
import { DialogHelp } from "./DialogHelp.js"

interface Command {
  readonly id: string
  readonly label: string
  readonly shortcut?: string
  readonly action: () => void
}

export function DialogCommand() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const visibleHeight = 11 // 15 max height - 3 for border/header - 1 for padding

  const refresh = useAtomSet(refreshAtom)
  const setView = useAtomSet(viewAtom)
  const setIsFiltering = useAtomSet(isFilteringAtom)
  const setIsSettingsFiltering = useAtomSet(isSettingsFilteringAtom)
  const setFilterText = useAtomSet(filterTextAtom)
  const clearNotifications = useAtomSet(clearNotificationsAtom)
  const setQuickFilterType = useAtomSet(quickFilterTypeAtom)
  const setAllAccounts = useAtomSet(setAllAccountsAtom)

  const commands: Command[] = useMemo(
    () => [
      { id: "create-pr", label: "Create Pull Request", shortcut: "c", action: () => dialog.show(() => <DialogCreatePR />) },
      { id: "refresh", label: "Refresh PRs", shortcut: "r", action: () => refresh() },
      { id: "filter", label: "Filter PRs", shortcut: "/", action: () => { setView("prs"); setIsFiltering(true) } },
      { id: "clear-filter", label: "Clear Filter", action: () => { setFilterText(""); setQuickFilterType("all") } },
      { id: "view-prs", label: "View: Pull Requests", shortcut: "Esc", action: () => setView("prs") },
      { id: "view-settings", label: "View: Settings", shortcut: "s", action: () => setView("settings") },
      { id: "view-notifications", label: "View: Notifications", shortcut: "n", action: () => setView("notifications") },
      { id: "filter-all", label: "Filter: All PRs", shortcut: "1", action: () => setQuickFilterType("all") },
      { id: "filter-mine", label: "Filter: My PRs", shortcut: "2", action: () => setQuickFilterType("mine") },
      { id: "filter-account", label: "Filter: By Account", shortcut: "3", action: () => setQuickFilterType("account") },
      { id: "filter-author", label: "Filter: By Author", shortcut: "4", action: () => setQuickFilterType("author") },
      { id: "filter-scope", label: "Filter: By Scope", shortcut: "5", action: () => setQuickFilterType("scope") },
      { id: "filter-date", label: "Filter: By Age", shortcut: "6", action: () => setQuickFilterType("date") },
      { id: "filter-repo", label: "Filter: By Repo", shortcut: "7", action: () => setQuickFilterType("repo") },
      { id: "filter-status", label: "Filter: By Status", shortcut: "8", action: () => setQuickFilterType("status") },
      { id: "settings-filter", label: "Settings: Filter Accounts", shortcut: "/", action: () => { setView("settings"); setIsSettingsFiltering(true) } },
      { id: "settings-all-on", label: "Settings: Enable All", shortcut: "a", action: () => setAllAccounts({ enabled: true }) },
      { id: "settings-all-off", label: "Settings: Disable All", shortcut: "d", action: () => setAllAccounts({ enabled: false }) },
      { id: "clear-notifications", label: "Clear Notifications", shortcut: "c", action: () => clearNotifications() },
      { id: "theme", label: "Change Theme", shortcut: "t", action: () => dialog.show(() => <DialogTheme />) },
      { id: "help", label: "Show Help", shortcut: "h", action: () => dialog.show(() => <DialogHelp />) },
    ],
    [refresh, setView, setIsFiltering, setIsSettingsFiltering, setFilterText, clearNotifications, setQuickFilterType, setAllAccounts, dialog]
  )

  const filteredCommands = useMemo(() => {
    if (!search) return commands
    const s = search.toLowerCase()
    return commands.filter((cmd) => cmd.label.toLowerCase().includes(s) || cmd.id.includes(s))
  }, [commands, search])

  // Scroll to keep selected item visible with 1-item margin
  useEffect(() => {
    if (!scrollRef.current) return
    let newOffset = scrollOffset
    // If selection is above visible area (with 1-item margin)
    if (selectedIndex < scrollOffset + 1) {
      newOffset = Math.max(0, selectedIndex - 1)
    }
    // If selection is below visible area (with 1-item margin)
    else if (selectedIndex > scrollOffset + visibleHeight - 2) {
      newOffset = selectedIndex - visibleHeight + 2
    }
    if (newOffset !== scrollOffset) {
      setScrollOffset(newOffset)
      scrollRef.current.scrollTo({ x: 0, y: newOffset })
    }
  }, [selectedIndex, scrollOffset, visibleHeight])

  useKeyboard((key: { name: string; char?: string }) => {
    if (key.name === "escape") {
      dialog.hide()
    } else if (key.name === "return") {
      const cmd = filteredCommands[selectedIndex]
      if (cmd) {
        dialog.hide()
        cmd.action()
      }
    } else if (key.name === "down") {
      setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
    } else if (key.name === "up") {
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (key.name === "backspace") {
      setSearch((s) => s.slice(0, -1))
      setSelectedIndex(0)
      setScrollOffset(0)
    } else {
      const char = key.char || (key.name?.length === 1 ? key.name : null)
      if (char && char.length === 1) {
        setSearch((s) => s + char)
        setSelectedIndex(0)
        setScrollOffset(0)
      }
    }
  })

  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: "20%",
        width: "60%",
        height: Math.min(filteredCommands.length + 3, 15),
        backgroundColor: theme.backgroundElement,
        borderStyle: "rounded",
        borderColor: theme.primary,
        flexDirection: "column"
      }}
    >
      <box
        style={{
          height: 1,
          width: "100%",
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "row",
          backgroundColor: theme.backgroundHeader
        }}
      >
        <text fg={theme.text}>{`> ${search}`}</text>
        <text fg={theme.primary}>{"│"}</text>
      </box>
      <scrollbox
        ref={scrollRef}
        style={{
          flexGrow: 1,
          width: "100%"
        }}
      >
        {filteredCommands.map((cmd, i) => (
          <box
            key={cmd.id}
            style={{
              height: 1,
              width: "100%",
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              ...(i === selectedIndex && { backgroundColor: theme.primary })
            }}
          >
            <text fg={i === selectedIndex ? theme.selectedText : theme.text}>
              {cmd.shortcut ? `${cmd.label}  [${cmd.shortcut}]` : cmd.label}
            </text>
          </box>
        ))}
        {filteredCommands.length === 0 && (
          <box style={{ height: 1, paddingLeft: 1 }}>
            <text fg={theme.textMuted}>No commands found</text>
          </box>
        )}
      </scrollbox>
    </box>
  )
}
