import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { Person } from "../../src/domain/actors.js"
import { PluginHealth } from "../../src/domain/freshness.js"
import {
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makePortfolioSnapshots } from "../../src/server/application/portfolioSnapshots.js"
import {
  recoverFakeReleaseProjection,
  synchronizeFakeRelease,
  synchronizeFakeReleaseFromMap
} from "../../src/server/application/releaseSynchronization.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { makeFakePluginRuntime } from "../../src/server/plugins/fake/FakePluginDefinition.js"
import {
  type FakePluginResponse,
  type FakePluginScenario,
  fakeSyncScriptKey
} from "../../src/server/plugins/fake/FakePluginScenario.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap, type PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000101")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000102")
const CODECOMMIT_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000109")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000103")
const OTHER_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000110")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000104")
const OWNER_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000105")
const APPROVER_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000106")
const OWNER_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000107")
const APPROVER_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000108")
const STREAM = Schema.decodeSync(PluginStreamKey)("releases")
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-14T09:00:00.000Z")
const OBSERVED_AT = "2026-07-14T09:01:00.000Z"
const SYNCHRONIZED_AT = "2026-07-14T09:02:00.000Z"
const RECENT_FAILURE_AT = "2026-07-14T09:03:00.000Z"
const STALE_FAILURE_AT = "2026-07-14T09:12:00.000Z"

const epochMillis = (timestamp: string): number => DateTime.toEpochMillis(Schema.decodeSync(UtcTimestamp)(timestamp))

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.fake-jira",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Deterministic Jira",
  configurationFields: [],
  capabilities: [{
    capabilityId: "sync.incremental",
    supportedVersions: [1],
    requirement: "required"
  }]
}

const success = (value: unknown): FakePluginResponse => ({ _tag: "success", value })

const releasePage = (
  includeApprover = true,
  checkpointAfterPage = "checkpoint-1",
  serviceName = "payments-api",
  hasMore = false
) => ({
  checkpointAfterPage,
  hasMore,
  events: [
    {
      _tag: "UpsertEntity",
      eventId: "release-event-1",
      observedAt: OBSERVED_AT,
      revision: "release-r1",
      entityType: "release",
      vendorImmutableId: "provider-release-42",
      sourceUrl: "https://jira.example/releases/42",
      title: "Payments 2.18.0",
      attributes: {
        releaseId: RELEASE_ID,
        serviceName,
        version: "2.18.0-rc.1",
        lifecycle: "candidate",
        targetEnvironmentIds: [ENVIRONMENT_ID],
        staleAfterSeconds: 300,
        collaborators: [
          {
            personId: OWNER_ID,
            assignmentId: OWNER_ASSIGNMENT_ID,
            vendorPersonId: "person-ada",
            role: "release-owner"
          },
          {
            personId: APPROVER_ID,
            assignmentId: APPROVER_ASSIGNMENT_ID,
            vendorPersonId: "person-grace",
            role: "release-approver"
          }
        ]
      }
    },
    {
      _tag: "UpsertPerson",
      eventId: "person-event-1",
      observedAt: OBSERVED_AT,
      revision: "person-r1",
      vendorPersonId: "person-ada",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      active: true
    },
    ...(includeApprover
      ? [{
        _tag: "UpsertPerson",
        eventId: "person-event-2",
        observedAt: OBSERVED_AT,
        revision: "person-r1",
        vendorPersonId: "person-grace",
        displayName: "Grace Hopper",
        avatarUrl: null,
        active: true
      }]
      : [])
  ]
})

const scenarioResponses = (
  syncResponses: ReadonlyArray<FakePluginResponse>,
  checkedAt = SYNCHRONIZED_AT,
  checkpoint: string | null = null
): FakePluginScenario => ({
  descriptor,
  discover: { _tag: "outage" },
  health: success({ _tag: "healthy", checkedAt }),
  sync: { [fakeSyncScriptKey(STREAM, checkpoint)]: syncResponses },
  readEntity: { _tag: "outage" },
  proposeAction: { _tag: "outage" },
  preflight: { _tag: "outage" },
  executeAuthorizedAction: { _tag: "outage" },
  requestCancellation: { _tag: "outage" },
  reconcile: {}
})

const scenario = (
  syncResponse: FakePluginResponse,
  checkedAt = SYNCHRONIZED_AT,
  checkpoint: string | null = null
): FakePluginScenario => scenarioResponses([syncResponse], checkedAt, checkpoint)

const input = {
  workspaceId: WORKSPACE_ID,
  pluginConnectionId: PLUGIN_ID,
  streamKey: STREAM
} satisfies Parameters<typeof synchronizeFakeRelease>[0]

