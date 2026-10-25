import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import { fleetFailures, fleetFailuresMax, type HostHistory } from "../src/fleet-failures.js"

const since = 1_000_000

const job = (id: string, fields: Partial<JobRecord> = {}): JobRecord => ({
  id,
  actor: "local",
  approvalNonce: null,
  approvedBy: null,
  createdAt: since + 10,
  updatedAt: since + 20,
  error: null,
  hash: id.padStart(64, "0"),
  payload: { kind: "nix.check" },
  result: null,
  status: "failed",
  ...fields
})
const read = (host: string, records: ReadonlyArray<JobRecord>): HostHistory => ({ _tag: "Read", host, records })

describe("fleet failures for Needs you", () => {
  it("(a) a local, unapproved nix.apply failure counts", () => {
    const { failures } = fleetFailures([
      read("SER8", [
        job("apply", { payload: { kind: "nix.apply", ref: "main" }, error: "fleet-apply: checkout is not on main" })
      ])
    ], since)
    expect(failures).toEqual([expect.objectContaining({
      sourceKey: "failed:ser8:apply",
      host: "SER8",
      kind: "nix.apply",
      actor: "local",
      reason: "not_on_main",
      approved: false
    })])
  })

  it("(b) a coordinator's tailnet delegation that failed reading host status counts", () => {
    const { failures } = fleetFailures([
      read("SER8", [job("delegate", {
        actor: "owner@example.com",
        payload: { kind: "agent.delegate", repository: "/repo", prompt: "Check the pool", mode: "consult" },
        error: "coordinator command failed: host-coordinator: fleetctl returned malformed host status"
      })])
    ], since)
    expect(failures).toEqual([expect.objectContaining({
      kind: "agent.delegate",
      reason: "host_status_unreadable",
      approved: false
    })])
  })

  it("(c) an approved job that was interrupted counts as approved", () => {
    const { failures } = fleetFailures([
      read("SER8", [job("restarted", {
        approvedBy: "owner@example.com",
        approvedAt: since + 15,
        status: "interrupted",
        error: "hostd restarted while this job was running"
      })])
    ], since)
    expect(failures).toEqual([expect.objectContaining({ reason: "hub_restarted", approved: true })])
  })

  it("(d) a failure older than the window doesn't count", () => {
    const { failures } = fleetFailures(
      [read("SER8", [job("old", { createdAt: since - 1, updatedAt: since + 1 })])],
      since
    )
    expect(failures).toEqual([])
  })

  it("(e) a later success of the same payload on the same host settles the failure", () => {
    const failed = job("first", { hash: "a".repeat(64) })
    const retried = job("second", { hash: "a".repeat(64), status: "succeeded", createdAt: since + 30 })
    const elsewhere = job("third", { hash: "a".repeat(64) })
    const { failures } = fleetFailures([read("SER8", [retried, failed]), read("mini", [elsewhere])], since)
    expect(failures.map(({ jobId }) => jobId)).toEqual(["third"])
  })

  it("orders newest first across hosts, keeps the newest few and says it truncated", () => {
    const many = Array.from(
      { length: fleetFailuresMax + 1 },
      (_, index) => job(`job-${index}`, { updatedAt: since + 100 + index })
    )
    const result = fleetFailures([read("SER8", many.slice(0, 10)), read("mini", many.slice(10))], since)
    expect(result.failures).toHaveLength(fleetFailuresMax)
    expect(result.failures[0]).toMatchObject({ jobId: `job-${fleetFailuresMax}`, host: "mini" })
    expect(result.truncated).toBe(true)
  })

  it("names a host whose history can't be read, and keeps the others", () => {
    const result = fleetFailures([
      { _tag: "Unreadable", host: "pi", reason: "offline" },
      read("SER8", [job("one")])
    ], since)
    expect(result.hosts).toEqual([{ host: "pi", reason: "offline" }])
    expect(result.failures).toHaveLength(1)
  })

  it("reports the newest approval or rejection inside the window, null when none", () => {
    expect(fleetFailures([read("SER8", [job("quiet", { status: "succeeded" })])], since).lastDecisionAt).toBeNull()
    const result = fleetFailures([
      read("SER8", [job("approved", { status: "succeeded", approvedAt: since + 40 })]),
      read("mini", [
        job("rejected", { status: "rejected", rejectedAt: since + 50 }),
        job("before", { createdAt: since - 5, status: "rejected", rejectedAt: since + 90 })
      ])
    ], since)
    expect(result.lastDecisionAt).toBe(since + 50)
  })
})
