import { describe, expect, it } from "vitest"
import { issueCopy } from "../src/presentation/StackListView.js"

describe("discovery issue copy", () => {
  it("says skipped folders were skipped, not that a state file couldn't be read", () => {
    const skipped = issueCopy({ source: "local", reason: "skipped" })
    expect(skipped.title).toBe("Some project folders were skipped.")
    expect(skipped.body).not.toContain("state file")
    expect(issueCopy({ source: "local", reason: "io" }).body).toContain("state file")
  })

  it("says a state file size limit is an incomplete local read", () => {
    const limit = issueCopy({ source: "local", reason: "limit" })
    expect(limit.title).toBe("Local discovery is incomplete.")
    expect(limit.body).toContain("state file")
    expect(limit.body).not.toContain("already found")
  })

  it("says a stopped walk kept the projects already found", () => {
    const truncated = issueCopy({ source: "local", reason: "truncated" })
    expect(truncated.title).toBe("The project walk stopped early.")
    expect(truncated.body).toContain("already found")
    expect(truncated.body).not.toContain("state file")
  })
})
