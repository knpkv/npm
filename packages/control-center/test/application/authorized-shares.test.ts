import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Ref, Result, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { Actor, Person } from "../../src/domain/actors.js"
import { AuthorizedShareGrant } from "../../src/domain/authorizedShare.js"
import { DeliveryEntityProjection } from "../../src/domain/deliveryGraph.js"
import {
  EntityId,
  PersonId,
  PluginConnectionId,
  SessionId,
  ShareId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { SourceRevision } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { ApplicationResourceNotFound } from "../../src/server/api/ApplicationServices.js"
import { makeAuthorizedShares } from "../../src/server/application/authorizedShares.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  DeliveryGraphQuery,
  DeliveryGraphReadResult
} from "../../src/server/persistence/repositories/delivery-graph/contract.js"
import { EntityRecord, PersonRecord, RecordRevision } from "../../src/server/persistence/repositories/models.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000101")
const entityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-000000000102")
const granteePersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000103")
const otherPersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000104")
const creatorPersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000105")
const sessionId = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000106")
const shareId = Schema.decodeSync(ShareId)("01890f6f-6d6a-7cc0-98d2-000000000107")
const pluginConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000108")
const now = Schema.decodeSync(UtcTimestamp)("2026-07-17T10:00:00.000Z")
const future = Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")
const past = Schema.decodeSync(UtcTimestamp)("2026-07-16T10:00:00.000Z")
const earlier = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")

const sourceRevision = Schema.decodeSync(SourceRevision)({
  pluginConnectionId,
  providerId: "jira",
  vendorImmutableId: "PAY-42",
  revision: "1001",
  normalizationSchemaVersion: 1,
  sourceUrl: "https://jira.example/browse/PAY-42",
  firstObservedAt: "2026-07-17T09:00:00.000Z",
  lastObservedAt: "2026-07-17T09:01:00.000Z",
  synchronizedAt: "2026-07-17T09:02:00.000Z"
})

const entity = EntityRecord.make({
  workspaceId,
  entityId,
  entityType: "issue",
  sourceRevision,
  revision: RecordRevision.make(1),
  createdAt: now,
  updatedAt: now
})

const grantee = PersonRecord.make({
  workspaceId,
  person: Person.make({
    personId: granteePersonId,
    displayName: "Avery Bell",
    avatar: { _tag: "initials", text: "AB" },
    isActive: true,
    sourceIdentities: []
  }),
  revision: RecordRevision.make(1),
  createdAt: now,
  updatedAt: now
})

const projection = Schema.decodeSync(DeliveryEntityProjection)({
  workspaceId,
  entityId,
  projectionRevision: 1,
  sourceEntityRevision: 1,
  supersedesProjectionRevision: null,
  projectionSchemaVersion: 1,
  entityState: "present",
  entityType: "issue",
  displayKey: "PAY-42",
  title: "Ship guarded refunds",
  details: {
    _tag: "issue",
    key: "PAY-42",
    status: "Ready for review",
    priority: "High",
    estimatePoints: 5
  }
})

const grant = (input?: {
  readonly createdAt?: typeof UtcTimestamp.Type
  readonly expiresAt?: typeof UtcTimestamp.Type
  readonly revokedAt?: typeof UtcTimestamp.Type | null
}) =>
  AuthorizedShareGrant.make({
    workspaceId,
    shareId,
    target: { _tag: "entity", entityId },
    granteePersonId,
    createdByPersonId: creatorPersonId,
    createdBySessionId: sessionId,
    createdAt: input?.createdAt ?? now,
    expiresAt: input?.expiresAt ?? future,
    revokedAt: input?.revokedAt ?? null
  })

