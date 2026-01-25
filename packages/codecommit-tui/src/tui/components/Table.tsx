import type { ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef } from "react"
import { useTheme } from "../context/theme.js"

export interface Column<T> {
  readonly header: string
  readonly width?: number | `${number}%` | "auto"
  readonly render: (item: T, selected: boolean) => React.ReactNode
}

interface TableProps<T> {
  readonly data: ReadonlyArray<T>
  readonly columns: ReadonlyArray<Column<T>>
  readonly keyExtractor: (item: T) => string | number
  readonly hideHeader?: boolean
  readonly selectedIndex?: number
  readonly renderRow?: (item: T, index: number, isSelected: boolean) => React.ReactNode
}

/**
 * Reusable Table component for TUI
 * @category components
 */
export function Table<T>({ data, columns, keyExtractor, hideHeader, selectedIndex, renderRow }: TableProps<T>) {
  const { theme } = useTheme()
  const scrollRef = useRef<ScrollBoxRenderable>(null)

  // Auto-scroll to selected index
  useEffect(() => {
    if (selectedIndex !== undefined && scrollRef.current) {
      // Row height calculation?
      // Rows have paddingBottom: 1. Content height depends on render?
      // Assuming row height 2 (like MainList)?
      // If we assume height 2.
      const targetY = Math.max(0, (selectedIndex - 2) * 2)
      scrollRef.current.scrollTo({ x: 0, y: targetY })
    }
  }, [selectedIndex])

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }} border={["left"]} borderColor={theme.primary}>
      {/* Header */}
      {!hideHeader && (
        <box
          flexDirection="row"
          border={["bottom"]}
          borderColor={theme.textMuted}
          style={{ width: "100%", paddingBottom: 0 }}
        >
          {columns.map((col, i) => (
            <box
              key={i}
              style={{
                width: (col.width === "auto" ? 0 : col.width) as any,
                flexGrow: col.width === "auto" || !col.width ? 1 : 0,
                paddingRight: 1
              }}
            >
              <text fg={theme.textMuted}>{col.header}</text>
            </box>
          ))}
        </box>
      )}

      {/* Rows */}
      <scrollbox
        ref={scrollRef}
        style={{
          flexGrow: 1,
          width: "100%",
          backgroundColor: theme.backgroundPanel
        }}
      >
        <box flexDirection="column" style={{ width: "100%" }}>
          {data.map((item, i) => {
            const selected = i === selectedIndex
            return (
              <box
                key={keyExtractor(item)}
                flexDirection="row"
                style={{
                  width: "100%",
                  paddingTop: 0,
                  paddingBottom: 1,
                  ...(selected ? { backgroundColor: theme.selectedBackground } : {})
                }}
              >
                {columns.map((col, j) => (
                  <box
                    key={j}
                    style={{
                      width: (col.width === "auto" ? 0 : col.width) as any,
                      flexGrow: col.width === "auto" || !col.width ? 1 : 0,
                      paddingRight: 1
                    }}
                  >
                    {col.render(item, selected)}
                  </box>
                ))}
              </box>
            )
          })}
        </box>
      </scrollbox>
    </box>
  )
}
