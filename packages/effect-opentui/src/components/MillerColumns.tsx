/**
 * MillerColumns React component for Finder-style column navigation.
 */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"

/**
 * Configuration for a column in MillerColumns.
 *
 * @category models
 */
export interface ColumnConfig<T> {
  readonly id: string
  readonly renderItem: (item: T) => string
  readonly getChildren?: (item: T) => Promise<ReadonlyArray<T>>
}

/**
 * Status bar configuration.
 *
 * @category models
 */
export interface StatusBarConfig {
  readonly user?: string
  readonly connected?: boolean
  readonly extra?: string
}

/**
 * Configuration for MillerColumns component.
 *
 * @category models
 */
export interface MillerColumnsConfig<T> {
  readonly columns: ReadonlyArray<ColumnConfig<T>>
  readonly initialItems: ReadonlyArray<T>
  readonly preview?: (item: T) => Promise<string>
  readonly actions?: Record<string, (item: T) => Promise<void>>
  readonly onQuit?: () => void
  readonly statusBar?: StatusBarConfig
}

/**
 * MillerColumns state.
 */
interface MillerState<T> {
  readonly focusedColumn: number
  readonly selectedIndices: Record<number, number>
  readonly columnData: Record<number, ReadonlyArray<T>>
  readonly previewContent: string
  readonly loading: boolean
}

/**
 * MillerColumns React component.
 *
 * @category components
 */
