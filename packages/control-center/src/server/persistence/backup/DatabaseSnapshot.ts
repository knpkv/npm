import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

import { EXPECTED_MIGRATIONS, MIGRATION_LEDGER_TABLE } from "../migrations/index.js"
import { BackupBlobEntryV1, BackupBoundaryV1, type BackupManifestV1, BackupMigrationEntry } from "./BackupManifest.js"
import { BackupIntegrityError, BackupManifestError, BackupSqlError } from "./errors.js"

const TableNameRow = Schema.Struct({ name: Schema.String })
const IntegrityCheckRow = Schema.Struct({ integrityCheck: Schema.String })
const CountRow = Schema.Struct({ count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) })
const MaximumRow = Schema.Struct({
  maximum: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
})

/** Exact inventory read from a consistent SQLite snapshot. */
export interface DatabaseSnapshotInventory {
  readonly blobs: ReadonlyArray<typeof BackupBlobEntryV1.Type>
  readonly boundary: typeof BackupBoundaryV1.Type
  readonly migrations: ReadonlyArray<typeof BackupMigrationEntry.Type>
}

const mapSql = <Value, Requirements>(
  operation: string,
  effect: Effect.Effect<Value, unknown, Requirements>
): Effect.Effect<Value, BackupSqlError, Requirements> =>
  effect.pipe(Effect.mapError((cause) => new BackupSqlError({ cause, operation })))

const decodeRows = <SchemaType extends Schema.Top>(
  schema: SchemaType,
  rows: unknown,
  operation: string
): Effect.Effect<ReadonlyArray<SchemaType["Type"]>, BackupSqlError, SchemaType["DecodingServices"]> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError((cause) => new BackupSqlError({ cause, operation }))
  )

const unexpectedRowCount = (operation: string, actualRowCount: number): BackupSqlError =>
  new BackupSqlError({
    cause: {
      _tag: "BackupInvariant",
      actualRowCount,
      expectedRowCount: 1,
      reason: "unexpected-row-count"
    },
    operation
  })

