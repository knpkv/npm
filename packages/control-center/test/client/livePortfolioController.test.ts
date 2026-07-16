import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as Tracer from "effect/Tracer"

import {
  type ControlCenterLiveEvent,
  type PortfolioInvalidatedLiveEvent,
  type PortfolioSnapshotLiveEvent,
  StreamHeartbeat,
  type StreamHeartbeatLiveEvent,
  StreamResetRequired,
  type StreamResetRequiredLiveEvent
} from "../../src/api/liveEvents.js"
import type { PortfolioSnapshotLoadState } from "../../src/client/portfolio/livePortfolioState.js"
import {
  type PortfolioBrowserConnectivity,
  type PortfolioLiveTransport,
  portfolioReconnectDelayMillis,
  runPortfolioLiveController
} from "../../src/client/portfolio/usePortfolioSnapshot.js"
import { PortfolioInvalidatedEventV1 } from "../../src/domain/domainEvent.js"
import type { EventCursor } from "../../src/domain/identifiers.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const onlineConnectivity: PortfolioBrowserConnectivity = {
  isOnline: Effect.succeed(true),
  waitUntilOnline: Effect.void
}

const deterministicRandom = {
  nextIntUnsafe: (): number => 0,
  nextDoubleUnsafe: (): number => 0
}

const snapshotEvent = (cursor: number): PortfolioSnapshotLiveEvent => {
  const snapshot = makePortfolioSnapshot("current", cursor)
  return { event: "portfolio.snapshot", id: snapshot.eventCursor, data: snapshot }
}

const invalidatedEvent = (cursor: number): PortfolioInvalidatedLiveEvent => {
  const eventCursor = makePortfolioSnapshot("current", cursor).eventCursor
  const data = Schema.decodeUnknownSync(PortfolioInvalidatedEventV1)({
    schemaVersion: 1,
    eventId: `01890f6f-6d6a-7cc0-98d2-${String(cursor).padStart(12, "0")}`,
    eventCursor: cursor,
    workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001",
    eventType: "portfolio-invalidated",
    occurredAt: "2026-07-14T10:16:00.000Z",
    ingestedAt: "2026-07-14T10:16:00.001Z",
    causationId: null,
    correlationId: null,
    metadata: {},
    payload: { reason: "release-projection" }
  })
  return { event: "portfolio.invalidated", id: eventCursor, data }
}

const heartbeatEvent = (cursor: number): StreamHeartbeatLiveEvent => ({
  event: "stream.heartbeat",
  data: Schema.decodeUnknownSync(StreamHeartbeat)({
    eventCursor: cursor,
    sentAt: "2026-07-14T10:16:25.000Z"
  })
})

const resetEvent = (
  requestedCursor: number,
  headCursor = requestedCursor + 10,
  prunedThroughCursor = requestedCursor + 1,
  reason: StreamResetRequired["reason"] = "retention"
): StreamResetRequiredLiveEvent => ({
  event: "stream.reset-required",
  data: Schema.decodeUnknownSync(StreamResetRequired)({
    reason,
    requestedCursor,
    headCursor,
    prunedThroughCursor
  })
})

const lastingStream = (events: ReadonlyArray<ControlCenterLiveEvent>): Stream.Stream<ControlCenterLiveEvent> =>
  Stream.fromIterable(events).pipe(Stream.concat(Stream.never))

