import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as TestClock from "effect/testing/TestClock"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import type { ProviderId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  makeManualPluginSyncDriverRegistry,
  makeManualPluginSynchronization
} from "../../src/server/application/manualPluginSynchronization.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"
import { PluginConnection, type PluginConnectionV1 } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000203")
const SYNCHRONIZED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-19T12:00:00.000Z")

const fixtures = [
  {
    providerId: "codecommit",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000204"),
    streamKey: "pull-requests",
    checkpoint: "codecommit-complete",
    entityType: "pull-request",
    vendorImmutableId: "17",
    title: "Guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/guard-refunds",
      targetBranch: "main",
      headRevision: "abc123",
      reviewState: "requested"
    }
  },
  {
    providerId: "codepipeline",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000205"),
    streamKey: "executions",
    checkpoint: "codepipeline-complete",
    entityType: "aws.codepipeline.execution",
    vendorImmutableId: "execution-42",
    title: "payments · execution-42",
    attributes: {
      pipelineName: "payments",
      executionId: "execution-42",
      status: "Succeeded",
      sourceRevisions: [{ revisionId: "abc123" }]
    }
  },
  {
    providerId: "clockify",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000206"),
    streamKey: "time-entries",
    checkpoint: "clockify-complete",
    entityType: "clockify.time-entry",
    vendorImmutableId: "time-entry-7",
    title: "Investigate PAY-42",
    attributes: {
      durationMinutes: 30,
      billable: true,
      approvalState: "pending"
    }
  }
] satisfies ReadonlyArray<{
  readonly providerId: ProviderId
  readonly pluginConnectionId: PluginConnectionId
  readonly streamKey: string
  readonly checkpoint: string
  readonly entityType: string
  readonly vendorImmutableId: string
  readonly title: string
  readonly attributes: Readonly<Record<string, unknown>>
}>

const descriptor = (providerId: ProviderId) => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: `dev.knpkv.${providerId}.fixture`,
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: `${providerId} fixture`,
  configurationFields: [],
  capabilities: [{ capabilityId: "sync.incremental", supportedVersions: [1], requirement: "required" }]
})

const pageFor = (fixture: typeof fixtures[number]) =>
  Schema.decodeSync(PluginSyncPageV1)({
    checkpointAfterPage: fixture.checkpoint,
    hasMore: false,
    events: [{
      _tag: "UpsertEntity",
      eventId: `${fixture.providerId}-entity-1`,
      observedAt: DateTime.formatIso(SYNCHRONIZED_AT),
      revision: "revision-1",
      entityType: fixture.entityType,
      vendorImmutableId: fixture.vendorImmutableId,
      sourceUrl: null,
      title: fixture.title,
      attributes: fixture.attributes
    }]
  })

const withApplication = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Persistence | DomainEventWakeups>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-manual-sync-")
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide([persistence, DomainEventWakeups.layer]))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("manual plugin synchronization", () => {
  it.effect("materializes each supported fixture connection once and exposes replay-safe attempt state", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const persistence = yield* Persistence
      yield* persistence.workspaces.create(WORKSPACE_ID, {
        displayName: WorkspaceName.make("Payments"),
        createdAt: SYNCHRONIZED_AT
      })
      for (const fixture of fixtures) {
        yield* persistence.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: fixture.pluginConnectionId,
          providerId: fixture.providerId,
          displayName: PluginConnectionDisplayName.make(`${fixture.providerId} fixture`),
          isEnabled: true,
          createdAt: SYNCHRONIZED_AT
        })
        yield* persistence.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          fixture.pluginConnectionId,
          fixture.providerId,
          descriptor(fixture.providerId),
          0,
          SYNCHRONIZED_AT
        )
      }

      const requests = yield* Ref.make<
        Array<{
          readonly providerId: ProviderId
          readonly checkpoint: string | null
        }>
      >([])
      const drivers = makeManualPluginSyncDriverRegistry(fixtures.map((fixture) => ({
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: (_connection, request) =>
          Stream.fromEffect(
            Ref.update(requests, (current) => [
              ...current,
              { providerId: fixture.providerId, checkpoint: request.checkpoint }
            ]).pipe(Effect.as(pageFor(fixture)))
          )
      })))
      const connectionsById = new Map<PluginConnectionId, PluginConnectionV1>()
      for (const fixture of fixtures) {
        const connection: PluginConnectionV1 = {
          descriptor: yield* negotiatePluginDescriptorV1(descriptor(fixture.providerId)),
          discover: Effect.die("not used"),
          health: Effect.succeed({ _tag: "healthy", checkedAt: SYNCHRONIZED_AT }),
          sync: () => Stream.die("driver owns synchronization"),
          readEntity: () => Effect.die("not used"),
          diff: Option.none(),
          proposeAction: () => Effect.die("not used")
        }
        connectionsById.set(fixture.pluginConnectionId, connection)
      }
      const connections: PluginConnectionMapV1 = {
        contextEffect: ({ pluginConnectionId }) => {
          const connection = connectionsById.get(pluginConnectionId)
          return connection === undefined
            ? Effect.die("fixture connection not found")
            : Effect.succeed(Context.make(PluginConnection, connection))
        },
        invalidate: () => Effect.void
      }
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      for (const fixture of fixtures) {
        const initial = yield* synchronization.state({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(initial.result, "never")
        const synchronized = yield* synchronization.synchronize({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(synchronized.result, "synchronized")
        assert.strictEqual(synchronized.pagesCommitted, 1)
        assert.isNotNull(synchronized.lastSuccessAt)
      }

      const itemRead = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "workspaceEntityProjections",
        owner: null,
        query: null,
        service: null,
        status: null,
        type: null,
        limit: 100
      })
      if (itemRead._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
      assert.deepStrictEqual(
        itemRead.value.items.map(({ projection }) => projection.entityType).sort(),
        ["pipeline-execution", "pull-request", "time-entry"]
      )
      const timelineBeforeReplay = (yield* persistence.timeline.page({
        workspaceId: WORKSPACE_ID,
        actorKind: "plugin",
        before: null,
        from: null,
        limit: 100,
        to: null
      })).filter(({ sourceKind }) => sourceKind === "plugin-sync")
      assert.deepStrictEqual(
        timelineBeforeReplay.map(({ service }) => service).sort(),
        ["clockify", "codecommit", "codepipeline"]
      )

      for (const fixture of fixtures) {
        const replay = yield* synchronization.synchronize({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(replay.result, "synchronized")
        assert.strictEqual(replay.pagesCommitted, 0)
      }
      const replayedItems = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "workspaceEntityProjections",
        owner: null,
        query: null,
        service: null,
        status: null,
        type: null,
        limit: 100
      })
      if (replayedItems._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
      assert.strictEqual(replayedItems.value.totalCount, 3)
      const timelineAfterReplay = (yield* persistence.timeline.page({
        workspaceId: WORKSPACE_ID,
        actorKind: "plugin",
        before: null,
        from: null,
        limit: 100,
        to: null
      })).filter(({ sourceKind }) => sourceKind === "plugin-sync")
      assert.lengthOf(timelineAfterReplay, timelineBeforeReplay.length)
      assert.deepStrictEqual(
        yield* Ref.get(requests),
        [
          ...fixtures.map((fixture) => ({ providerId: fixture.providerId, checkpoint: null })),
          ...fixtures.map((fixture) => ({
            providerId: fixture.providerId,
            checkpoint: fixture.checkpoint
          }))
        ]
      )
    })))
})
