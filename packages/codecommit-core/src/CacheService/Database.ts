/**
 * Database layer for local SQLite cache via libsql/Turso.
 *
 * @module
 */
import { FileSystem } from "@effect/platform"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { Config, Effect, Layer } from "effect"
import migration0001 from "./migrations/0001_initial.js"
import migration0002 from "./migrations/0002_indexes.js"
import migration0003 from "./migrations/0003_add_health_score.js"
import migration0004 from "./migrations/0004_unify_notifications.js"
import migration0005 from "./migrations/0005_add_sandboxes.js"
import migration0006 from "./migrations/0006_sandbox_logs.js"

const homeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE"))
)

const dbUrl = homeDir.pipe(Config.map((h) => `file:${h}/.codecommit/cache.db`))

const EnsureDbDir = Layer.effectDiscard(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const h = yield* homeDir
    yield* fs.makeDirectory(`${h}/.codecommit`, { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void)
    )
  })
)

export const LibsqlLive = Layer.unwrapEffect(
  Effect.map(dbUrl, (url) =>
    LibsqlClient.layer({
      url,
      transformResultNames: (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    }))
).pipe(Layer.provide(EnsureDbDir))

export const MigrationsLive = LibsqlMigrator.layer({
  loader: LibsqlMigrator.fromRecord({
    "0001_initial": migration0001,
    "0002_indexes": migration0002,
    "0003_add_health_score": migration0003,
    "0004_unify_notifications": migration0004,
    "0005_add_sandboxes": migration0005,
    "0006_sandbox_logs": migration0006
  })
})

export const DatabaseLive = MigrationsLive.pipe(Layer.provideMerge(LibsqlLive))
