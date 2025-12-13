/**
 * MillerColumns component for Finder-style column navigation.
 */
import { BoxRenderable, SelectRenderable } from "@opentui/core"
import { Effect, Fiber, Option, Ref, Stream } from "effect"
import { keyEvents } from "../input/Keyboard.ts"
import { Renderer } from "../Renderer.ts"
import type { RendererError } from "../RendererError.ts"
import { type ColumnDef, updateColumnFocus, updateColumnOptions } from "./Column.ts"
import {
  type ColumnState,
  getSelectedItem,
  makeColumnState,
  setColumnData,
  setFocusedColumn,
  setSelectedIndex
} from "./ColumnState.ts"
import { isActionKey, parseNavKey } from "./KeyboardNavigation.ts"

/**
 * Configuration for MillerColumns component.
 *
 * @category models
 */
export interface MillerColumnsConfig<T> {
  readonly columns: ReadonlyArray<
    ColumnDef<T> & {
      readonly getChildren?: (item: T) => Effect.Effect<ReadonlyArray<T>, RendererError>
    }
  >
  readonly initialItems: Effect.Effect<ReadonlyArray<T>, RendererError>
  readonly preview?: (item: T) => Effect.Effect<string, RendererError>
  readonly actions?: Record<string, (item: T) => Effect.Effect<void, RendererError>>
  readonly onQuit?: Effect.Effect<void, RendererError>
}

/**
 * Creates a MillerColumns component with keyboard navigation.
 *
 * Supports:
 * - hjkl and arrow keys for navigation
 * - Enter to drill into selection
 * - Backspace to go back
 * - q/Escape to quit
 * - Custom action keys
 *
 * @category constructors
 * @example
 * import { Effect } from "effect"
 * import { Renderer, RendererLive } from "@knpkv/effect-opentui"
 * import { MillerColumns } from "@knpkv/effect-opentui/components"
 *
 * const program = Effect.gen(function*() {
 *   yield* MillerColumns({
 *     columns: [
 *       { id: "col1", renderItem: (x) => x.name },
 *       { id: "col2", renderItem: (x) => x.name, getChildren: (x) => fetchChildren(x) }
 *     ],
 *     initialItems: Effect.succeed([{ name: "Item 1" }, { name: "Item 2" }])
 *   })
 * })
 */
export const MillerColumns = <T>(
  config: MillerColumnsConfig<T>
): Effect.Effect<void, RendererError, Renderer> =>
  Effect.gen(function*() {
    const { cli, root, start, stop } = yield* Renderer

    const stateRef = yield* Ref.make<ColumnState<T>>(makeColumnState())

    // Create layout
    const container = new BoxRenderable(cli, {
      id: "miller-root",
      flexDirection: "row",
      width: "100%",
      height: "100%"
    })
    root.add(container)

    // Create columns
    const columnSelects = config.columns.map((col) => {
      const select = new SelectRenderable(cli, {
        id: col.id,
        flexGrow: 1,
        height: "100%",
        border: true,
        borderStyle: "single"
      })
      container.add(select)
      return select
    })

    // Preview column
    let previewBox: BoxRenderable | undefined
    if (config.preview) {
      previewBox = new BoxRenderable(cli, {
        id: "preview",
        flexGrow: 2,
        height: "100%",
        border: true,
        borderStyle: "single"
      })
      container.add(previewBox)
    }

    // Load initial data
    const initialItems = yield* config.initialItems
    yield* Ref.update(stateRef, setColumnData(0, initialItems))
    updateColumnOptions(columnSelects[0]!, initialItems, config.columns[0]!)

    yield* start

    // Navigation handler
    const handleNavigation = (stateRef: Ref.Ref<ColumnState<T>>) =>
      keyEvents.pipe(
        Stream.tap((key) =>
          Effect.gen(function*() {
            const state = yield* Ref.get(stateRef)
            const col = state.focusedColumn
            const nav = parseNavKey(key)

            if (nav === "left" && col > 0) {
              yield* Ref.update(stateRef, setFocusedColumn(col - 1))
              updateColumnFocus(columnSelects, col - 1)
            } else if ((nav === "right" || nav === "select") && col < config.columns.length - 1) {
              const selectedItem = getSelectedItem(state)
              const colConfig = config.columns[col]
              if (selectedItem && colConfig?.getChildren) {
                const children = yield* colConfig.getChildren(selectedItem)
                yield* Ref.update(stateRef, (s) => setColumnData(col + 1, children)(setFocusedColumn(col + 1)(s)))
                updateColumnOptions(columnSelects[col + 1]!, children, config.columns[col + 1]!)
                updateColumnFocus(columnSelects, col + 1)
              }
            } else if (nav === "down") {
              const items = state.columnData[col]
              const idx = state.selectedIndices[col] ?? 0
              if (items && idx < items.length - 1) {
                yield* Ref.update(stateRef, setSelectedIndex(col, idx + 1))
                const colSelect = columnSelects[col]
                if (colSelect) colSelect.selectedIndex = idx + 1
                yield* updatePreview(stateRef, config, previewBox)
              }
            } else if (nav === "up") {
              const idx = state.selectedIndices[col] ?? 0
              if (idx > 0) {
                yield* Ref.update(stateRef, setSelectedIndex(col, idx - 1))
                const colSelect = columnSelects[col]
                if (colSelect) colSelect.selectedIndex = idx - 1
                yield* updatePreview(stateRef, config, previewBox)
              }
            } else if (nav === "quit") {
              if (config.onQuit) yield* config.onQuit
              return yield* Effect.interrupt
            } else if (isActionKey(key) && config.actions) {
              const action = config.actions[key.name]
              const selectedItem = getSelectedItem(state)
              if (selectedItem && action) yield* action(selectedItem)
            }
          })
        ),
        Stream.runDrain
      )

    const fiber = yield* Effect.fork(handleNavigation(stateRef))
    yield* Fiber.join(fiber)

    yield* stop
    container.destroy()
  })

const updatePreview = <T>(
  stateRef: Ref.Ref<ColumnState<T>>,
  config: MillerColumnsConfig<T>,
  previewBox: BoxRenderable | undefined
): Effect.Effect<void, RendererError> => {
  const previewFn = config.preview
  if (!previewFn || !previewBox) return Effect.void

  return Effect.gen(function*() {
    const state = yield* Ref.get(stateRef)
    const selectedItem = getSelectedItem(state)
    if (selectedItem) {
      const content = yield* previewFn(selectedItem)
      yield* Ref.update(stateRef, (s) => ({ ...s, previewContent: Option.some(content) }))
    }
  })
}
