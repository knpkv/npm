import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { AccountId, Holder, lease, PoolContract, RunEntry, RunId, SandboxName } from "@knpkv/sandbox-pool"
import { DateTime, Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { openSandboxDatabase } from "../src/sandbox-store.js"

/** An invented pool: no real organization's IDs or names. */
const contractInput = {
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
}
const contract = Schema.decodeUnknownSync(PoolContract)(contractInput)
const holder = Schema.decodeUnknownSync(Holder)("agent-a")
const now = DateTime.makeUnsafe("2026-10-17T08:00:00Z")

const databasePath = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-store-" }), "sandboxes.sqlite")
})

it.layer(NodeServices.layer)("sandbox store", (it) => {
  it.effect("seeds the contract's accounts once and keeps records across reopen", () =>
    Effect.gen(function*() {
      const path = yield* databasePath
      const leased = yield* Effect.scoped(Effect.gen(function*() {
        const { store } = yield* openSandboxDatabase(path, contract)
        expect((yield* store.list).map(({ name, version }) => `${name}@${version}`)).toEqual([
          "sandbox-a@0",
          "sandbox-b@0"
        ])
        return yield* store.put(yield* lease(yield* store.list, holder, now))
      }))
      // Keep the leased account, drop the other one, add a third.
      const kept = contractInput.accounts.find(({ accountId }) => accountId === leased.accountId)
      const grown = Schema.decodeUnknownSync(PoolContract)({
        ...contractInput,
        accounts: [kept, { name: "sandbox-c", accountId: "999999999992" }]
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const { store } = yield* openSandboxDatabase(path, grown)
        const records = yield* store.list
        // The leased record survives, the new account is seeded, the dropped one keeps its row.
        expect(records.map(({ name, version }) => `${name}@${version}`)).toEqual(
          ["sandbox-a", "sandbox-b", "sandbox-c"].map((name) => `${name}@${name === leased.name ? 1 : 0}`)
        )
        expect(yield* store.get(leased.accountId)).toEqual(leased)
      }))
    }))

  it.effect("writes only from the current version, and only the same account", () =>
    Effect.gen(function*() {
      const { store } = yield* openSandboxDatabase(yield* databasePath, contract)
      const pool = yield* store.list
      const next = yield* lease(pool, holder, now)
      yield* store.put(next)
      expect(yield* Effect.flip(store.put(next))).toMatchObject({ _tag: "StaleVersion", expected: 0, actual: 1 })
      expect(
        yield* Effect.flip(store.put({ ...next, version: 2, name: Schema.decodeUnknownSync(SandboxName)("other") }))
      )
        .toMatchObject({ _tag: "RecordMismatch", stored: next.name, received: "other" })
      expect(yield* Effect.flip(store.put({ ...next, accountId: Schema.decodeUnknownSync(AccountId)("999999999999") })))
        .toMatchObject({ _tag: "SandboxNotFound" })
      expect(yield* Effect.flip(store.get("999999999999"))).toMatchObject({ _tag: "SandboxNotFound" })
    }).pipe(Effect.scoped))

  it.effect("two connections racing on one version: exactly one write lands", () =>
    Effect.gen(function*() {
      const path = yield* databasePath
      const first = yield* openSandboxDatabase(path, contract)
      const second = yield* openSandboxDatabase(path, contract)
      const pool = yield* first.store.list
      const next = yield* lease(pool, holder, now)
      const results = yield* Effect.all([first.store.put(next), second.store.put(next)].map(Effect.result), {
        concurrency: "unbounded"
      })
      expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"])
      expect((yield* second.store.get(next.accountId)).version).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("an undecodable row is a typed store failure, never a defect", () =>
    Effect.gen(function*() {
      const path = yield* databasePath
      const { runLog, store } = yield* openSandboxDatabase(path, contract)
      const raw = yield* Effect.acquireRelease(
        openPrivateSqlite(path, { initialize: () => undefined }),
        (opened) => Effect.sync(() => opened.database.close())
      )
      raw.database.prepare("UPDATE sandboxes SET record = '{not json' WHERE account_id = ?").run("999999999990")
      raw.database.prepare("INSERT INTO sandbox_run_entries (run_id, started, entry) VALUES ('run-x', 1, '[]')").run()
      expect(yield* Effect.flip(store.list)).toMatchObject({ _tag: "SandboxStoreUnavailable", operation: "list" })
      expect(yield* Effect.flip(store.get("999999999990"))).toMatchObject({ _tag: "SandboxStoreUnavailable" })
      expect(yield* Effect.flip(runLog.recent(5))).toMatchObject({ _tag: "RunLogUnavailable" })
      expect(yield* Effect.flip(runLog.entries(Schema.decodeUnknownSync(RunId)("run-x")))).toMatchObject({
        _tag: "RunLogUnavailable"
      })
    }).pipe(Effect.scoped))

  it.effect("keeps run entries in order and summarizes the newest runs", () =>
    Effect.gen(function*() {
      const { runLog } = yield* openSandboxDatabase(yield* databasePath, contract)
      const entry = Schema.decodeUnknownSync(RunEntry)
      yield* runLog.record(entry({
        _tag: "Started",
        runId: "run-a",
        accountId: "999999999990",
        reason: "Released",
        at: "2026-10-17T08:00:00Z"
      }))
      yield* runLog.record(entry({
        _tag: "Step",
        runId: "run-a",
        step: "nuke",
        status: "started",
        at: "2026-10-17T08:01:00Z",
        detail: null,
        output: []
      }))
      yield* runLog.record(entry({
        _tag: "Started",
        runId: "run-b",
        accountId: "999999999991",
        reason: "Expired",
        at: "2026-10-17T09:00:00Z"
      }))
      const runA = Schema.decodeUnknownSync(RunId)("run-a")
      expect((yield* runLog.entries(runA)).map(({ _tag }) => _tag)).toEqual(["Started", "Step"])
      expect((yield* runLog.recent(5)).map(({ current, runId }) => `${runId}:${current}`)).toEqual([
        "run-b:null",
        "run-a:nuke"
      ])
      expect((yield* runLog.recent(1)).map(({ runId }) => runId)).toEqual(["run-b"])
      // A resumed run records a second Started entry; it still counts as one run.
      yield* runLog.record(entry({
        _tag: "Started",
        runId: "run-b",
        accountId: "999999999991",
        reason: "Expired",
        at: "2026-10-17T09:05:00Z"
      }))
      expect((yield* runLog.recent(2)).map(({ runId }) => runId)).toEqual(["run-b", "run-a"])
    }).pipe(Effect.scoped))
})
