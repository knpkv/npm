/**
 * Tests for ColumnState.
 *
 * Note: We avoid importing modules that depend on @opentui/core directly
 * as the package has .scm files that vitest cannot handle.
 */
import { describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  getSelectedItem,
  makeColumnState,
  setColumnData,
  setFocusedColumn,
  setSelectedIndex
} from "../src/components/ColumnState.ts"

describe("ColumnState", () => {
  it.effect("makeColumnState creates initial state", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = makeColumnState<string>()
        expect(state.focusedColumn).toBe(0)
        expect(state.previewContent).toEqual(Option.none())
      })
    }))

  it.effect("setFocusedColumn updates column", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = makeColumnState<string>()
        const updated = setFocusedColumn(2)(state)
        expect(updated.focusedColumn).toBe(2)
      })
    }))

  it.effect("setColumnData updates data", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = makeColumnState<string>()
        const updated = setColumnData(0, ["a", "b", "c"])(state)
        expect(updated.columnData[0]).toEqual(["a", "b", "c"])
      })
    }))

  it.effect("setSelectedIndex updates index", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = makeColumnState<string>()
        const updated = setSelectedIndex(1, 5)(state)
        expect(updated.selectedIndices[1]).toBe(5)
      })
    }))

  it.effect("getSelectedItem returns correct item", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = {
          ...makeColumnState<string>(),
          focusedColumn: 0,
          columnData: { 0: ["a", "b", "c"] },
          selectedIndices: { 0: 1 }
        }
        const item = getSelectedItem(state)
        expect(item).toBe("b")
      })
    }))

  it.effect("getSelectedItem returns undefined for empty column", () =>
    Effect.gen(function*() {
      yield* Effect.sync(() => {
        const state = makeColumnState<string>()
        const item = getSelectedItem(state)
        expect(item).toBeUndefined()
      })
    }))
})
