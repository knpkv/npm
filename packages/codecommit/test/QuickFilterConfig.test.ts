import { describe, expect, it } from "@effect/vitest"
import { quickFilterCommands, quickFilterTypeForShortcut } from "../src/tui/quick-filter-config.js"

describe("quick filter configuration", () => {
  it("keeps every footer shortcut aligned with the command palette", () => {
    expect(quickFilterCommands.map(({ shortcut, type }) => [shortcut, type])).toEqual([
      ["1", "all"],
      ["2", "hot"],
      ["3", "mine"],
      ["4", "account"],
      ["5", "author"],
      ["6", "scope"],
      ["7", "date"],
      ["8", "repo"],
      ["9", "status"]
    ])
    for (const command of quickFilterCommands) {
      expect(quickFilterTypeForShortcut(command.shortcut)).toBe(command.type)
    }
  })

  it("does not classify a nearby non-filter shortcut", () => {
    expect(quickFilterTypeForShortcut("n")).toBeUndefined()
  })
})
