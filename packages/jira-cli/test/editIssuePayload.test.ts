import { describe, expect, it } from "@effect/vitest"
import { isIsoDate } from "../src/commands/version.js"
import { buildEditIssuePayload } from "../src/IssueService.js"

const payloadOf = (result: ReturnType<typeof buildEditIssuePayload>) => {
  if (result._tag === "Invalid") throw new Error(`expected a payload, got invalid: ${result.reason}`)
  return result.payload
}

const errorOf = (result: ReturnType<typeof buildEditIssuePayload>): string => {
  if (result._tag === "Payload") throw new Error("expected an invalid result, got a payload")
  return result.reason
}

describe("buildEditIssuePayload", () => {
  // The reason this helper exists: attaching a ticket to a release must not
  // disturb the releases it is already in, so an add goes through `update`
  // rather than replacing `fields.fixVersions`.
  it("sends an added fix version as an incremental update, not a replacement", () => {
    const payload = payloadOf(buildEditIssuePayload({ addFixVersions: ["OOB 100"] }))

    expect(payload.update).toEqual({ fixVersions: [{ add: { name: "OOB 100" } }] })
    expect(payload.fields).toBeUndefined()
  })

  it("wraps fix versions as objects and labels as bare strings", () => {
    const payload = payloadOf(
      buildEditIssuePayload({ addFixVersions: ["OOB 100"], addLabels: ["domain:oob"] })
    )

    expect(payload.update).toEqual({
      fixVersions: [{ add: { name: "OOB 100" } }],
      labels: [{ add: "domain:oob" }]
    })
  })

  it("combines adds and removes for the same field in one call", () => {
    const payload = payloadOf(
      buildEditIssuePayload({ addFixVersions: ["OOB 100"], removeFixVersions: ["OOB 99"] })
    )

    expect(payload.update).toEqual({
      fixVersions: [{ add: { name: "OOB 100" } }, { remove: { name: "OOB 99" } }]
    })
  })

  it("sends a replacement through fields", () => {
    const payload = payloadOf(buildEditIssuePayload({ setFixVersions: ["OOB 100"] }))

    expect(payload.fields).toEqual({ fixVersions: [{ name: "OOB 100" }] })
    expect(payload.update).toBeUndefined()
  })

  // Jira rejects a field named in both `fields` and `update`, and its error does
  // not say which field — so the combination is refused here instead.
  it("refuses a replacement combined with an increment on the same field", () => {
    const message = errorOf(
      buildEditIssuePayload({ setFixVersions: ["OOB 100"], addFixVersions: ["OOB 99"] })
    )

    expect(message).toContain("--fix-version cannot be combined")
  })

  it("allows replacing one field while incrementing the other", () => {
    const payload = payloadOf(
      buildEditIssuePayload({ setFixVersions: ["OOB 100"], addLabels: ["domain:oob"] })
    )

    expect(payload.fields).toEqual({ fixVersions: [{ name: "OOB 100" }] })
    expect(payload.update).toEqual({ labels: [{ add: "domain:oob" }] })
  })

  it("refuses an edit that would send nothing", () => {
    expect(errorOf(buildEditIssuePayload({}))).toContain("Nothing to edit")
  })

  // Empty repeatable flags arrive as `[]`, which must read as "not passed"
  // rather than "replace with nothing" — the latter would clear the field.
  it("treats empty flag arrays as absent rather than as a clear", () => {
    expect(errorOf(buildEditIssuePayload({ setFixVersions: [], addLabels: [] }))).toContain("Nothing to edit")
  })
})

describe("isIsoDate", () => {
  it("accepts an ISO date", () => {
    expect(isIsoDate("2026-08-12")).toBe(true)
  })

  it.each([
    ["12-08-2026", "day first"],
    ["2026-8-12", "unpadded month"],
    ["2026-08-12T00:00:00Z", "timestamp"],
    ["", "empty"]
  ])("rejects %s (%s)", (value) => {
    expect(isIsoDate(value)).toBe(false)
  })

  // Shape-only validation would let these through and Jira would answer with an
  // unattributed 400.
  it.each(["2026-02-30", "2026-13-01", "2026-00-10"])("rejects the non-existent date %s", (value) => {
    expect(isIsoDate(value)).toBe(false)
  })
})
