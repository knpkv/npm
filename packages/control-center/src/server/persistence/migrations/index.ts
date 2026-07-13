import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { migration0001Core } from "./0001_core.js"
import { migration0002Integrity } from "./0002_integrity.js"
import { migration0003Auth } from "./0003_auth.js"

/** Private table recording the exact ordered Control Center migration ledger. */
export const MIGRATION_LEDGER_TABLE = "control_center_migrations"

/** Exact migration ledger supported by this build. */
export const EXPECTED_MIGRATIONS = [
  { id: 1, name: "core_heads" },
  { id: 2, name: "integrity_blobs" },
  { id: 3, name: "auth" }
]

/** Ordered, forward-only Control Center migrations. */
export const migrationLoader = LibsqlMigrator.fromRecord({
  "0001_core_heads": migration0001Core,
  "0002_integrity_blobs": migration0002Integrity,
  "0003_auth": migration0003Auth
})
