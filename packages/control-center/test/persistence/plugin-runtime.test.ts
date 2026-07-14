import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"

import type { PluginHealth } from "../../src/domain/freshness.js"
import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginCheckpointV1, PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RevisionConflictError,
  SourceIdentityMismatchError
} from "../../src/server/persistence/errors.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { PluginRuntimeRepository } from "../../src/server/persistence/repositories/pluginRuntimeRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000021")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000022")
const STREAM = Schema.decodeSync(PluginStreamKey)("issues")
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-14T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-14T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-14T09:02:00.000Z")
const ENTITY_RECORD_KEY = "entity/9655c54eadf49f24afd0ad93c70a0077cd23499f5237317dbb36262b2fb4fac9"
const SECOND_ENTITY_RECORD_KEY = "entity/6171f60b066a720ed62184749325e4c1af68ad382222c97e34dc27f3913b413b"

const normalizedPayload = (
  title: string,
  eventId = "raw-event-1",
  revision = "1001",
  vendorImmutableId = "PAY-42"
): string =>
  JSON.stringify({
    _tag: "UpsertEntity",
    eventId,
    observedAt: "2026-07-14T09:00:30.000Z",
    revision,
    entityType: "issue",
    vendorImmutableId,
    sourceUrl: null,
    title,
    attributes: {}
  })

const tombstonePayload = JSON.stringify({
  _tag: "TombstoneEntity",
  eventId: "raw-event-2",
  observedAt: "2026-07-14T09:01:30.000Z",
  revision: "1002",
  entityType: "issue",
  vendorImmutableId: "PAY-42",
  reason: "Deleted upstream"
})

const descriptor = (capabilities: ReadonlyArray<unknown>, contractMajor = 1): unknown => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: contractMajor, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: "Jira",
  configurationFields: [],
  capabilities
})

const supportedSync = {
  capabilityId: "sync.incremental",
  supportedVersions: [1],
  requirement: "required"
}

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-plugin-runtime-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withRuntime = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Database | PluginConnectionRepository | PluginRuntimeRepository | QuarantineRepository | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const connections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const runtime = PluginRuntimeRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(Effect.provide(Layer.mergeAll(foundation, connections, runtime, workspaces)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  const connections = yield* PluginConnectionRepository
  const runtime = yield* PluginRuntimeRepository
  yield* workspaces.create(WORKSPACE_ID, { displayName: WorkspaceName.make("Payments"), createdAt: T0 })
  yield* connections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  return yield* runtime.acceptPluginDescriptor(
    WORKSPACE_ID,
    PLUGIN_ID,
    "jira",
    descriptor([supportedSync]),
    0,
    T0
  )
})

const upsertPage = {
  providerId: "jira",
  streamKey: "issues",
  pageId: "page-1",
  expectedRevision: 0,
  checkpointJson: "{\"cursor\":\"one\"}",
  committedAt: "2026-07-14T09:01:00.000Z",
  events: [{
    _tag: "upsert",
    eventId: "raw-event-1",
    eventJson: normalizedPayload("Ship payments"),
    recordKey: ENTITY_RECORD_KEY,
    sourceRevision: "1001",
    observedAt: "2026-07-14T09:00:30.000Z",
    payloadJson: normalizedPayload("Ship payments")
  }]
}

