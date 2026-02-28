/**
 * MainList pure-helper unit tests.
 *
 * The MainList component mixes React rendering with pure computations
 * (settings filtering, index stabilization, group headers, item
 * positions). We extract and test the pure functions independently.
 *
 * Uses `@effect/vitest` for consistency with the rest of the codebase.
 */
import type { Domain } from "@knpkv/codecommit-core"
import { describe, expect, it } from "vitest"
import {
  applySettingsFilter,
  computeItemPositions,
  findGroupHeader,
  findStableIndex,
  parseSettingsFilter
} from "../src/tui/components/mainlist-utils.js"
import type { ListItem } from "../src/tui/ListBuilder.js"

// ── Fixtures ─────────────────────────────────────────────────────────

const mkAccount = (profile: string, enabled: boolean): ListItem => ({
  type: "account",
  account: {
    profile: profile as Domain.AwsProfileName,
    region: "us-east-1" as Domain.AwsRegion,
    enabled
  }
})

const mkHeader = (label: string, count: number): ListItem => ({
  type: "header",
  label,
  count
})

const mkPR = (id: string, description?: string): ListItem => ({
  type: "pr",
  pr: {
    id,
    title: `PR ${id}`,
    description,
    author: "alice",
    repositoryName: "repo",
    creationDate: new Date(),
    lastModifiedDate: new Date(),
    link: "https://example.com",
    account: { profile: "dev", region: "us-east-1" },
    status: "OPEN",
    sourceBranch: "feat",
    destinationBranch: "main",
    isMergeable: true,
    isApproved: false
  } as any
})

const empty: ListItem = { type: "empty" }

// ── Tests ────────────────────────────────────────────────────────────

describe("parseSettingsFilter", () => {
  // "on:" prefix filters to enabled-only accounts.
  it("parses on: prefix", () => {
    expect(parseSettingsFilter("on:dev")).toEqual({ status: "on", name: "dev" })
  })

  // "off:" prefix filters to disabled-only accounts.
  it("parses off: prefix", () => {
    expect(parseSettingsFilter("off:staging")).toEqual({ status: "off", name: "staging" })
  })

  // No prefix means search across all accounts regardless of status.
  it("defaults to all with name search", () => {
    expect(parseSettingsFilter("prod")).toEqual({ status: "all", name: "prod" })
  })

  // Prefix detection is case-insensitive: "ON:" and "On:" both work.
  it("is case-insensitive", () => {
    expect(parseSettingsFilter("ON:Dev")).toEqual({ status: "on", name: "dev" })
    expect(parseSettingsFilter("OFF:Prod")).toEqual({ status: "off", name: "prod" })
  })

  // Empty input returns "all" status with empty name — matches everything.
  it("empty string returns all with empty name", () => {
    expect(parseSettingsFilter("")).toEqual({ status: "all", name: "" })
  })
})

describe("applySettingsFilter", () => {
  const items: ReadonlyArray<ListItem> = [
    mkAccount("dev-account", true),
    mkAccount("prod-account", false),
    mkAccount("staging-account", true)
  ]

  // Empty filter returns all items unchanged — no filtering applied.
  it("returns all items when filter is empty", () => {
    expect(applySettingsFilter(items, "")).toBe(items)
  })

  // Name-only filter matches account profile substrings.
  it("filters by name substring", () => {
    const result = applySettingsFilter(items, "dev")
    expect(result).toHaveLength(1)
  })

  // "on:" prefix keeps only enabled accounts matching name.
  it("filters by on: prefix", () => {
    const result = applySettingsFilter(items, "on:account")
    expect(result).toHaveLength(2) // dev + staging (both enabled)
  })

  // "off:" prefix keeps only disabled accounts matching name.
  it("filters by off: prefix", () => {
    const result = applySettingsFilter(items, "off:account")
    expect(result).toHaveLength(1) // prod (disabled)
  })

  // Non-account items (headers, PRs) are always excluded.
  it("excludes non-account items", () => {
    const mixed: ReadonlyArray<ListItem> = [mkHeader("H", 0), mkAccount("dev", true)]
    const result = applySettingsFilter(mixed, "dev")
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("account")
  })
})

describe("findStableIndex", () => {
  const items: ReadonlyArray<ListItem> = [
    mkHeader("group", 2),
    mkPR("pr-1"),
    mkPR("pr-2"),
    mkPR("pr-3")
  ]

  // In prs/details view with a selected PR ID, the function should
  // find the matching PR regardless of the numeric index.
  it("finds PR by id in prs view", () => {
    expect(findStableIndex(items, "prs", "pr-2", 0)).toBe(2)
  })

  // Same behavior in details view — preserves selection across refresh.
  it("finds PR by id in details view", () => {
    expect(findStableIndex(items, "details", "pr-3", 0)).toBe(3)
  })

  // Falls back to numeric index when PR ID is not found.
  it("falls back to selectedIndex when PR not found", () => {
    expect(findStableIndex(items, "prs", "nonexistent", 1)).toBe(1)
  })

  // Non-prs views (settings, notifications) ignore PR ID matching.
  it("ignores PR id in settings view", () => {
    expect(findStableIndex(items, "settings", "pr-1", 2)).toBe(2)
  })

  // When selectedIndex exceeds list length, clamp to last item.
  it("clamps to last item when index overflows", () => {
    expect(findStableIndex(items, "settings", null, 100)).toBe(3)
  })

  // Negative index clamps to 0.
  it("clamps negative index to 0", () => {
    expect(findStableIndex(items, "settings", null, -5)).toBe(0)
  })

  // Empty list returns 0 (Math.max(0, -1) = 0).
  it("returns 0 for empty list", () => {
    expect(findStableIndex([], "prs", null, 5)).toBe(0)
  })
})

