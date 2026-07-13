import { describe, expect, it } from "vitest"
import { parseDiffFilePair, validateDiffCodeItem } from "../../src/diff/parse-diff.js"
import type { RlyDiffCodeItem } from "../../src/diff/types.js"

const item = {
  after: {
    cacheKey: "release-after-v2",
    contents: "export const canShip = true\nexport const blockers = 0\n",
    name: "src/release.ts"
  },
  before: {
    cacheKey: "release-before-v1",
    contents: "export const canShip = false\nexport const blockers = 1\n",
    name: "src/release.ts"
  },
  id: "release-verdict",
  version: 2
} satisfies RlyDiffCodeItem

describe("parseDiffFilePair", () => {
  it("centralizes complete before and after text through the pinned parser", () => {
    const parsed = parseDiffFilePair(item)
    expect(parsed.name).toBe("src/release.ts")
    expect(parsed.type).toBe("change")
    expect(parsed.isPartial).toBe(false)
    expect(parsed.deletionLines.join("\n")).toContain("export const canShip = false")
    expect(parsed.additionLines.join("\n")).toContain("export const canShip = true")
    expect(parsed.hunks.length).toBeGreaterThan(0)
  })

  it("retains rename metadata when the file path changes", () => {
    const parsed = parseDiffFilePair({
      ...item,
      after: { contents: item.after.contents, name: "src/verdict.ts" }
    })
    expect(parsed.name).toBe("src/verdict.ts")
    expect(parsed.prevName).toBe("src/release.ts")
  })

  it("rejects blank paths and invalid versions before calling the vendor parser", () => {
    expect(() => validateDiffCodeItem({ ...item, id: " " })).toThrow("Diff item id")
    expect(() => validateDiffCodeItem({ ...item, after: { contents: "", name: " " } })).toThrow(
      "after name"
    )
    expect(() => validateDiffCodeItem({ ...item, version: -1 })).toThrow("non-negative integer")
  })
})