const tableExists = Effect.fn("BackupDatabase.tableExists")(function*(
  sql: SqlClient.SqlClient,
  tableName: string
) {
  const rows = yield* mapSql(
    "inspect-table",
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`
  ).pipe(Effect.flatMap((value) => decodeRows(TableNameRow, value, "inspect-table")))
  return rows.length === 1
})

const countTable = Effect.fn("BackupDatabase.countTable")(function*(
  sql: SqlClient.SqlClient,
  tableName: string
) {
  if (!(yield* tableExists(sql, tableName))) return 0
  const rows = yield* mapSql(
    "count-table",
    sql`SELECT COUNT(*) AS count FROM ${sql(tableName)}`
  ).pipe(Effect.flatMap((value) => decodeRows(CountRow, value, "count-table")))
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) return yield* unexpectedRowCount("count-table", rows.length)
  return row.count
})

const maximumColumn = Effect.fn("BackupDatabase.maximumColumn")(function*(
  sql: SqlClient.SqlClient,
  tableName: string,
  columnName: string
) {
  if (!(yield* tableExists(sql, tableName))) return 0
  const rows = yield* mapSql(
    "read-boundary",
    sql`SELECT MAX(${sql(columnName)}) AS maximum FROM ${sql(tableName)}`
  ).pipe(Effect.flatMap((value) => decodeRows(MaximumRow, value, "read-boundary")))
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) return yield* unexpectedRowCount("read-boundary", rows.length)
  return row.maximum ?? 0
})

/** Verify SQLite page and foreign-key integrity without changing the database. */
export const verifyDatabaseIntegrity = Effect.fn("BackupDatabase.verifyIntegrity")(function*(
  sql: SqlClient.SqlClient
) {
  const integrityRows = yield* mapSql("integrity-check", sql`PRAGMA integrity_check`).pipe(
    Effect.flatMap((rows) => decodeRows(IntegrityCheckRow, rows, "integrity-check"))
  )
  if (integrityRows.length !== 1 || integrityRows[0]?.integrityCheck.toLowerCase() !== "ok") {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: "database-corrupt",
      workspaceId: null
    })
  }
  const foreignKeyRows = yield* mapSql("foreign-key-check", sql`PRAGMA foreign_key_check`)
  if (foreignKeyRows.length !== 0) {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: "foreign-key-violation",
      workspaceId: null
    })
  }
})

/** Read and validate the exact supported migration prefix from a snapshot. */
export const readSupportedMigrationLedger = Effect.fn("BackupDatabase.readMigrationLedger")(function*(
  sql: SqlClient.SqlClient
) {
  if (!(yield* tableExists(sql, MIGRATION_LEDGER_TABLE))) {
    return yield* new BackupManifestError({ reason: "migration-ledger-mismatch" })
  }
  const rows = yield* mapSql(
    "read-migration-ledger",
    sql`SELECT migration_id AS migrationId, name
      FROM ${sql(MIGRATION_LEDGER_TABLE)}
      ORDER BY migration_id ASC`
  ).pipe(
    Effect.flatMap((value) => decodeRows(BackupMigrationEntry, value, "read-migration-ledger"))
  )
  const isSupported = rows.length > 0 && rows.length <= EXPECTED_MIGRATIONS.length &&
    rows.every((row, index) => {
      const expected = EXPECTED_MIGRATIONS[index]
      return expected !== undefined && row.migrationId === expected.id && row.name === expected.name
    })
  if (!isSupported) return yield* new BackupManifestError({ reason: "migration-ledger-mismatch" })
  return rows
})

const readBlobInventory = Effect.fn("BackupDatabase.readBlobInventory")(function*(
  sql: SqlClient.SqlClient
) {
  if (!(yield* tableExists(sql, "content_blobs"))) return []
  const rows = yield* mapSql(
    "read-blob-inventory",
    sql`SELECT workspace_id AS workspaceId, digest,
      storage_class AS classification, byte_length AS byteLength
      FROM content_blobs
      ORDER BY workspace_id ASC, digest ASC`
  ).pipe(Effect.flatMap((value) => decodeRows(BackupBlobEntryV1, value, "read-blob-inventory")))
  return rows
})

/** Read the authoritative migration, boundary, and blob inventory from one snapshot. */
export const readDatabaseSnapshotInventory = Effect.fn("BackupDatabase.readSnapshotInventory")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<DatabaseSnapshotInventory, BackupIntegrityError | BackupManifestError | BackupSqlError> {
  yield* verifyDatabaseIntegrity(sql)
  const migrations = yield* readSupportedMigrationLedger(sql)
  const blobs = yield* readBlobInventory(sql)
  const boundaryInput = {
    domainEventCursor: yield* maximumColumn(sql, "domain_events", "event_cursor"),
    domainEventRows: yield* countTable(sql, "domain_events"),
    entityRevisionRows: yield* countTable(sql, "entity_revisions"),
    highestEntityRevision: yield* maximumColumn(sql, "entity_revisions", "revision"),
    highestReleaseRevision: yield* maximumColumn(sql, "release_revisions", "revision"),
    releaseRevisionRows: yield* countTable(sql, "release_revisions")
  }
  const boundary = yield* Schema.decodeUnknownEffect(BackupBoundaryV1)(boundaryInput).pipe(
    Effect.mapError((cause) => new BackupSqlError({ cause, operation: "decode-boundary" }))
  )
  return { blobs, boundary, migrations }
})

/** Create a transactionally consistent standalone SQLite database file. */
export const vacuumDatabaseInto = Effect.fn("BackupDatabase.vacuumInto")(function*(
  sql: SqlClient.SqlClient,
  destination: string
) {
  yield* mapSql("vacuum-into", sql.unsafe("VACUUM INTO ?", [destination]))
})

/** Cross-check a decoded manifest against its authoritative snapshot inventory. */
export const verifyManifestInventory = Effect.fn("BackupDatabase.verifyManifestInventory")(function*(
  manifest: BackupManifestV1,
  inventory: DatabaseSnapshotInventory
) {
  const seen = new Set<string>()
  let previous = ""
  for (const blob of manifest.blobs) {
    const key = `${blob.workspaceId}:${blob.digest}`
    if (seen.has(key)) return yield* new BackupManifestError({ reason: "duplicate-blob" })
    if (previous.length > 0 && previous.localeCompare(key) >= 0) {
      return yield* new BackupManifestError({ reason: "unsorted-blob-inventory" })
    }
    seen.add(key)
    previous = key
  }
  const durable = manifest.blobs.filter(({ classification }) => classification === "durable").length
  const reproducibleCache = manifest.blobs.filter(
    ({ classification }) => classification === "reproducible-cache"
  ).length
  if (
    manifest.counts.total !== manifest.blobs.length ||
    manifest.counts.durable !== durable ||
    manifest.counts.reproducibleCache !== reproducibleCache
  ) return yield* new BackupManifestError({ reason: "blob-count-mismatch" })

  const hasSameBlobs = manifest.blobs.length === inventory.blobs.length &&
    manifest.blobs.every((blob, index) => {
      const expected = inventory.blobs[index]
      return expected !== undefined &&
        blob.workspaceId === expected.workspaceId &&
        blob.digest === expected.digest &&
        blob.classification === expected.classification &&
        blob.byteLength === expected.byteLength
    })
  if (!hasSameBlobs) {
    return yield* new BackupManifestError({ reason: "blob-inventory-mismatch" })
  }
  const boundary = manifest.boundary
  const expectedBoundary = inventory.boundary
  if (
    boundary.domainEventCursor !== expectedBoundary.domainEventCursor ||
    boundary.domainEventRows !== expectedBoundary.domainEventRows ||
    boundary.entityRevisionRows !== expectedBoundary.entityRevisionRows ||
    boundary.highestEntityRevision !== expectedBoundary.highestEntityRevision ||
    boundary.highestReleaseRevision !== expectedBoundary.highestReleaseRevision ||
    boundary.releaseRevisionRows !== expectedBoundary.releaseRevisionRows
  ) {
    return yield* new BackupManifestError({ reason: "boundary-mismatch" })
  }
  const hasSameMigrations = manifest.migrations.length === inventory.migrations.length &&
    manifest.migrations.every((migration, index) => {
      const expected = inventory.migrations[index]
      return expected !== undefined &&
        migration.migrationId === expected.migrationId && migration.name === expected.name
    })
  if (!hasSameMigrations) {
    return yield* new BackupManifestError({ reason: "migration-ledger-mismatch" })
  }
})
