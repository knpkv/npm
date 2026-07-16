import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Ref, Result, Schema } from "effect"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError } from "../../src/server/persistence/errors.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfigurationKey } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { PluginConfigurationRepository } from "../../src/server/persistence/repositories/pluginConfigurationRepository.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import { PluginRuntimeRepository } from "../../src/server/persistence/repositories/pluginRuntimeRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"
import {
  PluginRuntimeAccountDigest,
  PluginRuntimeAuthorityToken,
  PluginRuntimeSourceDigest,
  type PublishPluginRuntimeAuthority
} from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import {
  digestPluginRuntimeAuthority,
  pluginRuntimeAuthoritySourceLayer
} from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeAuthoritySource } from "../../src/server/plugins/internal/PluginRuntimeAuthoritySource.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-550000000001")
const CONNECTION_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-550000000002")
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:03:00.000Z")
const T4 = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:04:00.000Z")
const ACCOUNT_A = PluginRuntimeAccountDigest.make(`sha256:${"b".repeat(64)}`)
const ACCOUNT_B = PluginRuntimeAccountDigest.make(`sha256:${"c".repeat(64)}`)
const BASE_URL_KEY = StoredPluginConfigurationKey.make("base-url")

const descriptor = (adapterPatch = 0): unknown => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 1, minor: 0, patch: adapterPatch },
  displayName: "Jira",
  configurationFields: [],
  capabilities: [{
    capabilityId: "sync.incremental",
    supportedVersions: [1],
    requirement: "required"
  }]
})

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-authority-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withAuthority = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | Database
    | PluginConfigurationRepository
    | PluginConnectionRepository
    | PluginRuntimeAuthoritySource
    | PluginRuntimeRepository
    | QuarantineRepository
    | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const configurations = PluginConfigurationRepository.layer.pipe(Layer.provide(foundation))
    const connections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const runtime = PluginRuntimeRepository.layer.pipe(Layer.provide(foundation))
    const authority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(
      Effect.provide(
        Layer.mergeAll(
          foundation,
          configurations,
          connections,
          runtime,
          authority,
          workspaces
        )
      )
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  const connections = yield* PluginConnectionRepository
  const runtime = yield* PluginRuntimeRepository
  yield* workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  const connection = yield* connections.create(WORKSPACE_ID, {
    pluginConnectionId: CONNECTION_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  const runtimeRecord = yield* runtime.acceptPluginDescriptor(
    WORKSPACE_ID,
    CONNECTION_ID,
    "jira",
    descriptor(),
    0,
    T0
  )
  return { connection, runtimeRecord }
})

const absentInput = (
  descriptorDigest: string,
  accountDigest = ACCOUNT_A,
  connectionRevision = 1,
  activatedAt = T1,
  descriptorGeneration = 1
): PublishPluginRuntimeAuthority => ({
  scope: { workspaceId: WORKSPACE_ID, pluginConnectionId: CONNECTION_ID },
  expected: {
    providerId: "jira",
    connectionRevision,
    descriptorGeneration,
    configuration: { _tag: "absent" },
    descriptorDigest: PluginRuntimeSourceDigest.make(descriptorDigest)
  },
  accountDigest,
  activatedAt
})

describe("plugin runtime authority", () => {
  it.effect("keeps the canonical digest stable and generation-bound", () =>
    Effect.gen(function*() {
      const base = {
        scope: { workspaceId: WORKSPACE_ID, pluginConnectionId: CONNECTION_ID },
        expected: {
          providerId: "jira",
          connectionRevision: 1,
          descriptorGeneration: 1,
          configuration: { _tag: "absent" },
          descriptorDigest: PluginRuntimeSourceDigest.make("a".repeat(64))
        },
        accountDigest: ACCOUNT_A
      } satisfies Omit<PublishPluginRuntimeAuthority, "activatedAt">
      const first = yield* digestPluginRuntimeAuthority({ ...base, generation: 1 })
      const repeated = yield* digestPluginRuntimeAuthority({ ...base, generation: 1 })
      const next = yield* digestPluginRuntimeAuthority({ ...base, generation: 2 })

      assert.strictEqual(
        first,
        "sha256:74f5bfe2ed71e29b95b69996987bc7a58df761eb624b1b6322178fd2d922f5f2"
      )
      assert.strictEqual(repeated, first)
      assert.notStrictEqual(next, first)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("publishes idempotently, rejects stale heads, and prevents token ABA", () =>
    withAuthority(Effect.gen(function*() {
      const authority = yield* PluginRuntimeAuthoritySource
      const connections = yield* PluginConnectionRepository
      const database = yield* Database
      const runtime = yield* PluginRuntimeRepository
      const { connection, runtimeRecord } = yield* setup
      const input = absentInput(runtimeRecord.descriptorDigest)

      const [first, repeated] = yield* Effect.all(
        [authority.publish(input), authority.publish(input)],
        { concurrency: "unbounded" }
      )
      assert.strictEqual(repeated.generation, 1)
      assert.strictEqual(repeated.runtimeAuthorityToken, first.runtimeAuthorityToken)

      yield* runtime.recordHealth(
        WORKSPACE_ID,
        CONNECTION_ID,
        runtimeRecord.revision,
        { _tag: "healthy", checkedAt: T2 },
        0
      )
      const afterHealth = yield* authority.publish({ ...input, activatedAt: T2 })
      assert.strictEqual(afterHealth.runtimeAuthorityToken, first.runtimeAuthorityToken)

      const callbackCount = yield* Ref.make(0)
      const currentGeneration = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: first.runtimeAuthorityToken },
        (current) =>
          Ref.update(callbackCount, (count) => count + 1).pipe(
            Effect.as(current.generation)
          )
      )
      assert.strictEqual(currentGeneration, 1)
      const negotiated = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: first.runtimeAuthorityToken },
        (current) => Effect.succeed(current.negotiated)
      )
      assert.strictEqual(negotiated.descriptor.pluginId, "dev.knpkv.jira")
      assert.deepStrictEqual(negotiated.capabilities, [{
        capabilityId: "sync.incremental",
        version: 1
      }])

      const updatedConnection = yield* connections.updateMetadata(WORKSPACE_ID, CONNECTION_ID, {
        displayName: connection.displayName,
        isEnabled: true,
        expectedRevision: connection.revision,
        updatedAt: T2
      })
      const stale = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: first.runtimeAuthorityToken },
        () => Ref.update(callbackCount, (count) => count + 1)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stale))
      assert.strictEqual(yield* Ref.get(callbackCount), 1)

      const second = yield* authority.publish(absentInput(
        runtimeRecord.descriptorDigest,
        ACCOUNT_A,
        updatedConnection.revision,
        T2
      ))
      const third = yield* authority.publish(absentInput(
        runtimeRecord.descriptorDigest,
        ACCOUNT_B,
        updatedConnection.revision,
        T3
      ))
      const fourth = yield* authority.publish(absentInput(
        runtimeRecord.descriptorDigest,
        ACCOUNT_A,
        updatedConnection.revision,
        T4
      ))

      assert.deepStrictEqual(
        [second.generation, third.generation, fourth.generation],
        [2, 3, 4]
      )
      assert.strictEqual(
        new Set([
          first.runtimeAuthorityToken,
          second.runtimeAuthorityToken,
          third.runtimeAuthorityToken,
          fourth.runtimeAuthorityToken
        ]).size,
        4
      )
      const history = yield* database.sql<{ readonly generation: number }>`SELECT generation
        FROM plugin_runtime_authority_generations ORDER BY generation`
      assert.deepStrictEqual(history, [
        { generation: 1 },
        { generation: 2 },
        { generation: 3 },
        { generation: 4 }
      ])
    })))

  it.effect("binds canonical configuration and rolls callback failure back", () =>
    withAuthority(Effect.gen(function*() {
      const authority = yield* PluginRuntimeAuthoritySource
      const configurations = yield* PluginConfigurationRepository
      const database = yield* Database
      const { runtimeRecord } = yield* setup
      const configuration = yield* configurations.update(
        WORKSPACE_ID,
        CONNECTION_ID,
        [{ _tag: "text", key: BASE_URL_KEY, value: "https://jira.example" }],
        0,
        T1
      )
      const wrongSnapshot = yield* authority.publish(
        absentInput(runtimeRecord.descriptorDigest)
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(wrongSnapshot))

      const input: PublishPluginRuntimeAuthority = {
        scope: { workspaceId: WORKSPACE_ID, pluginConnectionId: CONNECTION_ID },
        expected: {
          providerId: "jira",
          connectionRevision: 1,
          descriptorGeneration: runtimeRecord.descriptorGeneration,
          configuration: {
            _tag: "present",
            revision: configuration.revision,
            digest: PluginRuntimeSourceDigest.make(configuration.configurationDigest)
          },
          descriptorDigest: PluginRuntimeSourceDigest.make(runtimeRecord.descriptorDigest)
        },
        accountDigest: ACCOUNT_A,
        activatedAt: T1
      }
      const current = yield* authority.publish(input)
      const callbackFailure = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: current.runtimeAuthorityToken },
        () =>
          database.sql`UPDATE plugin_connections SET display_name = 'must roll back'`.pipe(
            Effect.andThen(Effect.fail("callback-failed"))
          )
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(callbackFailure))
      const names = yield* database.sql<{ readonly displayName: string }>`SELECT
        display_name AS displayName FROM plugin_connections`
      assert.deepStrictEqual(names, [{ displayName: "Payments Jira" }])

      const forgedToken = PluginRuntimeAuthorityToken.make(`sha256:${"f".repeat(64)}`)
      yield* database.sql`UPDATE plugin_runtime_authority_heads SET
        generation = 2,
        authority_digest = ${forgedToken}`
      const forged = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: forgedToken },
        Effect.succeed
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(forged))
      if (Result.isFailure(forged)) assert.instanceOf(forged.failure, PersistedRecordError)
    })))

  it.effect("rejects an obsolete runtime when descriptor bytes cycle back", () =>
    withAuthority(Effect.gen(function*() {
      const authority = yield* PluginRuntimeAuthoritySource
      const runtime = yield* PluginRuntimeRepository
      const { runtimeRecord } = yield* setup
      const original = absentInput(
        runtimeRecord.descriptorDigest,
        ACCOUNT_A,
        1,
        T1,
        runtimeRecord.descriptorGeneration
      )
      const first = yield* authority.publish(original)

      const changed = yield* runtime.acceptPluginDescriptor(
        WORKSPACE_ID,
        CONNECTION_ID,
        "jira",
        descriptor(1),
        runtimeRecord.revision,
        T2
      )
      const database = yield* Database
      const deletion = yield* database.sql`DELETE FROM plugin_runtime_state
        WHERE workspace_id = ${WORKSPACE_ID}
          AND plugin_connection_id = ${CONNECTION_ID}`.pipe(Effect.result)
      const recreation = yield* runtime.acceptPluginDescriptor(
        WORKSPACE_ID,
        CONNECTION_ID,
        "jira",
        descriptor(),
        0,
        T0
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(deletion))
      assert.isTrue(Result.isFailure(recreation))

      const cycled = yield* runtime.acceptPluginDescriptor(
        WORKSPACE_ID,
        CONNECTION_ID,
        "jira",
        descriptor(),
        changed.revision,
        T0
      )
      assert.strictEqual(cycled.descriptorDigest, runtimeRecord.descriptorDigest)
      assert.strictEqual(cycled.descriptorGeneration, 3)

      const callbackInvoked = yield* Ref.make(false)
      const obsolete = yield* authority.transactCurrent(
        { scope: original.scope, runtimeAuthorityToken: first.runtimeAuthorityToken },
        () => Ref.set(callbackInvoked, true)
      ).pipe(Effect.result)
      const stalePublication = yield* authority.publish(original).pipe(Effect.result)

      assert.isTrue(Result.isFailure(obsolete))
      assert.isTrue(Result.isFailure(stalePublication))
      assert.isFalse(yield* Ref.get(callbackInvoked))
    })))

  it.effect("revalidates authority after transactional intent and rolls self-invalidation back", () =>
    withAuthority(Effect.gen(function*() {
      const authority = yield* PluginRuntimeAuthoritySource
      const database = yield* Database
      const { runtimeRecord } = yield* setup
      const input = absentInput(
        runtimeRecord.descriptorDigest,
        ACCOUNT_A,
        1,
        T1,
        runtimeRecord.descriptorGeneration
      )
      const current = yield* authority.publish(input)
      yield* database.sql`CREATE TABLE runtime_authority_transaction_sentinel (
        value TEXT PRIMARY KEY
      )`

      yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: current.runtimeAuthorityToken },
        () => database.sql`INSERT INTO runtime_authority_transaction_sentinel (value) VALUES ('valid')`
      )
      const invalidated = yield* authority.transactCurrent(
        { scope: input.scope, runtimeAuthorityToken: current.runtimeAuthorityToken },
        () =>
          database.sql`UPDATE plugin_connections SET
            revision = revision + 1, updated_at = ${T2}`.pipe(
            Effect.andThen(
              database.sql`INSERT INTO runtime_authority_transaction_sentinel (value) VALUES ('rolled-back')`
            )
          )
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(invalidated))
      const connectionRows = yield* database.sql<{ readonly revision: number }>`SELECT revision
        FROM plugin_connections`
      const sentinelRows = yield* database.sql<{ readonly value: string }>`SELECT value
        FROM runtime_authority_transaction_sentinel ORDER BY value`
      assert.deepStrictEqual(connectionRows, [{ revision: 1 }])
      assert.deepStrictEqual(sentinelRows, [{ value: "valid" }])
    })))
})
