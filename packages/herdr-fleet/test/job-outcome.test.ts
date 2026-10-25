import { describe, expect, it } from "@effect/vitest"
import { type JobFailureReason, jobFailureReason, jobFailureReasonText, jobOutcome } from "../src/job-outcome.js"
import type { JobStatus } from "../src/model.js"

const envelope = (code: string, message: string) =>
  `command exited with code 1: ${JSON.stringify({ error: { code, message }, id: "c1" })}`

/** Real error texts from a hub's job store, hosts and paths redacted. */
const reasons: ReadonlyArray<readonly [string | null, JobFailureReason]> = [
  [envelope("timeout", "timed out waiting for agent status"), "agent_timeout"],
  [envelope("agent_not_found", "agent target 01a0 not found"), "agent_not_found"],
  [envelope("agent_blocked", "agent w8:p1 is blocked and requires input"), "agent_blocked"],
  [envelope("rate_limited", "slow down"), "other"],
  [envelope("internal", "host-coordinator: fleetctl returned malformed host status"), "host_status_unreadable"],
  ["hostd restarted while this job was running", "hub_restarted"],
  ["coordinator command failed: host-coordinator: fleetctl returned malformed host status", "host_status_unreadable"],
  ["command exited with code 1: fleet-apply: checkout is not on main", "not_on_main"],
  ["command exited with code 1: From https://example/nix\nsudo: a password is required", "sudo_password"],
  [
    "command exited with code 1: sudo: a terminal is required to read the password; either use the -S option",
    "sudo_password"
  ],
  ["command exited with code 1: error: Cannot build '/nix/store/abc-home-manager-files.drv'.", "build_failed"],
  ["command exited with code 1: jq: error: writing output failed: Disk quota exceeded", "disk_full"],
  [null, "no_reason"],
  ["", "no_reason"],
  ["command exited with code 1", "no_reason"],
  ["FleetOperationError", "no_reason"],
  ["FleetOperationError:      at file:///hostd/index.mjs:424:5000     at file:///hostd/index.mjs:9:1", "no_reason"],
  ["CoordinatorWorkGoalAmbiguous: could not rejoin the coordinator submission", "other"],
  // A plain message that mentions a code word is still plain text.
  ["the agent said timeout once, then exited", "other"]
]

describe("job failure reasons", () => {
  it.each(reasons)("classifies %j as %s", (error, reason) => {
    expect(jobFailureReason(error)).toBe(reason)
  })

  it("gives every reason a line to read", () => {
    for (const [, reason] of reasons) expect(jobFailureReasonText[reason]).not.toBe("")
  })
})

const outcomes: ReadonlyArray<readonly [JobStatus, boolean, string]> = [
  ["pending_approval", false, "Pending"],
  ["queued", true, "Pending"],
  ["running", true, "Running"],
  ["succeeded", true, "Succeeded"],
  ["succeeded", false, "Succeeded"],
  ["rejected", false, "Rejected"],
  ["expired", false, "Expired"],
  ["failed", true, "FailedAfterApproval"],
  ["interrupted", true, "FailedAfterApproval"],
  ["failed", false, "Failed"],
  ["interrupted", false, "Failed"]
]

describe("job outcomes", () => {
  it.each(outcomes)("%s, approved %s, is %s", (status, approved, tag) => {
    expect(jobOutcome({ status, approvedAt: approved ? 1 : null, error: null })._tag).toBe(tag)
  })

  it("carries the failure reason", () => {
    expect(jobOutcome({ status: "failed", approvedAt: 1, error: "hostd restarted while this job was running" }))
      .toEqual({ _tag: "FailedAfterApproval", reason: "hub_restarted" })
  })
})
