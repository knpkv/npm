import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem, Scope } from "effect"
import { Effect, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { migration0016PluginRuntimeAuthority } from "../../src/server/persistence/migrations/0016_plugin_runtime_authority.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-440000000001"
const CONNECTION_ID = "01890f6f-6d6a-7cc0-98d2-440000000002"
const PROVIDER_ID = "jira"
const CONNECTION_UPDATED_AT = "2026-07-15T10:00:00.000Z"
const RUNTIME_ACCEPTED_AT = "2026-07-15T10:01:00.000Z"
const CONFIGURATION_UPDATED_AT = "2026-07-15T10:02:00.000Z"
const ACTIVATED_AT = "2026-07-15T10:03:00.000Z"
const LATER_ACTIVATED_AT = "2026-07-15T10:04:00.000Z"
const DESCRIPTOR_DIGEST = "a".repeat(64)
const NEXT_DESCRIPTOR_DIGEST = "b".repeat(64)
const CONFIGURATION_DIGEST = "c".repeat(64)
const ACCOUNT_DIGEST = `sha256:${"d".repeat(64)}`
const NEXT_ACCOUNT_DIGEST = `sha256:${"e".repeat(64)}`
const AUTHORITY_DIGEST = `sha256:${"f".repeat(64)}`
const NEXT_AUTHORITY_DIGEST = `sha256:${"1".repeat(64)}`
const THIRD_AUTHORITY_DIGEST = `sha256:${"2".repeat(64)}`
const FOURTH_AUTHORITY_DIGEST = `sha256:${"3".repeat(64)}`

interface AuthorityHeadInput {
  readonly accountDigest: string
  readonly activatedAt: string
  readonly authorityDigest: string
  readonly configurationDigest: string | null
  readonly configurationRevision: number | null
  readonly connectionRevision: number
  readonly descriptorDigest: string
  readonly generation: number
  readonly providerId: string
  readonly schemaVersion: number
}

const defaultHead: AuthorityHeadInput = {
  accountDigest: ACCOUNT_DIGEST,
  activatedAt: ACTIVATED_AT,
  authorityDigest: AUTHORITY_DIGEST,
  configurationDigest: null,
  configurationRevision: null,
  connectionRevision: 1,
  descriptorDigest: DESCRIPTOR_DIGEST,
  generation: 1,
  providerId: PROVIDER_ID,
  schemaVersion: 1
}

const createParentSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE plugin_connections (
      workspace_id TEXT NOT NULL,
      plugin_connection_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      is_enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, plugin_connection_id),
      UNIQUE (workspace_id, plugin_connection_id, provider_id)
    )`
    yield* sql`CREATE TABLE plugin_runtime_state (
      workspace_id TEXT NOT NULL,
      plugin_connection_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      descriptor_digest TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      health_state TEXT NOT NULL,
      PRIMARY KEY (workspace_id, plugin_connection_id),
      FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
        REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id)
    )`
    yield* sql`CREATE TABLE plugin_configurations (
      workspace_id TEXT NOT NULL,
      plugin_connection_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      configuration_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, plugin_connection_id),
      FOREIGN KEY (workspace_id, plugin_connection_id)
        REFERENCES plugin_connections(workspace_id, plugin_connection_id)
    )`
  })

const seedCurrentSources = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`INSERT INTO plugin_connections (
      workspace_id, plugin_connection_id, provider_id, revision, is_enabled, updated_at
    ) VALUES (
      ${WORKSPACE_ID}, ${CONNECTION_ID}, ${PROVIDER_ID}, 1, 1, ${CONNECTION_UPDATED_AT}
    )`
    yield* sql`INSERT INTO plugin_runtime_state (
      workspace_id, plugin_connection_id, provider_id, revision,
      descriptor_digest, accepted_at, health_state
    ) VALUES (
      ${WORKSPACE_ID}, ${CONNECTION_ID}, ${PROVIDER_ID}, 1,
      ${DESCRIPTOR_DIGEST}, ${RUNTIME_ACCEPTED_AT}, 'healthy'
    )`
  })

const insertHead = (
  sql: SqlClient.SqlClient,
  overrides: Partial<AuthorityHeadInput> = {}
) => {
  const input = { ...defaultHead, ...overrides }
  return sql`INSERT INTO plugin_runtime_authority_heads (
    workspace_id, plugin_connection_id, provider_id, authority_schema_version,
    generation, connection_revision, configuration_revision, configuration_digest,
    descriptor_digest, account_digest, authority_digest, activated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${CONNECTION_ID}, ${input.providerId}, ${input.schemaVersion},
    ${input.generation}, ${input.connectionRevision}, ${input.configurationRevision},
    ${input.configurationDigest}, ${input.descriptorDigest}, ${input.accountDigest},
    ${input.authorityDigest}, ${input.activatedAt}
  )`
}

const withFixture = <Success, Failure>(
  use: Effect.Effect<Success, Failure, FileSystem.FileSystem | Scope.Scope | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-runtime-authority-migration-")
    return yield* use.pipe(
      Effect.provide(LibsqlClient.layer({ url: config.databaseUrl })),
      Effect.scoped
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("plugin runtime authority migration", () => {
  it.effect("starts without guessing a head and preserves the first valid generation", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createParentSchema(sql)
      yield* seedCurrentSources(sql)
      yield* migration0016PluginRuntimeAuthority

      const beforePublish = yield* sql`SELECT * FROM current_plugin_runtime_authority_heads`
      assert.isEmpty(beforePublish)

      yield* insertHead(sql)
      const published = yield* sql<{
        readonly authority_digest: string
        readonly generation: number
      }>`SELECT generation, authority_digest FROM current_plugin_runtime_authority_heads`
      const history = yield* sql<{
        readonly authority_digest: string
        readonly generation: number
      }>`SELECT generation, authority_digest FROM plugin_runtime_authority_generations`
      const deletion = yield* sql`DELETE FROM plugin_runtime_authority_heads`.pipe(Effect.result)
      const historyUpdate = yield* sql`UPDATE plugin_runtime_authority_generations
        SET authority_digest = ${NEXT_AUTHORITY_DIGEST}`.pipe(Effect.result)
      const historyDeletion = yield* sql`DELETE FROM plugin_runtime_authority_generations`.pipe(Effect.result)

      assert.deepStrictEqual(published, [{
        authority_digest: AUTHORITY_DIGEST,
        generation: 1
      }])
      assert.deepStrictEqual(history, [{
        authority_digest: AUTHORITY_DIGEST,
        generation: 1
      }])
      assert.isTrue(Result.isFailure(deletion))
      assert.isTrue(Result.isFailure(historyUpdate))
      assert.isTrue(Result.isFailure(historyDeletion))
    })))

  it.effect("rejects heads that do not exactly match enabled current sources", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createParentSchema(sql)
      yield* seedCurrentSources(sql)
      yield* migration0016PluginRuntimeAuthority

      const skippedInitialGeneration = yield* insertHead(sql, { generation: 2 }).pipe(Effect.result)
      const wrongConnectionRevision = yield* insertHead(sql, { connectionRevision: 2 }).pipe(Effect.result)
      const wrongDescriptor = yield* insertHead(sql, { descriptorDigest: NEXT_DESCRIPTOR_DIGEST }).pipe(Effect.result)
      const malformedAuthority = yield* insertHead(sql, { authorityDigest: "not-a-digest" }).pipe(Effect.result)
      const malformedActivation = yield* insertHead(sql, { activatedAt: "z" }).pipe(Effect.result)
      const halfPresentConfiguration = yield* insertHead(sql, {
        configurationRevision: 1
      }).pipe(Effect.result)

      yield* sql`UPDATE plugin_connections SET is_enabled = 0`
      const disabledConnection = yield* insertHead(sql).pipe(Effect.result)
      yield* sql`UPDATE plugin_connections SET is_enabled = 1`

      yield* sql`INSERT INTO plugin_configurations (
        workspace_id, plugin_connection_id, revision, configuration_digest, updated_at
      ) VALUES (
        ${WORKSPACE_ID}, ${CONNECTION_ID}, 1, ${CONFIGURATION_DIGEST},
        ${CONFIGURATION_UPDATED_AT}
      )`
      const falselyAbsentConfiguration = yield* insertHead(sql).pipe(Effect.result)
      const wrongConfigurationRevision = yield* insertHead(sql, {
        configurationDigest: CONFIGURATION_DIGEST,
        configurationRevision: 2
      }).pipe(Effect.result)
      const wrongConfigurationDigest = yield* insertHead(sql, {
        configurationDigest: NEXT_DESCRIPTOR_DIGEST,
        configurationRevision: 1
      }).pipe(Effect.result)

      for (
        const result of [
          skippedInitialGeneration,
          wrongConnectionRevision,
          wrongDescriptor,
          malformedAuthority,
          malformedActivation,
          halfPresentConfiguration,
          disabledConnection,
          falselyAbsentConfiguration,
          wrongConfigurationRevision,
          wrongConfigurationDigest
        ]
      ) {
        assert.isTrue(Result.isFailure(result))
      }

      yield* insertHead(sql, {
        configurationDigest: CONFIGURATION_DIGEST,
        configurationRevision: 1
      })
    })))

  it.effect("advances exactly while ignoring health-only runtime revisions", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createParentSchema(sql)
      yield* seedCurrentSources(sql)
      yield* migration0016PluginRuntimeAuthority
      yield* insertHead(sql)

      yield* sql`UPDATE plugin_runtime_state SET revision = 2, health_state = 'degraded'`
      yield* sql`UPDATE plugin_runtime_authority_heads SET
        generation = 2,
        account_digest = ${NEXT_ACCOUNT_DIGEST},
        authority_digest = ${NEXT_AUTHORITY_DIGEST},
        activated_at = ${LATER_ACTIVATED_AT}`
      const healthOnlyCurrent = yield* sql<{ readonly generation: number }>`SELECT generation
        FROM current_plugin_runtime_authority_heads`
      assert.deepStrictEqual(healthOnlyCurrent, [{ generation: 2 }])

      const skippedGeneration = yield* sql`UPDATE plugin_runtime_authority_heads
        SET generation = 4, authority_digest = ${AUTHORITY_DIGEST}`.pipe(Effect.result)
      const changedProvider = yield* sql`UPDATE plugin_runtime_authority_heads
        SET generation = 3, provider_id = 'codecommit', authority_digest = ${AUTHORITY_DIGEST}`.pipe(Effect.result)
      const backwardsActivation = yield* sql`UPDATE plugin_runtime_authority_heads
        SET generation = 3, activated_at = ${ACTIVATED_AT},
          authority_digest = ${AUTHORITY_DIGEST}`.pipe(Effect.result)

      yield* sql`INSERT INTO plugin_configurations (
        workspace_id, plugin_connection_id, revision, configuration_digest, updated_at
      ) VALUES (
        ${WORKSPACE_ID}, ${CONNECTION_ID}, 1, ${CONFIGURATION_DIGEST},
        ${CONFIGURATION_UPDATED_AT}
      )`
      const currentWhileConfigurationIsStale = yield* sql`SELECT *
        FROM current_plugin_runtime_authority_heads`
      assert.isEmpty(currentWhileConfigurationIsStale)
      const staleAbsentConfiguration = yield* sql`UPDATE plugin_runtime_authority_heads
        SET generation = 3, authority_digest = ${AUTHORITY_DIGEST}`.pipe(Effect.result)
      const reusedAuthority = yield* sql`UPDATE plugin_runtime_authority_heads SET
        generation = 3,
        configuration_revision = 1,
        configuration_digest = ${CONFIGURATION_DIGEST},
        authority_digest = ${AUTHORITY_DIGEST}`.pipe(Effect.result)
      yield* sql`UPDATE plugin_runtime_authority_heads SET
        generation = 3,
        configuration_revision = 1,
        configuration_digest = ${CONFIGURATION_DIGEST},
        authority_digest = ${THIRD_AUTHORITY_DIGEST}`

      yield* sql`UPDATE plugin_runtime_state
        SET descriptor_digest = ${NEXT_DESCRIPTOR_DIGEST}`
      const currentWhileDescriptorIsStale = yield* sql`SELECT *
        FROM current_plugin_runtime_authority_heads`
      assert.isEmpty(currentWhileDescriptorIsStale)
      const staleDescriptor = yield* sql`UPDATE plugin_runtime_authority_heads
        SET generation = 4, authority_digest = ${FOURTH_AUTHORITY_DIGEST}`.pipe(Effect.result)
      yield* sql`UPDATE plugin_runtime_authority_heads SET
        generation = 4,
        descriptor_digest = ${NEXT_DESCRIPTOR_DIGEST},
        authority_digest = ${FOURTH_AUTHORITY_DIGEST}`

      for (
        const result of [
          skippedGeneration,
          changedProvider,
          backwardsActivation,
          staleAbsentConfiguration,
          reusedAuthority,
          staleDescriptor
        ]
      ) {
        assert.isTrue(Result.isFailure(result))
      }

      const current = yield* sql<{
        readonly descriptor_digest: string
        readonly generation: number
      }>`SELECT generation, descriptor_digest FROM current_plugin_runtime_authority_heads`
      assert.deepStrictEqual(current, [{
        descriptor_digest: NEXT_DESCRIPTOR_DIGEST,
        generation: 4
      }])
      const history = yield* sql<{
        readonly authority_digest: string
        readonly generation: number
      }>`SELECT generation, authority_digest FROM plugin_runtime_authority_generations
        ORDER BY generation`
      assert.deepStrictEqual(history, [
        { authority_digest: AUTHORITY_DIGEST, generation: 1 },
        { authority_digest: NEXT_AUTHORITY_DIGEST, generation: 2 },
        { authority_digest: THIRD_AUTHORITY_DIGEST, generation: 3 },
        { authority_digest: FOURTH_AUTHORITY_DIGEST, generation: 4 }
      ])
    })))
})
