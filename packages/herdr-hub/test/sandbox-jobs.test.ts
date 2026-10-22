import { describe, expect, it } from "@effect/vitest"
import type { ApprovedJobIdentity } from "@knpkv/herdr-fleet"
import { JobHash, type SandboxJobPayload, type SandboxObservation } from "@knpkv/herdr-fleet/model"
import {
  budgetHoldBlocker,
  Holder,
  lease,
  makeMemoryRunLog,
  makeMemorySandboxStore,
  Nuke,
  type NukeOutcome,
  PoolAccess,
  PoolContract,
  RunId,
  Sandbox,
  SandboxState,
  SandboxStoreUnavailable,
  seedPool,
  SpendReader,
  type SpendReadError,
  SpendThrottled,
  SpendUnavailable,
  StaleVersion
} from "@knpkv/sandbox-pool"
import { DateTime, Duration, Effect, Fiber, Latch, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  BudgetControl,
  BudgetLiftFailed,
  makeSandboxPool,
  runSandboxSweep,
  type SandboxPoolServices
} from "../src/sandbox-jobs.js"

/** An invented pool: no real organization's IDs or names. */
const contract = Schema.decodeUnknownSync(PoolContract)({
  accounts: [
    { name: "sandbox-a", accountId: "999999999990" },
    { name: "sandbox-b", accountId: "999999999991" }
  ],
  nukeBlocklist: ["999999999900"],
  regions: ["eu-central-1"],
  accountAccessRole: "PoolAccessRole",
  boundaryPath: "/pool/",
  boundaryName: "PoolBoundary",
  accountAliasPrefix: "example-pool-",
  budgetActionRole: "example-pool-budget-action",
  denyAllPolicy: "PoolDenyAll"
})
const accountA = "999999999990"
const accountB = "999999999991"
const approval: ApprovedJobIdentity = {
  approvedBy: "owner",
  approvedAt: 0,
  hash: Schema.decodeUnknownSync(JobHash)("a".repeat(64))
}
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Sandbox))
const availableObserved = {
  endsAt: null,
  holder: null,
  state: "Available",
  version: 0
} satisfies SandboxObservation
const observe = (sandbox: Sandbox): SandboxObservation =>
  sandbox.state._tag === "Leased"
    ? {
      endsAt: DateTime.formatIso(sandbox.state.endsAt),
      holder: sandbox.state.holder,
      state: "Leased",
      version: sandbox.version
    }
    : { endsAt: null, holder: null, state: sandbox.state._tag, version: sandbox.version }
const clean = `Scan complete: 5 total, 0 nukeable, 5 filtered.`

interface FakeOptions {
  readonly hold?: boolean
  /** Outputs each aws-nuke call returns in order; a clean scan once they run out. */
  readonly runs?: Array<NukeOutcome>
  /** Holds every aws-nuke call until this effect completes. */
  readonly gate?: Effect.Effect<void>
  /** Holds the store's `list` after it has read, so a sweep acts on a snapshot that ages. */
  readonly listGate?: Effect.Effect<void>
  /** Makes the budget lift fail, as a detach that errored after it may have changed the account. */
  readonly liftFails?: boolean
  /** Fails every put as the store does when it cannot tell whether the write landed. */
  readonly putFails?: boolean
  /** The compare-and-set loses, as another writer landed first. */
  readonly putStale?: boolean
  /** Each account's answer to a spend read, by account id. Without it the pool has no reader. */
  readonly spend?: ReadonlyMap<string, Effect.Effect<number, SpendReadError>>
}