describe("live portfolio controller", () => {
  it("keeps the initial connection pending until the stream proves catch-up", () =>
    Effect.gen(function*() {
      const streamOpened = yield* Deferred.make<void>()
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => Deferred.succeed(streamOpened, undefined).pipe(Effect.as(Stream.never))
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(streamOpened)
      const opened = states.at(-1)
      assert.strictEqual(opened?._tag, "loaded")
      if (opened?._tag === "loaded") {
        assert.strictEqual(opened.connection._tag, "connecting")
        assert.isFalse(opened.isSnapshotStale)
      }
      assert.isFalse(states.some((state) => state._tag === "loaded" && state.connection._tag === "connected"))
      yield* Fiber.interrupt(fiber)
    }))

  it("converges through authoritative refresh while deduplicating queued invalidations", () =>
    Effect.gen(function*() {
      const refreshedSnapshot = makePortfolioSnapshot("current", 13)
      const snapshots = [makePortfolioSnapshot("current", 10), refreshedSnapshot]
      let snapshotIndex = 0
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.sync(() => snapshots[snapshotIndex++] ?? refreshedSnapshot),
        openStream: () => Effect.succeed(lastingStream([snapshotEvent(10), invalidatedEvent(11), invalidatedEvent(12)]))
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 13).eventCursor)
        assert.isFalse(finalState.isSnapshotStale)
      }
      assert.strictEqual(snapshotIndex, 2)
      yield* Fiber.interrupt(fiber)
    }))

  it("allows a resumed stream to begin with heartbeat or durable invalidation", () =>
    Effect.gen(function*() {
      const refreshedSnapshot = makePortfolioSnapshot("current", 11)
      const snapshots = [makePortfolioSnapshot("current", 10), refreshedSnapshot]
      let snapshotIndex = 0
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.sync(() => snapshots[snapshotIndex++] ?? refreshedSnapshot),
        openStream: () => Effect.succeed(lastingStream([heartbeatEvent(10), invalidatedEvent(11)]))
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      assert.isTrue(states.some((state) => state._tag === "loaded" && state.connection._tag === "connected"))
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 11).eventCursor)
      }
      yield* Fiber.interrupt(fiber)
    }))

  it("returns a stale reconnect to Live when an equal heartbeat proves catch-up", () =>
    Effect.gen(function*() {
      const states: Array<PortfolioSnapshotLoadState> = []
      let openings = 0
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          openings += 1
          return Effect.succeed(
            openings === 1 ? Stream.fail({ _tag: "TransportFailure" }) : lastingStream([heartbeatEvent(10)])
          )
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      assert.isTrue(states.some((state) => state._tag === "loaded" && state.connection._tag === "reconnecting"))
      yield* TestClock.adjust(250)
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.connection._tag, "connected")
        assert.isFalse(finalState.isSnapshotStale)
      }
      yield* Fiber.interrupt(fiber)
    }))

  it("preserves the snapshot offline and reconnects immediately when the browser returns", () =>
    Effect.gen(function*() {
      const returnOnline = yield* Deferred.make<void>()
      const streamOpened = yield* Deferred.make<void>()
      let isOnline = false
      const states: Array<PortfolioSnapshotLoadState> = []
      const connectivity: PortfolioBrowserConnectivity = {
        isOnline: Effect.sync(() => isOnline),
        waitUntilOnline: Deferred.await(returnOnline)
      }
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => Deferred.succeed(streamOpened, undefined).pipe(Effect.as(Stream.never))
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      const offline = states.at(-1)
      assert.strictEqual(offline?._tag, "loaded")
      if (offline?._tag === "loaded") {
        assert.strictEqual(offline.connection._tag, "offline")
        assert.isTrue(offline.isSnapshotStale)
        assert.strictEqual(offline.snapshot.eventCursor, makePortfolioSnapshot("current", 10).eventCursor)
      }

      isOnline = true
      yield* Deferred.succeed(returnOnline, undefined)
      yield* Deferred.await(streamOpened)
      const awaitingCatchUp = states.at(-1)
      assert.strictEqual(awaitingCatchUp?._tag, "loaded")
      if (awaitingCatchUp?._tag === "loaded") assert.strictEqual(awaitingCatchUp.connection._tag, "offline")
      yield* Fiber.interrupt(fiber)
    }))

  it("refreshes authoritatively when a heartbeat is ahead of the applied snapshot", () =>
    Effect.gen(function*() {
      const refreshedSnapshot = makePortfolioSnapshot("current", 12)
      const snapshots = [makePortfolioSnapshot("current", 10), refreshedSnapshot]
      let snapshotIndex = 0
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.sync(() => snapshots[snapshotIndex++] ?? refreshedSnapshot),
        openStream: () => Effect.succeed(lastingStream([heartbeatEvent(12)]))
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      const updating = states.find(
        (state) => state._tag === "loaded" && state.connection._tag === "connecting" && state.isSnapshotStale
      )
      assert.strictEqual(updating?._tag, "loaded")
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 12).eventCursor)
        assert.isFalse(finalState.isSnapshotStale)
      }
      yield* Fiber.interrupt(fiber)
    }))

  it("retains the reset head and reconnects when a replacement arrives below its floor", () =>
    Effect.gen(function*() {
      const states: Array<PortfolioSnapshotLoadState> = []
      let openings = 0
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          openings += 1
          return Effect.succeed(
            openings === 1
              ? Stream.make(resetEvent(10, 20, 11), snapshotEvent(19))
              : lastingStream([resetEvent(10, 20, 11), snapshotEvent(20)])
          )
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      const resetState = states.find((state) => state._tag === "loaded" && state.awaitingResetSnapshot)
      assert.strictEqual(resetState?._tag, "loaded")
      if (resetState?._tag === "loaded") {
        assert.strictEqual(resetState.snapshot.eventCursor, makePortfolioSnapshot("current", 10).eventCursor)
        assert.strictEqual(resetState.minimumRefreshCursor, makePortfolioSnapshot("current", 20).eventCursor)
      }
      assert.isFalse(
        states.some(
          (state) =>
            state._tag === "loaded" && state.snapshot.eventCursor === makePortfolioSnapshot("current", 19).eventCursor
        )
      )
      yield* TestClock.adjust(250)
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 20).eventCursor)
      }
      assert.strictEqual(openings, 2)
      yield* Fiber.interrupt(fiber)
    }))

  it("rejects a reset for another resume cursor without regressing the applied snapshot", () =>
    Effect.gen(function*() {
      const openedAfter: Array<EventCursor> = []
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: (after) => {
          openedAfter.push(after)
          return Effect.succeed(
            openedAfter.length === 1
              ? Stream.make(resetEvent(9, 5, 0, "cursor-ahead"), snapshotEvent(5))
              : lastingStream([heartbeatEvent(10)])
          )
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      assert.isFalse(
        states.some(
          (state) =>
            state._tag === "loaded" && state.snapshot.eventCursor === makePortfolioSnapshot("current", 5).eventCursor
        )
      )
      yield* TestClock.adjust(250)
      assert.deepStrictEqual(openedAfter, [
        makePortfolioSnapshot("current", 10).eventCursor,
        makePortfolioSnapshot("current", 10).eventCursor
      ])
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 10).eventCursor)
        assert.strictEqual(finalState.connection._tag, "connected")
      }
      yield* Fiber.interrupt(fiber)
    }))

  it("accepts a reset correlated with the cursor advanced by a replayed invalidation", () =>
    Effect.gen(function*() {
      const refreshedSnapshot = makePortfolioSnapshot("current", 11)
      const snapshots = [makePortfolioSnapshot("current", 10), refreshedSnapshot]
      let snapshotIndex = 0
      let openings = 0
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.sync(() => snapshots[snapshotIndex++] ?? refreshedSnapshot),
        openStream: () => {
          openings += 1
          return Effect.succeed(
            lastingStream([invalidatedEvent(11), resetEvent(11, 20, 12), snapshotEvent(20)])
          )
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") {
        assert.strictEqual(finalState.snapshot.eventCursor, makePortfolioSnapshot("current", 20).eventCursor)
        assert.strictEqual(finalState.connection._tag, "connected")
      }
      assert.strictEqual(snapshotIndex, 2)
      assert.strictEqual(openings, 1)
      yield* Fiber.interrupt(fiber)
    }))

  it("allows only reason-consistent reset cursor ordering", () =>
    Effect.gen(function*() {
      const acceptedStates: Array<PortfolioSnapshotLoadState> = []
      const acceptedTransport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () =>
          Effect.succeed(
            lastingStream([
              resetEvent(10, 5, 0, "cursor-ahead"),
              snapshotEvent(5),
              resetEvent(5, 8, 6),
              snapshotEvent(8)
            ])
          )
      }
      const accepted = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => acceptedStates.push(state),
        sessionKey: "session-a",
        transport: acceptedTransport
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const lowered = acceptedStates.at(-1)
      assert.strictEqual(lowered?._tag, "loaded")
      if (lowered?._tag === "loaded") {
        assert.strictEqual(lowered.snapshot.eventCursor, makePortfolioSnapshot("current", 8).eventCursor)
        assert.strictEqual(lowered.connection._tag, "connected")
      }
      yield* Fiber.interrupt(accepted)

      let rejectedOpenings = 0
      const rejectedStates: Array<PortfolioSnapshotLoadState> = []
      const rejectedTransport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          rejectedOpenings += 1
          return Effect.succeed(
            rejectedOpenings === 1 ? Stream.make(resetEvent(10, 10, 0, "gap")) : lastingStream([heartbeatEvent(10)])
          )
        }
      }
      const rejected = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => rejectedStates.push(state),
        sessionKey: "session-b",
        transport: rejectedTransport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))
      assert.isFalse(rejectedStates.some((state) => state._tag === "loaded" && state.awaitingResetSnapshot))
      yield* TestClock.adjust(250)
      assert.strictEqual(rejectedOpenings, 2)
      yield* Fiber.interrupt(rejected)
    }))

  it("accepts only replay-budget resets whose requested cursor does not exceed the head", () =>
    Effect.gen(function*() {
      const acceptedStates: Array<PortfolioSnapshotLoadState> = []
      const acceptedTransport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => Effect.succeed(lastingStream([resetEvent(10, 20, 15, "replay-budget"), snapshotEvent(20)]))
      }
      const accepted = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => acceptedStates.push(state),
        sessionKey: "session-a",
        transport: acceptedTransport
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const replaced = acceptedStates.at(-1)
      assert.strictEqual(replaced?._tag, "loaded")
      if (replaced?._tag === "loaded") {
        assert.strictEqual(replaced.snapshot.eventCursor, makePortfolioSnapshot("current", 20).eventCursor)
        assert.strictEqual(replaced.connection._tag, "connected")
      }
      yield* Fiber.interrupt(accepted)

      let rejectedOpenings = 0
      const rejectedTransport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          rejectedOpenings += 1
          return Effect.succeed(
            rejectedOpenings === 1
              ? Stream.make(resetEvent(10, 9, 0, "replay-budget"))
              : lastingStream([heartbeatEvent(10)])
          )
        }
      }
      const rejected = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: () => undefined,
        sessionKey: "session-b",
        transport: rejectedTransport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(250)
      assert.strictEqual(rejectedOpenings, 2)
      yield* Fiber.interrupt(rejected)
    }))

  it("rejects reset metadata whose pruned cursor is beyond the advertised head", () =>
    Effect.gen(function*() {
      let openings = 0
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          openings += 1
          return Effect.succeed(
            openings === 1 ? Stream.make(resetEvent(10, 20, 21)) : lastingStream([heartbeatEvent(10)])
          )
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      assert.isFalse(states.some((state) => state._tag === "loaded" && state.awaitingResetSnapshot))
      yield* TestClock.adjust(250)
      assert.strictEqual(openings, 2)
      const finalState = states.at(-1)
      assert.strictEqual(finalState?._tag, "loaded")
      if (finalState?._tag === "loaded") assert.strictEqual(finalState.connection._tag, "connected")
      yield* Fiber.interrupt(fiber)
    }))

  it("reconnects from the last applied snapshot cursor and closes every stream", () =>
    Effect.gen(function*() {
      const openedAfter: Array<EventCursor> = []
      let activeStreams = 0
      let closedStreams = 0
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: (after) =>
          Effect.sync(() => {
            openedAfter.push(after)
            activeStreams += 1
            const source = openedAfter.length === 1 ? Stream.fail({ _tag: "TransportFailure" }) : Stream.never
            return source.pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  activeStreams -= 1
                  closedStreams += 1
                })
              )
            )
          })
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: () => undefined,
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(250)
      assert.deepStrictEqual(openedAfter, [
        makePortfolioSnapshot("current", 10).eventCursor,
        makePortfolioSnapshot("current", 10).eventCursor
      ])
      assert.strictEqual(activeStreams, 1)
      assert.strictEqual(closedStreams, 1)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(activeStreams, 0)
      assert.strictEqual(closedStreams, 2)
    }))

  it("resets reconnect backoff after acquiring a stream", () =>
    Effect.gen(function*() {
      let openings = 0
      const reconnectAttempts: Array<number> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          openings += 1
          if (openings === 1) return Effect.fail({ _tag: "TransportFailure" })
          if (openings === 2) {
            return Effect.succeed(
              Stream.fromIterable<ControlCenterLiveEvent>([heartbeatEvent(10)]).pipe(
                Stream.concat(Stream.fail({ _tag: "TransportFailure" }))
              )
            )
          }
          return Effect.succeed(Stream.never)
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => {
          if (state._tag === "loaded" && state.connection._tag === "reconnecting") {
            reconnectAttempts.push(state.connection.attempt)
          }
        },
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(250)
      assert.deepStrictEqual(reconnectAttempts, [1, 1])
      yield* TestClock.adjust(250)
      assert.strictEqual(openings, 3)
      yield* Fiber.interrupt(fiber)
    }))

  it("keeps increasing backoff across consecutive stream acquisition failures", () =>
    Effect.gen(function*() {
      let openings = 0
      const reconnectAttempts: Array<number> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () => {
          openings += 1
          return openings <= 2
            ? Effect.fail({ _tag: "TransportFailure" })
            : Effect.succeed(Stream.never)
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: (state) => {
          if (state._tag === "loaded" && state.connection._tag === "reconnecting") {
            reconnectAttempts.push(state.connection.attempt)
          }
        },
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(250)
      assert.deepStrictEqual(reconnectAttempts, [1, 2])
      yield* Fiber.interrupt(fiber)
    }))

  it("keeps one reconnect span across repeated transient failures", () =>
    Effect.gen(function*() {
      let activeReconnectSpans = 0
      let maximumActiveReconnectSpans = 0
      let reconnectSpansStarted = 0
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          if (options.name !== "PortfolioLiveController.reconnect") return span

          activeReconnectSpans += 1
          reconnectSpansStarted += 1
          maximumActiveReconnectSpans = Math.max(maximumActiveReconnectSpans, activeReconnectSpans)
          const end = span.end.bind(span)
          span.end = (endTime, exit) => {
            if (span.status._tag === "Started") activeReconnectSpans -= 1
            end(endTime, exit)
          }
          return span
        }
      })
      let openings = 0
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () =>
          Effect.sync(() => {
            openings += 1
            return openings <= 5 ? Stream.fail({ _tag: "TransportFailure" }) : Stream.never
          })
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: () => undefined,
        sessionKey: "session-a",
        transport
      }).pipe(
        Effect.provideService(Random.Random, deterministicRandom),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.forkChild({ startImmediately: true })
      )

      yield* TestClock.adjust(8_000)
      assert.strictEqual(openings, 6)
      assert.strictEqual(reconnectSpansStarted, 1)
      assert.strictEqual(maximumActiveReconnectSpans, 1)
      assert.strictEqual(activeReconnectSpans, 1)

      yield* Fiber.interrupt(fiber)
      assert.strictEqual(activeReconnectSpans, 0)
    }))

  it("does not advance the resume cursor when a snapshot event id mismatches its data", () =>
    Effect.gen(function*() {
      const openedAfter: Array<EventCursor> = []
      const mismatched = { ...snapshotEvent(12), id: makePortfolioSnapshot("current", 11).eventCursor }
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: (after) => {
          openedAfter.push(after)
          return Effect.succeed(openedAfter.length === 1 ? Stream.make(mismatched) : Stream.never)
        }
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: () => undefined,
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(250)
      assert.deepStrictEqual(openedAfter, [
        makePortfolioSnapshot("current", 10).eventCursor,
        makePortfolioSnapshot("current", 10).eventCursor
      ])
      yield* Fiber.interrupt(fiber)
    }))

  it("invalidates exactly the session whose live stream is unauthorized", () =>
    Effect.gen(function*() {
      const invalidatedSessions: Array<string> = []
      const states: Array<PortfolioSnapshotLoadState> = []
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot()),
        openStream: () => Effect.fail({ _tag: "UnauthorizedApiError" })
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: (sessionKey) => invalidatedSessions.push(sessionKey),
        onState: (state) => states.push(state),
        sessionKey: "session-a",
        transport
      }).pipe(Effect.forkChild({ startImmediately: true }))

      assert.deepStrictEqual(invalidatedSessions, ["session-a"])
      assert.deepStrictEqual(states.at(-1), {
        _tag: "failed",
        failure: "session-expired",
        sessionKey: "session-a"
      })
      yield* Fiber.interrupt(fiber)
    }))

  it("uses capped equal jitter with a positive minimum", () => {
    assert.strictEqual(portfolioReconnectDelayMillis(1, 0), 250)
    assert.strictEqual(portfolioReconnectDelayMillis(1, 1), 500)
    assert.strictEqual(portfolioReconnectDelayMillis(2, 0.5), 750)
    assert.strictEqual(portfolioReconnectDelayMillis(99, 0), 15_000)
    assert.strictEqual(portfolioReconnectDelayMillis(99, 1), 30_000)
    assert.strictEqual(portfolioReconnectDelayMillis(99, 0.5), 22_500)
  })

  it("waits a positive delay before retrying an always-failing transport with zero random", () =>
    Effect.gen(function*() {
      let openings = 0
      const transport: PortfolioLiveTransport = {
        loadSnapshot: Effect.succeed(makePortfolioSnapshot("current", 10)),
        openStream: () =>
          Effect.sync(() => {
            openings += 1
            return Stream.fail({ _tag: "TransportFailure" })
          })
      }
      const fiber = yield* runPortfolioLiveController({
        connectivity: onlineConnectivity,
        onSessionExpired: () => undefined,
        onState: () => undefined,
        sessionKey: "session-a",
        transport
      }).pipe(Effect.provideService(Random.Random, deterministicRandom), Effect.forkChild({ startImmediately: true }))

      assert.strictEqual(openings, 1)
      yield* TestClock.adjust(249)
      assert.strictEqual(openings, 1)
      yield* TestClock.adjust(1)
      assert.strictEqual(openings, 2)
      yield* Fiber.interrupt(fiber)
    }))
})
