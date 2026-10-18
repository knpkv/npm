/** The pool owner's private sandbox records and reset run log, in one SQLite database. @module */
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import {
  pageRuns,
  type PoolContract,
  RecordMismatch,
  RunEntry,
  type RunId,
  RunLog,
  RunLogUnavailable,
  Sandbox,
  SandboxNotFound,
  SandboxStore,
  SandboxStoreUnavailable,
  seedPool,
  StaleVersion,
  summarizeRuns
} from "@knpkv/sandbox-pool"
import { Effect, Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"

const sandboxJson = Schema.fromJsonString(Sandbox)
const entryJson = Schema.fromJsonString(RunEntry)
const decodeSandbox = Schema.decodeUnknownSync(sandboxJson)
const encodeSandbox = Schema.encodeSync(sandboxJson)
const decodeEntry = Schema.decodeUnknownSync(entryJson)
const encodeEntry = Schema.encodeSync(entryJson)
const SandboxRow = Schema.Struct({ record: Schema.String })
const EntryRow = Schema.Struct({ entry: Schema.String })
const RunRow = Schema.Struct({ run_id: Schema.String })
const SweepRow = Schema.Struct({ swept_at: Schema.NullOr(Schema.Int) })
const decodeRows = <A>(row: Schema.Codec<A>) => Schema.decodeUnknownSync(Schema.Array(row))

/** Every driver throw and undecodable row ends in this store's typed error, never a defect. */
const attempt = <A, E>(run: () => A, failure: (cause: unknown) => E) => Effect.try({ try: run, catch: failure })

const transaction = <A>(database: DatabaseSync, run: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = run()
    database.exec("COMMIT")
    return result
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

const storeFailure = (operation: SandboxStoreUnavailable["operation"]) => (cause: unknown) =>
  new SandboxStoreUnavailable({ operation, detail: String(cause) })
const logFailure = (cause: unknown) => new RunLogUnavailable({ detail: String(cause) })

/** A put's outcome inside its transaction; turned into the store's typed result outside it. */
type PutOutcome =
  | { readonly _tag: "Written" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Mismatch"; readonly stored: string }
  | { readonly _tag: "Stale"; readonly actual: number }

/** A rename's outcome inside its transaction. Conflict means the version moved and nothing was written. */
type RenameOutcome =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Same" | "Renamed"; readonly sandbox: Sandbox }
  | { readonly _tag: "Conflict" }

/**
 * Opens `<path>` in the caller's scope; failing to open is the private database's own error. The pool's accounts are seeded as Available at version 0 the
 * first time each appears in the contract. An account that leaves the contract keeps its row.
 * A contract that keeps the id and changes the name is migrated on open: `rename` writes the new
 * name and leaves the version and state. A later open of the same name changes nothing.
 *
 * Records and run entries are server-private: entries carry aws-nuke output naming the account's
 * resources and are served to the pool owner only.
 */
export const openSandboxDatabase = Effect.fn("SandboxDatabase.open")(function*(path: string, contract: PoolContract) {
  const seed = seedPool(contract).map((sandbox) => ({ accountId: sandbox.accountId, record: encodeSandbox(sandbox) }))
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(path, {
      busyTimeoutMillis: 2_000,
      initialize: (database) => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS sandboxes (
            account_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sandbox_run_entries (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, started INTEGER NOT NULL, entry TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS sandbox_run_entries_run ON sandbox_run_entries (run_id, seq);
          CREATE TABLE IF NOT EXISTS sandbox_sweep (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            swept_at INTEGER
          );
        `)
        const insert = database.prepare(
          "INSERT OR IGNORE INTO sandboxes (account_id, version, record) VALUES (?, 0, ?)"
        )
        for (const { accountId, record } of seed) insert.run(accountId, record)
      }
    }),
    (resource) => Effect.sync(() => resource.database.close())
  )
  const database = opened.database
  const secure = <E>(failure: (cause: unknown) => E) => opened.secureFiles.pipe(Effect.mapError(failure))

  const readRecord = (accountId: string): Sandbox | undefined => {
    const row = database.prepare("SELECT record FROM sandboxes WHERE account_id = ?").get(accountId)
    return row === undefined ? undefined : decodeSandbox(Schema.decodeUnknownSync(SandboxRow)(row).record)
  }

  // A put that committed but could not re-secure the files fails as SandboxStoreUnavailable: the row may
  // have landed, so callers must not report it as "nothing written".
  const store = SandboxStore.of({
    list: attempt(
      () =>
        decodeRows(SandboxRow)(database.prepare("SELECT record FROM sandboxes ORDER BY account_id").all()).map((row) =>
          decodeSandbox(row.record)
        ),
      storeFailure("list")
    ),
    get: (accountId) =>
      attempt(() => readRecord(accountId), storeFailure("get")).pipe(
        Effect.flatMap((found) =>
          found === undefined ? Effect.fail(new SandboxNotFound({ accountId })) : Effect.succeed(found)
        )
      ),
    put: (next) =>
      attempt(
        () =>
          transaction(database, (): PutOutcome => {
            const current = readRecord(next.accountId)
            if (current === undefined) return { _tag: "Missing" }
            if (current.name !== next.name) return { _tag: "Mismatch", stored: current.name }
            const written = database
              .prepare("UPDATE sandboxes SET version = ?, record = ? WHERE account_id = ? AND version = ?")
              .run(next.version, encodeSandbox(next), next.accountId, next.version - 1)
            return written.changes === 1 ? { _tag: "Written" } : { _tag: "Stale", actual: current.version }
          }),
        storeFailure("put")
      ).pipe(
        Effect.tap(() => secure(storeFailure("put"))),
        Effect.flatMap((outcome): Effect.Effect<Sandbox, StaleVersion | SandboxNotFound | RecordMismatch> => {
          switch (outcome._tag) {
            case "Written":
              return Effect.succeed(next)
            case "Missing":
              return Effect.fail(new SandboxNotFound({ accountId: next.accountId }))
            case "Mismatch":
              return Effect.fail(
                new RecordMismatch({ accountId: next.accountId, stored: outcome.stored, received: next.name })
              )
            case "Stale":
              return Effect.fail(
                new StaleVersion({ accountId: next.accountId, expected: next.version - 1, actual: outcome.actual })
              )
          }
        })
      ),
    sweepAt: attempt(() => {
      const row = database.prepare("SELECT swept_at FROM sandbox_sweep WHERE id = 1").get()
      return row === undefined ? null : Schema.decodeUnknownSync(SweepRow)(row).swept_at
    }, storeFailure("sweep")),
    markSweep: (at) =>
      attempt(
        () =>
          database
            .prepare(
              "INSERT INTO sandbox_sweep (id, swept_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET swept_at = excluded.swept_at"
            )
            .run(at),
        storeFailure("sweep")
      ).pipe(Effect.andThen(secure(storeFailure("sweep"))), Effect.asVoid),
    rename: (accountId, name) =>
      attempt(
        () =>
          transaction(database, (): RenameOutcome => {
            const current = readRecord(accountId)
            if (current === undefined) return { _tag: "Missing" }
            if (current.name === name) return { _tag: "Same", sandbox: current }
            const renamed = { ...current, name }
            const written = database
              .prepare("UPDATE sandboxes SET record = ? WHERE account_id = ? AND version = ?")
              .run(encodeSandbox(renamed), accountId, current.version)
            return written.changes === 1 ? { _tag: "Renamed", sandbox: renamed } : { _tag: "Conflict" }
          }),
        storeFailure("rename")
      ).pipe(
        Effect.flatMap((outcome): Effect.Effect<Sandbox, SandboxNotFound | SandboxStoreUnavailable> => {
          switch (outcome._tag) {
            case "Missing":
              return Effect.fail(new SandboxNotFound({ accountId }))
            case "Conflict":
              return Effect.fail(storeFailure("rename")("sandbox version changed during rename"))
            case "Same":
              return Effect.succeed(outcome.sandbox)
            case "Renamed":
              return secure(storeFailure("rename")).pipe(Effect.as(outcome.sandbox))
          }
        })
      )
  })

  const entriesOf = (runIds: ReadonlyArray<string>): ReadonlyArray<RunEntry> =>
    runIds.length === 0
      ? []
      : decodeRows(EntryRow)(
        database
          .prepare(
            `SELECT entry FROM sandbox_run_entries WHERE run_id IN (${runIds.map(() => "?").join(", ")}) ORDER BY seq`
          )
          .all(...runIds)
      ).map((row) => decodeEntry(row.entry))

  const runLog = RunLog.of({
    record: (entry) =>
      attempt(
        () =>
          database
            .prepare("INSERT INTO sandbox_run_entries (run_id, started, entry) VALUES (?, ?, ?)")
            .run(entry.runId, entry._tag === "Started" ? 1 : 0, encodeEntry(entry)),
        logFailure
      ).pipe(Effect.andThen(secure(logFailure))),
    entries: (runId: RunId) => attempt(() => entriesOf([runId]), logFailure),
    recent: (limit) =>
      attempt(() => {
        const runs = decodeRows(RunRow)(
          database
            .prepare(
              "SELECT run_id FROM sandbox_run_entries WHERE started = 1 GROUP BY run_id ORDER BY MAX(seq) DESC LIMIT ?"
            )
            .all(Math.max(0, Math.floor(limit)))
        )
        return summarizeRuns(entriesOf(runs.map(({ run_id }) => run_id)))
      }, logFailure),
    forAccount: (accountId, options) =>
      attempt(() => {
        const seen = new Set<RunId>()
        const started = decodeRows(EntryRow)(
          database.prepare("SELECT entry FROM sandbox_run_entries WHERE started = 1 ORDER BY seq DESC").all()
        ).flatMap((row) => {
          const decoded = decodeEntry(row.entry)
          if (decoded._tag !== "Started" || decoded.accountId !== accountId || seen.has(decoded.runId)) return []
          seen.add(decoded.runId)
          return [decoded.runId]
        })
        return started
      }, logFailure).pipe(
        Effect.flatMap((runIds) => pageRuns(runIds.map((runId) => ({ runId })), options)),
        Effect.flatMap(({ next, page }) =>
          attempt(() => {
            const byId = new Map(
              summarizeRuns(entriesOf(page.map((item) => item.runId))).map((summary) => [
                summary.runId,
                summary
              ])
            )
            return {
              runs: page.flatMap((item) => {
                const summary = byId.get(item.runId)
                return summary === undefined ? [] : [summary]
              }),
              next
            }
          }, logFailure)
        )
      )
  })

  // Same id, new contract name: the row is this account, not a second one. Ids absent from the contract stay.
  yield* Effect.forEach(contract.accounts, ({ accountId, name }) => store.rename(accountId, name), { discard: true })

  return { store, runLog }
})