describe("plugin runtime persistence", () => {
  it.effect("accepts a last-valid descriptor, records health, and redacts malformed candidates", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      const quarantine = yield* QuarantineRepository
      const accepted = yield* setup
      assert.include(accepted.descriptorJson, "dev.knpkv.jira")
      assert.include(accepted.descriptorJson, "sync.incremental")
      assert.strictEqual(accepted.health._tag, "healthy")

      const unavailable: PluginHealth = {
        _tag: "unavailable",
        checkedAt: T1,
        failureClass: "outage",
        retryAt: T2,
        safeMessage: "Provider is temporarily unavailable."
      }
      const updated = yield* runtime.recordHealth(WORKSPACE_ID, PLUGIN_ID, 1, unavailable, 2)
      assert.strictEqual(updated.health._tag, "unavailable")
      assert.strictEqual(updated.consecutiveFailures, 2)

      const secretCanary = "do-not-persist-this-secret"
      const malformed = yield* runtime.acceptPluginDescriptor(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        { contractId: "dev.knpkv.control-center.plugin", descriptorJson: secretCanary },
        2,
        T2
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(malformed))
      if (Result.isFailure(malformed)) assert.instanceOf(malformed.failure, PersistedRecordError)
      const records = yield* quarantine.list(WORKSPACE_ID)
      assert.lengthOf(records, 1)
      assert.strictEqual(records[0]?.recordKind, "plugin-descriptor")
      assert.notInclude(JSON.stringify(records), secretCanary)
      assert.strictEqual(
        (yield* runtime.getRuntime(WORKSPACE_ID, PLUGIN_ID)).descriptorDigest,
        accepted.descriptorDigest
      )
    })))

  it.effect("quarantines negotiation failures and provider mismatch without replacing last valid", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      const quarantine = yield* QuarantineRepository
      const accepted = yield* setup
      const unknownMajor = descriptor([supportedSync], 2)
      const attempts = [
        runtime.acceptPluginDescriptor(WORKSPACE_ID, PLUGIN_ID, "jira", unknownMajor, 1, T1),
        runtime.acceptPluginDescriptor(WORKSPACE_ID, PLUGIN_ID, "jira", unknownMajor, 1, T2),
        runtime.acceptPluginDescriptor(
          WORKSPACE_ID,
          PLUGIN_ID,
          "jira",
          descriptor([{
            capabilityId: "sync.incremental",
            supportedVersions: "invalid",
            requirement: "required"
          }]),
          1,
          T2
        ),
        runtime.acceptPluginDescriptor(
          WORKSPACE_ID,
          PLUGIN_ID,
          "jira",
          descriptor([{
            capabilityId: "sync.incremental",
            supportedVersions: [2],
            requirement: "required"
          }]),
          1,
          T2
        ),
        runtime.acceptPluginDescriptor(WORKSPACE_ID, PLUGIN_ID, "codecommit", descriptor([supportedSync]), 1, T2)
      ]
      const outcomes = yield* Effect.forEach(attempts, (attempt) => attempt.pipe(Effect.result))
      assert.isTrue(outcomes.every(Result.isFailure))

      const records = yield* quarantine.list(WORKSPACE_ID)
      const unknown = records.find(({ diagnosticCode }) => diagnosticCode === "plugin-contract-major-unsupported")
      assert.strictEqual(unknown?.occurrenceCount, 2)
      assert.isDefined(records.find(({ diagnosticCode }) => diagnosticCode === "plugin-descriptor-schema-invalid"))
      assert.isDefined(
        records.find(({ diagnosticCode }) => diagnosticCode === "plugin-required-capability-unsupported")
      )
      assert.isDefined(records.find(({ diagnosticCode }) => diagnosticCode === "plugin-descriptor-provider-mismatch"))
      const retained = yield* runtime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(retained.descriptorDigest, accepted.descriptorDigest)
      assert.strictEqual(retained.revision, accepted.revision)
    })))

  it.effect("commits pages atomically, is idempotent, and retains payloads through tombstones", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      yield* setup

      const first = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, upsertPage)
      assert.strictEqual(first.revision, 1)
      const replay = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, upsertPage)
      assert.strictEqual(replay.revision, 1)
      const laterReplay = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        committedAt: "2026-07-14T09:02:00.000Z"
      })
      assert.strictEqual(laterReplay.revision, 1)
      const database = yield* Database
      const committed = yield* database.sql<{ readonly committedAt: string }>`SELECT committed_at AS committedAt
        FROM plugin_sync_pages WHERE page_id = 'page-1'`
      assert.strictEqual(committed[0]?.committedAt, "2026-07-14T09:01:00.000Z")

      const changedReplay = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        checkpointJson: "{\"cursor\":\"changed\"}"
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changedReplay))
      if (Result.isFailure(changedReplay)) assert.instanceOf(changedReplay.failure, SourceIdentityMismatchError)

      const tombstoned = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        providerId: "jira",
        streamKey: "issues",
        pageId: "page-2",
        expectedRevision: 1,
        checkpointJson: "{\"cursor\":\"two\"}",
        committedAt: "2026-07-14T09:02:00.000Z",
        events: [{
          _tag: "tombstone",
          eventId: "raw-event-2",
          eventJson: tombstonePayload,
          recordKey: ENTITY_RECORD_KEY,
          sourceRevision: "1002",
          observedAt: "2026-07-14T09:01:30.000Z"
        }]
      })
      assert.strictEqual(tombstoned.revision, 2)
      const cache = yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.lengthOf(cache, 1)
      assert.strictEqual(cache[0]?.state, "tombstoned")
      assert.strictEqual(cache[0]?.payloadJson, normalizedPayload("Ship payments"))
      const evidence = yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.deepStrictEqual(evidence.map(({ eventKind }) => eventKind), ["upsert", "tombstone"])
      assert.strictEqual(evidence[0]?.payloadJson, normalizedPayload("Ship payments"))
      assert.strictEqual(evidence[1]?.payloadJson, tombstonePayload)

      const fork = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        pageId: "fork",
        expectedRevision: 1
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(fork))
      if (Result.isFailure(fork)) assert.instanceOf(fork.failure, RevisionConflictError)
    })))

  it.effect("ingests all five public normalized event kinds through the atomic commit", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      yield* setup
      const reference = { entityType: "issue", vendorImmutableId: "PAY-42" }
      const page = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "checkpoint-1",
        hasMore: false,
        events: [
          {
            _tag: "UpsertEntity",
            eventId: "event-1",
            observedAt: "2026-07-14T09:01:00.000Z",
            ...reference,
            revision: "1001",
            sourceUrl: null,
            title: "Ship payments",
            attributes: { priority: "high" }
          },
          {
            _tag: "TombstoneEntity",
            eventId: "event-2",
            observedAt: "2026-07-14T09:01:01.000Z",
            entityType: "issue",
            vendorImmutableId: "PAY-OLD",
            revision: "deleted-1",
            reason: "Deleted upstream"
          },
          {
            _tag: "AppendEvidence",
            eventId: "event-3",
            observedAt: "2026-07-14T09:01:02.000Z",
            evidenceId: "evidence-1",
            revision: "evidence-r1",
            subject: reference,
            evidenceType: "review",
            summary: "Reviewed by agent",
            capturedAt: "2026-07-14T09:01:02.000Z",
            data: { approved: true }
          },
          {
            _tag: "UpsertPerson",
            eventId: "event-4",
            observedAt: "2026-07-14T09:01:03.000Z",
            vendorPersonId: "account-ada",
            revision: "person-r1",
            displayName: "Ada Lovelace",
            avatarUrl: null,
            active: true
          },
          {
            _tag: "ProposeRelationship",
            eventId: "event-5",
            observedAt: "2026-07-14T09:01:04.000Z",
            relationshipId: "relationship-1",
            revision: "relationship-r1",
            from: reference,
            to: { entityType: "pull-request", vendorImmutableId: "PR-7" },
            relationshipType: "implements",
            confidence: 0.95,
            evidenceIds: ["evidence-1"]
          }
        ]
      })

      const stream = yield* runtime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        STREAM,
        0,
        page,
        T1
      )
      const cache = yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM)
      const evidence = yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-1\"")
      assert.lengthOf(stream.lastPageId ?? "", 64)
      assert.lengthOf(cache, 5)
      assert.lengthOf(evidence, 5)
      assert.deepStrictEqual(
        cache.map(({ state }) => state).sort(),
        ["present", "present", "present", "present", "tombstoned"]
      )

      const firstEvent = page.events[0]
      if (firstEvent === undefined) return yield* Effect.die("expected first normalized event")
      const replayPage = {
        ...page,
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("checkpoint-2"),
        events: [firstEvent]
      }
      const replayed = yield* runtime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        STREAM,
        1,
        replayPage,
        T2
      )
      assert.strictEqual(replayed.revision, 2)
      assert.lengthOf(yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM), 5)

      if (firstEvent?._tag !== "UpsertEntity") return yield* Effect.die("expected upsert fixture")
      const changedReplay = yield* runtime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        STREAM,
        2,
        {
          ...replayPage,
          events: [{ ...firstEvent, attributes: { priority: "low" } }]
        },
        T2
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changedReplay))
      if (Result.isFailure(changedReplay)) {
        assert.instanceOf(changedReplay.failure, SourceIdentityMismatchError)
      }
      const quarantined = yield* QuarantineRepository
      assert.isDefined(
        (yield* quarantined.list(WORKSPACE_ID)).find(({ recordKind }) => recordKind === "plugin-sync-page")
      )
    })))

  it.effect("rolls back evidence, cache, and checkpoint together on a write failure", () =>
    withRuntime(Effect.gen(function*() {
      const database = yield* Database
      const runtime = yield* PluginRuntimeRepository
      yield* setup
      yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, upsertPage)
      yield* database.sql`CREATE TRIGGER fail_plugin_evidence BEFORE INSERT ON plugin_sync_evidence
        WHEN NEW.page_id = 'page-fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`

      const failed = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        pageId: "page-fail",
        expectedRevision: 1,
        checkpointJson: "{\"cursor\":\"must-not-commit\"}",
        committedAt: "2026-07-14T09:03:00.000Z",
        events: [{
          ...upsertPage.events[0],
          eventId: "raw-event-fail",
          eventJson: normalizedPayload("Changed", "raw-event-fail", "1002"),
          sourceRevision: "1002",
          payloadJson: normalizedPayload("Changed", "raw-event-fail", "1002")
        }]
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(failed))

      const stream = yield* runtime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)
      const cache = yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM)
      const pages = yield* database.sql<{ readonly count: number }>`SELECT count(*) AS count FROM plugin_sync_pages`
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "{\"cursor\":\"one\"}")
      assert.strictEqual(cache[0]?.payloadJson, normalizedPayload("Ship payments"))
      assert.strictEqual(pages[0]?.count, 1)
    })))

  it.effect("rejects and quarantines a malformed whole page without advancing its stream", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      const quarantine = yield* QuarantineRepository
      yield* setup
      const malformed = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        events: [upsertPage.events[0], upsertPage.events[0]]
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(malformed))
      if (Result.isFailure(malformed)) assert.instanceOf(malformed.failure, PersistedRecordError)
      const streams = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* database.sql<{ readonly count: number }>`SELECT count(*) AS count FROM plugin_sync_streams`
      })
      assert.strictEqual(streams[0]?.count, 0)
      assert.strictEqual((yield* quarantine.list(WORKSPACE_ID))[0]?.recordKind, "plugin-sync-page")
    })))

  it.effect("accepts sequential changes to one record and rejects oversized pages", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      yield* setup
      const sequential = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        events: [
          upsertPage.events[0],
          {
            _tag: "tombstone",
            eventId: "raw-event-2",
            eventJson: tombstonePayload,
            recordKey: ENTITY_RECORD_KEY,
            sourceRevision: "1002",
            observedAt: "2026-07-14T09:01:30.000Z"
          }
        ]
      })
      assert.strictEqual(sequential.revision, 1)
      assert.strictEqual((yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM))[0]?.state, "tombstoned")
      assert.lengthOf(yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM), 2)

      const oversized = yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        pageId: "oversized",
        expectedRevision: 1,
        events: Array.from({ length: 501 }, (_, index) => ({
          ...upsertPage.events[0],
          eventId: `oversized-${index}`,
          recordKey: `record-${index}`
        }))
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(oversized))
      assert.strictEqual((yield* runtime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
    })))

  it.effect("uses CAS for descriptor and health mutations", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      const accepted = yield* setup
      const staleDescriptor = yield* runtime.acceptPluginDescriptor(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        descriptor([supportedSync]),
        0,
        T1
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(staleDescriptor))
      if (Result.isFailure(staleDescriptor)) assert.instanceOf(staleDescriptor.failure, RevisionConflictError)

      const health: PluginHealth = { _tag: "healthy", checkedAt: T1 }
      const updated = yield* runtime.recordHealth(WORKSPACE_ID, PLUGIN_ID, accepted.revision, health, 0)
      assert.strictEqual(updated.revision, 2)
      const staleHealth = yield* runtime.recordHealth(WORKSPACE_ID, PLUGIN_ID, accepted.revision, health, 0).pipe(
        Effect.result
      )
      assert.isTrue(Result.isFailure(staleHealth))
      if (Result.isFailure(staleHealth)) assert.instanceOf(staleHealth.failure, RevisionConflictError)
    })))

  it.effect("lists immutable evidence in stream revision order rather than page-id order", () =>
    withRuntime(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeRepository
      yield* setup
      yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, { ...upsertPage, pageId: "z-page" })
      const secondPayload = normalizedPayload("Second", "order-event-2", "1002", "PAY-43")
      yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, {
        ...upsertPage,
        pageId: "a-page",
        expectedRevision: 1,
        checkpointJson: "{\"cursor\":\"two\"}",
        events: [{
          ...upsertPage.events[0],
          eventId: "order-event-2",
          eventJson: secondPayload,
          recordKey: SECOND_ENTITY_RECORD_KEY,
          sourceRevision: "1002",
          payloadJson: secondPayload
        }]
      })
      const evidence = yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.deepStrictEqual(evidence.map(({ pageId }) => pageId), ["z-page", "a-page"])
      assert.deepStrictEqual(evidence.map(({ eventId }) => eventId), ["raw-event-1", "order-event-2"])
    })))

  it.effect("quarantines corrupted descriptor and cache JSON without trusting it", () =>
    withRuntime(Effect.gen(function*() {
      const database = yield* Database
      const runtime = yield* PluginRuntimeRepository
      const quarantine = yield* QuarantineRepository
      yield* setup
      yield* database.sql`UPDATE plugin_runtime_state SET descriptor_json = '{}'`
      const corruptDescriptor = yield* runtime.getRuntime(WORKSPACE_ID, PLUGIN_ID).pipe(Effect.result)
      assert.isTrue(Result.isFailure(corruptDescriptor))
      if (Result.isFailure(corruptDescriptor)) assert.instanceOf(corruptDescriptor.failure, PersistedRecordError)

      yield* database.sql`UPDATE plugin_runtime_state SET descriptor_json = (
        SELECT descriptor_json FROM plugin_runtime_state
      )`
      yield* database.sql`DELETE FROM plugin_runtime_state`
      yield* runtime.acceptPluginDescriptor(WORKSPACE_ID, PLUGIN_ID, "jira", descriptor([supportedSync]), 0, T0)
      yield* runtime.commitPage(WORKSPACE_ID, PLUGIN_ID, upsertPage)
      yield* database.sql`UPDATE plugin_cache_entries SET record_key = 'WRONG-KEY'`
      const corruptCacheIdentity = yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      assert.isTrue(Result.isFailure(corruptCacheIdentity))
      if (Result.isFailure(corruptCacheIdentity)) {
        assert.instanceOf(corruptCacheIdentity.failure, PersistedRecordError)
      }
      yield* database.sql`UPDATE plugin_cache_entries SET record_key = ${ENTITY_RECORD_KEY}`
      yield* database.sql`UPDATE plugin_cache_entries SET payload_json = '{}'`
      const corruptCache = yield* runtime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      assert.isTrue(Result.isFailure(corruptCache))
      if (Result.isFailure(corruptCache)) assert.instanceOf(corruptCache.failure, PersistedRecordError)
      yield* database.sql`UPDATE plugin_sync_evidence SET observed_at = '2026-07-14T09:59:00.000Z'`
      const corruptEvidence = yield* runtime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      assert.isTrue(Result.isFailure(corruptEvidence))
      if (Result.isFailure(corruptEvidence)) assert.instanceOf(corruptEvidence.failure, PersistedRecordError)
      yield* database.sql`UPDATE plugin_sync_streams SET checkpoint_json = '{"tampered":true}'`
      const corruptCheckpoint = yield* runtime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      assert.isTrue(Result.isFailure(corruptCheckpoint))
      if (Result.isFailure(corruptCheckpoint)) assert.instanceOf(corruptCheckpoint.failure, PersistedRecordError)
      assert.isAtLeast((yield* quarantine.list(WORKSPACE_ID)).length, 5)
    })))
})