/** A pool over the memory store and run log, with fakes that record every AWS-side call. */
const fixture = (options: FakeOptions = {}, initial: ReadonlyArray<Sandbox> = seedPool(contract)) =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    let held = options.hold ?? false
    const memory = yield* makeMemorySandboxStore(initial)
    const store = {
      ...memory,
      list: Effect.tap(memory.list, () => options.listGate ?? Effect.void),
      put: (next: Sandbox) =>
        options.putFails === true
          ? Effect.fail(new SandboxStoreUnavailable({ operation: "put", detail: "chmod failed after commit" }))
          : options.putStale === true
          ? Effect.fail(
            new StaleVersion({ accountId: next.accountId, expected: next.version - 1, actual: next.version })
          )
          : memory.put(next)
    }
    const runLog = yield* makeMemoryRunLog
    const services: SandboxPoolServices = {
      contract,
      store,
      runLog,
      access: PoolAccess.of({
        session: () =>
          Effect.succeed({
            accessKeyId: "ASIATEST",
            secretAccessKey: Redacted.make("secret"),
            sessionToken: Redacted.make("token")
          }),
        ensureBaseline: () => Effect.void,
        budgetHold: () => Effect.sync(() => held)
      }),
      nuke: Nuke.of({
        writeConfig: (accountId) => Effect.succeed(`/tmp/nuke-${accountId}.json`),
        run: ({ live }) =>
          Effect.sync(() => calls.push(live ? "nuke live" : "nuke dry")).pipe(
            Effect.andThen(options.gate ?? Effect.void),
            Effect.as(options.runs?.shift() ?? { exitCode: 0, output: clean })
          )
      }),
      budget: BudgetControl.of({
        lift: (accountId) =>
          options.liftFails === true
            ? Effect.fail(new BudgetLiftFailed({ accountId, detail: "throttled" }))
            : Effect.sync(() => {
              calls.push(`lift ${accountId}`)
              held = false
            })
      })
    }
    const reader = SpendReader.of({
      monthToDate: (account) =>
        Effect.suspend(() => {
          calls.push(`spend ${account.accountId}`)
          return options.spend?.get(account.accountId) ??
            Effect.fail(new SpendUnavailable({ accountId: account.accountId, detail: "unknown" }))
        })
    })
    const pool = yield* makeSandboxPool(options.spend === undefined ? services : { ...services, spend: reader })
    const job = (payload: SandboxJobPayload, actor: string, id: string, approved = false) =>
      pool.run(payload, id, actor, approved ? approval : null).pipe(Effect.map(decodeResult))
    return { pool, store, runLog, calls, job }
  })

