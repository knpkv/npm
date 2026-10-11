import { NodeServices } from "@effect/platform-node"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Result, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Reactivity from "effect/reactivity/Reactivity"
import { attachHostCache } from "../src/CacheService/HostReads.js"
import { ensurePrivateDatabasePath } from "../src/CacheService/internal/PrivateDatabasePathNode.js"
import type { NewAuditLogEntry } from "../src/PermissionService/AuditLog.js"

const fixture = <A, E, R>(run: (database: string, sql: LibsqlClient.LibsqlClient) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const services = yield* Layer.build(Layer.merge(Reactivity.layer, NodeServices.layer))
    return yield* Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-host-cache-" })
      const database = `${directory}/cache.db`
      yield* ensurePrivateDatabasePath(directory, database)
      const sql = yield* LibsqlClient.make({ url: `file:${database}` })
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY)`
      yield* sql`CREATE TABLE audit_log (timestamp TEXT, operation TEXT, account_profile TEXT, region TEXT, permission_state TEXT, context TEXT, duration_ms REAL)`
      for (let id = 1; id <= 25; id++) yield* sql`INSERT INTO effect_sql_migrations VALUES (${id})`
      return yield* run(database, sql)
    }).pipe(Effect.provideContext(services))
  })

const entry = {
  timestamp: "2026-10-11T00:00:00Z",
  operation: "getBlob",
  accountProfile: "fixture",
  region: "us-east-1",
  permissionState: "always_allowed",
  context: "hub:example-viewer Read blob",
  durationMs: null
} satisfies NewAuditLogEntry

describe("host cache attachment", () => {
  /** Attaching must never migrate an older or future owner's schema. */
  it.effect("accepts only the exact known migration set", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        yield* attachHostCache(database)
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 25`
        expect(Result.isFailure(yield* Effect.result(attachHostCache(database)))).toBe(true)
        yield* sql`INSERT INTO effect_sql_migrations VALUES (25), (26)`
        expect(Result.isFailure(yield* Effect.result(attachHostCache(database)))).toBe(true)
        expect((yield* sql`SELECT migration_id FROM effect_sql_migrations`).length).toBe(26)
      })
    ))

  /** A concurrently upgraded owner must prevent the next audit, hence the next provider call. */
  it.effect("checks schema again in each audit transaction", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        yield* cache.log(entry)
        yield* sql`INSERT INTO effect_sql_migrations VALUES (26)`
        expect(Result.isFailure(yield* Effect.result(cache.log(entry)))).toBe(true)
        expect((yield* sql`SELECT * FROM audit_log`).length).toBe(1)
      })
    ))

  it.effect("refuses an audit while another connection holds the writer lock", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO audit_log VALUES ('lock', 'lock', 'fixture', 'fixture', 'allowed', 'lock', NULL)`
          const outcome = yield* Effect.result(cache.log(entry))
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("CacheError")
        }))
        expect((yield* sql`SELECT * FROM audit_log`).length).toBe(1)
      })
    ))

  /** Native SQLite contention must use the configured timeout on transaction-pool connections too. */
  it.live("waits for a short external lock and bounds a long one", () =>
    fixture((database) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const holdLock = (milliseconds: number) =>
          spawner.spawn(ChildProcess.make("node", [
            "--input-type=module",
            "-e",
            `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));
    `,
            database,
            String(milliseconds)
          ], { extendEnv: true }))
        const short = yield* holdLock(200)
        yield* short.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect)
        yield* cache.log(entry)
        expect(yield* short.exitCode).toBe(0)
        const long = yield* holdLock(2000)
        yield* long.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect)
        const started = yield* Clock.currentTimeMillis
        expect(Result.isFailure(yield* Effect.result(cache.log(entry)))).toBe(true)
        const duration = (yield* Clock.currentTimeMillis) - started
        expect(duration).toBeGreaterThanOrEqual(350)
        expect(duration).toBeLessThan(1500)
      })
    ))
})
