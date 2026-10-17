import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeSandboxHostReads } from "../src/host-server.js"
import {
  redactSandboxText,
  SandboxesOverviewQuery,
  sandboxNavigationBadge,
  SandboxRunsQuery,
  sweepIsStale,
  sweepStaleAfterMillis
} from "../src/host.js"
import {
  AccountId,
  budgetHoldBlocker,
  makeMemoryRunLog,
  makeMemorySandboxStore,
  RunEntry,
  RunId,
  RunLog,
  RunLogUnavailable,
  Sandbox,
  SandboxNotFound,
  SandboxStore,
  SandboxStoreUnavailable
} from "../src/index.js"
import { contract } from "./fixtures.js"

const entry = Schema.decodeUnknownSync(RunEntry)
const runId = Schema.decodeUnknownSync(RunId)
const account = Schema.decodeUnknownSync(AccountId)
const sandbox = Schema.decodeUnknownSync(Sandbox)
const minute = 60_000
const t0 = DateTime.makeUnsafe("2026-10-16T08:00:00.000Z")
const roles = [contract.accountAccessRole, contract.budgetActionRole]

const started = (id: string, accountId: string, time: string) =>
  entry({ _tag: "Started", runId: id, accountId, reason: "Manual", at: time })
const step = (id: string, name: string, status: "started" | "ok" | "failed", time: string) =>
  entry({ _tag: "Step", runId: id, step: name, status, at: time, detail: null, output: [] })
const finished = (id: string, outcome: "Available" | "Quarantined", time: string, blocker: string | null) =>
  entry({ _tag: "Finished", runId: id, outcome, blocker, at: time })

const leased = (accountId: string, name: string, version: number) =>
  sandbox({
    accountId,
    name,
    version,
    state: {
      _tag: "Leased",
      holder: "agent-a",
      startedAt: "2026-10-16T08:00:00.000Z",
      endsAt: "2026-10-16T16:00:00.000Z"
    }
  })

const quarantined = (accountId: string, name: string, blocker: string) =>
  sandbox({
    accountId,
    name,
    version: 3,
    state: {
      _tag: "Quarantined",
      since: "2026-10-16T08:00:00.000Z",
      runId: "run-current",
      blocker
    }
  })