export function MillerColumns<T>(props: MillerColumnsConfig<T>) {
  const dimensions = useTerminalDimensions()

  const [state, setState] = useState<MillerState<T>>({
    focusedColumn: 0,
    selectedIndices: { 0: 0 },
    columnData: { 0: props.initialItems },
    previewContent: "",
    loading: false
  })

  const getSelectedItem = useCallback((): T | undefined => {
    const items = state.columnData[state.focusedColumn]
    const idx = state.selectedIndices[state.focusedColumn] ?? 0
    return items?.[idx]
  }, [state.columnData, state.focusedColumn, state.selectedIndices])

  // Load preview on selection change
  useEffect(() => {
    const item = getSelectedItem()
    if (item && props.preview) {
      setState((s) => ({ ...s, loading: true }))
      props
        .preview(item)
        .then((content) => {
          setState((s) => ({ ...s, previewContent: content, loading: false }))
        })
        .catch(() => {
          setState((s) => ({ ...s, previewContent: "Error loading preview", loading: false }))
        })
    }
  }, [state.focusedColumn, state.selectedIndices, getSelectedItem, props])

  // Keyboard navigation
  useKeyboard((key) => {
    const col = state.focusedColumn
    const items = state.columnData[col] ?? []
    const idx = state.selectedIndices[col] ?? 0

    if (key.name === "up" || key.name === "k") {
      if (idx > 0) {
        setState((s) => ({
          ...s,
          selectedIndices: { ...s.selectedIndices, [col]: idx - 1 }
        }))
      }
    } else if (key.name === "down" || key.name === "j") {
      if (idx < items.length - 1) {
        setState((s) => ({
          ...s,
          selectedIndices: { ...s.selectedIndices, [col]: idx + 1 }
        }))
      }
    } else if (key.name === "left" || key.name === "h") {
      if (col > 0) {
        setState((s) => ({ ...s, focusedColumn: col - 1 }))
      }
    } else if (key.name === "right" || key.name === "l" || key.name === "return") {
      const item = getSelectedItem()
      const colConfig = props.columns[col]
      if (item && colConfig?.getChildren && col < props.columns.length - 1) {
        setState((s) => ({ ...s, loading: true }))
        colConfig
          .getChildren(item)
          .then((children) => {
            setState((s) => ({
              ...s,
              focusedColumn: col + 1,
              columnData: { ...s.columnData, [col + 1]: children },
              selectedIndices: { ...s.selectedIndices, [col + 1]: 0 },
              loading: false
            }))
          })
          .catch(() => {
            setState((s) => ({ ...s, loading: false }))
          })
      }
    } else if (key.name === "q" || key.name === "escape") {
      props.onQuit?.()
    } else if (props.actions && key.name) {
      const action = props.actions[key.name]
      const item = getSelectedItem()
      if (action && item) {
        action(item).catch(() => {})
      }
    }
  })

  // Layout calculations
  const statusBarHeight = 1
  const contentHeight = dimensions.height - statusBarHeight - 1
  const totalColumns = props.columns.length + (props.preview ? 1 : 0)
  const columnWidth = Math.floor(dimensions.width / totalColumns)

  return (
    <box width={dimensions.width} height={dimensions.height} flexDirection="column">
      {/* Main content area */}
      <box width={dimensions.width} height={contentHeight} flexDirection="row">
        {props.columns.map((colConfig, colIdx) => {
          const items = state.columnData[colIdx] ?? []
          const selectedIdx = state.selectedIndices[colIdx] ?? 0
          const isFocused = colIdx === state.focusedColumn

          return (
            <box
              key={colConfig.id}
              width={columnWidth}
              height={contentHeight}
              border={true}
              borderColor={isFocused ? "#3b82f6" : "#404040"}
            >
              <scrollbox height={contentHeight - 2}>
                {items.length === 0 ? (
                  <text fg="#666666" paddingLeft={1}>
                    Empty
                  </text>
                ) : (
                  items.map((item, itemIdx) => {
                    const isSelected = itemIdx === selectedIdx
                    return (
                      <box
                        key={itemIdx}
                        backgroundColor={isSelected && isFocused ? "#3b82f6" : isSelected ? "#333333" : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text fg={isSelected && isFocused ? "#ffffff" : isSelected ? "#aaaaaa" : "#e5e5e5"}>
                          {colConfig.renderItem(item)}
                        </text>
                      </box>
                    )
                  })
                )}
              </scrollbox>
            </box>
          )
        })}

        {/* Preview column */}
        {props.preview && (
          <box width={columnWidth} height={contentHeight} border={true} borderColor="#404040" title=" Preview ">
            <scrollbox height={contentHeight - 2}>
              {state.loading ? (
                <text fg="#666666" paddingLeft={1}>
                  Loading...
                </text>
              ) : (
                <text fg="#e5e5e5" paddingLeft={1}>
                  {state.previewContent || "Select an item"}
                </text>
              )}
            </scrollbox>
          </box>
        )}
      </box>

      {/* Status bar */}
      <box
        width={dimensions.width}
        height={statusBarHeight}
        backgroundColor="#1e1e1e"
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Left side - keybindings */}
        <box flexGrow={1} flexDirection="row" gap={2}>
          <text>
            <span style={{ fg: "#666666" }}>↑↓</span>
            <span style={{ fg: "#888888" }}> nav </span>
          </text>
          <text>
            <span style={{ fg: "#666666" }}>←→</span>
            <span style={{ fg: "#888888" }}> cols </span>
          </text>
          <text>
            <span style={{ fg: "#666666" }}>⏎</span>
            <span style={{ fg: "#888888" }}> expand </span>
          </text>
          <text>
            <span style={{ fg: "#666666" }}>q</span>
            <span style={{ fg: "#888888" }}> quit </span>
          </text>
          {props.actions &&
            Object.keys(props.actions).map((key) => (
              <text key={key}>
                <span style={{ fg: "#666666" }}>{key}</span>
                <span style={{ fg: "#888888" }}> action </span>
              </text>
            ))}
        </box>

        {/* Right side - status */}
        <box flexDirection="row" gap={2}>
          {props.statusBar?.extra && <text fg="#888888">{props.statusBar.extra}</text>}
          {props.statusBar?.user && (
            <text>
              <span style={{ fg: props.statusBar.connected ? "#22c55e" : "#ef4444" }}>●</span>
              <span style={{ fg: "#888888" }}> {props.statusBar.user}</span>
            </text>
          )}
          {state.loading && <text fg="#f59e0b">⟳</text>}
        </box>
      </box>
    </box>
  )
}