describe("sandbox jobs", () => {
  it.effect("the job's actor leases, extends and releases; release resets in the same job", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      expect(leased.state).toMatchObject({ _tag: "Leased", holder: "agent-a" })
      const extended = yield* f.job({ kind: "sandbox.extend", accountId: leased.accountId }, "agent-a", "job-2")
      expect(extended.version).toBe(leased.version + 1)
      const released = yield* f.job({ kind: "sandbox.release", accountId: leased.accountId }, "agent-a", "job-3")
      expect(released.state._tag).toBe("Available")
      expect(f.calls).toEqual(["nuke dry", "nuke live", "nuke dry"])
      expect(yield* f.runLog.recent(5)).toMatchObject([{ runId: "job-3", reason: "Released", outcome: "Available" }])
    }))

  it.effect("another actor can neither extend nor release a lease, and nothing is written", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      const foreign: ReadonlyArray<SandboxJobPayload> = [
        { kind: "sandbox.extend", accountId: leased.accountId },
        { kind: "sandbox.release", accountId: leased.accountId }
      ]
      for (const payload of foreign) {
        const error = yield* Effect.flip(f.job(payload, "agent-b", `job-${payload.kind}`))
        expect(error).toMatchObject({ _tag: "FleetOperationError", disposition: "rejected" })
        expect(error.detail).toContain("NotHolder")
      }
      expect(yield* f.store.get(leased.accountId)).toEqual(leased)
      expect(f.calls).toEqual([])
    }))

  it.effect("reset and budget lift refuse to run without a persisted approval", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      for (
        const payload of [
          { kind: "sandbox.reset", accountId: accountA, reason: "Manual" },
          { kind: "sandbox.budget.lift", accountId: accountA }
        ] satisfies ReadonlyArray<SandboxJobPayload>
      ) {
        const error = yield* Effect.flip(f.job(payload, "owner", "job-x"))
        expect(error.detail).toContain("ApprovalRequired")
      }
      expect(f.calls).toEqual([])
    }))

  it.effect("an approved reset with no bound record is rejected before anything is nuked", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.reset", accountId: accountA, reason: "Manual" }, "owner", "job-1", true)
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("ApprovalUnbound")
      expect(yield* f.store.get(accountA)).toMatchObject({ version: 0, state: { _tag: "Available" } })
      expect(f.calls).toEqual([])
    }))

  it.effect("a reset bound to a record that has since been leased is rejected and the lease stays", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      const error = yield* Effect.flip(
        f.job(
          { kind: "sandbox.reset", accountId: leased.accountId, reason: "Manual", observed: availableObserved },
          "owner",
          "job-2",
          true
        )
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("RecordMoved")
      expect(yield* f.store.get(leased.accountId)).toEqual(leased)
      expect(f.calls).toEqual([])
    }))

  it.effect("a lost compare-and-set on reset is rejected before nuke", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ putStale: true })
      const before = yield* f.store.get(accountA)
      const error = yield* Effect.flip(
        f.job(
          { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
          "owner",
          "job-1",
          true
        )
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("RecordMoved")
      expect(yield* f.store.get(accountA)).toEqual(before)
      expect(f.calls).toEqual([])
    }))

  it.effect("a budget lift bound to a record that moved does not detach the policy", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ hold: true })
      const error = yield* Effect.flip(
        f.job(
          {
            kind: "sandbox.budget.lift",
            accountId: accountA,
            observed: { endsAt: null, holder: null, state: "Quarantined", version: 3 }
          },
          "owner",
          "job-1",
          true
        )
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("RecordMoved")
      expect(f.calls.some((call) => call.startsWith("lift"))).toBe(false)
    }))

  it.effect("a lost compare-and-set after the policy was lifted is not a rejection", () =>
    Effect.gen(function*() {
      const now = yield* DateTime.now
      const initial = seedPool(contract).map((sandbox): Sandbox =>
        sandbox.accountId === accountA
          ? {
            ...sandbox,
            state: SandboxState.cases.Quarantined.make({
              blocker: budgetHoldBlocker(contract),
              runId: Schema.decodeUnknownSync(RunId)("prior-run"),
              since: now
            }),
            version: 1
          }
          : sandbox
      )
      const held = initial.find((sandbox) => sandbox.accountId === accountA)
      if (held === undefined) return yield* Effect.die("account A missing from the seed")
      const f = yield* fixture({ putStale: true }, initial)
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.budget.lift", accountId: accountA, observed: observe(held) }, "owner", "job-1", true)
      )
      expect(error.disposition).toBeUndefined()
      expect(error.detail).toContain("StaleVersion")
      expect(f.calls).toContain(`lift ${accountA}`)
    }))

  it.effect("a held account quarantines; an approved lift detaches the policy and resets it to Available", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ hold: true })
      const reset = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
        "owner",
        "job-1",
        true
      )
      expect(reset.state).toMatchObject({ _tag: "Quarantined", blocker: budgetHoldBlocker(contract) })
      const lifted = yield* f.job(
        { kind: "sandbox.budget.lift", accountId: accountA, observed: observe(reset) },
        "owner",
        "job-2",
        true
      )
      expect(lifted.state._tag).toBe("Available")
      expect(f.calls).toContain(`lift ${accountA}`)
    }))

  it.effect("a lift on an account that is not budget-held is rejected before anything is detached", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ runs: [{ exitCode: 1, output: "boom" }] })
      const failed = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
        "owner",
        "job-1",
        true
      )
      expect(failed.state._tag).toBe("Quarantined")
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.budget.lift", accountId: accountA, observed: observe(failed) }, "owner", "job-2", true)
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("NotBudgetHeld")
      expect(f.calls.some((call) => call.startsWith("lift"))).toBe(false)
    }))

  it.effect("two approved retries bound to one quarantine reset it once; the second is refused as moved", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ runs: [{ exitCode: 1, output: "boom" }] })
      const quarantined = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
        "owner",
        "job-1",
        true
      )
      expect(quarantined.state._tag).toBe("Quarantined")
      const bound = observe(quarantined)
      const first = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Retry", observed: bound },
        "owner",
        "job-2",
        true
      )
      expect(first.state._tag).toBe("Available")
      const nukesAfterFirst = f.calls.length
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.reset", accountId: accountA, reason: "Retry", observed: bound }, "owner", "job-3", true)
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("RecordMoved")
      expect(f.calls.length).toBe(nukesAfterFirst)
      expect(yield* f.store.get(accountA)).toEqual(first)
    }))

  it.effect("two approved lifts bound to one budget hold lift it once; the second is refused as moved", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ hold: true })
      const held = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
        "owner",
        "job-1",
        true
      )
      const bound = observe(held)
      const first = yield* f.job(
        { kind: "sandbox.budget.lift", accountId: accountA, observed: bound },
        "owner",
        "job-2",
        true
      )
      expect(first.state._tag).toBe("Available")
      const callsAfterFirst = f.calls.length
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.budget.lift", accountId: accountA, observed: bound }, "owner", "job-3", true)
      )
      expect(error).toMatchObject({ disposition: "rejected" })
      expect(error.detail).toContain("RecordMoved")
      expect(f.calls.length).toBe(callsAfterFirst)
    }))

  it.effect("a lift that errors after it was called is not reported as rejected", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ hold: true, liftFails: true })
      const reset = yield* f.job(
        { kind: "sandbox.reset", accountId: accountA, reason: "Manual", observed: availableObserved },
        "owner",
        "job-1",
        true
      )
      const error = yield* Effect.flip(
        f.job({ kind: "sandbox.budget.lift", accountId: accountA, observed: observe(reset) }, "owner", "job-2", true)
      )
      expect(error.detail).toContain("BudgetLiftFailed")
      expect(error.disposition).toBeUndefined()
    }))

  it.effect("a failed reset step ends Quarantined as a result, not a failed job", () =>
    Effect.gen(function*() {
      const f = yield* fixture({
        runs: [{ exitCode: 0, output: clean }, { exitCode: 0, output: clean }, {
          exitCode: 0,
          output:
            "eu-central-1 - S3Bucket - s3://left - [] - would remove\nScan complete: 6 total, 1 nukeable, 5 filtered."
        }]
      })
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      const released = yield* f.job({ kind: "sandbox.release", accountId: leased.accountId }, "agent-a", "job-2")
      expect(released.state).toMatchObject({ _tag: "Quarantined", runId: "job-2" })
    }))
})

