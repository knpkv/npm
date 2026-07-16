import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { Cause, Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import type { BackupFailure } from "./backup/errors.js"
import { MigrationWriteBarrierError } from "./backup/errors.js"
import { createVerifiedPreMigrationBackup } from "./backup/QuiescentBackup.js"
import {
  DatabaseInitializationError,
  type MigrationLedgerError,
  MigrationLedgerError as MigrationLedgerErrorClass,
  type PersistenceConfigError
} from "./errors.js"
import { EXPECTED_MIGRATIONS, MIGRATION_LEDGER_TABLE, migrationLoader } from "./migrations/index.js"
import { decodePersistenceConfig, type PersistenceConfig } from "./PersistenceConfig.js"
import { BusyTimeoutPragmaRow, ForeignKeysPragmaRow, JournalModePragmaRow, MigrationLedgerRow } from "./schemas.js"

/** Busy timeout used for bounded local write contention. */
export const BUSY_TIMEOUT_MILLISECONDS = 5_000

type LedgerPhase = "before-migration" | "after-migration"

// The pinned libSQL client applies this option to every local connection, while
// the current Effect beta has not yet surfaced it in LibsqlClientConfig.Full.
interface LocalLibsqlConfig extends LibsqlClient.LibsqlClientConfig.Full {
  readonly timeout: number
}

/** Database operations shared by all workspace-scoped persistence services. */
export interface DatabaseShape {
  readonly sql: SqlClient.SqlClient
  readonly transaction: SqlClient.SqlClient["withTransaction"]
  readonly validateMigrationLedger: Effect.Effect<
    void,
    DatabaseInitializationError | MigrationLedgerError
  >
}

/** Scoped Control Center database service backed by one shared libSQL client. */
export class Database extends Context.Service<Database, DatabaseShape>()(
  "@knpkv/control-center/server/persistence/Database"
) {}

// All application database layers coordinate schema inspection and migration.
// SQLite remains the cross-process lock; this permit removes the in-process
// check-then-migrate race between independently acquired server layers.
const migrationLock = Semaphore.makeUnsafe(1)

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

const expectedLedgerLabels = EXPECTED_MIGRATIONS.map(({ id, name }) => `${id}:${name}`)

const decodeRows = <SchemaType extends Schema.Top>(schema: SchemaType, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows)

const readMigrationLedger = Effect.fn("Database.readMigrationLedger")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<
  ReadonlyArray<MigrationLedgerRow>,
  SqlError.SqlError | MigrationLedgerError
> {
  const ledgerTables = yield* sql<{ readonly name: string }>`SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${MIGRATION_LEDGER_TABLE}`

  if (ledgerTables.length === 0) return []

  const rows = yield* sql`SELECT migration_id AS migrationId, name
    FROM ${sql(MIGRATION_LEDGER_TABLE)}
    ORDER BY migration_id ASC`

  return yield* decodeRows(MigrationLedgerRow, rows).pipe(
    Effect.mapError(
      () =>
        new MigrationLedgerErrorClass({
          actual: ["malformed-ledger-row"],
          expected: expectedLedgerLabels,
          phase: "before-migration"
        })
    )
  )
})

const validateLedger = Effect.fn("Database.validateMigrationLedger")(function*(
  sql: SqlClient.SqlClient,
  phase: LedgerPhase,
  minimumEntries: number
): Effect.fn.Return<void, DatabaseInitializationError | MigrationLedgerError> {
  const rows = yield* readMigrationLedger(sql).pipe(
    Effect.mapError((error) => {
      if (error._tag === "MigrationLedgerError") {
        return error.phase === phase
          ? error
          : new MigrationLedgerErrorClass({ ...error, phase })
      }
      return new DatabaseInitializationError({
        operation: "verify-ledger"
      })
    })
  )
  const actual = rows.map(({ migrationId, name }) => `${migrationId}:${name}`)
  const isValid = phase === "before-migration"
    ? actual.length >= minimumEntries &&
      actual.every((label, index) => label === expectedLedgerLabels[index])
    : actual.length === expectedLedgerLabels.length &&
      actual.every((label, index) => label === expectedLedgerLabels[index])

  if (!isValid) {
    return yield* new MigrationLedgerErrorClass({
      actual,
      expected: expectedLedgerLabels,
      phase
    })
  }
})