const withPersistence = <Success, Failure>(use: Effect.Effect<Success, Failure, Persistence>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-release-sync-")
    return yield* use.pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: CODECOMMIT_PLUGIN_ID,
    providerId: "codecommit",
    displayName: PluginConnectionDisplayName.make("Payments CodeCommit"),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    PLUGIN_ID,
    "jira",
    descriptor,
    0,
    T0
  )
  return persistence
})

const runScenario = Effect.fn("ReleaseSynchronizationTest.runScenario")(function*(fixture: FakePluginScenario) {
  const runtime = yield* makeFakePluginRuntime(fixture)
  return yield* synchronizeFakeRelease(input).pipe(Effect.provide(runtime.layer))
})

const runScenarioFromMap = Effect.fn("ReleaseSynchronizationTest.runScenarioFromMap")(function*(
  fixture: FakePluginScenario
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const runtime = yield* makeFakePluginRuntime(fixture)
    const runtimeContext = yield* Layer.build(runtime.layer)
    const connectionContext = Context.make(PluginConnection, Context.get(runtimeContext, PluginConnection))
    const pluginConnections = {
      contextEffect: () => Effect.succeed(connectionContext),
      invalidate: () => Effect.void
    } satisfies PluginConnectionMapV1
    return yield* synchronizeFakeReleaseFromMap(input).pipe(
      Effect.provideService(PluginConnectionMap, pluginConnections)
    )
  }))
})

