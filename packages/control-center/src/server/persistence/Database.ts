import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { Cause, Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { SchemaWriteBarrierError } from "./backup/errors.js"
import { DatabaseInitializationError, type PersistenceConfigError } from "./errors.js"
import { decodePersistenceConfig, type PersistenceConfig } from "./PersistenceConfig.js"
import { initializeCurrentSchema, validateCurrentSchema } from "./schema.js"
import { BusyTimeoutPragmaRow, ForeignKeysPragmaRow, JournalModePragmaRow } from "./schemas.js"

/** Busy timeout used for bounded local write contention. */
export const BUSY_TIMEOUT_MILLISECONDS = 5_000

// The pinned libSQL client applies this option to every local connection, while
// the current Effect beta has not yet surfaced it in LibsqlClientConfig.Full.
interface LocalLibsqlConfig extends LibsqlClient.LibsqlClientConfig.Full {
  readonly timeout: number
}

/** Database operations shared by all workspace-scoped persistence services. */
export interface DatabaseShape {
  readonly sql: SqlClient.SqlClient
  readonly transaction: SqlClient.SqlClient["withTransaction"]
  readonly validateSchema: Effect.Effect<void, DatabaseInitializationError>
}

/** Scoped Control Center database service backed by one shared libSQL client. */
export class Database extends Context.Service<Database, DatabaseShape>()(
  "@knpkv/control-center/server/persistence/Database"
) {}

// SQLite remains the cross-process authority; this permit only removes races
// between independently acquired database layers inside one process.
const schemaLock = Semaphore.makeUnsafe(1)

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

const decodeRows = <SchemaType extends Schema.Top>(schema: SchemaType, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows)

const configureAndVerifyPragmas = Effect.fn("Database.configureAndVerifyPragmas")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, DatabaseInitializationError> {
  yield* Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA busy_timeout = 5000`
  }).pipe(
    Effect.catchCause(() => new DatabaseInitializationError({ operation: "configure" }))
  )

  yield* Effect.gen(function*() {
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
    ) return yield* Effect.fail("SQLite pragmas did not retain their required values")
  }).pipe(
    Effect.catchCause(() => new DatabaseInitializationError({ operation: "verify-pragmas" }))
  )
})

const checkpointBeforeSchemaChange = Effect.fn("Database.checkpointBeforeSchemaChange")(function*(
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, SchemaWriteBarrierError> {
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
    Effect.catchCause(() => new SchemaWriteBarrierError({ phase: "acquire" }))
  )
})

const verifyCheckpointStayedQuiescent = Effect.fn("Database.verifyCheckpointStayedQuiescent")(function*(
  databaseFile: string
): Effect.fn.Return<void, SchemaWriteBarrierError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const walFile = `${databaseFile}-wal`
  const exists = yield* fileSystem.exists(walFile).pipe(
    Effect.mapError(() => new SchemaWriteBarrierError({ phase: "verify" }))
  )
  if (!exists) return
  const info = yield* fileSystem.stat(walFile).pipe(
    Effect.mapError(() => new SchemaWriteBarrierError({ phase: "verify" }))
  )
  if (info.type !== "File" || info.size !== 0n) {
    return yield* new SchemaWriteBarrierError({ phase: "verify" })
  }
})

/** Convert schema transaction defects and interruption into a redacted typed failure. */
export const sandboxSchemaTransaction = <Value, Failure, Requirements>(
  transaction: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, Failure | SchemaWriteBarrierError, Requirements> =>
  transaction.pipe(
    Effect.catchCause((cause): Effect.Effect<never, Failure | SchemaWriteBarrierError> => {
      const typedFailure = Cause.findErrorOption(cause)
      if (Cause.hasDies(cause) || Cause.hasInterrupts(cause) || Option.isNone(typedFailure)) {
        return Effect.fail<Failure | SchemaWriteBarrierError>(new SchemaWriteBarrierError({ phase: "verify" }))
      }
      return Effect.fail<Failure | SchemaWriteBarrierError>(typedFailure.value)
    })
  )

/** Hold SQLite's reserved writer transaction across one fresh-schema operation. */
export const withSchemaWriteBarrier = <Value, Failure, Requirements>(
  sql: SqlClient.SqlClient,
  databaseSourceFile: string,
  operation: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, Failure | SchemaWriteBarrierError, FileSystem.FileSystem | Requirements> =>
  checkpointBeforeSchemaChange(sql).pipe(
    Effect.andThen(
      sandboxSchemaTransaction(sql.withTransaction(
        verifyCheckpointStayedQuiescent(databaseSourceFile).pipe(Effect.andThen(operation))
      )).pipe(
        Effect.catchTag("SqlError", () => new SchemaWriteBarrierError({ phase: "acquire" }))
      )
    )
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
    Layer.catchCause(() => Layer.effectContext(Effect.fail(new DatabaseInitializationError({ operation: "connect" }))))
  )
}

const initializeDatabase = Effect.fn("Database.initializeDatabase")(function*(config: PersistenceConfig) {
  yield* schemaLock.withPermit(
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
        yield* withSchemaWriteBarrier(sql, databaseSourceFile, initializeCurrentSchema(sql))
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
      yield* validateCurrentSchema(sql)
      return Database.of({
        sql,
        transaction: sql.withTransaction,
        validateSchema: validateCurrentSchema(sql)
      })
    })
  )

/** Verify that an existing local database has the exact current prototype schema. */
export const validateExistingControlCenterDatabase = Effect.fn(
  "Database.validateExistingControlCenterDatabase"
)(function*(
  input: unknown
): Effect.fn.Return<void, PersistenceConfigError | DatabaseInitializationError> {
  const config = yield* decodePersistenceConfig(input)
  yield* Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(
        makeClientLayer(config.busyTimeoutMilliseconds, config.databaseUrl, config.maxConnections)
      )
      yield* validateCurrentSchema(Context.get(context, SqlClient.SqlClient))
    })
  )
})

/** Build a scoped database layer after decoding secret-free local configuration. */
export const databaseLayer = (
  input: unknown
): Layer.Layer<
  Database,
  DatabaseInitializationError | SchemaWriteBarrierError | PersistenceConfigError,
  FileSystem.FileSystem | Path.Path
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
