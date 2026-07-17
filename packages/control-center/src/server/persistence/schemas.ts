import * as Schema from "effect/Schema"

/** Decoded SQLite foreign-key pragma result. */
export const ForeignKeysPragmaRow = Schema.Struct({
  foreignKeys: Schema.Number.check(Schema.isInt())
})

/** Decoded SQLite journal-mode pragma result. */
export const JournalModePragmaRow = Schema.Struct({
  journalMode: Schema.String
})

/** Decoded SQLite busy-timeout pragma result. */
export const BusyTimeoutPragmaRow = Schema.Struct({
  timeout: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