describe("fake release synchronization", () => {
  it.effect("persists one atomic page and idempotently projects its people and release", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const first = yield* runScenario(scenario(success(releasePage())))
      assert.deepStrictEqual(first, {
        _tag: "synchronized",
        pagesCommitted: 1,
        releaseId: RELEASE_ID
      })

      const stream = yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-1\"")
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 3)

      const release = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
      assert.strictEqual(release.revision, 1)
      assert.strictEqual(release.release.freshness._tag, "current")
      assert.strictEqual(release.release.freshness.provenance._tag, "provider")
      assert.lengthOf(release.release.roleAssignments, 2)
      assert.strictEqual(
        (yield* persistence.people.getPerson(WORKSPACE_ID, OWNER_ID)).person.displayName,
        "Ada Lovelace"
      )

      const replay = yield* runScenario(
        scenario(success(releasePage(true, "checkpoint-2")), SYNCHRONIZED_AT, "checkpoint-1")
      )
      assert.strictEqual(replay._tag, "synchronized")
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 2)
      assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
      assert.strictEqual((yield* persistence.people.getPerson(WORKSPACE_ID, OWNER_ID)).revision, 1)

      const portfolio = yield* makePortfolioSnapshots
      const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)
      assert.lengthOf(snapshot.releases, 1)
      assert.deepStrictEqual(snapshot.releases[0]?.collaborators, [
        { personId: OWNER_ID, displayName: "Ada Lovelace", avatarFallback: "AL", role: "release-owner" },
        { personId: APPROVER_ID, displayName: "Grace Hopper", avatarFallback: "GH", role: "release-approver" }
      ])
    })))

  it.effect("accepts an at-least-once replay without malformed health or revision churn", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))

      const replay = yield* runScenario(
        scenario(success(releasePage()), SYNCHRONIZED_AT, "checkpoint-1")
      )

      assert.deepStrictEqual(replay, {
        _tag: "synchronized",
        pagesCommitted: 1,
        releaseId: RELEASE_ID
      })
      const stream = yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-1\"")
      assert.lengthOf(yield* persistence.pluginRuntime.listEvidence(WORKSPACE_ID, PLUGIN_ID, STREAM), 3)
      assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
      assert.strictEqual((yield* persistence.people.getPerson(WORKSPACE_ID, OWNER_ID)).revision, 1)
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(runtime.health._tag, "healthy")
      assert.strictEqual(runtime.consecutiveFailures, 0)
    })))

  it.effect("rejects a missing referenced collaborator before checkpoint, cache, or release advance", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const attempted = yield* runScenario(scenario(success(releasePage(false)))).pipe(Effect.result)
      assert.deepStrictEqual(attempted, Result.succeed({ _tag: "source-unavailable", releaseId: null }))
      const stream = yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stream))
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 0)
      assert.isTrue(Result.isFailure(
        yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID).pipe(Effect.result)
      ))
    })))

  it.effect("rejects malformed release attributes before checkpoint advance", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const attempted = yield* runScenario(
        scenario(success(releasePage(true, "checkpoint-1", " ")))
      ).pipe(Effect.result)
      assert.deepStrictEqual(attempted, Result.succeed({ _tag: "source-unavailable", releaseId: null }))
      assert.isTrue(Result.isFailure(
        yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      ))
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 0)
      assert.isTrue(Result.isFailure(
        yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID).pipe(Effect.result)
      ))
    })))

  it.effect("reloads the projected release through a newly acquired persistence service", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-release-reload-")
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* setup
          yield* runScenario(scenario(success(releasePage())))
        }).pipe(Effect.provide(persistenceLayer(config)))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* Persistence
          const release = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
          assert.strictEqual(release.release.serviceName, "payments-api")
          assert.strictEqual(release.release.freshness._tag, "current")
          const portfolio = yield* makePortfolioSnapshots
          const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)
          assert.strictEqual(snapshot.releases[0]?.releaseId, RELEASE_ID)
          assert.deepStrictEqual(
            snapshot.releases[0]?.collaborators.map(({ displayName, role }) => ({ displayName, role })),
            [
              { displayName: "Ada Lovelace", role: "release-owner" },
              { displayName: "Grace Hopper", role: "release-approver" }
            ]
          )
        }).pipe(Effect.provide(persistenceLayer(config)))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains an earlier committed page when a later provider page fails", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const outcome = yield* runScenario(scenarioResponses([
        success(releasePage(true, "checkpoint-1", "payments-api", true)),
        { _tag: "authentication" }
      ]))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 3)
      const release = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
      assert.strictEqual(release.release.freshness._tag, "current")
      assert.strictEqual(
        (yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)).health._tag,
        "unavailable"
      )
    })))

  it.effect("preserves recent cache on failure and marks it stale only after its threshold", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))

      yield* TestClock.setTime(epochMillis(RECENT_FAILURE_AT))
      const recent = yield* runScenario(scenario({ _tag: "authentication" }, RECENT_FAILURE_AT, "checkpoint-1"))
      assert.strictEqual(recent._tag, "source-unavailable")
      const preserved = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
      assert.strictEqual(preserved.revision, 1)
      assert.strictEqual(preserved.release.freshness._tag, "current")
      assert.strictEqual(
        (yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)).health._tag,
        "unavailable"
      )

      yield* TestClock.setTime(epochMillis(STALE_FAILURE_AT))
      const stale = yield* runScenario(scenario({ _tag: "authentication" }, STALE_FAILURE_AT, "checkpoint-1"))
      assert.strictEqual(stale._tag, "source-unavailable")
      const projected = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
      assert.strictEqual(projected.revision, 2)
      assert.strictEqual(projected.release.freshness._tag, "stale")
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 3)
    })))

  it.effect("merges a synchronized identity without erasing identities from other plugins", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      const existing = Schema.decodeSync(Person)({
        personId: OWNER_ID,
        displayName: "Ada Lovelace",
        avatar: { _tag: "initials", text: "AL" },
        isActive: true,
        sourceIdentities: [{
          pluginConnectionId: CODECOMMIT_PLUGIN_ID,
          providerId: "codecommit",
          vendorPersonId: VendorImmutableId.make("codecommit-user-ada")
        }]
      })
      yield* persistence.people.createPerson(WORKSPACE_ID, existing, T0)
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))

      const person = (yield* persistence.people.getPerson(WORKSPACE_ID, OWNER_ID)).person
      assert.deepStrictEqual(person.sourceIdentities, [
        {
          pluginConnectionId: CODECOMMIT_PLUGIN_ID,
          providerId: "codecommit",
          vendorPersonId: VendorImmutableId.make("codecommit-user-ada")
        },
        {
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorPersonId: VendorImmutableId.make("person-ada")
        }
      ])
    })))

  it.effect("requires a terminal page and keeps the committed prefix as last-valid cache", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const outcome = yield* runScenario(scenarioResponses([
        success(releasePage(true, "checkpoint-1", "payments-api", true))
      ]))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.strictEqual(
        (yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)).health._tag,
        "unavailable"
      )
    })))

  it.effect("rejects a source timestamp beyond the checked-at boundary before checkpoint advance", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const futurePage = releasePage()
      const attempted = yield* runScenario(scenario(success({
        ...futurePage,
        events: futurePage.events.map((event) => ({ ...event, observedAt: STALE_FAILURE_AT }))
      })))
      assert.deepStrictEqual(attempted, { _tag: "source-unavailable", releaseId: null })
      assert.isTrue(Result.isFailure(
        yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      ))
    })))

  it.effect("rejects a second release identity before committing its later page", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const nextRelease = releasePage(true, "checkpoint-2")
      const outcome = yield* runScenario(scenarioResponses([
        success(releasePage(true, "checkpoint-1", "payments-api", true)),
        success({
          ...nextRelease,
          events: nextRelease.events.map((event) =>
            event._tag === "UpsertEntity"
              ? {
                ...event,
                vendorImmutableId: "provider-release-43",
                attributes: { ...event.attributes, releaseId: OTHER_RELEASE_ID }
              }
              : event
          )
        })
      ]))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.isTrue(Result.isFailure(
        yield* persistence.releases.get(WORKSPACE_ID, OTHER_RELEASE_ID).pipe(Effect.result)
      ))
    })))

  it.effect("rejects any page emitted after a terminal page", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const outcome = yield* runScenario(scenarioResponses([
        success(releasePage()),
        success(releasePage(true, "checkpoint-2"))
      ]))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      const stream = yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-1\"")
    })))

  it.effect("rejects a release tombstone before checkpoint, cache, or projection advance", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))
      const tombstonePage = {
        checkpointAfterPage: "checkpoint-2",
        hasMore: false,
        events: [{
          _tag: "TombstoneEntity",
          eventId: "release-tombstone-1",
          observedAt: SYNCHRONIZED_AT,
          revision: "release-r2",
          entityType: "release",
          vendorImmutableId: "provider-release-42",
          reason: "Removed upstream"
        }]
      }
      const outcome = yield* runScenario(
        scenario(success(tombstonePage), SYNCHRONIZED_AT, "checkpoint-1")
      )

      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      const stream = yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)
      assert.strictEqual(stream.revision, 1)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-1\"")
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 3)
      assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
    })))

  it.effect("reconciles a crash-committed cache before an unavailable provider is called", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-release-crash-")
      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* setup
          const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
          const healthy = yield* Schema.decodeUnknownEffect(PluginHealth)({
            _tag: "healthy",
            checkedAt: SYNCHRONIZED_AT
          })
          yield* persistence.pluginRuntime.recordHealth(WORKSPACE_ID, PLUGIN_ID, runtime.revision, healthy, 0)
          const page = yield* Schema.decodeUnknownEffect(PluginSyncPageV1)(releasePage())
          yield* persistence.pluginRuntime.commitNormalizedPage(
            WORKSPACE_ID,
            PLUGIN_ID,
            "jira",
            STREAM,
            0,
            page,
            healthy.checkedAt,
            healthy
          )
          const afterHealthy = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
          const unavailable = yield* Schema.decodeUnknownEffect(PluginHealth)({
            _tag: "unavailable",
            checkedAt: RECENT_FAILURE_AT,
            failureClass: "outage",
            retryAt: null,
            safeMessage: "Provider is temporarily unavailable."
          })
          yield* persistence.pluginRuntime.recordHealth(
            WORKSPACE_ID,
            PLUGIN_ID,
            afterHealthy.revision,
            unavailable,
            1
          )
          assert.isTrue(Result.isFailure(
            yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID).pipe(Effect.result)
          ))
        }).pipe(Effect.provide(persistenceLayer(config)))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* Persistence
          assert.strictEqual(
            (yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)).health._tag,
            "unavailable"
          )
          yield* TestClock.setTime(epochMillis(STALE_FAILURE_AT))
          const recoveredId = yield* recoverFakeReleaseProjection(input)
          assert.strictEqual(recoveredId, RELEASE_ID)
          const recovered = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
          assert.strictEqual(recovered.revision, 1)
          assert.strictEqual(recovered.release.freshness._tag, "stale")
          assert.strictEqual(recovered.release.freshness.pluginHealth._tag, "healthy")
          assert.strictEqual(recovered.release.freshness.provenance._tag, "cache")

          const unavailableScenario = {
            ...scenario({ _tag: "authentication" }, STALE_FAILURE_AT, "checkpoint-1"),
            health: { _tag: "authentication" }
          } satisfies FakePluginScenario
          const outcome = yield* runScenarioFromMap(unavailableScenario)
          assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
          const release = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)
          assert.strictEqual(release.revision, 2)
          assert.strictEqual(release.release.freshness._tag, "stale")
          assert.strictEqual(release.release.freshness.pluginHealth._tag, "unavailable")
          assert.strictEqual(release.release.freshness.provenance._tag, "cache")
        }).pipe(Effect.provide(persistenceLayer(config)))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not churn release revisions during cache-first restart reconciliation", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-release-restart-")
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* setup
          yield* runScenario(scenario(success(releasePage())))
        }).pipe(Effect.provide(persistenceLayer(config)))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* Persistence
          const outcome = yield* runScenarioFromMap(
            scenario(success(releasePage(true, "checkpoint-2")), SYNCHRONIZED_AT, "checkpoint-1")
          )
          assert.deepStrictEqual(outcome, {
            _tag: "synchronized",
            pagesCommitted: 1,
            releaseId: RELEASE_ID
          })
          assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
        }).pipe(Effect.provide(persistenceLayer(config)))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("keeps the last-valid projection when a resumed provider page is malformed", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))

      const outcome = yield* runScenarioFromMap(
        scenario(success(releasePage(true, "checkpoint-2", " ")), SYNCHRONIZED_AT, "checkpoint-1")
      )
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(runtime.health._tag, "unavailable")
      if (runtime.health._tag === "unavailable") {
        assert.strictEqual(runtime.health.failureClass, "malformed-response")
      }
    })))

  it.effect("supports a release page followed by its people on the terminal page", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const complete = releasePage()
      const outcome = yield* runScenario(scenarioResponses([
        success({
          ...complete,
          checkpointAfterPage: "checkpoint-people-pending",
          hasMore: true,
          events: complete.events.filter(({ _tag }) => _tag === "UpsertEntity")
        }),
        success({
          checkpointAfterPage: "checkpoint-people-complete",
          hasMore: false,
          events: complete.events.filter(({ _tag }) => _tag === "UpsertPerson")
        })
      ]))
      assert.deepStrictEqual(outcome, {
        _tag: "synchronized",
        pagesCommitted: 2,
        releaseId: RELEASE_ID
      })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 2)
      assert.lengthOf((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).release.roleAssignments, 2)
    })))

  it.effect("keeps a pending release page when the provider fails before its people page", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const complete = releasePage()
      const outcome = yield* runScenario(scenarioResponses([
        success({
          ...complete,
          checkpointAfterPage: "checkpoint-people-pending",
          hasMore: true,
          events: complete.events.filter(({ _tag }) => _tag === "UpsertEntity")
        }),
        { _tag: "authentication" }
      ]))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: null })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 1)
      assert.isTrue(Result.isFailure(
        yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID).pipe(Effect.result)
      ))
    })))

  it.effect("rejects conflicting collaborator aliases within the initial page before commit", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const conflicting = releasePage()
      const outcome = yield* runScenario(scenario(success({
        ...conflicting,
        events: conflicting.events.map((event) => {
          if (event._tag !== "UpsertEntity" || event.attributes === undefined) return event
          return {
            ...event,
            attributes: {
              ...event.attributes,
              collaborators: event.attributes.collaborators.map((collaborator) =>
                collaborator.role === "release-approver"
                  ? { ...collaborator, vendorPersonId: "person-ada" }
                  : collaborator
              )
            }
          }
        })
      })))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: null })
      assert.isTrue(Result.isFailure(
        yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      ))
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 0)
    })))

  it.effect("rejects a collaborator identity already owned by another durable person before commit", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      const conflictingOwner = Schema.decodeSync(Person)({
        personId: OWNER_ID,
        displayName: "Ada Lovelace",
        avatar: { _tag: "initials", text: "AL" },
        isActive: true,
        sourceIdentities: [{
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorPersonId: "person-grace"
        }]
      })
      yield* persistence.people.createPerson(WORKSPACE_ID, conflictingOwner, T0)
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      const outcome = yield* runScenario(scenario(success(releasePage())))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: null })
      assert.isTrue(Result.isFailure(
        yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM).pipe(Effect.result)
      ))
      assert.lengthOf(yield* persistence.pluginRuntime.getCache(WORKSPACE_ID, PLUGIN_ID, STREAM), 0)
    })))

  it.effect("classifies a conflicting replay event as malformed source data and retains last-valid cache", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* setup
      yield* TestClock.setTime(epochMillis(SYNCHRONIZED_AT))
      yield* runScenario(scenario(success(releasePage())))
      const replay = releasePage(true, "checkpoint-2")
      const outcome = yield* runScenario(scenario(
        success({
          ...replay,
          events: replay.events.map((event) =>
            event._tag === "UpsertPerson" && event.vendorPersonId === "person-ada"
              ? { ...event, displayName: "Ada Byron" }
              : event
          )
        }),
        SYNCHRONIZED_AT,
        "checkpoint-1"
      ))
      assert.deepStrictEqual(outcome, { _tag: "source-unavailable", releaseId: RELEASE_ID })
      assert.strictEqual((yield* persistence.pluginRuntime.getStream(WORKSPACE_ID, PLUGIN_ID, STREAM)).revision, 1)
      assert.strictEqual((yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)).revision, 1)
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(runtime.health._tag, "unavailable")
      if (runtime.health._tag === "unavailable") {
        assert.strictEqual(runtime.health.failureClass, "malformed-response")
      }
    })))
})
