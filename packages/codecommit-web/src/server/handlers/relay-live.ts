/**
 * `/api/relay`: the Relay dock's routes, behind the owner session like every other route.
 *
 * **Mental model**
 *
 * - **The stream is the dock's only source of truth.** `events` sends a Snapshot first, then each change,
 *   as `data: <RelayEvent JSON>` frames. Every 15 seconds a `: hb` comment re-checks the owner session; once
 *   it no longer holds, the stream sends `data: {"_tag":"Unauthorized"}` and ends, so the dock re-pairs
 *   instead of waiting on a dead stream.
 * - **Writes answer with what happened, not just OK.** `messages` is 202 with the `runId` the run's events
 *   carry; `cancel` and `decisions` are 204, or 409 with the state they found (`NotRunning`, `Decided`,
 *   `Expired`, `Unknown`).
 *
 * @module
 */
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { RelayEvent } from "@knpkv/relay"
import { Effect, Schedule, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ApiError, CodeCommitApi, RelayBadRequestError, RelayConflictError } from "../Api.js"
import { RelayMount } from "../relay/RelayMount.js"

const encoder = new TextEncoder()
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(RelayEvent))
const heartbeat = encoder.encode(": hb\n\n")
const unauthorized = encoder.encode(`data: ${JSON.stringify({ _tag: "Unauthorized" })}\n\n`)

const storeFailed = ({ message }: { readonly message: string }) => new ApiError({ message })

export const RelayLive = HttpApiBuilder.group(CodeCommitApi, "relay", (handlers) =>
  Effect.gen(function*() {
    const mount = yield* RelayMount
    const session = yield* OwnerSession.OwnerSession

    return handlers
      .handleRaw("events", ({ query, request }) =>
        Effect.gen(function*() {
          const relay = yield* mount.harness
          const credential = request.cookies["cc_owner"] ?? ""
          const events = relay.events(query).pipe(
            Stream.mapEffect((event) => Effect.orDie(encodeEvent(event))),
            Stream.map((json) => encoder.encode(`data: ${json}\n\n`)),
            Stream.catch((failure) =>
              Stream.fromEffect(Effect.logWarning("Relay event stream failed", failure)).pipe(Stream.drain)
            )
          )
          // The session is re-checked on the heartbeat; the stream ends after telling the dock it expired.
          const liveness = Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
            Stream.mapEffect(() =>
              session.authorizeHttp(credential).pipe(
                Effect.as(heartbeat),
                Effect.catch(() => Effect.succeed(unauthorized)),
                Effect.provideService(HttpServerRequest.HttpServerRequest, request)
              )
            ),
            Stream.takeUntil((chunk) => chunk === unauthorized)
          )
          return HttpServerResponse.stream(Stream.merge(events, liveness, { haltStrategy: "either" }), {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive"
            }
          })
        }))
      .handle("messages", ({ payload }) =>
        Effect.gen(function*() {
          const relay = yield* mount.harness
          yield* relay.send(payload.ref, payload.text, payload.requestId, payload.backend).pipe(
            Effect.catchTags({
              RelayBackendNotConfigured: ({ backend }) =>
                Effect.fail(new RelayBadRequestError({ message: `Backend ${backend} is not offered here.` })),
              RelayStoreFailed: (failure) => Effect.fail(storeFailed(failure))
            })
          )
          return { runId: payload.requestId }
        }))
      .handle("cancel", ({ payload }) =>
        Effect.gen(function*() {
          const relay = yield* mount.harness
          yield* relay.cancel(payload.ref, payload.runId).pipe(
            Effect.catchTags({
              RelayRunNotActive: () => Effect.fail(new RelayConflictError({ state: { _tag: "NotRunning" } })),
              RelayStoreFailed: (failure) => Effect.fail(storeFailed(failure))
            })
          )
        }))
      .handle("decisions", ({ payload }) =>
        Effect.gen(function*() {
          const relay = yield* mount.harness
          yield* relay.decide(payload.callId, payload.allow).pipe(
            Effect.catchTag("RelayDecisionNotPending", ({ state }) => Effect.fail(new RelayConflictError({ state })))
          )
        }))
      .handle("session", ({ query }) =>
        Effect.gen(function*() {
          const relay = yield* mount.harness
          return yield* relay.session(query).pipe(Effect.mapError(storeFailed))
        }))
      .handle("backends", () => Effect.flatMap(mount.harness, (relay) => relay.backends))
  }))
