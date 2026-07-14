import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"

import { DomainEventId, EventCursor } from "../../src/domain/identifiers.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { SourceIdentityMismatchError } from "../../src/server/persistence/errors.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  type AppendDomainEventInput,
  DomainEventDedupeKey
} from "../../src/server/persistence/repositories/domainEventModels.js"
import { DomainEventRepository } from "../../src/server/persistence/repositories/domainEventRepository.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"
import { fixtureTimestamps, fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_A = fixtureWorkspaceIds.alpha
const WORKSPACE_B = fixtureWorkspaceIds.beta
const CREATED_AT = fixtureTimestamps.created

const eventId = (suffix: string) => Schema.decodeSync(DomainEventId)(`01890f6f-6d6a-7cc0-98d2-${suffix}`)

const makeEventInput = (
  suffix: string,
  dedupeKey: string,
  reason: AppendDomainEventInput["payload"]["reason"] = "release-projection"
): AppendDomainEventInput => ({
  dedupeKey: DomainEventDedupeKey.make(dedupeKey),
  schemaVersion: 1,
  eventId: eventId(suffix),
  eventType: "portfolio-invalidated",
  occurredAt: CREATED_AT,
  causationId: null,
  correlationId: null,
  metadata: {},
  payload: { reason }
})

const createWorkspaces = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  yield* workspaces.create(WORKSPACE_A, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: CREATED_AT
  })
  yield* workspaces.create(WORKSPACE_B, {
    displayName: WorkspaceName.make("Identity"),
    createdAt: CREATED_AT
  })
})