const configureAndVerifyPragmas = Effect.fn("Database.configureAndVerifyPragmas")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, DatabaseInitializationError> {
  const configure = Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA busy_timeout = 5000`
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new DatabaseInitializationError({
          operation: "configure"
        })
      )
    )
  )

  yield* configure

  const verify = Effect.gen(function*() {
    const foreignKeys = yield* sql`PRAGMA foreign_keys`.pipe(
      Effect.flatMap((rows) => decodeRows(ForeignKeysPragmaRow, rows))
    )
    const journalMode = yield* sql`PRAGMA journal_mode`.pipe(
      Effect.flatMap((rows) => decodeRows(JournalModePragmaRow, rows))
    )
    const busyTimeout = yield* sql`PRAGMA busy_timeout`.pipe(
      Effect.flatMap((rows) => decodeRows(BusyTimeoutPragmaRow, rows))
    )

    if (
      foreignKeys.length !== 1 ||
      foreignKeys[0]?.foreignKeys !== 1 ||
      journalMode.length !== 1 ||
      journalMode[0]?.journalMode.toLowerCase() !== "wal" ||
      busyTimeout.length !== 1 ||
      busyTimeout[0]?.timeout !== BUSY_TIMEOUT_MILLISECONDS
    ) {
      return yield* Effect.fail("SQLite connection pragmas did not retain their required values")
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new DatabaseInitializationError({
          operation: "verify-pragmas"
        })
      )
    )
  )

  yield* verify
})

const checkpointBeforeMigration = Effect.fn("Database.checkpointBeforeMigration")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, MigrationWriteBarrierError> {
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
    Effect.catchCause(() => new MigrationWriteBarrierError({ phase: "acquire" }))
  )
})

const verifyCheckpointStayedQuiescent = Effect.fn("Database.verifyCheckpointStayedQuiescent")(function*(
  databaseFile: string
): Effect.fn.Return<void, MigrationWriteBarrierError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const walFile = `${databaseFile}-wal`
  const exists = yield* fileSystem.exists(walFile).pipe(
    Effect.mapError(() => new MigrationWriteBarrierError({ phase: "verify" }))
  )
  if (!exists) return
  const info = yield* fileSystem.stat(walFile).pipe(
    Effect.mapError(() => new MigrationWriteBarrierError({ phase: "verify" }))
  )
  if (info.type !== "File" || info.size !== 0n) {
    return yield* new MigrationWriteBarrierError({ phase: "verify" })
  }
})

/** Convert transaction commit, rollback, and interruption causes into a redacted typed failure. */
export const sandboxMigrationTransaction = <Value, Failure, Requirements>(
  transaction: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, Failure | MigrationWriteBarrierError, Requirements> =>
  transaction.pipe(
    Effect.catchCause((cause): Effect.Effect<never, Failure | MigrationWriteBarrierError> => {
      const typedFailure = Cause.findErrorOption(cause)
      if (Cause.hasDies(cause) || Cause.hasInterrupts(cause) || Option.isNone(typedFailure)) {
        return Effect.fail<Failure | MigrationWriteBarrierError>(
          new MigrationWriteBarrierError({ phase: "verify" })
        )
      }
      return Effect.fail<Failure | MigrationWriteBarrierError>(typedFailure.value)
    })
  )

/** Hold SQLite's reserved writer transaction across one migration-critical operation. */
export const withMigrationWriteBarrier = <Value, Failure, Requirements>(
  sql: SqlClient.SqlClient,
  databaseSourceFile: string,
  operation: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<
  Value,
  Failure | MigrationWriteBarrierError,
  FileSystem.FileSystem | Requirements
> =>
  checkpointBeforeMigration(sql).pipe(
    Effect.andThen(
      sandboxMigrationTransaction(sql.withTransaction(
        verifyCheckpointStayedQuiescent(databaseSourceFile).pipe(Effect.andThen(operation))
      )).pipe(
        Effect.catchTag("SqlError", () => new MigrationWriteBarrierError({ phase: "acquire" }))
      )
    )
  )

const createPreMigrationBackup = Effect.fn("Database.createPreMigrationBackup")(function*(
  config: PersistenceConfig,
  migrationCount: number,
  databaseSourceFile: string
) {
  const cryptoService = yield* Crypto.Crypto
  const path = yield* Path.Path
  const backupId = yield* cryptoService.randomUUIDv7.pipe(
    Effect.mapError(() => new DatabaseInitializationError({ operation: "verify-ledger" }))
  )
  const fromVersion = EXPECTED_MIGRATIONS[migrationCount - 1]?.id ?? 0
  const toVersion = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1]?.id ?? 0
  const destination = path.join(
    path.dirname(config.blobRoot),
    "backups",
    "pre-migration",
    `v${fromVersion}-to-v${toVersion}`,
    backupId
  )
  yield* Effect.scoped(
    createVerifiedPreMigrationBackup({
      destination,
      databaseSourceFile,
      persistenceConfig: config
    })
  )
})

const runMigrations = Effect.fn("Database.runMigrations")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, DatabaseInitializationError> {
  yield* LibsqlMigrator.run({
    loader: migrationLoader,
    table: MIGRATION_LEDGER_TABLE
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause(() =>
      Effect.fail(
        new DatabaseInitializationError({
          operation: "migrate"
        })
      )
    )
  )
})

const initializeDatabase = Effect.fn("Database.initializeDatabase")(function*(
  config: PersistenceConfig
) {
  yield* migrationLock.withPermit(
    Effect.scoped(
      Effect.gen(function*() {
        const context = yield* Layer.build(
          makeClientLayer(config.busyTimeoutMilliseconds, config.databaseUrl, 1)
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        const path = yield* Path.Path
        const databaseSourceFile = yield* path.fromFileUrl(new URL(config.databaseUrl)).pipe(
          Effect.mapError(() => new DatabaseInitializationError({ operation: "connect" }))
        )

        yield* configureAndVerifyPragmas(sql)
        yield* withMigrationWriteBarrier(
          sql,
          databaseSourceFile,
          Effect.gen(function*() {
            yield* validateLedger(sql, "before-migration", 0)
            const beforeMigration = yield* readMigrationLedger(sql).pipe(
              Effect.mapError((error) =>
                error._tag === "MigrationLedgerError"
                  ? error
                  : new DatabaseInitializationError({ operation: "verify-ledger" })
              )
            )
            if (beforeMigration.length > 0 && beforeMigration.length < EXPECTED_MIGRATIONS.length) {
              yield* createPreMigrationBackup(config, beforeMigration.length, databaseSourceFile)
            }
            yield* runMigrations(sql)
            yield* validateLedger(sql, "after-migration", expectedLedgerLabels.length)
          })
        )
      })
    )
  )
})

const databaseFromSql = () =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* configureAndVerifyPragmas(sql)
      yield* validateLedger(sql, "after-migration", expectedLedgerLabels.length)
      return Database.of({
        sql,
        transaction: sql.withTransaction,
        validateMigrationLedger: validateLedger(sql, "after-migration", expectedLedgerLabels.length)
      })
    })
  )

const makeClientLayer = (
  busyTimeoutMilliseconds: number,
  databaseUrl: string,
  maxConnections: number
) => {
  const clientConfig: LocalLibsqlConfig = {
    concurrency: maxConnections,
    timeout: busyTimeoutMilliseconds,
    transformResultNames: snakeToCamel,
    url: databaseUrl
  }
  return LibsqlClient.layer(clientConfig).pipe(
    Layer.catchCause(() =>
      Layer.effectContext(
        Effect.fail(
          new DatabaseInitializationError({
            operation: "connect"
          })
        )
      )
    )
  )
}

/** Verify that an existing local database has a non-empty supported Control Center migration ledger. */
export const validateExistingControlCenterDatabase = Effect.fn(
  "Database.validateExistingControlCenterDatabase"
)(function*(
  input: unknown
): Effect.fn.Return<
  void,
  PersistenceConfigError | DatabaseInitializationError | MigrationLedgerError
> {
  const config = yield* decodePersistenceConfig(input)
  yield* Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(
        makeClientLayer(
          config.busyTimeoutMilliseconds,
          config.databaseUrl,
          config.maxConnections
        )
      )
      const sql = Context.get(context, SqlClient.SqlClient)
      yield* validateLedger(sql, "before-migration", 1)
    })
  )
})

/** Build a scoped database layer after decoding secret-free local configuration. */
export const databaseLayer = (
  input: unknown
): Layer.Layer<
  Database,
  | BackupFailure
  | DatabaseInitializationError
  | MigrationLedgerError
  | MigrationWriteBarrierError
  | PersistenceConfigError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Layer.unwrap(
    decodePersistenceConfig(input).pipe(
      Effect.flatMap((config) => initializeDatabase(config).pipe(Effect.as(config))),
      Effect.map((config) => {
        const clientLayer = makeClientLayer(
          config.busyTimeoutMilliseconds,
          config.databaseUrl,
          config.maxConnections
        )
        return databaseFromSql().pipe(Layer.provide(clientLayer))
      })
    )
  )
