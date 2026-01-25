import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { themeAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { themes } from "../theme/themes.js"

export function DialogTheme() {
  const currentThemeId = useAtomValue(themeAtom)
  const [originalThemeId] = useState(currentThemeId)

  const { theme } = useTheme()
  const setTheme = useAtomSet(themeAtom)
  const dialog = useDialog()
  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const visibleHeight = 11 // 15 max height - 3 for border/header - 1 for padding

  const allThemes = useMemo(
    () =>
      Object.keys(themes)
        .sort()
        .map((name) => ({ id: name, label: name })),
    []
  )

  const filteredThemes = useMemo(() => {
    if (!search) return allThemes
    const s = search.toLowerCase()
    return allThemes.filter((t) => t.label.toLowerCase().includes(s))
  }, [allThemes, search])

  // Set initial selection to current theme
  useEffect(() => {
    if (!search) {
      const idx = filteredThemes.findIndex((t) => t.id === currentThemeId)
      if (idx >= 0) {
        setSelectedIndex(idx)
        // Set initial scroll to show item with margin
        const initialOffset = Math.max(0, idx - 1)
        setScrollOffset(initialOffset)
        if (scrollRef.current) {
          scrollRef.current.scrollTo({ x: 0, y: initialOffset })
        }
      }
    }
  }, [])

  // Scroll to keep selected item visible with 1-item margin
  useEffect(() => {
    if (!scrollRef.current) return
    let newOffset = scrollOffset
    if (selectedIndex < scrollOffset + 1) {
      newOffset = Math.max(0, selectedIndex - 1)
    } else if (selectedIndex > scrollOffset + visibleHeight - 2) {
      newOffset = selectedIndex - visibleHeight + 2
    }
    if (newOffset !== scrollOffset) {
      setScrollOffset(newOffset)
      scrollRef.current.scrollTo({ x: 0, y: newOffset })
    }
  }, [selectedIndex, scrollOffset, visibleHeight])

  // Live preview
  useEffect(() => {
    const selected = filteredThemes[selectedIndex]
    if (selected) {
      setTheme(selected.id)
    }
  }, [selectedIndex, filteredThemes, setTheme])

  useKeyboard((key: { name: string; char?: string }) => {
    if (key.name === "escape") {
      setTheme(originalThemeId)
      dialog.hide()
    } else if (key.name === "return") {
      dialog.hide()
    } else if (key.name === "down") {
      setSelectedIndex((i) => Math.min(i + 1, filteredThemes.length - 1))
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
        height: Math.min(filteredThemes.length + 3, 15),
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
        {filteredThemes.map((t, i) => (
          <box
            key={t.id}
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
              {t.id === currentThemeId ? `${t.label} (current)` : t.label}
            </text>
          </box>
        ))}
        {filteredThemes.length === 0 && (
          <box style={{ height: 1, paddingLeft: 1 }}>
            <text fg={theme.textMuted}>No themes found</text>
          </box>
        )}
      </scrollbox>
    </box>
  )
}
