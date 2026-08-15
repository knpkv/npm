import type * as Schema from "effect/Schema"

/** Concrete values the SQL drivers may expose before repository schemas decode a row. */
export type SqlColumnValue = Schema.Json | bigint | Date | Uint8Array | undefined

/** Unparsed driver row accepted only at repository schema boundaries. */
export type SqlRow = Readonly<Record<string, SqlColumnValue>>
