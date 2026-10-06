/**
 * Work's tables are created and migrated by two drivers that run against the
 * same file in production: `WorkStore.open` (node:sqlite) and the coordinator's
 * `makeSqliteWorkBridge(sql).initialize` (SqlClient). Each creates the tables it
 * needs, so their sets differ; these tests pin that every object both create is
 * defined identically, that each driver's own objects are exactly the listed
 * ones, that both migrate legacy files to the same schema and rows, and that
 * opening a file in either order, or both at once, produces the same schema.
 */
import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { WorkStore } from "@knpkv/herdr-work"
import { makeSqliteWorkBridge } from "@knpkv/herdr-work/sql"
import { Effect, Option, Predicate, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isDeepStrictEqual } from "node:util"
import { addOversizedLegacyHandoffs, advanceLegacyClaim, writePreV2WorkFile } from "./fixtures/legacy-work.js"

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

/** Runs `effect` while a WorkStore connection holds `path` open, as herdr-approvals does in production. */
const whileStoreHolds = <A, E, R>(path: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.acquireRelease(
        WorkStore.open(path).pipe(provideNodeServices),
        (store) => Effect.sync(() => store.close())
      )
      return yield* effect
    })
  )

const ColumnRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Number,
  dflt_value: Schema.NullOr(Schema.String),
  pk: Schema.Number,
  hidden: Schema.Number
})
const TableListRow = Schema.Struct({
  name: Schema.String,
  schema: Schema.String,
  wr: Schema.Number,
  strict: Schema.Number
})
const IndexRow = Schema.Struct({ name: Schema.String, unique: Schema.Number, partial: Schema.Number })
const IndexKeyRow = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  desc: Schema.Number,
  coll: Schema.NullOr(Schema.String),
  key: Schema.Number
})
const ForeignKeyRow = Schema.Struct({
  table: Schema.String,
  from: Schema.String,
  to: Schema.NullOr(Schema.String),
  on_update: Schema.String,
  on_delete: Schema.String,
  match: Schema.String
})
const SqlRow = Schema.Struct({ name: Schema.String, sql: Schema.NullOr(Schema.String) })
const TriggerRow = Schema.Struct({ name: Schema.String, tbl_name: Schema.String, sql: Schema.String })
const VersionRow = Schema.Struct({ user_version: Schema.Number })
/** A stored cell; Work's tables hold no blobs or 64-bit integers. */
const Cell = Schema.Union([Schema.String, Schema.Number, Schema.Null])
const TableRow = Schema.Record(Schema.String, Cell)

const rows = <A, I>(schema: Schema.Codec<A, I>, database: DatabaseSync, query: string): ReadonlyArray<A> =>
  Schema.decodeUnknownSync(Schema.Array(schema))(database.prepare(query).all())

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()

const quoted = (name: string) => JSON.stringify(name)

