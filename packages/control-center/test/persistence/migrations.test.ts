import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, Exit, Path, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { verifyBackup } from "../../src/server/persistence/backup/index.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { MigrationLedgerError } from "../../src/server/persistence/errors.js"
import { migration0001Core } from "../../src/server/persistence/migrations/0001_core.js"
import { migration0002Integrity } from "../../src/server/persistence/migrations/0002_integrity.js"
import { migration0003Auth } from "../../src/server/persistence/migrations/0003_auth.js"
import { migration0004PluginRuntime } from "../../src/server/persistence/migrations/0004_plugin_runtime.js"
import { migration0005PluginConfiguration } from "../../src/server/persistence/migrations/0005_plugin_configuration.js"
import { migration0006PluginSyncPageEvidence } from "../../src/server/persistence/migrations/0006_plugin_sync_page_evidence.js"
import { EXPECTED_MIGRATIONS, MIGRATION_LEDGER_TABLE } from "../../src/server/persistence/migrations/index.js"

const expectedTables = [
  "content_blobs",
  "control_center_migrations",
  "domain_event_streams",
  "domain_events",
  "entities",
  "entity_revisions",
  "pairing_codes",
  "person_identities",
  "persons",
  "plugin_cache_entries",
  "plugin_configurations",
  "plugin_connections",
  "plugin_runtime_state",
  "plugin_secret_bindings",
  "plugin_sync_evidence",
  "plugin_sync_pages",
  "plugin_sync_streams",
  "quarantined_records",
  "recovery_audit_events",
  "release_revisions",
  "release_targets",
  "releases",
  "role_assignments",
  "sessions",
  "workspaces"
]

const EXPECTED_CORE_SCHEMA_DIGEST = "172796a81b2a7525678fec510b69a251ffd4e3ba7f06f0659cf77d535b1152dd"

const EXPECTED_PREVIOUS_ROWS = [
  {
    recordKind: "entity",
    snapshot:
      "{\"workspace_id\":\"01890f6f-6d6a-7cc0-98d2-000000000001\",\"entity_id\":\"01890f6f-6d6a-7cc0-98d2-000000000004\",\"vendor_immutable_id\":\"10042\",\"current_revision\":1}"
  },
  {
    recordKind: "entity-revision",
    snapshot:
      "{\"entity_id\":\"01890f6f-6d6a-7cc0-98d2-000000000004\",\"revision\":1,\"source_revision\":\"42\",\"source_url\":\"https://jira.example/browse/PAY-42\"}"
  },
  {
    recordKind: "person",
    snapshot:
      "{\"person_id\":\"01890f6f-6d6a-7cc0-98d2-000000000005\",\"display_name\":\"Ada Lovelace\",\"avatar_json\":\"{\\\"_tag\\\":\\\"initials\\\",\\\"text\\\":\\\"AL\\\"}\",\"revision\":1}"
  },
  {
    recordKind: "person-identity",
    snapshot:
      "{\"person_id\":\"01890f6f-6d6a-7cc0-98d2-000000000005\",\"provider_id\":\"jira\",\"vendor_person_id\":\"account-ada\"}"
  },
  {
    recordKind: "plugin",
    snapshot:
      "{\"plugin_connection_id\":\"01890f6f-6d6a-7cc0-98d2-000000000002\",\"provider_id\":\"jira\",\"display_name\":\"Payments Jira\",\"is_enabled\":1,\"revision\":1}"
  },
  {
    recordKind: "release",
    snapshot:
      "{\"release_id\":\"01890f6f-6d6a-7cc0-98d2-000000000003\",\"current_revision\":1,\"created_at\":\"2026-07-13T10:00:00.000Z\"}"
  },
  {
    recordKind: "release-revision",
    snapshot:
      "{\"release_id\":\"01890f6f-6d6a-7cc0-98d2-000000000003\",\"revision\":1,\"snapshot_json\":\"{}\",\"snapshot_digest\":\"0000000000000000000000000000000000000000000000000000000000000000\"}"
  },
  {
    recordKind: "release-target",
    snapshot:
      "{\"release_id\":\"01890f6f-6d6a-7cc0-98d2-000000000003\",\"environment_id\":\"01890f6f-6d6a-7cc0-98d2-000000000006\"}"
  },
  {
    recordKind: "role-assignment",
    snapshot:
      "{\"assignment_id\":\"01890f6f-6d6a-7cc0-98d2-000000000007\",\"actor_kind\":\"agent\",\"agent_id\":\"01890f6f-6d6a-7cc0-98d2-000000000008\",\"scope_kind\":\"environment\",\"environment_id\":\"01890f6f-6d6a-7cc0-98d2-000000000006\",\"revision\":1}"
  },
  {
    recordKind: "workspace",
    snapshot: "{\"workspace_id\":\"01890f6f-6d6a-7cc0-98d2-000000000001\",\"display_name\":\"Payments\",\"revision\":1}"
  }
]

const readPreviousRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly recordKind: string; readonly snapshot: string }>`
    SELECT 'workspace' AS recordKind,
      json_object('workspace_id', workspace_id, 'display_name', display_name, 'revision', revision) AS snapshot
      FROM workspaces
    UNION ALL SELECT 'plugin',
      json_object('plugin_connection_id', plugin_connection_id, 'provider_id', provider_id,
        'display_name', display_name, 'is_enabled', is_enabled, 'revision', revision)
      FROM plugin_connections
    UNION ALL SELECT 'release',
      json_object('release_id', release_id, 'current_revision', current_revision, 'created_at', created_at)
      FROM releases
    UNION ALL SELECT 'release-revision',
      json_object('release_id', release_id, 'revision', revision, 'snapshot_json', snapshot_json,
        'snapshot_digest', snapshot_digest)
      FROM release_revisions
    UNION ALL SELECT 'release-target',
      json_object('release_id', release_id, 'environment_id', environment_id)
      FROM release_targets
    UNION ALL SELECT 'entity',
      json_object('workspace_id', workspace_id, 'entity_id', entity_id,
        'vendor_immutable_id', vendor_immutable_id, 'current_revision', current_revision)
      FROM entities
    UNION ALL SELECT 'entity-revision',
      json_object('entity_id', entity_id, 'revision', revision, 'source_revision', source_revision,
        'source_url', source_url)
      FROM entity_revisions
    UNION ALL SELECT 'person',
      json_object('person_id', person_id, 'display_name', display_name,
        'avatar_json', avatar_json, 'revision', revision)
      FROM persons
    UNION ALL SELECT 'person-identity',
      json_object('person_id', person_id, 'provider_id', provider_id,
        'vendor_person_id', vendor_person_id)
      FROM person_identities
    UNION ALL SELECT 'role-assignment',
      json_object('assignment_id', assignment_id, 'actor_kind', actor_kind, 'agent_id', agent_id,
        'scope_kind', scope_kind, 'environment_id', environment_id, 'revision', revision)
      FROM role_assignments
    ORDER BY recordKind`

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-migrations-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

