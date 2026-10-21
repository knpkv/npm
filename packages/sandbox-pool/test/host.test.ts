import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeSandboxHostReads } from "../src/host-server.js"
import {
  SandboxBlocker,
  SandboxesOverview,
  SandboxesOverviewQuery,
  sandboxNavigationBadge,
  SandboxRuns,
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
import { dryRunListedSamlProvider } from "./dry-run-fixture.js"
import { contract } from "./fixtures.js"

const entry = Schema.decodeUnknownSync(RunEntry)
const runId = Schema.decodeUnknownSync(RunId)
const account = Schema.decodeUnknownSync(AccountId)
const sandbox = Schema.decodeUnknownSync(Sandbox)
const minute = 60_000
const t0 = DateTime.makeUnsafe("2026-10-16T08:00:00.000Z")

/** A served blocker is one of these five. The copy is fixed; tests repeat it so a drifted constant fails. */
type ServedBlocker =
  | { readonly _tag: "ResourcesRemain"; readonly count: number; readonly text: string }
  | { readonly _tag: "NukeFailed"; readonly resourceType: string | null; readonly text: string }
  | { readonly _tag: "BudgetHold"; readonly text: string }
  | { readonly _tag: "ScanIncomplete"; readonly text: string }
  | { readonly _tag: "Unknown"; readonly text: string }

const budgetHold = {
  _tag: "BudgetHold",
  text: "Budget hold. Lift it with sandbox.budget.lift"
} satisfies ServedBlocker
const scanIncomplete = { _tag: "ScanIncomplete", text: "The scan did not finish" } satisfies ServedBlocker
const unknown = { _tag: "Unknown", text: "Reset failed" } satisfies ServedBlocker
const remain = (count: number): ServedBlocker => ({
  _tag: "ResourcesRemain",
  count,
  text: count === 1 ? "1 resource still removable" : `${count} resources still removable`
})
const nukeFailed = (resourceType: string | null): ServedBlocker => ({
  _tag: "NukeFailed",
  resourceType,
  text: resourceType === null ? "A resource could not be removed" : `${resourceType} could not be removed`
})

const listingFailed =
  `time="2026-10-16T09:00:00Z" level=error msg="listing failed: AccessDenied" owner=eu-central-1 resource_type=S3Bucket`
const queueFull =
  `time="2026-10-16T09:00:00Z" level=warning msg="item queue is full, not all resources will be enqueued" owner=eu-central-1 resource_type=CloudWatchLogsLogGroup`
const protectedListed =
  "global - IAMSAMLProvider - arn:aws:iam::111111111111:saml-provider/AWSSSO_x_DO_NOT_DELETE - [] - would remove"
const esc = String.fromCharCode(27)
const colouredDryRun = dryRunListedSamlProvider
  .split("\n")
  .map((row) => `${esc}[36m${row.replace(" - would remove", ` - ${esc}[32mwould remove${esc}[0m`)}\r`)
  .join("\n")

/** Every stored blocker the reset tests and the dry-run fixture can produce, plus junk. */
const storedBlockers: ReadonlyArray<{ readonly stored: string; readonly blocker: ServedBlocker }> = [
  { stored: budgetHoldBlocker(contract), blocker: budgetHold },
  { stored: "budget hold: EphemeralDenyAll attached; lift via sandbox.budget.lift", blocker: budgetHold },
  { stored: "budget hold check: AccessDenied", blocker: unknown },
  { stored: "budget hold check: PoolDenyAll attached; lift via sandbox.budget.lift", blocker: unknown },
  { stored: "verify: 2 resources still removable.", blocker: remain(2) },
  {
    stored: "verify: 1 resources still removable. CodeBuildProject x - failed: in use",
    blocker: remain(1)
  },
  { stored: "verify: 3 resources still removable.", blocker: remain(3) },
  { stored: `dry run: incomplete scan: ${listingFailed}`, blocker: scanIncomplete },
  { stored: `verify: incomplete scan and 1 more: ${listingFailed}`, blocker: scanIncomplete },
  { stored: `dry run: incomplete scan: ${queueFull}`, blocker: scanIncomplete },
  { stored: `verify: incomplete scan: ${queueFull}`, blocker: scanIncomplete },
  { stored: "nuke: S3Bucket ephemeral-a - failed: BucketNotEmpty", blocker: nukeFailed("S3Bucket") },
  { stored: "S3Bucket ephemeral-x - failed: AccessDenied", blocker: nukeFailed("S3Bucket") },
  {
    stored: `${esc}[31mnuke: S3Bucket ephemeral-a - failed: BucketNotEmpty${esc}[0m\r`,
    blocker: nukeFailed("S3Bucket")
  },
  { stored: "nuke: not-a-type id - failed: BucketNotEmpty", blocker: nukeFailed(null) },
  { stored: "baseline: AccessDenied", blocker: unknown },
  {
    stored: `guard: protected resource listed (Identity Center SAML provider): ${protectedListed}`,
    blocker: unknown
  },
  { stored: "guard: dry run counts 1 removable resources but lists 0 removal lines", blocker: unknown },
  { stored: dryRunListedSamlProvider, blocker: unknown },
  { stored: colouredDryRun, blocker: unknown },
  { stored: "customer-private-data", blocker: unknown }
]

const forbidden = [
  "BucketNotEmpty",
  "ephemeral-a",
  "ephemeral-x",
  "resource_type=",
  "AWSReservedSSO_",
  "AWSServiceRole",
  "CodeBuildProject",
  "in use",
  "customer-private-data",
  "arn:",
  "PoolDenyAll",
  "EphemeralDenyAll",
  "AccessDenied",
  "listing failed",
  "would remove",
  "AWSSSO_",
  "Scan complete",
  "not all resources will be enqueued",
  "Identity Center",
  "\\u001b",
  "\\r",
  "\r"
]

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
  it.effect("serves the lease start and the available reset time", () =>
    Effect.gen(function*() {
      const store = yield* makeMemorySandboxStore([
        leased("111111111111", "sandbox-a", 2),
        sandbox({
          accountId: "222222222222",
          name: "sandbox-b",
          version: 1,
          state: { _tag: "Available", lastResetAt: "2026-10-16T01:00:00.000Z" }
        })
      ])
      const log = yield* makeMemoryRunLog
      const reads = yield* makeSandboxHostReads({ contract, store, runLog: log })
      const overview = yield* reads.overview
      if (overview._tag !== "Ready") throw new Error("expected a ready overview")
      const byId = new Map(overview.sandboxes.map((card) => [card.accountId, card]))
      const held = byId.get(account("111111111111"))
      const free = byId.get(account("222222222222"))
      if (held?.state._tag !== "Leased") throw new Error("expected a lease")
      if (free?.state._tag !== "Available") throw new Error("expected an available account")
      expect(DateTime.formatIso(held.state.startedAt)).toBe("2026-10-16T08:00:00.000Z")
      if (free.state.lastResetAt === null) throw new Error("expected a reset time")
      expect(DateTime.formatIso(free.state.lastResetAt)).toBe("2026-10-16T01:00:00.000Z")
    }))

  it.effect("serves every stored blocker as one closed tag, and drops the stored line", () =>
    Effect.gen(function*() {
      for (const sample of storedBlockers) {
        const store = yield* makeMemorySandboxStore([quarantined("222222222222", "sandbox-b", sample.stored)])
        const log = yield* makeMemoryRunLog
        yield* log.record(started("run-current", "222222222222", "2026-10-16T08:00:00.000Z"))
        yield* log.record(finished("run-current", "Quarantined", "2026-10-16T08:03:00.000Z", sample.stored))
        const reads = yield* makeSandboxHostReads({ contract, store, runLog: log })
        const overview = yield* reads.overview
        const runs = yield* reads.runs({ id: account("222222222222") })
        expect(Schema.decodeUnknownSync(SandboxesOverview)(overview), sample.stored).toEqual(overview)
        expect(Schema.decodeUnknownSync(SandboxRuns)(runs), sample.stored).toEqual(runs)
        const served = `${JSON.stringify(overview)}\n${JSON.stringify(runs)}`
        for (const secret of forbidden) {
          expect(served, sample.stored).not.toContain(secret)
        }
        expect(served, sample.stored).not.toContain(sample.stored)
        if (overview._tag !== "Ready") throw new Error("expected a ready overview")
        const card = overview.sandboxes[0]
        if (card?.state._tag !== "Quarantined") throw new Error("expected a quarantined card")
        expect(card.state.blocker, sample.stored).toEqual(sample.blocker)
        if (runs._tag !== "Ready") throw new Error("expected a ready runs page")
        expect(runs.runs[0]?.blocker, sample.stored).toEqual(sample.blocker)
      }
    }))

  it("rejects stored free text and a blocker whose copy was rewritten", () => {
    expect(
      Schema.decodeUnknownResult(SandboxBlocker)(
        "verify: 1 resources still removable. CodeBuildProject x - failed: in use"
      )._tag
    ).toBe("Failure")
    expect(Schema.decodeUnknownResult(SandboxBlocker)({ _tag: "Unknown", text: "customer-private-data" })._tag).toBe(
      "Failure"
    )
    expect(
      Schema.decodeUnknownResult(SandboxBlocker)({
        _tag: "ResourcesRemain",
        count: 1,
        text: "1 resources still removable"
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(SandboxBlocker)({
        _tag: "NukeFailed",
        resourceType: "ephemeral-a",
        text: "A resource could not be removed"
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(SandboxBlocker)({
        _tag: "NukeFailed",
        resourceType: null,
        text: "S3Bucket could not be removed"
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(SandboxBlocker)({
        _tag: "BudgetHold",
        text: "budget hold: PoolDenyAll attached; lift via sandbox.budget.lift"
      })._tag
    ).toBe("Failure")
    expect(Schema.decodeUnknownSync(SandboxBlocker)(budgetHold)).toEqual(budgetHold)
    expect(Schema.decodeUnknownSync(SandboxBlocker)(remain(1))).toEqual(remain(1))
    expect(Schema.decodeUnknownSync(SandboxBlocker)(nukeFailed("S3Bucket"))).toEqual(nukeFailed("S3Bucket"))
    expect(Schema.decodeUnknownSync(SandboxBlocker)(nukeFailed(null))).toEqual(nukeFailed(null))
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
          blocker: unknown
        }
      })
      expect(byId.get(account("999999999991"))).toMatchObject({
        label: "left the pool",
        state: {
          _tag: "Quarantined",
          blocker: budgetHold
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
        runs: [{ runId: "run-current", step: null, blocker: unknown, outcome: "Quarantined" }]
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
