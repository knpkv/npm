import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import type { ControlCenterLiveEvent } from "../../src/api/liveEvents.js"
import { DomainEventId, EventCursor, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { PortfolioSnapshots } from "../../src/server/api/ApplicationServices.js"
import { makeLiveEvents } from "../../src/server/application/liveEvents.js"
import { makePortfolioSnapshots } from "../../src/server/application/portfolioSnapshots.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import { DomainEventDedupeKey } from "../../src/server/persistence/repositories/domainEventModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000201")
const OTHER_WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000202")
const OCCURRED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:00:00.000Z")

const eventId = (index: number) =>
  Schema.decodeSync(DomainEventId)(
    `01890f6f-6d6a-7cc0-98d2-${String(index + 500).padStart(12, "0")}`
  )

const withLivePersistence = <Success, Failure>(
  use: Effect.Effect<Success, Failure, DomainEventWakeups | Persistence | Scope.Scope>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-live-events-")
    return yield* use.pipe(
      Effect.provide(Layer.merge(persistenceLayer(config), DomainEventWakeups.layer))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const createWorkspace = (persistence: Persistence["Service"], workspaceId: WorkspaceId) =>
  persistence.workspaces.create(workspaceId, {
    displayName: WorkspaceName.make("Live events"),
    createdAt: OCCURRED_AT
  })

const appendInvalidation = (
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  index: number
) => {
  const id = eventId(index)
  return persistence.events.append(workspaceId, {
    dedupeKey: DomainEventDedupeKey.make(`live-event-${index}`),
    schemaVersion: 1,
    eventId: id,
    eventType: "portfolio-invalidated",
    occurredAt: OCCURRED_AT,
    causationId: null,
    correlationId: null,
    metadata: {},
    payload: { reason: "release-projection" }
  })
}

const liveServices = Effect.gen(function*() {
  const portfolio = yield* makePortfolioSnapshots
  const events = yield* makeLiveEvents.pipe(Effect.provideService(PortfolioSnapshots, portfolio))
  return { events, portfolio }
})

const collect = (stream: Stream.Stream<ControlCenterLiveEvent>, count: number) =>
  stream.pipe(Stream.take(count), Stream.runCollect)

describe("durable live events", () => {
  it.effect("starts fresh with an authoritative snapshot and immediate catch-up heartbeat", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      yield* appendInvalidation(persistence, WORKSPACE_ID, 1)
      const { events, portfolio } = yield* liveServices

      const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)
      const frames = yield* events.open({ workspaceId: WORKSPACE_ID, after: undefined }).pipe(
        Effect.flatMap((stream) => collect(stream, 2))
      )

      assert.strictEqual(snapshot.eventCursor, 1)
      assert.strictEqual(frames[0]?.event, "portfolio.snapshot")
      assert.strictEqual(frames[0]?.id, 1)
      assert.strictEqual(frames[1]?.event, "stream.heartbeat")
      if (frames[1]?.event === "stream.heartbeat") assert.strictEqual(frames[1].data.eventCursor, 1)
    })))

  it.effect("replays more than one bounded page before emitting its catch-up marker", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      yield* Effect.forEach(
        Array.from({ length: 129 }, (_, index) => index + 1),
        (index) => appendInvalidation(persistence, WORKSPACE_ID, index),
        { concurrency: 1, discard: true }
      )
      const { events } = yield* liveServices

      const frames = yield* events.open({ workspaceId: WORKSPACE_ID, after: EventCursor.make(0) }).pipe(
        Effect.flatMap((stream) => collect(stream, 130))
      )

      assert.lengthOf(frames, 130)
      assert.strictEqual(frames[0]?.event, "portfolio.invalidated")
      assert.strictEqual(frames[0]?.id, 1)
      assert.strictEqual(frames[128]?.event, "portfolio.invalidated")
      assert.strictEqual(frames[128]?.id, 129)
      assert.strictEqual(frames[129]?.event, "stream.heartbeat")
      if (frames[129]?.event === "stream.heartbeat") assert.strictEqual(frames[129].data.eventCursor, 129)
    })))

  it.effect("replaces state instead of replaying a journal beyond the per-stream budget", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      yield* Effect.forEach(
        Array.from({ length: 513 }, (_, index) => index + 1),
        (index) => appendInvalidation(persistence, WORKSPACE_ID, index),
        { concurrency: 1, discard: true }
      )
      const { events } = yield* liveServices

      const frames = yield* events.open({ workspaceId: WORKSPACE_ID, after: EventCursor.make(0) }).pipe(
        Effect.flatMap((stream) => collect(stream, 3))
      )

      assert.strictEqual(frames[0]?.event, "stream.reset-required")
      if (frames[0]?.event === "stream.reset-required") {
        assert.strictEqual(frames[0].data.reason, "replay-budget")
        assert.strictEqual(frames[0].data.requestedCursor, 0)
        assert.strictEqual(frames[0].data.headCursor, 513)
      }
      assert.strictEqual(frames[1]?.event, "portfolio.snapshot")
      assert.strictEqual(frames[1]?.id, 513)
      assert.strictEqual(frames[2]?.event, "stream.heartbeat")
    })))

  it.effect("resets a pruned cursor before replacing state with a fresh snapshot", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      yield* appendInvalidation(persistence, WORKSPACE_ID, 1)
      yield* appendInvalidation(persistence, WORKSPACE_ID, 2)
      yield* persistence.events.prune(WORKSPACE_ID, EventCursor.make(1), 500)
      const { events } = yield* liveServices

      const frames = yield* events.open({ workspaceId: WORKSPACE_ID, after: EventCursor.make(0) }).pipe(
        Effect.flatMap((stream) => collect(stream, 3))
      )

      assert.strictEqual(frames[0]?.event, "stream.reset-required")
      if (frames[0]?.event === "stream.reset-required") {
        assert.strictEqual(frames[0].data.reason, "retention")
        assert.strictEqual(frames[0].data.prunedThroughCursor, 1)
      }
      assert.strictEqual(frames[1]?.event, "portfolio.snapshot")
      assert.strictEqual(frames[1]?.id, 2)
      assert.strictEqual(frames[2]?.event, "stream.heartbeat")
    })))

  it.effect("keeps replay scoped to the authenticated workspace", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      yield* createWorkspace(persistence, OTHER_WORKSPACE_ID)
      yield* appendInvalidation(persistence, WORKSPACE_ID, 1)
      const { events } = yield* liveServices

      const frames = yield* events.open({ workspaceId: OTHER_WORKSPACE_ID, after: undefined }).pipe(
        Effect.flatMap((stream) => collect(stream, 2))
      )

      assert.strictEqual(frames[0]?.event, "portfolio.snapshot")
      assert.strictEqual(frames[0]?.id, 0)
      assert.strictEqual(frames[1]?.event, "stream.heartbeat")
      if (frames[1]?.event === "stream.heartbeat") assert.strictEqual(frames[1].data.eventCursor, 0)
    })))

  it.effect("repairs a dropped wake hint on the heartbeat poll", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* createWorkspace(persistence, WORKSPACE_ID)
      const { events } = yield* liveServices
      const stream = yield* events.open({ workspaceId: WORKSPACE_ID, after: undefined })
      const pull = yield* Stream.toPull(stream)

      assert.strictEqual((yield* pull)[0]?.event, "portfolio.snapshot")
      assert.strictEqual((yield* pull)[0]?.event, "stream.heartbeat")
      yield* appendInvalidation(persistence, WORKSPACE_ID, 1)
      const next = yield* pull.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(25))
      const repaired = yield* Fiber.join(next)

      assert.strictEqual(repaired[0]?.event, "portfolio.invalidated")
      assert.strictEqual(repaired[0]?.id, 1)
    })))

  it.effect("delivers a post-commit wake to an already-open stream immediately", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const wakeups = yield* DomainEventWakeups
      yield* createWorkspace(persistence, WORKSPACE_ID)
      const { events } = yield* liveServices
      const stream = yield* events.open({ workspaceId: WORKSPACE_ID, after: undefined })
      const pull = yield* Stream.toPull(stream)

      assert.strictEqual((yield* pull)[0]?.event, "portfolio.snapshot")
      assert.strictEqual((yield* pull)[0]?.event, "stream.heartbeat")
      yield* appendInvalidation(persistence, WORKSPACE_ID, 1)
      yield* wakeups.notify(WORKSPACE_ID)
      const awakened = yield* pull

      assert.strictEqual(awakened[0]?.event, "portfolio.invalidated")
      assert.strictEqual(awakened[0]?.id, 1)
    })))

  it.effect("bounds slow-client wake hints while replaying every durable event in order", () =>
    withLivePersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const wakeups = yield* DomainEventWakeups
      const closed = yield* Deferred.make<void>()
      yield* createWorkspace(persistence, WORKSPACE_ID)
      const { events } = yield* liveServices

      yield* Effect.scoped(Effect.gen(function*() {
        const stream = yield* events.open({ workspaceId: WORKSPACE_ID, after: undefined })
        const pull = yield* Stream.toPull(stream.pipe(
          Stream.ensuring(Deferred.succeed(closed, undefined))
        ))
        assert.strictEqual((yield* pull)[0]?.event, "portfolio.snapshot")
        assert.strictEqual((yield* pull)[0]?.event, "stream.heartbeat")

        yield* Effect.forEach(
          Array.from({ length: 129 }, (_, index) => index + 1),
          (index) => appendInvalidation(persistence, WORKSPACE_ID, index),
          { concurrency: 1, discard: true }
        )
        const notifications = yield* Effect.forEach(
          Array.from({ length: 65 }),
          () => wakeups.notify(WORKSPACE_ID),
          { concurrency: 1, discard: true }
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const notificationExit = notifications.pollUnsafe()
        assert.isDefined(notificationExit)
        if (notificationExit !== undefined) assert.isTrue(Exit.isSuccess(notificationExit))

        const firstPage = yield* pull
        const secondPage = yield* pull
        const heartbeat = yield* pull
        const replayed = [...firstPage, ...secondPage].filter(
          (frame) => frame.event === "portfolio.invalidated"
        )
        assert.deepStrictEqual(
          replayed.map(({ id }) => id),
          Array.from({ length: 129 }, (_, index) => index + 1)
        )
        assert.strictEqual(heartbeat[0]?.event, "stream.heartbeat")
        if (heartbeat[0]?.event === "stream.heartbeat") {
          assert.strictEqual(heartbeat[0].data.eventCursor, 129)
        }
      }))

      yield* Deferred.await(closed)
    })))
})