/** Every `CHECK (…)` expression in a CREATE statement, whitespace-normalized and sorted. */
const checkConstraints = (sql: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const pattern = /\bCHECK\s*\(/gi
  for (let match = pattern.exec(sql); match !== null; match = pattern.exec(sql)) {
    let depth = 1
    let end = pattern.lastIndex
    while (end < sql.length && depth > 0) {
      if (sql[end] === "(") depth++
      if (sql[end] === ")") depth--
      end++
    }
    found.push(normalize(sql.slice(pattern.lastIndex, end - 1)))
  }
  return found.sort()
}

/** The user tables of a file, sorted by name. */
const userTables = (database: DatabaseSync) =>
  rows(TableListRow, database, "PRAGMA table_list")
    .filter(({ name, schema }) => schema === "main" && !name.startsWith("sqlite_"))
    .sort((left, right) => left.name.localeCompare(right.name))

/** Structural schema of a file: columns, constraints, indexes and triggers per table, sorted by name. */
const schemaSnapshot = (path: string) => {
  const database = new DatabaseSync(path)
  try {
    const sqlByName = new Map(
      rows(SqlRow, database, "SELECT name, sql FROM sqlite_master").map(({ name, sql }) => [name, sql])
    )
    return {
      tables: userTables(database).map((table) => ({
        checks: checkConstraints(sqlByName.get(table.name) ?? ""),
        // The CREATE text carries clauses no PRAGMA reports (ON CONFLICT, AUTOINCREMENT, collations, FK deferral).
        create: normalize(sqlByName.get(table.name) ?? ""),
        columns: rows(ColumnRow, database, `PRAGMA table_xinfo(${quoted(table.name)})`),
        foreignKeys: rows(ForeignKeyRow, database, `PRAGMA foreign_key_list(${quoted(table.name)})`),
        indexes: rows(IndexRow, database, `PRAGMA index_list(${quoted(table.name)})`)
          .map((index) => ({
            ...index,
            keys: rows(IndexKeyRow, database, `PRAGMA index_xinfo(${quoted(index.name)})`)
              .filter(({ key }) => key === 1),
            // Autoindexes have no SQL; explicit ones carry any partial-index WHERE clause here.
            sql: Option.fromNullishOr(sqlByName.get(index.name)).pipe(Option.map(normalize), Option.getOrNull)
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        name: table.name,
        strict: table.strict,
        withoutRowid: table.wr
      })),
      triggers: rows(
        TriggerRow,
        database,
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
      ).map((trigger) => ({ ...trigger, sql: normalize(trigger.sql) })),
      userVersion: rows(VersionRow, database, "PRAGMA user_version")[0]?.user_version
    }
  } finally {
    database.close()
  }
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** A stored cell with JSON text parsed, so key order inside a record does not matter. */
const comparable = (cell: typeof Cell.Type): Schema.Json =>
  Predicate.isString(cell) && /^[[{]/.test(cell)
    ? Option.getOrElse(parseJson(cell), () => cell)
    : cell

/** Every row of every table, JSON columns parsed, sorted by primary key. */
const tableRows = (path: string): ReadonlyMap<string, ReadonlyArray<Schema.Json>> => {
  const database = new DatabaseSync(path)
  try {
    return new Map(
      userTables(database).map(({ name }): readonly [string, ReadonlyArray<Schema.Json>] => {
        const keys = rows(ColumnRow, database, `PRAGMA table_xinfo(${quoted(name)})`)
          .filter(({ pk }) => pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => quoted(column.name))
        const order = keys.length > 0 ? keys.join(", ") : "rowid"
        return [
          name,
          rows(TableRow, database, `SELECT * FROM ${quoted(name)} ORDER BY ${order}`).map((row) =>
            Object.fromEntries(Object.entries(row).map(([column, value]) => [column, comparable(value)]))
          )
        ]
      })
    )
  } finally {
    database.close()
  }
}

const LaneClaimRow = Schema.Struct({
  record: Schema.fromJsonString(Schema.Struct({
    operationId: Schema.String,
    revision: Schema.Number
  }))
})

/** The migrated claim of `goal:legacy`. */
const laneClaim = (path: string) => {
  const database = new DatabaseSync(path)
  try {
    return rows(LaneClaimRow, database, "SELECT record FROM work_lane_claims WHERE lane_id = 'goal:legacy'")[0]?.record
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

/** Runs a fixture writer against `path` on a short-lived connection. */
const writeFixture = (path: string, write: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(path)
  try {
    write(database)
  } finally {
    database.close()
  }
}

const ledgerMaxRecords = 16_384
const ledgerMaxBytes = 2 * 1024 * 1024

const withDatabase = <A>(path: string, read: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(path)
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** Both drivers reject a copy of `fixture` with their own operation, leaving every copy unchanged. */
const expectRejectedUnchanged = (
  root: string,
  fixture: string,
  operations: { readonly bridge: string; readonly store: string }
) =>
  Effect.gen(function*() {
    const before = { rows: tableRows(fixture), schema: schemaSnapshot(fixture) }
    const storePath = join(root, "rejected-store.sqlite")
    const bridgePath = join(root, "rejected-bridge.sqlite")
    copyFileSync(fixture, storePath)
    copyFileSync(fixture, bridgePath)
    expect(yield* Effect.result(drivers.store(storePath))).toMatchObject({
      failure: {
        _tag: "WorkStoreError",
        cause: { _tag: "WorkStoreError", operation: operations.store },
        operation: "open.database"
      }
    })
    expect(yield* Effect.result(drivers.bridge(bridgePath))).toMatchObject({
      failure: { _tag: "WorkStoreError", operation: operations.bridge }
    })
    for (const path of [storePath, bridgePath]) {
      expect(schemaSnapshot(path), path).toEqual(before.schema)
      expect(tableRows(path), path).toEqual(before.rows)
    }
  })

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

const isAutoindex = (index: { readonly name: string }) => index.name.startsWith("sqlite_autoindex_")

/**
 * Every table, index and trigger keyed as "<kind> <name>", with its normalized
 * definition. Inline PRIMARY KEY and UNIQUE constraints exist only as
 * `sqlite_autoindex_*` indexes, so they stay part of their table's definition,
 * without the generated names and sorted by their keys.
 */
const objects = (snapshot: Snapshot): ReadonlyMap<string, unknown> =>
  new Map<string, unknown>([
    ...snapshot.tables.flatMap(({ indexes, name, ...table }): ReadonlyArray<SchemaObject> => [
      [`table ${name}`, {
        ...table,
        constraints: indexes
          .filter(isAutoindex)
          .map(({ keys, partial, unique }) => ({ keys, partial, unique }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      }],
      ...indexes
        .filter((index) => !isAutoindex(index))
        .map((index): SchemaObject => [`index ${index.name}`, { ...index, table: name }])
    ]),
    ...snapshot.triggers.map((trigger): SchemaObject => [`trigger ${trigger.name}`, trigger]),
    ["pragma user_version", snapshot.userVersion]
  ])

const onlyIn = (left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>) =>
  [...left.keys()].filter((key) => !right.has(key)).sort()

/** Keys of objects both maps hold but define differently. */
const differing = (left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>) =>
  [...left]
    .filter(([key, definition]) => right.has(key) && !isDeepStrictEqual(right.get(key), definition))
    .map(([key]) => key)
    .sort()

/** What a comparison expects: each driver's own objects, and shared objects defined differently. */
interface Ownership {
  readonly bridgeOnly: ReadonlyArray<string>
  readonly divergences: ReadonlyArray<string>
  readonly storeOnly: ReadonlyArray<string>
}

const freshOwnership: Ownership = { bridgeOnly, divergences: knownDivergences, storeOnly }

/**
 * A legacy file already holds `work_dispatch_handoffs`, so after migration
 * only its index is the bridge's own.
 */
const legacyOwnership: Ownership = {
  bridgeOnly: ["index work_dispatch_handoffs_lane"],
  divergences: knownDivergences,
  storeOnly
}

/** Asserts a store-opened and a bridge-opened file hold the same shared schema and rows. */
const expectSameResult = (
  storePath: string,
  bridgePath: string,
  ownership: Ownership = freshOwnership
) => {
  const store = objects(schemaSnapshot(storePath))
  const bridge = objects(schemaSnapshot(bridgePath))
  expect(onlyIn(store, bridge)).toEqual(ownership.storeOnly)
  expect(onlyIn(bridge, store)).toEqual(ownership.bridgeOnly)
  expect(differing(store, bridge)).toEqual(ownership.divergences)
  const storeRows = tableRows(storePath)
  const bridgeRows = tableRows(bridgePath)
  const rowMismatches = [...storeRows]
    .filter(([table, contents]) => bridgeRows.has(table) && !isDeepStrictEqual(bridgeRows.get(table), contents))
    .map(([table]) => table)
  expect(rowMismatches).toEqual([])
}

/** Copies `legacy` once per driver, opens each copy with its driver, and compares the results. */
const migrateWithBoth = (
  root: string,
  legacy: string,
  ownership: Ownership
) =>
  Effect.gen(function*() {
    const storePath = join(root, "store.sqlite")
    const bridgePath = join(root, "bridge.sqlite")
    copyFileSync(legacy, storePath)
    copyFileSync(legacy, bridgePath)
    yield* drivers.store(storePath)
    yield* drivers.bridge(bridgePath)
    expectSameResult(storePath, bridgePath, ownership)
    // A migrated file must also reopen: the first open alone skips current-schema checks.
    yield* drivers.store(storePath)
    yield* drivers.bridge(bridgePath)
  })

describe("Work schema parity between WorkStore and the SQL bridge", () => {
  it.effect("defines every shared object identically and owns only the listed objects", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const storePath = join(root, "store.sqlite")
        const bridgePath = join(root, "bridge.sqlite")
        yield* drivers.store(storePath)
        yield* drivers.bridge(bridgePath)
        expectSameResult(storePath, bridgePath)
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
        expect(differing(storeThenBridge, bridgeThenStore)).toEqual(knownDivergences)
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

  it.effect("initializes the bridge while WorkStore holds a fresh file open", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const sequential = join(root, "sequential.sqlite")
        yield* drivers.store(sequential)
        yield* drivers.bridge(sequential)
        // Production order: WorkStore stays open while the coordinator initializes the bridge.
        const held = join(root, "held.sqlite")
        yield* whileStoreHolds(held, drivers.bridge(held))
        expect(objects(schemaSnapshot(held))).toEqual(objects(schemaSnapshot(sequential)))
        expect(tableRows(held)).toEqual(tableRows(sequential))
      })
    ))

  it.effect("reopens a migrated pre-session file that has a running binding, in any driver order", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, writePreV2WorkFile)
        const orders = {
          "bridge then bridge": [drivers.bridge, drivers.bridge],
          "bridge then store": [drivers.bridge, drivers.store],
          "store then bridge": [drivers.store, drivers.bridge],
          "store then store": [drivers.store, drivers.store]
        }
        for (const [name, [first, second]] of Object.entries(orders)) {
          const path = join(root, `${name.replaceAll(" ", "-")}.sqlite`)
          copyFileSync(legacy, path)
          yield* first(path)
          yield* second(path)
          // The claim takes the operation the running binding recorded for it.
          expect(laneClaim(path), name).toMatchObject({ operationId: "dispatch:legacy-sol", revision: 1 })
        }
        // Production order: WorkStore migrates and stays open while the bridge initializes.
        const held = join(root, "held.sqlite")
        copyFileSync(legacy, held)
        yield* whileStoreHolds(held, drivers.bridge(held))
        yield* whileStoreHolds(held, drivers.bridge(held))
      })
    ))

  it.effect("keeps the lane id as operation id when the claim moved past its binding", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, (database) => {
          writePreV2WorkFile(database)
          advanceLegacyClaim(database)
        })
        for (const [name, open] of Object.entries(drivers)) {
          const path = join(root, `${name}.sqlite`)
          copyFileSync(legacy, path)
          yield* open(path)
          yield* open(path)
          expect(laneClaim(path), name).toMatchObject({ operationId: "goal:legacy", revision: 2 })
        }
      })
    ))

  it.effect("rejects a pre-session file whose claim two running bindings hold, leaving it unchanged", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, (database) => {
          writePreV2WorkFile(database)
          // One more running dispatch bound to the same lane at the same revision.
          addOversizedLegacyHandoffs(database, 1)
        })
        const before = { rows: tableRows(legacy), schema: schemaSnapshot(legacy) }
        const storePath = join(root, "store.sqlite")
        const bridgePath = join(root, "bridge.sqlite")
        copyFileSync(legacy, storePath)
        copyFileSync(legacy, bridgePath)
        expect(yield* Effect.result(drivers.store(storePath))).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: "open.migrate.lane-binding-ambiguous" },
            operation: "open.database"
          }
        })
        expect(yield* Effect.result(drivers.bridge(bridgePath))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "sql-work.initialize.lane-binding-ambiguous" }
        })
        for (const path of [storePath, bridgePath]) {
          expect(schemaSnapshot(path), path).toEqual(before.schema)
          expect(tableRows(path), path).toEqual(before.rows)
        }
      })
    ))

  it.effect("migrates a moved-past claim whose operation row already exists exactly, and rejects a different one", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, (database) => {
          writePreV2WorkFile(database)
          advanceLegacyClaim(database)
        })
        // The exact row a migration writes for the claim's own operation.
        const probe = join(root, "probe.sqlite")
        copyFileSync(legacy, probe)
        yield* drivers.store(probe)
        const migrated = withDatabase(probe, (database) =>
          database.prepare("SELECT * FROM work_lane_operations WHERE operation_id = 'goal:legacy'").get())
        const replica = join(root, "replica.sqlite")
        copyFileSync(legacy, replica)
        writeFixture(replica, (database) => {
          database.prepare(
            "INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(
            ...Schema.decodeUnknownSync(Schema.Tuple([
              Schema.String,
              Schema.String,
              Schema.String,
              Schema.String,
              Schema.Number,
              Schema.String
            ]))(Object.values(migrated ?? {}))
          )
        })
        for (const [name, open] of Object.entries(drivers)) {
          const path = join(root, `replica-${name}.sqlite`)
          copyFileSync(replica, path)
          yield* open(path)
          yield* open(path)
          expect(laneClaim(path), name).toMatchObject({ operationId: "goal:legacy", revision: 2 })
        }
        const collision = join(root, "collision.sqlite")
        copyFileSync(replica, collision)
        writeFixture(collision, (database) => {
          database.exec(`
            UPDATE work_lane_operations SET goal_id = 'goal:other', record = json_set(record, '$.goalId', 'goal:other')
            WHERE operation_id = 'goal:legacy'
          `)
        })
        yield* expectRejectedUnchanged(root, collision, {
          bridge: "sql-work.initialize.lane-operation-collision",
          store: "open.migrate.lane-operation-collision"
        })
      })
    ))

  it.effect("rejects a migration whose new operation rows would overflow the ledger, by count or by bytes", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const fill = (path: string, rows: (count: number, bytes: number) => ReadonlyArray<string>) =>
          writeFixture(path, (database) => {
            writePreV2WorkFile(database)
            advanceLegacyClaim(database)
            const { bytes, count } = Schema.decodeUnknownSync(
              Schema.Struct({ bytes: Schema.Number, count: Schema.Number })
            )(
              database.prepare(
                `SELECT COUNT(*) AS count, COALESCE(SUM(
                   length(CAST(operation_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
                 FROM work_lane_operations`
              ).get()
            )
            const insert = database.prepare(
              "INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, 'goal:filler', 'review', 1, ?)"
            )
            database.exec("BEGIN")
            rows(count, bytes).forEach((record, index) => insert.run(`filler-${index}`, `lane:filler-${index}`, record))
            database.exec("COMMIT")
          })
        const atCount = join(root, "at-count.sqlite")
        fill(atCount, (count) => Array.from({ length: ledgerMaxRecords - count }, () => "{}"))
        yield* expectRejectedUnchanged(root, atCount, {
          bridge: "sql-work.initialize.lane-operation-capacity",
          store: "open.migrate.lane-operation-capacity"
        })
        const belowCount = join(root, "below-count.sqlite")
        fill(belowCount, (count) => Array.from({ length: ledgerMaxRecords - count - 1 }, () => "{}"))
        for (const [name, open] of Object.entries(drivers)) {
          const path = join(root, `below-count-${name}.sqlite`)
          copyFileSync(belowCount, path)
          yield* open(path)
          yield* open(path)
        }
        const atBytes = join(root, "at-bytes.sqlite")
        // One row that leaves the ledger a few bytes short of its byte bound: the migrated row cannot fit.
        fill(atBytes, (_, bytes) => ["x".repeat(ledgerMaxBytes - bytes - "filler-0".length - 8)])
        yield* expectRejectedUnchanged(root, atBytes, {
          bridge: "sql-work.initialize.lane-operation-capacity",
          store: "open.migrate.lane-operation-capacity"
        })
      })
    ))

  it.effect("rejects a pre-session claim that disagrees with its running binding's lane, leaving it unchanged", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, (database) => {
          writePreV2WorkFile(database)
          // The binding recorded the lane in implementation; the claim says validation.
          database.exec(`
            UPDATE work_lane_claims SET record = json_set(record, '$.phase', 'validation')
            WHERE lane_id = 'goal:legacy'
          `)
        })
        const before = { rows: tableRows(legacy), schema: schemaSnapshot(legacy) }
        const storePath = join(root, "store.sqlite")
        const bridgePath = join(root, "bridge.sqlite")
        copyFileSync(legacy, storePath)
        copyFileSync(legacy, bridgePath)
        expect(yield* Effect.result(drivers.store(storePath))).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: "open.migrate.lane-binding-mismatch" },
            operation: "open.database"
          }
        })
        expect(yield* Effect.result(drivers.bridge(bridgePath))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "sql-work.initialize.lane-binding-mismatch" }
        })
        for (const path of [storePath, bridgePath]) {
          expect(schemaSnapshot(path), path).toEqual(before.schema)
          expect(tableRows(path), path).toEqual(before.rows)
        }
      })
    ))

  it.effect("migrates a pre-session legacy file to the same schema and rows", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "legacy.sqlite")
        writeFixture(legacy, writePreV2WorkFile)
        yield* migrateWithBoth(root, legacy, legacyOwnership)
      })
    ))

  it.effect("migrates v1 handoffs stored in the current schema to the same schema and rows", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        // A current-schema file whose handoff records predate v2: migrate a
        // legacy file once, then rewrite its handoffs back to the v1 shape.
        const current = join(root, "current.sqlite")
        writeFixture(current, writePreV2WorkFile)
        yield* drivers.store(current)
        writeFixture(current, (database) => {
          database.exec(`
            UPDATE work_decision_handoffs SET record = json_set(
              json_remove(record, '$.expectedRevision'), '$.version', 'herdr.work.decision.v1'
            );
            UPDATE work_dispatch_handoffs SET record = json_set(
              json_remove(record, '$.expectedRevision'), '$.version', 'herdr.work.decision.v1'
            );
            UPDATE orchestrator_dispatch_metadata SET work_link = json_set(
              json_remove(work_link, '$.handoff.expectedRevision'), '$.handoff.version', 'herdr.work.decision.v1'
            ) WHERE work_link IS NOT NULL;
          `)
        })
        // WorkStore created this file's schema, so the bridge adds only its handoff
        // index, and both copies keep WorkStore's session index.
        yield* migrateWithBoth(root, current, {
          bridgeOnly: ["index work_dispatch_handoffs_lane"],
          divergences: [],
          storeOnly: []
        })
        for (const path of [join(root, "store.sqlite"), join(root, "bridge.sqlite")]) {
          expect(tableRows(path).get("work_decision_handoffs"), path).toMatchObject([
            { record: { expectedRevision: 0, version: "herdr.work.decision.v2" } }
          ])
        }
      })
    ))

  it.effect("rejects an over-capacity legacy file with each driver's own error and leaves it unchanged", () =>
    withRoot((root) =>
      Effect.gen(function*() {
        const legacy = join(root, "oversized.sqlite")
        writeFixture(legacy, (database) => {
          writePreV2WorkFile(database)
          addOversizedLegacyHandoffs(database, 260)
        })
        const before = { rows: tableRows(legacy), schema: schemaSnapshot(legacy) }
        const storePath = join(root, "store.sqlite")
        const bridgePath = join(root, "bridge.sqlite")
        copyFileSync(legacy, storePath)
        copyFileSync(legacy, bridgePath)

        expect(yield* Effect.result(drivers.store(storePath))).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-capacity" },
            operation: "open.database"
          }
        })
        expect(yield* Effect.result(drivers.bridge(bridgePath))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "sql-work.initialize.handoff-capacity" }
        })
        for (const path of [storePath, bridgePath]) {
          expect(schemaSnapshot(path), path).toEqual(before.schema)
          expect(tableRows(path), path).toEqual(before.rows)
        }
      })
    ))
})
