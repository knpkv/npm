import { describe, expect, it } from "vitest"
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
  })

  it("does not classify a nearby non-filter shortcut", () => {
    expect(quickFilterTypeForShortcut("n")).toBeUndefined()
  })
})