describe("sandbox sweep", () => {
  it.effect("reads each pool account's spend and keeps the last good reading when a read fails", () =>
    Effect.gen(function*() {
      const spend = new Map<string, Effect.Effect<number, SpendReadError>>([
        [accountA, Effect.succeed(7.4)],
        [accountB, Effect.succeed(3.1)]
      ])
      const f = yield* fixture({ spend })
      yield* f.pool.sweepOnce
      expect((yield* f.store.spend).map(({ accountId, usd }) => [accountId, usd])).toEqual([
        [accountA, 7.4],
        [accountB, 3.1]
      ])
      spend.set(accountA, Effect.fail(new SpendThrottled({ accountId: accountA })))
      spend.set(accountB, Effect.succeed(4.2))
      expect(yield* f.pool.sweepOnce).toMatchObject({ failed: 0 })
      expect((yield* f.store.spend).map(({ accountId, usd }) => [accountId, usd])).toEqual([
        [accountA, 7.4],
        [accountB, 4.2]
      ])
      expect(yield* f.store.sweepAt).not.toBeNull()
    }))

  it.effect("records no reading a reader answered with a negative or non-finite amount", () =>
    Effect.gen(function*() {
      const f = yield* fixture({
        spend: new Map([[accountA, Effect.succeed(-5)], [accountB, Effect.succeed(Number.NaN)]])
      })
      expect(yield* f.pool.sweepOnce).toMatchObject({ failed: 0 })
      expect(yield* f.store.spend).toEqual([])
    }))

  it.effect("reads no spend on a host without a reader", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      yield* f.pool.sweepOnce
      expect(yield* f.store.spend).toEqual([])
      expect(f.calls.filter((call) => call.startsWith("spend"))).toEqual([])
    }))

  it.effect("records the sweep time only when every account succeeded", () =>
    Effect.gen(function*() {
      const stuck = Schema.decodeUnknownSync(Sandbox)({
        accountId: accountA,
        name: "sandbox-a",
        state: { _tag: "Cleaning", since: "1970-01-01T00:00:00Z", runId: "job-crashed", reason: "Released" },
        version: 3
      })
      const [, other] = seedPool(contract)
      const failed = yield* fixture({ putFails: true }, other === undefined ? [stuck] : [stuck, other])
      yield* failed.store.markSweep(1)
      expect(yield* failed.pool.sweepOnce).toMatchObject({ failed: 1 })
      expect(yield* failed.store.sweepAt).toBe(1)

      const done = yield* fixture()
      expect(yield* done.store.sweepAt).toBeNull()
      expect(yield* done.pool.sweepOnce).toMatchObject({ expired: 0, resumed: 0, failed: 0 })
      const recorded = yield* done.store.sweepAt
      expect(recorded).not.toBeNull()
    }))

  it.effect("expires a lease at its end, resets it, and leaves the others alone", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      yield* TestClock.adjust(Duration.hours(7))
      expect(yield* f.pool.sweepOnce).toMatchObject({ expired: 0, resumed: 0, failed: 0 })
      expect((yield* f.store.get(leased.accountId)).state._tag).toBe("Leased")
      yield* TestClock.adjust(Duration.hours(1))
      expect(yield* f.pool.sweepOnce).toMatchObject({ expired: 1, resumed: 0 })
      expect((yield* f.store.get(leased.accountId)).state._tag).toBe("Available")
      expect((yield* f.runLog.recent(5))[0]).toMatchObject({ reason: "Expired", outcome: "Available" })
    }))

  it.effect("resumes a reset left in Cleaning with its own run id, once", () =>
    Effect.gen(function*() {
      const stuck = Schema.decodeUnknownSync(Sandbox)({
        accountId: accountA,
        name: "sandbox-a",
        state: { _tag: "Cleaning", since: "1970-01-01T00:00:00Z", runId: "job-crashed", reason: "Released" },
        version: 3
      })
      const [, other] = seedPool(contract)
      const f = yield* fixture({}, other === undefined ? [stuck] : [stuck, other])
      expect(yield* f.pool.sweepOnce).toMatchObject({ resumed: 1 })
      expect(yield* f.store.get(accountA)).toMatchObject({ version: 4, state: { _tag: "Available" } })
      expect((yield* f.runLog.recent(5))[0]).toMatchObject({ runId: "job-crashed" })
      expect(yield* f.pool.sweepOnce).toMatchObject({ resumed: 0 })
    }))

  it.effect("never resets from a stale snapshot: a job that finished meanwhile wins", () =>
    Effect.gen(function*() {
      const nukeGate = yield* Latch.make(false)
      const listGate = yield* Latch.make(true)
      const f = yield* fixture({ gate: nukeGate.await, listGate: listGate.await })
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      const releasing = yield* Effect.forkChild(
        f.job({ kind: "sandbox.release", accountId: leased.accountId }, "agent-a", "job-2")
      )
      yield* Effect.yieldNow
      // The sweep lists while the account is Cleaning, then waits before acting on that snapshot.
      yield* listGate.close
      const sweeping = yield* Effect.forkChild(f.pool.sweepOnce)
      yield* Effect.yieldNow
      yield* nukeGate.open
      expect((yield* Fiber.join(releasing)).state._tag).toBe("Available")
      yield* listGate.open
      expect(yield* Fiber.join(sweeping)).toMatchObject({ resumed: 0, failed: 0 })
      expect(f.calls.filter((call) => call === "nuke live")).toHaveLength(1)
      expect((yield* f.store.get(leased.accountId)).state._tag).toBe("Available")
    }))

  it.effect("skips an account whose reset a job is running", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make(false)
      const f = yield* fixture({ gate: gate.await })
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      const releasing = yield* Effect.forkChild(
        f.job({ kind: "sandbox.release", accountId: leased.accountId }, "agent-a", "job-2")
      )
      yield* Effect.yieldNow
      expect((yield* f.store.get(leased.accountId)).state._tag).toBe("Cleaning")
      expect(yield* f.pool.sweepOnce).toMatchObject({ resumed: 0 })
      yield* gate.open
      expect((yield* Fiber.join(releasing)).state._tag).toBe("Available")
      expect(f.calls.filter((call) => call === "nuke live")).toHaveLength(1)
    }))

  it.effect("the sweep fiber runs now and every five minutes, and stops with its fiber", () =>
    Effect.gen(function*() {
      const f = yield* fixture()
      const fiber = yield* Effect.forkChild(runSandboxSweep(f.pool))
      yield* Effect.yieldNow
      const first = yield* f.pool.lastSweep
      expect(first).not.toBeNull()
      yield* TestClock.adjust(Duration.minutes(5))
      const second = yield* f.pool.lastSweep
      expect(second?.at).not.toEqual(first?.at)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(Duration.minutes(5))
      expect(yield* f.pool.lastSweep).toEqual(second)
    }))

  it.effect("an account that left the contract is never leased and cannot be extended", () =>
    Effect.gen(function*() {
      const retired = Schema.decodeUnknownSync(PoolContract)({
        ...Schema.encodeSync(PoolContract)(contract),
        accounts: [{ name: "sandbox-z", accountId: "999999999992" }]
      })
      const now = DateTime.makeUnsafe("2026-10-17T08:00:00Z")
      const retiredLeased = yield* lease(seedPool(retired), Schema.decodeUnknownSync(Holder)("agent-a"), now)
      const retiredFree = seedPool(
        Schema.decodeUnknownSync(PoolContract)({
          ...Schema.encodeSync(PoolContract)(contract),
          accounts: [{ name: "sandbox-y", accountId: "999999999993" }]
        })
      )
      const f = yield* fixture({}, [...retiredFree, retiredLeased, ...seedPool(contract)])
      const leased = [
        yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1"),
        yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-2")
      ]
      expect(leased.map(({ accountId }) => accountId).sort()).toEqual(["999999999990", "999999999991"])
      const none = yield* Effect.flip(f.job({ kind: "sandbox.lease" }, "agent-a", "job-3"))
      expect(none).toMatchObject({ disposition: "rejected" })
      expect(none.detail).toContain("NoneAvailable")
      const extend = yield* Effect.flip(
        f.job({ kind: "sandbox.extend", accountId: retiredLeased.accountId }, "agent-a", "job-4")
      )
      expect(extend).toMatchObject({ disposition: "rejected" })
      expect(extend.detail).toContain("AccountNotInPool")
      expect(yield* f.store.get(retiredLeased.accountId)).toEqual(retiredLeased)
    }))

  it.effect("a put the store cannot confirm is a failure, never a rejection", () =>
    Effect.gen(function*() {
      const f = yield* fixture({ putFails: true })
      const error = yield* Effect.flip(f.job({ kind: "sandbox.lease" }, "agent-a", "job-1"))
      expect(error.detail).toContain("SandboxStoreUnavailable")
      expect(error.disposition).toBeUndefined()
    }))

  it.effect("a record whose account was renamed in the contract is history: not leased, changed or swept", () =>
    Effect.gen(function*() {
      const renamed = Schema.decodeUnknownSync(PoolContract)({
        ...Schema.encodeSync(PoolContract)(contract),
        accounts: [{ name: "sandbox-old", accountId: accountA }]
      })
      // On the test clock, so the sweep below runs past this lease's end.
      const now = yield* DateTime.now
      const oldLease = yield* lease(seedPool(renamed), Schema.decodeUnknownSync(Holder)("agent-a"), now)
      const current = seedPool(contract).filter(({ accountId }) => accountId !== accountA)
      const f = yield* fixture({}, [oldLease, ...current])
      const leased = yield* f.job({ kind: "sandbox.lease" }, "agent-a", "job-1")
      expect(leased.accountId).toBe(accountB)
      expect((yield* Effect.flip(f.job({ kind: "sandbox.lease" }, "agent-a", "job-2"))).detail).toContain(
        "NoneAvailable"
      )
      for (
        const payload of [
          { kind: "sandbox.extend", accountId: accountA },
          { kind: "sandbox.release", accountId: accountA }
        ] satisfies ReadonlyArray<SandboxJobPayload>
      ) {
        const error = yield* Effect.flip(f.job(payload, "agent-a", `job-${payload.kind}`))
        expect(error).toMatchObject({ disposition: "rejected" })
        expect(error.detail).toContain("AccountNotInPool")
      }
      yield* TestClock.adjust(Duration.hours(9))
      // Only the current account's own lease expires; the renamed record is left as it was.
      expect(yield* f.pool.sweepOnce).toMatchObject({ expired: 1, resumed: 0, failed: 0 })
      expect(yield* f.store.get(accountA)).toEqual(oldLease)
      expect((yield* f.store.get(accountB)).state._tag).toBe("Available")
    }))
})
