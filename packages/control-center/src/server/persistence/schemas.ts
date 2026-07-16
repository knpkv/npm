import * as Schema from "effect/Schema"

/** Decoded row from the private migration ledger. */
export const MigrationLedgerRow = Schema.Struct({
  migrationId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(255))
})

/** Decoded row from the private migration ledger. */
export type MigrationLedgerRow = typeof MigrationLedgerRow.Type

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
