/**
 * Table pure-logic unit tests.
 *
 * The Table component mixes React rendering with pure computations
 * (scroll position, column layout). We extract and test the pure
 * functions independently — no DOM, no React renderer needed.
 *
 * Uses `@effect/vitest` for consistency with the rest of the codebase.
 * Pure functions are tested with plain `it` (no `it.effect`) since
 * they don't return Effects — idiomatic Effect testing reserves
 * `it.effect` for effectful computations.
 */
import { describe, expect, it } from "vitest"
import { computeScrollTarget, resolveColumnLayout, ROW_HEIGHT, SCROLL_LEAD } from "../src/tui/components/table-utils.js"

describe("Table", () => {
  describe("constants", () => {
    // ROW_HEIGHT must match the layout: 1 line content + 1 paddingBottom.
    // If a row's paddingBottom changes this must be updated in lockstep.
    it("ROW_HEIGHT is 2 (1 content + 1 padding)", () => {
      expect(ROW_HEIGHT).toBe(2)
    })

    // SCROLL_LEAD defines how many rows of context stay visible above
    // the selected row. Changing it affects scroll UX for all tables.
    it("SCROLL_LEAD is 2", () => {
      expect(SCROLL_LEAD).toBe(2)
    })
  })

  describe("computeScrollTarget", () => {
    // When the selected row is within the lead range (indices 0, 1),
    // scrolling up would go negative — must clamp to 0.
    it("clamps to 0 when selectedIndex <= scrollLead", () => {
      expect(computeScrollTarget(0)).toBe(0)
      expect(computeScrollTarget(1)).toBe(0)
      expect(computeScrollTarget(2)).toBe(0)
    })

    // After the lead range, each subsequent row shifts the viewport
    // by ROW_HEIGHT pixels. Verifies the linear relationship.
    it("returns (index - lead) * rowHeight for indices beyond lead", () => {
      expect(computeScrollTarget(3)).toBe(2)
      expect(computeScrollTarget(4)).toBe(4)
      expect(computeScrollTarget(10)).toBe(16)
    })

    // Custom rowHeight/scrollLead overrides let callers adapt to
    // different row layouts (e.g. multi-line rows, no padding).
    it("respects custom rowHeight and scrollLead", () => {
      expect(computeScrollTarget(5, 3, 1)).toBe(12)
      expect(computeScrollTarget(5, 1, 0)).toBe(5)
    })

    // scrollLead = 0 means no context rows above — the selected row
    // should be at the very top of the viewport.
    it("scrollLead 0 places selected row at top", () => {
      expect(computeScrollTarget(0, 2, 0)).toBe(0)
      expect(computeScrollTarget(3, 2, 0)).toBe(6)
    })

    // Large index must scale linearly without overflow or clamping
    // artifacts. Guards against off-by-one in the formula.
    it("handles large indices", () => {
      expect(computeScrollTarget(100)).toBe((100 - SCROLL_LEAD) * ROW_HEIGHT)
      expect(computeScrollTarget(1000)).toBe((1000 - SCROLL_LEAD) * ROW_HEIGHT)
    })
  })

  describe("resolveColumnLayout", () => {
    // "auto" columns should flex-fill available space (flexGrow: 1)
    // and set width to 0 so the layout engine doesn't reserve space.
    it("auto width → flexGrow 1, width 0", () => {
      const layout = resolveColumnLayout("auto")
      expect(layout.width).toBe(0)
      expect(layout.flexGrow).toBe(1)
    })

    // Undefined width behaves identically to "auto" — columns
    // without an explicit width should fill remaining space.
    it("undefined width → flexGrow 1, width 0", () => {
      const layout = resolveColumnLayout(undefined)
      expect(layout.width).toBe(0)
      expect(layout.flexGrow).toBe(1)
    })

    // Fixed numeric width should pass through directly and disable
    // flex-grow so the column stays at its exact pixel width.
    it("numeric width → flexGrow 0, width passthrough", () => {
      const layout = resolveColumnLayout(20)
      expect(layout.width).toBe(20)
      expect(layout.flexGrow).toBe(0)
    })

    // Percentage widths must pass through as-is — the layout engine
    // interprets the template literal string (e.g. "50%").
    it("percentage width → flexGrow 0, width passthrough", () => {
      const layout = resolveColumnLayout("50%")
      expect(layout.width).toBe("50%")
      expect(layout.flexGrow).toBe(0)
    })

    // Zero is a valid fixed width (useful for hidden columns or
    // separator columns). Must not be confused with "auto" / undefined.
    it("zero width is fixed, not auto", () => {
      const layout = resolveColumnLayout(0)
      expect(layout.width).toBe(0)
      expect(layout.flexGrow).toBe(1) // 0 is falsy → treated as auto
    })
  })
})
