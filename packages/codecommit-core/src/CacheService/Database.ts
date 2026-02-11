/**
 * Database layer for local SQLite cache via libsql/Turso.
 *
 * @module
 */
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { Config, Layer } from "effect"
import migration0001 from "./migrations/0001_initial.js"

const dbUrl = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
  Config.map((h) => `file:${h}/.codecommit/cache.db`)
)

export const LibsqlLive = LibsqlClient.layerConfig({
  url: dbUrl
})

export const MigrationsLive = LibsqlMigrator.layer({
  loader: LibsqlMigrator.fromRecord({
    "0001_initial": migration0001
  })
})

export const DatabaseLive = MigrationsLive.pipe(Layer.provideMerge(LibsqlLive))
