import { describe, expect, it } from "@effect/vitest"
import { codeDisplayAuthor } from "../src/server/host-presentation.js"

describe("Code host display privacy", () => {
  /** Assumed-role ARNs contain account identity; only the final display name crosses to the viewer. */
  it("derives an assumed-role author without the ARN or account identity", () => {
    const account = "1".repeat(12)
    const arn = `arn:aws:sts::${account}:assumed-role/Reviewers/example-author`
    expect(codeDisplayAuthor(arn)).toBe("example-author")
    expect(JSON.stringify({ author: codeDisplayAuthor(arn) })).not.toContain(account)
    expect(codeDisplayAuthor(` ${arn} `)).toBe("example-author")
  })

  it("refuses malformed ARN display rather than returning a provider locator", () => {
    expect(codeDisplayAuthor("arn:aws:iam::broken")).toBe("Unknown author")
    expect(codeDisplayAuthor("arn:aws:sts::" + "1".repeat(12))).toBe("Unknown author")
    expect(codeDisplayAuthor("example author")).toBe("example author")
    expect(codeDisplayAuthor("x".repeat(500))).toHaveLength(256)
  })
})
