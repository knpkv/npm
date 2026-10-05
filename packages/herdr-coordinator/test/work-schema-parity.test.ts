/**
 * Work's tables are created and migrated by two drivers that run against the
 * same file in production: `WorkStore.open` (node:sqlite) and the coordinator's
 * `makeSqliteWorkBridge(sql).initialize` (SqlClient). Each creates the tables it
 * needs, so their sets differ; these tests pin that every table both create is
 * defined identically, that each driver's own tables are exactly the listed
 * ones, and that opening a file in either order produces the same schema.
 */
import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { WorkStore } from "@knpkv/herdr-work"
import { makeSqliteWorkBridge } from "@knpkv/herdr-work/sql"
import { Effect, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isDeepStrictEqual } from "node:util"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const openWithStore = (path: string) =>
  Effect.acquireUseRelease(
    WorkStore.open(path),
    () => Effect.void,
    (store) => Effect.sync(() => store.close())
  ).pipe(provideNodeServices)

const openWithBridge = (path: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* makeSqliteWorkBridge(sql).initialize
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(SqliteClient.layer({ filename: path })),
    Effect.scoped
  )

const drivers = { bridge: openWithBridge, store: openWithStore }

const NamedRow = Schema.Struct({ name: Schema.String })
const ColumnRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Number,
  dflt_value: Schema.NullOr(Schema.String),
  pk: Schema.Number,
  hidden: Schema.Number
})
const IndexRow = Schema.Struct({ name: Schema.String, unique: Schema.Number, partial: Schema.Number })
const TriggerRow = Schema.Struct({ name: Schema.String, tbl_name: Schema.String, sql: Schema.String })
const VersionRow = Schema.Struct({ user_version: Schema.Number })

const rows = <A, I>(schema: Schema.Codec<A, I>, database: DatabaseSync, query: string): ReadonlyArray<A> =>
  Schema.decodeUnknownSync(Schema.Array(schema))(database.prepare(query).all())

/** Structural schema of a file: columns, indexes and triggers per table, sorted by name. */
const schemaSnapshot = (path: string) => {
  const database = new DatabaseSync(path)
  try {
    const tables = rows(
      NamedRow,
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map(({ name }) => name)
    return {
      tables: tables.map((table) => ({
        columns: rows(ColumnRow, database, `PRAGMA table_xinfo(${JSON.stringify(table)})`),
        indexes: rows(IndexRow, database, `PRAGMA index_list(${JSON.stringify(table)})`)
          .map((index) => ({
            ...index,
            columns: rows(NamedRow, database, `PRAGMA index_info(${JSON.stringify(index.name)})`)
              .map(({ name }) => name)
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        name: table
      })),
      triggers: rows(
        TriggerRow,
        database,
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
      ).map((trigger) => ({ ...trigger, sql: trigger.sql.replace(/\s+/g, " ").trim() })),
      userVersion: rows(VersionRow, database, "PRAGMA user_version")[0]?.user_version
    }
  } finally {
    database.close()
  }
}

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "herdr-work-schema-parity-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      return yield* use(root)
    })
  )

/** Tables, indexes and triggers only one driver creates; both are required in production. */
const storeOnly = [
  "index work_decision_handoffs_lane_time",
  "table work_goal_reassignments",
  "table work_goal_transaction_totals",
  "table work_goal_transactions",
  "trigger work_goal_transactions_after_insert"
]
const bridgeOnly = ["index work_dispatch_handoffs_lane", "table work_dispatch_handoffs"]

/**
 * Shared objects the two drivers still define differently. Both use
 * `IF NOT EXISTS`, so whichever opens a file first decides; in production
 * WorkStore opens first. Remove an entry when its definitions are unified.
 * - The bridge makes the handoff session index UNIQUE; WorkStore does not.
 */
const knownDivergences = ["index work_decision_handoffs_session"]

type Snapshot = ReturnType<typeof schemaSnapshot>

type SchemaObject = readonly [key: string, definition: unknown]

/** Every table, index and trigger keyed as "<kind> <name>", with its normalized definition. */
const objects = (snapshot: Snapshot): ReadonlyMap<string, unknown> =>
  new Map<string, unknown>([
    ...snapshot.tables.flatMap((table): ReadonlyArray<SchemaObject> => [
      [`table ${table.name}`, table.columns],
      ...table.indexes
        .filter((index) => !index.name.startsWith("sqlite_autoindex_"))
        .map((index): SchemaObject => [`index ${index.name}`, { ...index, table: table.name }])
    ]),
    ...snapshot.triggers.map((trigger): SchemaObject => [`trigger ${trigger.name}`, trigger])
  ])

const onlyIn = (left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>) =>
  [...left.keys()].filter((key) => !right.has(key)).sort()

describe("Work schema parity between WorkStore and the SQL bridge", () => {
  it.effect("defines every shared table identically and owns only the listed objects", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const storePath = join(root, "store.sqlite")
        const bridgePath = join(root, "bridge.sqlite")
        yield* drivers.store(storePath)
        yield* drivers.bridge(bridgePath)
        const store = objects(schemaSnapshot(storePath))
        const bridge = objects(schemaSnapshot(bridgePath))
        expect(onlyIn(store, bridge)).toEqual(storeOnly)
        expect(onlyIn(bridge, store)).toEqual(bridgeOnly)
        const divergent = [...store]
          .filter(([key, definition]) => bridge.has(key) && !isDeepStrictEqual(bridge.get(key), definition))
          .map(([key]) => key)
        expect(divergent).toEqual(knownDivergences)
      })
    ))

  it.effect("produces the same schema whichever driver opens the file first", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const storeFirst = join(root, "store-first.sqlite")
        yield* drivers.store(storeFirst)
        const storeAlone = objects(schemaSnapshot(storeFirst))
        yield* drivers.bridge(storeFirst)

        const bridgeFirst = join(root, "bridge-first.sqlite")
        yield* drivers.bridge(bridgeFirst)
        const bridgeAlone = objects(schemaSnapshot(bridgeFirst))
        yield* drivers.store(bridgeFirst)

        // The second driver only adds its own objects; it never redefines the first's.
        const storeThenBridge = objects(schemaSnapshot(storeFirst))
        const bridgeThenStore = objects(schemaSnapshot(bridgeFirst))
        for (const [key, definition] of storeAlone) expect(storeThenBridge.get(key), key).toEqual(definition)
        for (const [key, definition] of bridgeAlone) expect(bridgeThenStore.get(key), key).toEqual(definition)
        // Apart from the known divergences, open order does not change the result.
        expect([...storeThenBridge.keys()].sort()).toEqual([...bridgeThenStore.keys()].sort())
        const orderDependent = [...storeThenBridge]
          .filter(([key, definition]) => !isDeepStrictEqual(bridgeThenStore.get(key), definition))
          .map(([key]) => key)
        expect(orderDependent).toEqual(knownDivergences)
      })
    ))

  it.effect("is idempotent for each driver", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        for (const [name, open] of Object.entries(drivers)) {
          const path = join(root, `${name}.sqlite`)
          yield* open(path)
          const first = schemaSnapshot(path)
          const copy = join(root, `${name}-copy.sqlite`)
          copyFileSync(path, copy)
          yield* open(copy)
          expect(schemaSnapshot(copy), name).toEqual(first)
        }
      })
    ))
})
