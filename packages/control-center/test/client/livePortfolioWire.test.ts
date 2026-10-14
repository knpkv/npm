import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { makeControlCenterApiClient } from "../../src/api/client.js"
import {
  type ControlCenterLiveEvent,
  StreamHeartbeatLiveEvent,
  StreamResetRequiredLiveEvent
} from "../../src/api/liveEvents.js"
import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import type { PortfolioSnapshotLoadState } from "../../src/client/portfolio/livePortfolioState.js"
import { runPortfolioLiveController } from "../../src/client/portfolio/usePortfolioSnapshot.js"
import { EventCursor } from "../../src/domain/identifiers.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const invalidation = {
  schemaVersion: 1,
  eventId: "01890f6f-6d6a-7cc0-98d2-000000000011",
  eventCursor: 11,
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001",
  eventType: "portfolio-invalidated",
  occurredAt: "2026-07-14T12:00:00.000Z",
  ingestedAt: "2026-07-14T12:00:00.000Z",
  causationId: null,
  correlationId: null,
  metadata: {},
  payload: { reason: "release-projection" }
}

const heartbeat = { eventCursor: 11, sentAt: "2026-07-14T12:00:00.000Z" }
const reset = { reason: "gap", requestedCursor: 11, headCursor: 12, prunedThroughCursor: 10 }
const wire = `id: 11\nevent: portfolio.invalidated\ndata: ${JSON.stringify(invalidation)}\n\n` +
  `event: stream.heartbeat\ndata: ${JSON.stringify(heartbeat)}\n\n` +
  `event: stream.reset-required\ndata: ${JSON.stringify(reset)}\n\n`

/** Only HTTP bytes are faked; the generated API client supplies its production SSE parser and codecs. */
const clientForBody = (body: string | ReadableStream<Uint8Array>) =>
  makeControlCenterApiClient({ baseUrl: "http://fixture.invalid" }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.include(request.url, "/api/v1/events")
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { "content-type": "text/event-stream" } })
          )
        })
      )
    )
  )

describe("live portfolio wire", () => {
  /** Prevent inherited SSE IDs from turning ordinary heartbeats/resets into decode failures. */
  it.effect("decodes no-ID heartbeat and reset frames after an ID-bearing invalidation", () =>
    Effect.gen(function*() {
      const client = yield* clientForBody(wire)
      const events = yield* client.liveEvents.stream({
        headers: { "last-event-id": EventCursor.make(10) },
        query: { after: EventCursor.make(10) }
      }).pipe(
        Effect.flatMap(Stream.runCollect)
      )
      assert.deepEqual(events.map((event) => event.event), [
        "portfolio.invalidated",
        "stream.heartbeat",
        "stream.reset-required"
      ])
      assert.strictEqual(events[0]?.id, 11)
      assert.notProperty(events[1], "id")
      assert.notProperty(events[2], "id")
    }))

  /** Exercise wire decoding and the real controller together; decoded-event mocks miss this failure class. */
  it.effect("keeps one stream open and advances its resume cursor only on cursor-bearing events", () =>
    Effect.gen(function*() {
      const chunks = yield* Queue.unbounded<string>()
      const finished = yield* Deferred.make<void>()
      const states: Array<PortfolioSnapshotLoadState> = []
      const decoded: Array<ControlCenterLiveEvent> = []
      const resumeCursors: Array<number> = []
      let loads = 0
      let settledAtTwelve = 0
      const snapshot = makePortfolioSnapshot("current", 12)
      const fiber = yield* runPortfolioLiveController({
        connectivity: { isOnline: Effect.succeed(true), waitUntilOnline: Effect.void },
        sessionKey: "fixture-session",
        onSessionExpired: () => undefined,
        onState: (state) => {
          states.push(state)
          if (state._tag !== "loaded") return
          if (state.connection._tag === "reconnecting") Deferred.doneUnsafe(finished, Effect.void)
          if (state.snapshot.eventCursor === 12 && !state.awaitingResetSnapshot) {
            settledAtTwelve += 1
            if (settledAtTwelve === 2) Deferred.doneUnsafe(finished, Effect.void)
          }
        },
        transport: {
          loadSnapshot: Effect.sync(() => makePortfolioSnapshot("current", ++loads === 1 ? 10 : 11)),
          openStream: (after) =>
            Effect.gen(function*() {
              resumeCursors.push(after)
              const bytes = Stream.fromQueue(chunks).pipe(
                Stream.map((chunk) => new TextEncoder().encode(chunk))
              )
              const body = yield* Stream.toReadableStreamEffect(bytes)
              const client = yield* clientForBody(body)
              return (yield* client.liveEvents.stream({ headers: { "last-event-id": after }, query: { after } })).pipe(
                Stream.tap((event) => Effect.sync(() => decoded.push(event)))
              )
            })
        }
      }).pipe(Effect.forkScoped)
      yield* Queue.offer(chunks, wire)
      yield* Queue.offer(
        chunks,
        `id: 12\nevent: portfolio.snapshot\ndata: ${
          JSON.stringify(Schema.encodeSync(PortfolioSnapshot)(snapshot))
        }\n\n` +
          `event: stream.heartbeat\ndata: ${JSON.stringify({ ...heartbeat, eventCursor: 12 })}\n\n`
      )
      yield* Deferred.await(finished)
      assert.deepEqual(resumeCursors, [10])
      assert.isFalse(states.some((state) => state._tag === "loaded" && state.connection._tag === "reconnecting"))
      const resetState = states.find((state) => state._tag === "loaded" && state.awaitingResetSnapshot)
      assert.strictEqual(resetState?._tag, "loaded")
      if (resetState?._tag === "loaded") assert.strictEqual(resetState.snapshot.eventCursor, 11)
      for (const event of decoded) {
        if (event.event === "stream.heartbeat" || event.event === "stream.reset-required") {
          assert.notProperty(event, "id")
        }
      }
      assert.strictEqual(loads, 2)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped))

  /** Compatibility: server-produced heartbeat/reset frames continue to omit an SSE ID. */
  it("keeps heartbeat and reset IDs absent when encoding server frames", () => {
    const heartbeatFrame = Schema.decodeUnknownSync(StreamHeartbeatLiveEvent)({
      event: "stream.heartbeat",
      data: JSON.stringify(heartbeat)
    })
    const resetFrame = Schema.decodeUnknownSync(StreamResetRequiredLiveEvent)({
      event: "stream.reset-required",
      data: JSON.stringify(reset)
    })
    assert.notProperty(Schema.encodeSync(StreamHeartbeatLiveEvent)(heartbeatFrame), "id")
    assert.notProperty(Schema.encodeSync(StreamResetRequiredLiveEvent)(resetFrame), "id")
  })
})
