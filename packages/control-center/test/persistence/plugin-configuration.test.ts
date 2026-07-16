import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RevisionConflictError,
  SecretReferenceScopeConflictError
} from "../../src/server/persistence/errors.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfigurationKey } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { PluginConfigurationRepository } from "../../src/server/persistence/repositories/pluginConfigurationRepository.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000031")
const OTHER_WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000032")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000033")
const OTHER_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000034")
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:01:00.000Z")
const SECRET_REF = SecretRef.make(`secret_${"a".repeat(64)}`)
const BASE_URL_KEY = StoredPluginConfigurationKey.make("base-url")
const ENABLED_KEY = StoredPluginConfigurationKey.make("enabled")
const TOKEN_KEY = StoredPluginConfigurationKey.make("token")

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-plugin-configuration-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withConfiguration = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | Database
    | PluginConfigurationRepository
    | PluginConnectionRepository
    | QuarantineRepository
    | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const connections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const configurations = PluginConfigurationRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(
      Effect.provide(Layer.mergeAll(foundation, connections, configurations, workspaces))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  const connections = yield* PluginConnectionRepository
  yield* workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* workspaces.create(OTHER_WORKSPACE_ID, {
    displayName: WorkspaceName.make("Other"),
    createdAt: T0
  })
  yield* connections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  yield* connections.create(WORKSPACE_ID, {
    pluginConnectionId: OTHER_PLUGIN_ID,
    providerId: "codecommit",
    displayName: PluginConnectionDisplayName.make("Payments GitHub"),
    isEnabled: true,
    createdAt: T0
  })
  yield* connections.create(OTHER_WORKSPACE_ID, {
    pluginConnectionId: OTHER_PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Other Jira"),
    isEnabled: true,
    createdAt: T0
  })
})

describe("plugin configuration persistence", () => {
  it.effect("creates and updates canonical configuration with optimistic concurrency", () =>
    withConfiguration(Effect.gen(function*() {
      const configurations = yield* PluginConfigurationRepository
      yield* setup

      assert.isTrue(Option.isNone(yield* configurations.get(WORKSPACE_ID, PLUGIN_ID)))
      const created = yield* configurations.update(
        WORKSPACE_ID,
        PLUGIN_ID,
        [
          { _tag: "text", key: BASE_URL_KEY, value: "https://jira.example" },
          { _tag: "secret-reference", key: TOKEN_KEY, ref: SECRET_REF }
        ],
        0,
        T0
      )
      assert.strictEqual(created.revision, 1)
      assert.strictEqual(created.values[1]?._tag, "secret-reference")

      const updated = yield* configurations.update(
        WORKSPACE_ID,
        PLUGIN_ID,
        [
          { _tag: "boolean", key: ENABLED_KEY, value: true }
        ],
        1,
        T1
      )
      assert.strictEqual(updated.revision, 2)
      assert.strictEqual(updated.values[0]?._tag, "boolean")

      const stale = yield* configurations.update(WORKSPACE_ID, PLUGIN_ID, [], 1, T1).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stale))
      if (Result.isFailure(stale)) assert.instanceOf(stale.failure, RevisionConflictError)
    })))

  it.effect("keeps configuration workspace-scoped", () =>
    withConfiguration(Effect.gen(function*() {
      const configurations = yield* PluginConfigurationRepository
      yield* setup
      yield* configurations.update(WORKSPACE_ID, PLUGIN_ID, [], 0, T0)
      assert.isTrue(Option.isNone(yield* configurations.get(OTHER_WORKSPACE_ID, PLUGIN_ID)))
    })))

  it.effect("durably rejects secret-reference reuse across plugin and workspace scopes", () =>
    withConfiguration(Effect.gen(function*() {
      const configurations = yield* PluginConfigurationRepository
      yield* setup
      yield* configurations.update(
        WORKSPACE_ID,
        PLUGIN_ID,
        [{ _tag: "secret-reference", key: TOKEN_KEY, ref: SECRET_REF }],
        0,
        T0
      )
      yield* configurations.update(WORKSPACE_ID, PLUGIN_ID, [], 1, T1)

      const crossField = yield* configurations.update(
        WORKSPACE_ID,
        PLUGIN_ID,
        [{ _tag: "secret-reference", key: BASE_URL_KEY, ref: SECRET_REF }],
        2,
        T1
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossField))
      if (Result.isFailure(crossField)) {
        assert.instanceOf(crossField.failure, SecretReferenceScopeConflictError)
      }

      const crossPlugin = yield* configurations.update(
        WORKSPACE_ID,
        OTHER_PLUGIN_ID,
        [{ _tag: "secret-reference", key: TOKEN_KEY, ref: SECRET_REF }],
        0,
        T0
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossPlugin))
      if (Result.isFailure(crossPlugin)) {
        assert.instanceOf(crossPlugin.failure, SecretReferenceScopeConflictError)
      }

      const crossWorkspace = yield* configurations.update(
        OTHER_WORKSPACE_ID,
        OTHER_PLUGIN_ID,
        [{ _tag: "secret-reference", key: TOKEN_KEY, ref: SECRET_REF }],
        0,
        T0
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossWorkspace))
      if (Result.isFailure(crossWorkspace)) {
        assert.instanceOf(crossWorkspace.failure, SecretReferenceScopeConflictError)
      }

      assert.isTrue(Option.isNone(yield* configurations.get(WORKSPACE_ID, OTHER_PLUGIN_ID)))
      assert.isTrue(Option.isNone(yield* configurations.get(OTHER_WORKSPACE_ID, OTHER_PLUGIN_ID)))
    })))

  it.effect("quarantines a digest-mismatched row without retaining its values", () =>
    withConfiguration(Effect.gen(function*() {
      const configurations = yield* PluginConfigurationRepository
      const database = yield* Database
      const quarantine = yield* QuarantineRepository
      yield* setup
      yield* configurations.update(
        WORKSPACE_ID,
        PLUGIN_ID,
        [
          { _tag: "text", key: BASE_URL_KEY, value: "https://jira.example/private-canary" }
        ],
        0,
        T0
      )
      yield* database.sql`UPDATE plugin_configurations
        SET configuration_digest = ${"0".repeat(64)}
        WHERE workspace_id = ${WORKSPACE_ID} AND plugin_connection_id = ${PLUGIN_ID}`

      const result = yield* configurations.get(WORKSPACE_ID, PLUGIN_ID).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistedRecordError)
      const records = yield* quarantine.list(WORKSPACE_ID)
      assert.strictEqual(records[0]?.diagnosticCode, "plugin-configuration-schema-invalid")
      assert.notInclude(JSON.stringify(records), "private-canary")
    })))
})