describe("findGroupHeader", () => {
  const items: ReadonlyArray<ListItem> = [
    mkHeader("Group A", 2),
    mkPR("pr-1"),
    mkPR("pr-2"),
    mkHeader("Group B", 1),
    mkPR("pr-3")
  ]

  // Walks backward from the given index to find the nearest header.
  it("finds header above current index", () => {
    const header = findGroupHeader(items, 2)
    expect(header).not.toBeNull()
    expect(header!.type === "header" && header!.label).toBe("Group A")
  })

  // PR at index 4 belongs to "Group B" (header at index 3).
  it("finds correct group for second section", () => {
    const header = findGroupHeader(items, 4)
    expect(header!.type === "header" && header!.label).toBe("Group B")
  })

  // Index pointing directly at a header returns that header.
  it("returns header when index is on a header", () => {
    const header = findGroupHeader(items, 3)
    expect(header!.type === "header" && header!.label).toBe("Group B")
  })

  // Empty list always returns null — no headers to find.
  it("returns null for empty list", () => {
    expect(findGroupHeader([], 0)).toBeNull()
  })

  // Negative index clamps to -1 via Math.min, then loop doesn't run.
  it("returns null for negative index", () => {
    expect(findGroupHeader(items, -1)).toBeNull()
  })

  // Index beyond list length clamps to last item and walks back.
  it("clamps index beyond list length", () => {
    const header = findGroupHeader(items, 100)
    expect(header!.type === "header" && header!.label).toBe("Group B")
  })
})

describe("computeItemPositions", () => {
  // First header has height 2 (no margin above), subsequent headers
  // have height 3 (1 extra line for visual separator).
  it("first header is height 2, subsequent headers height 3", () => {
    const items: ReadonlyArray<ListItem> = [
      mkHeader("A", 1),
      mkPR("1"),
      mkHeader("B", 1)
    ]
    const pos = computeItemPositions(items)
    expect(pos[0]).toEqual({ start: 0, end: 2 }) // first header: h=2
    expect(pos[1]).toEqual({ start: 2, end: 6 }) // PR: h=4
    expect(pos[2]).toEqual({ start: 6, end: 9 }) // second header: h=3
  })

  // PR without description: 1 (content) + 1 (spacing) + 0 (desc) + 1 + 1 = 4
  it("PR without description has height 4", () => {
    const items: ReadonlyArray<ListItem> = [mkPR("1")]
    const pos = computeItemPositions(items)
    expect(pos[0]).toEqual({ start: 0, end: 4 })
  })

  // PR with multi-line description adds line count (capped at 5).
  it("PR with description adds lines (capped at 5)", () => {
    const items: ReadonlyArray<ListItem> = [mkPR("1", "line1\nline2\nline3")]
    const pos = computeItemPositions(items)
    // height = 1 + 1 + 3 + 1 + 1 = 7
    expect(pos[0]).toEqual({ start: 0, end: 7 })
  })

  // Description with more than 5 lines is capped to prevent
  // overflow in the scroll calculations.
  it("caps description lines at 5", () => {
    const desc = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const items: ReadonlyArray<ListItem> = [mkPR("1", desc)]
    const pos = computeItemPositions(items)
    // height = 1 + 1 + 5 + 1 + 1 = 9
    expect(pos[0]).toEqual({ start: 0, end: 9 })
  })

  // "empty" and other item types default to height 2.
  it("empty item has height 2", () => {
    const items: ReadonlyArray<ListItem> = [empty]
    const pos = computeItemPositions(items)
    expect(pos[0]).toEqual({ start: 0, end: 2 })
  })

  // Positions are cumulative — each item starts where the previous ended.
  it("positions are cumulative", () => {
    const items: ReadonlyArray<ListItem> = [
      mkHeader("A", 1),
      mkPR("1"),
      empty
    ]
    const pos = computeItemPositions(items)
    expect(pos[0]).toEqual({ start: 0, end: 2 })
    expect(pos[1]).toEqual({ start: 2, end: 6 })
    expect(pos[2]).toEqual({ start: 6, end: 8 })
  })

  // Empty list produces no positions.
  it("returns empty for empty list", () => {
    expect(computeItemPositions([])).toEqual([])
  })
})
