import { describe, expect, it } from "vitest"
import { issueCopy } from "../src/presentation/StackListView.js"

describe("discovery issue copy", () => {
  it("says skipped folders were skipped, not that a state file couldn't be read", () => {
    const skipped = issueCopy({ source: "local", reason: "skipped" })
    expect(skipped.title).toBe("Some project folders were skipped.")
    expect(skipped.body).not.toContain("state file")
    expect(issueCopy({ source: "local", reason: "io" }).body).toContain("state file")
  })
})
