import { useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import { useEffect, useRef, useState } from "react"
import { commandPaletteAtom, viewAtom, quickFilterAtom } from "../../atoms/ui.js"
import { refreshAtom } from "../../atoms/app.js"
import { useTheme } from "../../theme/index.js"
import styles from "./CommandPalette.module.css"

interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
}

export function CommandPalette() {
  const { theme } = useTheme()
  const isOpen = useAtomValue(commandPaletteAtom)
  const setIsOpen = useAtomSet(commandPaletteAtom)
  const setView = useAtomSet(viewAtom)
  const setQuickFilter = useAtomSet(quickFilterAtom)
  const refresh = useAtomSet(refreshAtom)

  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands: Command[] = [
    {
      id: "refresh",
      label: "Refresh PRs",
      shortcut: "r",
      action: () => {
        refresh({})
        setIsOpen(false)
      }
    },
    {
      id: "view-prs",
      label: "View: PR List",
      action: () => {
        setView("prs")
        setIsOpen(false)
      }
    },
    {
      id: "filter-all",
      label: "Filter: All",
      shortcut: "1",
      action: () => {
        setQuickFilter({ type: "all" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-mine",
      label: "Filter: Mine",
      shortcut: "2",
      action: () => {
        setQuickFilter({ type: "mine" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-account",
      label: "Filter: By Account",
      shortcut: "3",
      action: () => {
        setQuickFilter({ type: "account" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-author",
      label: "Filter: By Author",
      shortcut: "4",
      action: () => {
        setQuickFilter({ type: "author" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-scope",
      label: "Filter: By Scope",
      shortcut: "5",
      action: () => {
        setQuickFilter({ type: "scope" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-repo",
      label: "Filter: By Repository",
      shortcut: "6",
      action: () => {
        setQuickFilter({ type: "repo" })
        setIsOpen(false)
      }
    },
    {
      id: "filter-status",
      label: "Filter: By Status",
      shortcut: "7",
      action: () => {
        setQuickFilter({ type: "status" })
        setIsOpen(false)
      }
    }
  ]

  const filteredCommands = commands.filter((cmd) => cmd.label.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => {
    if (isOpen) {
      setSearch("")
      setSelectedIndex(0)
      inputRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Open command palette
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault()
        setIsOpen((open) => !open)
        return
      }

      if (!isOpen) return

      if (e.key === "Escape") {
        e.preventDefault()
        setIsOpen(false)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        filteredCommands[selectedIndex]?.action()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isOpen, filteredCommands, selectedIndex, setIsOpen])

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  if (!isOpen) return null

  return (
    <div className={styles.overlay} onClick={() => setIsOpen(false)}>
      <div
        className={styles.palette}
        style={{ backgroundColor: theme.backgroundPanel, borderColor: theme.textMuted }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          style={{ backgroundColor: theme.background, color: theme.text, borderColor: theme.textMuted }}
          placeholder="Type a command..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.commands}>
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`${styles.command} ${i === selectedIndex ? styles.selected : ""}`}
              style={{
                backgroundColor: i === selectedIndex ? theme.primary : "transparent",
                color: i === selectedIndex ? theme.background : theme.text
              }}
              onClick={() => cmd.action()}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span>{cmd.label}</span>
              {cmd.shortcut && (
                <span
                  className={styles.shortcut}
                  style={{ color: i === selectedIndex ? theme.background : theme.textMuted }}
                >
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))}
          {filteredCommands.length === 0 && (
            <div className={styles.empty} style={{ color: theme.textMuted }}>
              No commands found
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
