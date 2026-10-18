import { describe, expect, it } from "vitest"
import { issueCopy } from "../src/presentation/StackListView.js"

describe("discovery issue copy", () => {
  it("says skipped folders were skipped, not that a state file couldn't be read", () => {
    const skipped = issueCopy({ source: "local", reason: "skipped" })
    expect(skipped.title).toBe("Some project folders were skipped.")
    expect(skipped.body).not.toContain("state file")
    expect(issueCopy({ source: "local", reason: "io" }).body).toContain("state file")
  })

  it("says a capped walk stopped early and kept the projects it found", () => {
    const limit = issueCopy({ source: "local", reason: "limit" })
    expect(limit.title).toBe("The project walk stopped early.")
    expect(limit.body).toContain("already found")
    expect(limit.body).not.toContain("state file")
  })
})