const withPersistence = <Success, Failure>(use: Effect.Effect<Success, Failure, Persistence>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-authorized-shares-")
    return yield* use.pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const makeTestService = Effect.fn("AuthorizedSharesTest.makeService")(function*(input?: {
  readonly grant?: AuthorizedShareGrant
  readonly granteeIsActive?: boolean
  readonly entityState?: "present" | "deleted"
}) {
  const persistence = yield* Persistence
  const targetReads = yield* Ref.make(0)
  const selectedGrant = input?.grant ?? grant()
  const selectedProjection = DeliveryEntityProjection.make({
    ...projection,
    entityState: input?.entityState ?? "present"
  })
  const selectedGrantee = PersonRecord.make({
    ...grantee,
    person: Person.make({ ...grantee.person, isActive: input?.granteeIsActive ?? true })
  })
  const fakePersistence = Persistence.of({
    ...persistence,
    authorizedShares: {
      create: () => Effect.succeed(selectedGrant),
      get: () => Effect.succeed(selectedGrant),
      revoke: () => Effect.succeed(AuthorizedShareGrant.make({ ...selectedGrant, revokedAt: now }))
    },
    deliveryGraph: {
      ...persistence.deliveryGraph,
      read: (_requestedWorkspaceId, query) => {
        const decodedQuery = Schema.decodeUnknownSync(DeliveryGraphQuery)(query)
        if (decodedQuery._tag !== "entityProjection") {
          return Effect.die("share resolution requested adjacent graph data")
        }
        return Ref.update(targetReads, (count) => count + 1).pipe(
          Effect.as(DeliveryGraphReadResult.make({
            _tag: "entityProjection",
            value: { projection: selectedProjection, recordedAt: now }
          }))
        )
      }
    },
    entities: {
      ...persistence.entities,
      get: () => Ref.update(targetReads, (count) => count + 1).pipe(Effect.as(entity))
    },
    people: {
      ...persistence.people,
      getPerson: () => Effect.succeed(selectedGrantee)
    }
  })
  const service = yield* makeAuthorizedShares.pipe(Effect.provideService(Persistence, fakePersistence))
  return { service, targetReads }
})

describe("authorized shares", () => {
  it.effect("resolves only the exact current projection for the named grantee", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const { service, targetReads } = yield* makeTestService()

      const resolved = yield* service.resolve({
        workspaceId,
        shareId,
        actor: { _tag: "human", personId: granteePersonId }
      })

      assert.strictEqual(resolved.item.projection.entityId, entityId)
      assert.strictEqual(resolved.item.projection.title, "Ship guarded refunds")
      assert.strictEqual(yield* Ref.get(targetReads), 2)
    })))

  it.effect("denies mismatch, expiry, and revocation before reading target state", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const scenarios = [
        {
          actor: Actor.make({ _tag: "human", personId: otherPersonId }),
          selectedGrant: grant()
        },
        {
          actor: Actor.make({ _tag: "human", personId: granteePersonId }),
          selectedGrant: grant({ createdAt: earlier, expiresAt: past })
        },
        {
          actor: Actor.make({ _tag: "human", personId: granteePersonId }),
          selectedGrant: grant({ revokedAt: now })
        }
      ]

      for (const scenario of scenarios) {
        const { service, targetReads } = yield* makeTestService({ grant: scenario.selectedGrant })
        const attempted = yield* service.resolve({ workspaceId, shareId, actor: scenario.actor }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(attempted))
        if (Result.isFailure(attempted)) assert.instanceOf(attempted.failure, ApplicationResourceNotFound)
        assert.strictEqual(yield* Ref.get(targetReads), 0)
      }
    })))

  it.effect("denies a deactivated grantee before reading target state", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const { service, targetReads } = yield* makeTestService({ granteeIsActive: false })

      const attempted = yield* service.resolve({
        workspaceId,
        shareId,
        actor: { _tag: "human", personId: granteePersonId }
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(attempted))
      if (Result.isFailure(attempted)) assert.instanceOf(attempted.failure, ApplicationResourceNotFound)
      assert.strictEqual(yield* Ref.get(targetReads), 0)
    })))

  it.effect("rejects a deleted current target after authenticating the grantee", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const { service, targetReads } = yield* makeTestService({ entityState: "deleted" })

      const attempted = yield* service.resolve({
        workspaceId,
        shareId,
        actor: { _tag: "human", personId: granteePersonId }
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(attempted))
      if (Result.isFailure(attempted)) assert.instanceOf(attempted.failure, ApplicationResourceNotFound)
      assert.strictEqual(yield* Ref.get(targetReads), 2)
    })))

  it.effect("creates and revokes with explicit owner, grantee, expiry, and target scope", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const persistence = yield* Persistence
      const createdInput = yield* Ref.make<unknown>(null)
      const revokedInput = yield* Ref.make<unknown>(null)
      const fakePersistence = Persistence.of({
        ...persistence,
        authorizedShares: {
          create: (input) => Ref.set(createdInput, input).pipe(Effect.as(grant())),
          get: () => Effect.succeed(grant()),
          revoke: (input) =>
            Ref.set(revokedInput, input).pipe(
              Effect.as(AuthorizedShareGrant.make({ ...grant(), revokedAt: now }))
            )
        },
        deliveryGraph: {
          ...persistence.deliveryGraph,
          read: () =>
            Effect.succeed({
              _tag: "entityProjection",
              value: { projection, recordedAt: now }
            })
        },
        entities: { ...persistence.entities, get: () => Effect.succeed(entity) },
        people: { ...persistence.people, getPerson: () => Effect.succeed(grantee) }
      })
      const service = yield* makeAuthorizedShares.pipe(Effect.provideService(Persistence, fakePersistence))

      const created = yield* service.create({
        workspaceId,
        request: { shareId, entityId, granteePersonId, expiresAt: future },
        createdByPersonId: creatorPersonId,
        sessionId
      })
      yield* service.revoke({ workspaceId, shareId, revokedByPersonId: creatorPersonId, sessionId })

      assert.strictEqual(created.shareId, shareId)
      assert.deepStrictEqual(yield* Ref.get(createdInput), {
        workspaceId,
        shareId,
        entityId,
        granteePersonId,
        createdByPersonId: creatorPersonId,
        createdBySessionId: sessionId,
        createdAt: now,
        expiresAt: future
      })
      assert.deepStrictEqual(yield* Ref.get(revokedInput), {
        workspaceId,
        shareId,
        revokedByPersonId: creatorPersonId,
        revokedBySessionId: sessionId,
        revokedAt: now
      })
    })))
})