const withEventRepositories = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Database | DomainEventRepository | QuarantineRepository | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-domain-events-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const events = DomainEventRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(Effect.provide(Layer.mergeAll(foundation, events, workspaces)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("DomainEventRepository", () => {
  it.effect("assigns ordered workspace-local cursors and starts absent streams at zero", () =>
    withEventRepositories(
      Effect.gen(function*() {
        const events = yield* DomainEventRepository
        const absent = yield* events.streamState(WORKSPACE_A)
        assert.deepStrictEqual(absent, {
          headCursor: EventCursor.make(0),
          prunedThroughCursor: EventCursor.make(0)
        })

        yield* createWorkspaces
        const alphaOne = yield* events.append(
          WORKSPACE_A,
          makeEventInput("000000000101", "alpha:one")
        )
        const betaOne = yield* events.append(
          WORKSPACE_B,
          makeEventInput("000000000102", "beta:one")
        )
        const alphaTwo = yield* events.append(
          WORKSPACE_A,
          makeEventInput("000000000103", "alpha:two", "plugin-health")
        )

        assert.strictEqual(alphaOne.eventCursor, 1)
        assert.strictEqual(betaOne.eventCursor, 1)
        assert.strictEqual(alphaTwo.eventCursor, 2)

        const alphaPage = yield* events.pageAfter(WORKSPACE_A, EventCursor.make(0), 128)
        assert.strictEqual(alphaPage._tag, "page")
        if (alphaPage._tag === "page") {
          assert.deepStrictEqual(
            alphaPage.events.map(({ eventId: id }) => id),
            [alphaOne.eventId, alphaTwo.eventId]
          )
          assert.strictEqual(alphaPage.headCursor, 2)
          assert.strictEqual(alphaPage.nextCursor, 2)
          assert.strictEqual(alphaPage.prunedThroughCursor, 0)
        }

        const betaPage = yield* events.pageAfter(WORKSPACE_B, EventCursor.make(0), 128)
        assert.strictEqual(betaPage._tag, "page")
        if (betaPage._tag === "page") {
          assert.deepStrictEqual(betaPage.events.map(({ eventId: id }) => id), [betaOne.eventId])
          assert.strictEqual(betaPage.headCursor, 1)
          assert.strictEqual(betaPage.nextCursor, 1)
          assert.strictEqual(betaPage.prunedThroughCursor, 0)
        }
      })
    ))

  it.effect("rolls back event allocation through the public persistence transaction", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-domain-event-rollback-")
      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })

        const outcome = yield* persistence.transact(
          persistence.events.append(
            WORKSPACE_A,
            makeEventInput("000000000111", "rollback:one")
          ).pipe(Effect.andThen(Effect.fail("injected rollback")))
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(outcome))
        assert.strictEqual((yield* persistence.events.streamState(WORKSPACE_A)).headCursor, 0)

        const page = yield* persistence.events.pageAfter(WORKSPACE_A, EventCursor.make(0), 128)
        assert.strictEqual(page._tag, "page")
        if (page._tag === "page") assert.deepStrictEqual(page.events, [])
      }).pipe(Effect.provide(persistenceLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("deduplicates semantic retries and rejects conflicting or split identities", () =>
    withEventRepositories(
      Effect.gen(function*() {
        yield* createWorkspaces
        const events = yield* DomainEventRepository
        const firstInput = makeEventInput("000000000121", "identity:first")
        const secondInput = makeEventInput(
          "000000000122",
          "identity:second",
          "plugin-health"
        )
        const first = yield* events.append(WORKSPACE_A, firstInput)
        const second = yield* events.append(WORKSPACE_A, secondInput)

        const retry = yield* events.append(WORKSPACE_A, {
          ...firstInput,
          eventId: eventId("000000000123")
        })
        assert.strictEqual(retry.eventId, first.eventId)
        assert.strictEqual(retry.eventCursor, first.eventCursor)

        const semanticConflict = yield* events.append(WORKSPACE_A, {
          ...firstInput,
          eventId: eventId("000000000124"),
          payload: { reason: "plugin-health" }
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(semanticConflict))
        if (Result.isFailure(semanticConflict)) {
          assert.instanceOf(semanticConflict.failure, SourceIdentityMismatchError)
        }

        const splitIdentity = yield* events.append(WORKSPACE_A, {
          ...secondInput,
          eventId: first.eventId
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(splitIdentity))
        if (Result.isFailure(splitIdentity)) {
          assert.instanceOf(splitIdentity.failure, SourceIdentityMismatchError)
        }
        assert.strictEqual((yield* events.streamState(WORKSPACE_A)).headCursor, 2)
        assert.strictEqual(second.eventCursor, 2)
      })
    ))

  it.effect("reports retention, cursor-ahead, and missing-row replay resets", () =>
    withEventRepositories(
      Effect.gen(function*() {
        yield* createWorkspaces
        const database = yield* Database
        const events = yield* DomainEventRepository
        for (
          const input of [
            { suffix: "000000000131", dedupeKey: "retention:one" },
            { suffix: "000000000132", dedupeKey: "retention:two" },
            { suffix: "000000000133", dedupeKey: "retention:three" }
          ]
        ) {
          yield* events.append(
            WORKSPACE_A,
            makeEventInput(input.suffix, input.dedupeKey)
          )
        }

        const pruned = yield* events.prune(WORKSPACE_A, EventCursor.make(2), 500)
        assert.deepStrictEqual(pruned, {
          deletedCount: 2,
          prunedThroughCursor: EventCursor.make(2)
        })
        const retention = yield* events.pageAfter(WORKSPACE_A, EventCursor.make(0), 128)
        assert.strictEqual(retention._tag, "reset")
        if (retention._tag === "reset") assert.strictEqual(retention.reason, "retention")
        const retained = yield* events.pageAfter(WORKSPACE_A, EventCursor.make(2), 128)
        assert.strictEqual(retained._tag, "page")
        if (retained._tag === "page") assert.strictEqual(retained.events.length, 1)
        const ahead = yield* events.pageAfter(WORKSPACE_A, EventCursor.make(4), 128)
        assert.strictEqual(ahead._tag, "reset")
        if (ahead._tag === "reset") assert.strictEqual(ahead.reason, "cursor-ahead")

        for (
          const input of [
            { suffix: "000000000134", dedupeKey: "gap:one" },
            { suffix: "000000000135", dedupeKey: "gap:two" },
            { suffix: "000000000136", dedupeKey: "gap:three" }
          ]
        ) {
          yield* events.append(
            WORKSPACE_B,
            makeEventInput(input.suffix, input.dedupeKey)
          )
        }
        yield* database.sql`DELETE FROM domain_events
          WHERE workspace_id = ${WORKSPACE_B} AND event_cursor = 2`
        const gap = yield* events.pageAfter(WORKSPACE_B, EventCursor.make(0), 128)
        assert.strictEqual(gap._tag, "reset")
        if (gap._tag === "reset") assert.strictEqual(gap.reason, "gap")
      })
    ))

  it.effect("quarantines a corrupt retained row and returns a gap reset", () =>
    withEventRepositories(
      Effect.gen(function*() {
        yield* createWorkspaces
        const database = yield* Database
        const events = yield* DomainEventRepository
        const quarantine = yield* QuarantineRepository
        const stored = yield* events.append(
          WORKSPACE_A,
          makeEventInput("000000000141", "corrupt:one")
        )
        yield* database.sql`UPDATE domain_events
          SET payload_json = '{"reason":"plugin-health"}'
          WHERE workspace_id = ${WORKSPACE_A} AND event_cursor = 1`

        const replay = yield* events.pageAfter(WORKSPACE_A, EventCursor.make(0), 128)
        assert.strictEqual(replay._tag, "reset")
        if (replay._tag === "reset") assert.strictEqual(replay.reason, "gap")

        const quarantined = yield* quarantine.list(WORKSPACE_A)
        assert.strictEqual(quarantined.length, 1)
        assert.strictEqual(quarantined[0]?.recordKind, "domain-event")
        assert.strictEqual(quarantined[0]?.recordKey, stored.eventId)
        assert.strictEqual(
          quarantined[0]?.diagnosticCode,
          "domain-event-payload-digest-mismatch"
        )
      })
    ))
})