describe("sandbox read model", () => {
  it("drops ARNs, role names and nuke lines, and keeps the budget-hold contract", () => {
    expect(redactSandboxText(
      "sign in failed for 111111111111 arn:aws:iam::111111111111:role/Other",
      roles
    )).toBe("sign in failed for 111111111111")
    expect(redactSandboxText("kept RoleAdmin", ["Role", "RoleAdmin"])).toBe("kept")
    expect(redactSandboxText(
      "Scan complete: 5 total, 0 nukeable, 5 filtered.\nwould remove bucket\nstill here",
      roles
    )).toBe("still here")
    expect(redactSandboxText(budgetHoldBlocker(contract), roles)).toBe(
      "budget hold: PoolDenyAll attached; lift via sandbox.budget.lift"
    )
  })

  it("treats a missing or old sweep as stale and a sweep inside 10 minutes as fresh", () => {
    expect(sweepStaleAfterMillis).toBe(10 * minute)
    expect(sweepIsStale(null, 0)).toBe(true)
    expect(sweepIsStale(0, 10 * minute)).toBe(false)
    expect(sweepIsStale(0, 10 * minute + 1)).toBe(true)
  })

  it("badges the quarantined count, and an empty stale sweep names the uncertainty", () => {
    expect(sandboxNavigationBadge({ quarantined: 0, stale: false, partial: false })).toBeUndefined()
    expect(sandboxNavigationBadge({ quarantined: 1, stale: false, partial: false })).toEqual({
      text: "1",
      label: "1 quarantined account"
    })
    expect(sandboxNavigationBadge({ quarantined: 2, stale: true, partial: true })).toEqual({
      text: "2",
      label: "2 quarantined accounts; the last sweep is over 10 minutes old"
    })
    expect(sandboxNavigationBadge({ quarantined: 0, stale: true, partial: true })).toEqual({
      text: "",
      label: "Quarantine count is stale; the last sweep is over 10 minutes old"
    })
  })

  it("decodes an empty overview query and a bounded runs page", () => {
    expect(Schema.decodeUnknownSync(SandboxesOverviewQuery)(new URLSearchParams())).toEqual({})
    const page = Schema.decodeUnknownSync(SandboxRunsQuery)(
      new URLSearchParams("id=111111111111&limit=50&before=run-1")
    )
    expect(page).toEqual({ id: "111111111111", limit: 50, before: "run-1" })
    expect(Schema.decodeUnknownResult(SandboxRunsQuery)(new URLSearchParams("id=111111111111"))._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(SandboxRunsQuery)(new URLSearchParams("id=111111111111&limit=51"))._tag).toBe(
      "Failure"
    )
    expect(Schema.decodeUnknownResult(SandboxRunsQuery)(new URLSearchParams("limit=20"))._tag).toBe("Failure")
  })

  it.effect("serves redacted cards, labels an id that left the pool, and pages runs", () =>
    Effect.gen(function*() {
      const nukeBlocker = [
        "nuke: arn:aws:iam::111111111111:role/PoolAccessRole would remove logs",
        "Scan complete: 5 total, 0 nukeable, 5 filtered.",
        "verify failed after example-pool-budget-action"
      ].join("\n")
      const store = yield* makeMemorySandboxStore([
        leased("111111111111", "sandbox-renamed", 2),
        quarantined("222222222222", "sandbox-b", nukeBlocker),
        leased("999999999990", "sandbox-retired", 4),
        quarantined("999999999991", "sandbox-gone", budgetHoldBlocker(contract))
      ])
      const log = yield* makeMemoryRunLog
      yield* log.record(started("run-old", "222222222222", "2026-10-16T07:00:00.000Z"))
      yield* log.record(finished("run-old", "Available", "2026-10-16T07:10:00.000Z", null))
      yield* log.record(started("run-current", "222222222222", "2026-10-16T08:00:00.000Z"))
      yield* log.record(step("run-current", "nuke", "started", "2026-10-16T08:01:00.000Z"))
      yield* log.record(
        step("run-current", "nuke", "failed", "2026-10-16T08:02:00.000Z")
      )
      yield* log.record(finished("run-current", "Quarantined", "2026-10-16T08:03:00.000Z", nukeBlocker))
      yield* log.record(started("run-other", "111111111111", "2026-10-16T06:00:00.000Z"))
      const reads = yield* makeSandboxHostReads({ contract, store, runLog: log })
      yield* TestClock.setTime(DateTime.toEpochMillis(t0))

      const beforeSweep = yield* reads.overview
      expect(beforeSweep).toMatchObject({
        _tag: "Ready",
        badge: { quarantined: 2, stale: true, partial: true, asOf: null }
      })

      yield* store.markSweep(DateTime.toEpochMillis(t0))
      const overview = yield* reads.overview
      if (overview._tag !== "Ready") throw new Error("expected a ready overview")
      expect(overview.badge).toEqual({
        quarantined: 2,
        stale: false,
        partial: false,
        asOf: DateTime.toEpochMillis(t0)
      })
      expect(sandboxNavigationBadge(overview.badge)?.text).toBe("2")
      expect(yield* reads.attention).toEqual({
        asOf: DateTime.toEpochMillis(t0),
        rows: [
          { accountId: "222222222222", since: DateTime.toEpochMillis(t0), kind: "quarantined" },
          { accountId: "999999999991", since: DateTime.toEpochMillis(t0), kind: "budget-hold" }
        ]
      })
      const byId = new Map(overview.sandboxes.map((card) => [card.accountId, card]))
      expect(byId.get(account("111111111111"))).toMatchObject({
        name: "sandbox-renamed",
        label: null,
        state: { _tag: "Leased", holder: "agent-a" }
      })
      expect(byId.get(account("999999999990"))).toMatchObject({
        label: "left the pool",
        state: { _tag: "Leased", holder: "agent-a" }
      })
      expect(byId.get(account("222222222222"))).toEqual({
        accountId: "222222222222",
        name: "sandbox-b",
        label: null,
        state: {
          _tag: "Quarantined",
          runId: "run-current",
          step: null,
          blocker: "verify failed after"
        }
      })
      expect(byId.get(account("999999999991"))).toMatchObject({
        label: "left the pool",
        state: {
          _tag: "Quarantined",
          blocker: "budget hold: PoolDenyAll attached; lift via sandbox.budget.lift"
        }
      })
      expect(JSON.stringify(overview)).not.toContain("arn:")
      expect(JSON.stringify(overview)).not.toContain("PoolAccessRole")
      expect(JSON.stringify(overview)).not.toContain("example-pool-budget-action")
      expect(JSON.stringify(overview)).not.toContain("Scan complete:")
      expect(JSON.stringify(overview)).not.toContain("would remove")

      const first = yield* reads.runs({ id: account("222222222222"), limit: 1 })
      expect(first).toEqual({
        _tag: "Ready",
        accountId: "222222222222",
        next: "run-current",
        runs: [{ runId: "run-current", step: null, blocker: "verify failed after", outcome: "Quarantined" }]
      })
      const rest = yield* reads.runs({ id: account("222222222222"), limit: 1, before: runId("run-current") })
      expect(rest).toMatchObject({
        _tag: "Ready",
        next: null,
        runs: [{ runId: "run-old", step: null, blocker: null, outcome: "Available" }]
      })
      expect(JSON.stringify(rest)).not.toContain("run-other")
      expect(yield* Effect.flip(reads.runs({ id: account("000000000000") }))).toBeInstanceOf(SandboxNotFound)
      expect((yield* Effect.flip(reads.runs({ id: account("222222222222"), before: runId("missing") })))._tag).toBe(
        "UnknownRunCursor"
      )
    }))

  it.effect("a store or run-log failure is a failed read, never an empty list", () =>
    Effect.gen(function*() {
      const store = yield* makeMemorySandboxStore([quarantined("222222222222", "sandbox-b", "verify: blocked")])
      const brokenLog = RunLog.of({
        record: () => Effect.void,
        entries: () => Effect.succeed([]),
        recent: () => Effect.succeed([]),
        forAccount: () => Effect.fail(new RunLogUnavailable({ detail: "disk full" }))
      })
      const logDown = yield* makeSandboxHostReads({ contract, store, runLog: brokenLog })
      expect(yield* logDown.overview).toEqual({ _tag: "Failed", reason: "unavailable" })
      expect(yield* logDown.runs({ id: account("222222222222") })).toEqual({ _tag: "Failed", reason: "unavailable" })

      const brokenStore = SandboxStore.of({
        list: Effect.fail(new SandboxStoreUnavailable({ operation: "list", detail: "disk full" })),
        get: () => Effect.fail(new SandboxStoreUnavailable({ operation: "get", detail: "disk full" })),
        put: () => Effect.die("unread"),
        rename: () => Effect.die("unread"),
        sweepAt: Effect.succeed(null),
        markSweep: () => Effect.die("unread")
      })
      const storeDown = yield* makeSandboxHostReads({
        contract,
        store: brokenStore,
        runLog: yield* makeMemoryRunLog
      })
      expect(yield* storeDown.overview).toEqual({ _tag: "Failed", reason: "unavailable" })
      expect(yield* Effect.flip(storeDown.attention)).toBeInstanceOf(SandboxStoreUnavailable)
      expect(yield* storeDown.runs({ id: account("222222222222") })).toEqual({ _tag: "Failed", reason: "unavailable" })
    }))
})
