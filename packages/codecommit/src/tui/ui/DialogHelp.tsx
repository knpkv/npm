import { useAtomValue } from "@effect-atom/atom-react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useMemo, useRef } from "react"
import { viewAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"

interface HelpItem {
  readonly key: string
  readonly description: string
}

const HELP_ITEMS: Record<string, Array<HelpItem>> = {
  prs: [
    { key: "f", description: "Filter PRs" },
    { key: "1", description: "All PRs" },
    { key: "2", description: "My PRs" },
    { key: "3", description: "By Account" },
    { key: "4", description: "By Author" },
    { key: "5", description: "By Scope" },
    { key: "6", description: "By Age" },
    { key: "←→", description: "Cycle filter values" },
    { key: "Enter", description: "PR Details" },
    { key: "o", description: "Open PR in browser" },
    { key: "s", description: "Manage Accounts" },
    { key: "n", description: "Notifications" }
  ],
  settings: [
    { key: "Enter", description: "Toggle account sync" },
    { key: "s", description: "Back to PRs" },
    { key: "n", description: "Notifications" }
  ],
  notifications: [
    { key: "Enter", description: "Run action" },
    { key: "c", description: "Clear all" },
    { key: "s", description: "Manage Accounts" },
    { key: "n", description: "Back to PRs" }
  ],
  details: [
    { key: "Esc", description: "Back to list" },
    { key: "Enter", description: "Open in browser" }
  ]
}

const COMMON_ITEMS: Array<HelpItem> = [
  { key: ":", description: "Command palette" },
  { key: "r", description: "Refresh" },
  { key: "t", description: "Theme" },
  { key: "h", description: "Help" },
  { key: "Esc", description: "Close / Clear" },
  { key: "q", description: "Quit" }
]

/**
 * Help modal showing keyboard shortcuts for current view
 * @category ui
 */
export function DialogHelp() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const view = useAtomValue(viewAtom)
  const scrollRef = useRef<ScrollBoxRenderable>(null)

  const items = useMemo(() => {
    const viewItems = HELP_ITEMS[view as keyof typeof HELP_ITEMS] || []
    return [...viewItems, { key: "─", description: "───────────────" }, ...COMMON_ITEMS]
  }, [view])

  useKeyboard((key: { name: string }) => {
    if (key.name === "escape" || key.name === "h" || key.name === "return") {
      dialog.hide()
    }
  })

  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: "20%",
        width: "60%",
        height: Math.min(items.length + 2, 18),
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
        <text fg={theme.primary}>KEYBOARD SHORTCUTS</text>
      </box>
      <scrollbox
        ref={scrollRef}
        style={{
          flexGrow: 1,
          width: "100%"
        }}
      >
        {items.map((item, i) => (
          <box
            key={i}
            style={{
              height: 1,
              width: "100%",
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row"
            }}
          >
            <box style={{ width: 8 }}>
              <text fg={item.key === "─" ? theme.textMuted : theme.primary}>{item.key}</text>
            </box>
            <text fg={theme.text}>{item.description}</text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
}