describe("Control Center migrations", () => {
  it.effect("creates the exact fresh schema and final ledger", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const snapshot = yield* Effect.gen(function*() {
        const database = yield* Database
        const tables = yield* database.sql<{ readonly name: string }>`SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
        const ledger = yield* database.sql<{
          readonly migrationId: number
          readonly name: string
        }>`SELECT migration_id AS migrationId, name
          FROM ${database.sql(MIGRATION_LEDGER_TABLE)}
          ORDER BY migration_id`
        return { ledger, tables: tables.map(({ name }) => name) }
      }).pipe(Effect.provide(databaseLayer(config)))

      assert.deepStrictEqual(snapshot.tables, expectedTables)
      assert.deepStrictEqual(
        snapshot.ledger,
        EXPECTED_MIGRATIONS.map(({ id, name }) => ({
          migrationId: id,
          name
        }))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("upgrades the exact previous ledger by appending later migrations", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const previousLoader = LibsqlMigrator.fromRecord({
        "0001_core_heads": migration0001Core,
        "0002_integrity_blobs": migration0002Integrity,
        "0003_auth": migration0003Auth,
        "0004_plugin_runtime": migration0004PluginRuntime
      })
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* LibsqlMigrator.run({ loader: previousLoader, table: MIGRATION_LEDGER_TABLE })
        yield* sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000091', 'Legacy', 1,
          '2026-07-14T09:00:00.000Z', '2026-07-14T09:00:00.000Z'
        )`
        yield* sql`INSERT INTO plugin_connections (
          workspace_id, plugin_connection_id, provider_id, display_name,
          revision, is_enabled, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000091',
          '01890f6f-6d6a-7cc0-98d2-000000000092',
          'jira', 'Legacy Jira', 1, 1,
          '2026-07-14T09:00:00.000Z', '2026-07-14T09:00:00.000Z'
        )`
        yield* sql`INSERT INTO plugin_sync_streams (
          workspace_id, plugin_connection_id, provider_id, stream_key, revision,
          checkpoint_json, checkpoint_digest, last_page_id, synchronized_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000091',
          '01890f6f-6d6a-7cc0-98d2-000000000092',
          'jira', 'releases', 1, '{}',
          '0000000000000000000000000000000000000000000000000000000000000000',
          'legacy-page', '2026-07-14T09:01:00.000Z'
        )`
        yield* sql`INSERT INTO plugin_sync_pages (
          workspace_id, plugin_connection_id, stream_key, page_id, expected_revision,
          page_digest, checkpoint_digest, event_count, committed_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000091',
          '01890f6f-6d6a-7cc0-98d2-000000000092',
          'releases', 'legacy-page', 0,
          '0000000000000000000000000000000000000000000000000000000000000000',
          '0000000000000000000000000000000000000000000000000000000000000000',
          0, '2026-07-14T09:01:00.000Z'
        )`
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            transformResultNames: snakeToCamel,
            url: config.databaseUrl
          })
        ),
        Effect.scoped
      )

      const snapshot = yield* Effect.gen(function*() {
        const database = yield* Database
        const ledger = yield* database.sql<{ readonly migrationId: number; readonly name: string }>`SELECT
          migration_id AS migrationId, name FROM ${database.sql(MIGRATION_LEDGER_TABLE)}
          ORDER BY migration_id`
        const tables = yield* database.sql<{ readonly name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'plugin_%' ORDER BY name`
        const pageColumns = yield* database.sql<{
          readonly name: string
          readonly notNull: number
        }>`SELECT name, "notnull" AS "notNull" FROM pragma_table_info('plugin_sync_pages')`
        const legacyPages = yield* database.sql<{
          readonly hasMore: number
          readonly successfulHealthDigest: string | null
          readonly successfulHealthJson: string | null
        }>`SELECT has_more AS hasMore, successful_health_json AS successfulHealthJson,
          successful_health_digest AS successfulHealthDigest
          FROM plugin_sync_pages WHERE page_id = 'legacy-page'`
        return { ledger, legacyPages, pageColumns, tables }
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      assert.deepStrictEqual(snapshot.ledger, EXPECTED_MIGRATIONS.map(({ id, name }) => ({ migrationId: id, name })))
      assert.deepStrictEqual(snapshot.tables.map(({ name }) => name), [
        "plugin_cache_entries",
        "plugin_configurations",
        "plugin_connections",
        "plugin_runtime_state",
        "plugin_secret_bindings",
        "plugin_sync_evidence",
        "plugin_sync_pages",
        "plugin_sync_streams"
      ])
      assert.deepStrictEqual(
        snapshot.pageColumns
          .filter(({ name }) => name === "has_more" || name.startsWith("successful_health_"))
          .map(({ name, notNull }) => ({ name, notNull })),
        [
          { name: "has_more", notNull: 1 },
          { name: "successful_health_json", notNull: 0 },
          { name: "successful_health_digest", notNull: 0 }
        ]
      )
      assert.deepStrictEqual(snapshot.legacyPages, [{
        hasMore: 0,
        successfulHealthDigest: null,
        successfulHealthJson: null
      }])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("upgrades schema version 6 to workspace-local event streams without rewriting data", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const previousLoader = LibsqlMigrator.fromRecord({
        "0001_core_heads": migration0001Core,
        "0002_integrity_blobs": migration0002Integrity,
        "0003_auth": migration0003Auth,
        "0004_plugin_runtime": migration0004PluginRuntime,
        "0005_plugin_configuration": migration0005PluginConfiguration,
        "0006_plugin_sync_page_evidence": migration0006PluginSyncPageEvidence
      })
      const legacyWorkspaceId = "01890f6f-6d6a-7cc0-98d2-000000000093"

      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* LibsqlMigrator.run({ loader: previousLoader, table: MIGRATION_LEDGER_TABLE })
        yield* sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          ${legacyWorkspaceId}, 'Version Six', 1,
          '2026-07-14T09:00:00.000Z', '2026-07-14T09:00:00.000Z'
        )`
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            transformResultNames: snakeToCamel,
            url: config.databaseUrl
          })
        ),
        Effect.scoped
      )

      const snapshot = yield* Effect.gen(function*() {
        const database = yield* Database
        const workspaces = yield* database.sql<{ readonly displayName: string }>`SELECT
          display_name AS displayName FROM workspaces WHERE workspace_id = ${legacyWorkspaceId}`
        const streams = yield* database.sql`SELECT workspace_id FROM domain_event_streams`
        const events = yield* database.sql`SELECT workspace_id FROM domain_events`
        const ledger = yield* database.sql<{
          readonly migrationId: number
          readonly name: string
        }>`SELECT migration_id AS migrationId, name
          FROM ${database.sql(MIGRATION_LEDGER_TABLE)}
          ORDER BY migration_id`
        return { events, ledger, streams, workspaces }
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      assert.deepStrictEqual(snapshot.workspaces, [{ displayName: "Version Six" }])
      assert.deepStrictEqual(snapshot.streams, [])
      assert.deepStrictEqual(snapshot.events, [])
      assert.deepStrictEqual(
        snapshot.ledger,
        EXPECTED_MIGRATIONS.map(({ id, name }) => ({ migrationId: id, name }))
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const backupRoot = path.join(
        path.dirname(config.blobRoot),
        "backups",
        "pre-migration",
        "v6-to-v7"
      )
      const archives = (yield* fileSystem.readDirectory(backupRoot)).filter(
        (entry) => !entry.startsWith(".control-center-backup-incoming-")
      )
      assert.strictEqual(archives.length, 1)
      const archive = archives[0]
      if (archive === undefined) return yield* Effect.fail("missing pre-migration archive")
      const verification = yield* verifyBackup(path.join(backupRoot, archive))
      assert.strictEqual(verification.manifest.kind, "pre-migration")
      assert.deepStrictEqual(
        verification.manifest.migrations,
        EXPECTED_MIGRATIONS.slice(0, 6).map(({ id, name }) => ({ migrationId: id, name }))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("upgrades an exact previous schema without rewriting its ledger entry", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const previousLoader = LibsqlMigrator.fromRecord({
        "0001_core_heads": migration0001Core
      })

      const beforeUpgrade = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const cryptoService = yield* Crypto.Crypto
        yield* LibsqlMigrator.run({
          loader: previousLoader,
          table: MIGRATION_LEDGER_TABLE
        })
        yield* sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001', 'Payments', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO plugin_connections (
          workspace_id, plugin_connection_id, provider_id, display_name,
          revision, is_enabled, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          'jira', 'Payments Jira', 1, 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO releases (
          workspace_id, release_id, current_revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000003', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO release_revisions (
          workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000003', 1, '{}',
          '0000000000000000000000000000000000000000000000000000000000000000',
          '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO entities (
          workspace_id, entity_id, plugin_connection_id, provider_id,
          vendor_immutable_id, entity_type, current_revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000004',
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          'jira', '10042', 'jira-issue', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision,
          normalization_schema_version, source_url, first_observed_at,
          last_observed_at, synchronized_at, created_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000004', 1, '42', 1,
          'https://jira.example/browse/PAY-42',
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO persons (
          workspace_id, person_id, display_name, avatar_json, is_active,
          revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000005', 'Ada Lovelace',
          '{"_tag":"initials","text":"AL"}', 1, 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO person_identities (
          workspace_id, person_id, plugin_connection_id, provider_id,
          vendor_person_id, created_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000005',
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          'jira', 'account-ada', '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO release_targets (
          workspace_id, release_id, environment_id, created_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000003',
          '01890f6f-6d6a-7cc0-98d2-000000000006',
          '2026-07-13T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO role_assignments (
          workspace_id, assignment_id, actor_kind, agent_id, role, scope_kind,
          release_id, environment_id, lifecycle_kind, assigned_at, revision,
          created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000007', 'agent',
          '01890f6f-6d6a-7cc0-98d2-000000000008', 'deployment-approver', 'environment',
          '01890f6f-6d6a-7cc0-98d2-000000000003',
          '01890f6f-6d6a-7cc0-98d2-000000000006', 'active',
          '2026-07-13T10:00:00.000Z', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        const schemaRows = yield* sql<{ readonly name: string; readonly sql: string }>`
          SELECT name, sql FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT IN (${MIGRATION_LEDGER_TABLE}, 'content_blobs', 'quarantined_records')
          ORDER BY name`
        const schemaBytes = yield* Effect.fromResult(
          Encoding.decodeBase64(Encoding.encodeBase64(JSON.stringify(schemaRows)))
        )
        const schemaDigest = Encoding.encodeHex(yield* cryptoService.digest("SHA-256", schemaBytes))
        return { rows: yield* readPreviousRows(sql), schemaDigest }
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            transformResultNames: snakeToCamel,
            url: config.databaseUrl
          })
        ),
        Effect.scoped
      )

      const afterUpgrade = yield* Effect.gen(function*() {
        const database = yield* Database
        const ledger = yield* database.sql<{
          readonly migrationId: number
          readonly name: string
        }>`SELECT migration_id AS migrationId, name
          FROM ${database.sql(MIGRATION_LEDGER_TABLE)}
          ORDER BY migration_id`
        const coreRows = yield* readPreviousRows(database.sql)
        const integrityTables = yield* database.sql<{ readonly name: string }>`SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('content_blobs', 'quarantined_records')
          ORDER BY name`
        return { coreRows, integrityTables, ledger }
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      const ledgerAfterReopen = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* database.sql<{
          readonly migrationId: number
          readonly name: string
        }>`SELECT migration_id AS migrationId, name
          FROM ${database.sql(MIGRATION_LEDGER_TABLE)}
          ORDER BY migration_id`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      assert.strictEqual(beforeUpgrade.schemaDigest, EXPECTED_CORE_SCHEMA_DIGEST)
      assert.deepStrictEqual(beforeUpgrade.rows, EXPECTED_PREVIOUS_ROWS)
      assert.deepStrictEqual(afterUpgrade.coreRows, EXPECTED_PREVIOUS_ROWS)
      assert.deepStrictEqual(afterUpgrade.integrityTables, [
        { name: "content_blobs" },
        { name: "quarantined_records" }
      ])
      assert.deepStrictEqual(
        afterUpgrade.ledger,
        EXPECTED_MIGRATIONS.map(({ id, name }) => ({
          migrationId: id,
          name
        }))
      )
      assert.deepStrictEqual(ledgerAfterReopen, afterUpgrade.ledger)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back both schema and ledger when a migration fails", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const failure = Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)`
        return yield* Effect.fail("injected migration failure")
      })
      const failedLoader = LibsqlMigrator.fromRecord({
        "0001_injected_failure": failure
      })

      const snapshot = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const outcome = yield* LibsqlMigrator.run({
          loader: failedLoader,
          table: "failed_migrations"
        }).pipe(Effect.exit)
        const tables = yield* sql<{ readonly name: string }>`SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'should_rollback'`
        const ledger = yield* sql`SELECT migration_id FROM failed_migrations`
        return { ledger, outcome, tables }
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            transformResultNames: snakeToCamel,
            url: config.databaseUrl
          })
        )
      )

      assert.isTrue(Exit.isFailure(snapshot.outcome))
      assert.deepStrictEqual(snapshot.tables, [])
      assert.deepStrictEqual(snapshot.ledger, [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("enforces workspace scope through composite foreign keys", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const snapshot = yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES
          ('01890f6f-6d6a-7cc0-98d2-000000000001', 'Payments', 1,
           '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'),
          ('01890f6f-6d6a-7cc0-98d2-000000000002', 'Identity', 1,
           '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z')`
        yield* database.sql`INSERT INTO plugin_connections (
          workspace_id, plugin_connection_id, provider_id, display_name,
          revision, is_enabled, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000003',
          'jira', 'Payments Jira', 1, 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`

        const result = yield* database.sql`INSERT INTO entities (
          workspace_id, entity_id, plugin_connection_id, provider_id,
          vendor_immutable_id, entity_type, current_revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          '01890f6f-6d6a-7cc0-98d2-000000000004',
          '01890f6f-6d6a-7cc0-98d2-000000000003',
          'jira', '10042', 'jira-issue', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`.pipe(Effect.result)
        const entities = yield* database.sql`SELECT entity_id FROM entities`
        return { entities, result }
      }).pipe(Effect.provide(databaseLayer(config)))

      assert.isTrue(Result.isFailure(snapshot.result))
      assert.deepStrictEqual(snapshot.entities, [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a tampered previous ledger before applying later migrations", () =>
    Effect.gen(function*() {
      const config = yield* testConfig

      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE ${sql(MIGRATION_LEDGER_TABLE)} (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          name VARCHAR(255) NOT NULL
        )`
        yield* sql`INSERT INTO ${sql(MIGRATION_LEDGER_TABLE)} (migration_id, name)
          VALUES (1, 'rewritten_history')`
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            transformResultNames: snakeToCamel,
            url: config.databaseUrl
          })
        ),
        Effect.scoped
      )

      const result = yield* Effect.gen(function*() {
        yield* Database
      }).pipe(Effect.provide(databaseLayer(config)), Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, MigrationLedgerError)
        assert.strictEqual(result.failure.phase, "before-migration")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
