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

export const LibsqlLive = LibsqlClient.layerConfig({
  url: dbUrl
}).pipe(Layer.provide(EnsureDbDir))

export const MigrationsLive = LibsqlMigrator.layer({
  loader: LibsqlMigrator.fromRecord({
    "0001_initial": migration0001,
    "0002_indexes": migration0002
  })
})

export const DatabaseLive = MigrationsLive.pipe(Layer.provideMerge(LibsqlLive))
