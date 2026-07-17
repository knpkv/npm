import { Effect, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

import { DatabaseInitializationError } from "./errors.js"
import currentSchemaJson from "./schema.json" with { type: "json" }

const CurrentSchemaObject = Schema.Struct({
  type: Schema.Literals(["index", "table", "trigger", "view"]),
  name: Schema.String.check(Schema.isNonEmpty()),
  sql: Schema.String.check(Schema.isNonEmpty())
})

const CurrentSchema = Schema.Struct({
  version: Schema.Literal("unstable"),
  objects: Schema.Array(CurrentSchemaObject)
})

const currentSchema = Schema.decodeUnknownSync(CurrentSchema)(currentSchemaJson)

/** Unstable schema identity stored in prototype backup manifests. */
export const CURRENT_SCHEMA_VERSION = currentSchema.version

const readSchemaObjects = Effect.fn("DatabaseSchema.readObjects")(function*(sql: SqlClient.SqlClient) {
  const rows = yield* sql`SELECT type, name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type
      WHEN 'table' THEN 0
      WHEN 'index' THEN 1
      WHEN 'view' THEN 2
      WHEN 'trigger' THEN 3
      ELSE 4
    END, name`
  return yield* Schema.decodeUnknownEffect(Schema.Array(CurrentSchemaObject))(rows)
})

const matchesCurrentSchema = (actual: ReadonlyArray<typeof CurrentSchemaObject.Type>): boolean =>
  actual.length === currentSchema.objects.length &&
  actual.every((object, index) => {
    const expected = currentSchema.objects[index]
    return (
      expected !== undefined &&
      object.type === expected.type &&
      object.name === expected.name &&
      object.sql === expected.sql
    )
  })

/** Require the exact current prototype schema without compatibility handling. */
export const validateCurrentSchema = Effect.fn("DatabaseSchema.validate")(function*(sql: SqlClient.SqlClient) {
  const objects = yield* readSchemaObjects(sql).pipe(
    Effect.mapError(() => new DatabaseInitializationError({ operation: "verify-schema" }))
  )
  if (!matchesCurrentSchema(objects)) {
    return yield* new DatabaseInitializationError({ operation: "verify-schema" })
  }
})

/**
 * Initialize a brand-new prototype database or require the exact current shape.
 *
 * Start versioned migrations only after the persistence model is declared stable
 * and a released database file must remain readable by a newer application build.
 * Until then, schema changes are intentionally breaking and require recreating the
 * local database.
 */
export const initializeCurrentSchema = Effect.fn("DatabaseSchema.initialize")(function*(sql: SqlClient.SqlClient) {
  const existing = yield* readSchemaObjects(sql).pipe(
    Effect.mapError(() => new DatabaseInitializationError({ operation: "initialize-schema" }))
  )
  if (existing.length > 0) return yield* validateCurrentSchema(sql)

  yield* Effect.forEach(currentSchema.objects, ({ sql: statement }) => sql.unsafe(statement), { discard: true }).pipe(
    Effect.mapError(() => new DatabaseInitializationError({ operation: "initialize-schema" }))
  )
  yield* validateCurrentSchema(sql)
})
