/**
 * `/v1/relay/*` on the hub's canonical listener: the routes `@knpkv/relay-product/client` reads with
 * `makeRelayClient({ base: "/v1/relay" })`.
 *
 * **Mental model**
 *
 * - **Checked before Relay starts.** Every route authorizes the request first (the listener's Tailscale
 *   identity check), every POST also checks the origin, and every route names the hub's one conversation,
 *   `{ product: "herdr", kind: "fleet", id: <hub host> }`. Only then does it wait for the harness, so a
 *   request that may not use Relay never opens its store.
 * - **The stream is the panel's only source of truth.** `events` sends a Snapshot first, then each change,
 *   as `data:` frames. Every 15 seconds a `: hb` comment re-runs the authorization; once it fails, the
 *   stream sends `Unauthorized` and ends. If the session's events fail, it sends `StreamFailed` and ends;
 *   the cause is logged here, never sent. A browser that disconnects ends its subscription and heartbeat.
 * - **Writes answer with what happened.** `messages` is 202 with the `runId` the run's events carry;
 *   `cancel` and `decisions` are 204, or 409 with the state they found. 503 is Relay unable to run here,
 *   with the fix.
 *
 * @module
 */
import type * as Relay from "@knpkv/relay"
import {
  BackendStatus,
  ObjectRef,
  RelayCancelRequest,
  type RelayConflictState,
  RelayDecisionRequest,
  RelayMessageRequest,
  RelayStreamFrame,
  type RelayUnavailableError,
  SessionInfo
} from "@knpkv/relay/wire"
import { Effect, type Exit, Fiber, Schedule, Schema, Stream } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { RelayHubMount } from "./mount.js"

/** What the HTTP server lends the routes: its checks, its JSON reader and its runtime. */
export interface RelayRouteContext<E, R> {
  /** The hub's host: the id of its one fleet conversation. */
  readonly host: string
  readonly mount: RelayHubMount
  /** Fails when this request may not use the hub. */
  readonly authorize: Effect.Effect<unknown, E, R>
  /** Fails when a POST did not come from the hub's own page. */
  readonly sameOrigin: Effect.Effect<unknown, E, R>
  readonly readJson: <A>(schema: Schema.Codec<A, unknown, never, never>) => Effect.Effect<A, E, R>
  /** Answers a refused check the way every other hub route does. */
  readonly refuse: (response: ServerResponse, error: E) => void
  readonly runtime: {
    readonly runPromiseExit: <A, X>(effect: Effect.Effect<A, X, R>) => Promise<Exit.Exit<A, X>>
    readonly runFork: <A, X>(effect: Effect.Effect<A, X, R>) => Fiber.Fiber<A, X>
  }
}

/** A refusal in the shape the client decodes: the wire's tagged errors, encoded. */
type Refusal =
  | { readonly status: 400; readonly body: { readonly _tag: "RelayBadRequestError"; readonly message: string } }
  | {
    readonly status: 409
    readonly body: { readonly _tag: "RelayConflictError"; readonly state: typeof RelayConflictState.Type }
  }
  | {
    readonly status: 503
    readonly body: { readonly _tag: "RelayUnavailableError"; readonly message: string; readonly fix: string }
  }

const badRequest = (message: string): Refusal => ({ status: 400, body: { _tag: "RelayBadRequestError", message } })
const conflict = (state: typeof RelayConflictState.Type): Refusal => ({
  status: 409,
  body: { _tag: "RelayConflictError", state }
})
const unavailableOf = ({ fix, message }: RelayUnavailableError): Refusal => ({
  status: 503,
  body: { _tag: "RelayUnavailableError", message, fix }
})
const storeFailed = ({ message }: { readonly message: string }): Refusal => ({
  status: 503,
  body: { _tag: "RelayUnavailableError", message, fix: "Retry; if it repeats, restart hostd." }
})

/** Sends a JSON text body, or none. */
const send = (response: ServerResponse, status: number, json?: string): void => {
  if (json === undefined) {
    response.writeHead(status, { "cache-control": "no-store" })
    response.end()
    return
  }
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" })
  response.end(`${json}\n`)
}

const refuseWith = (response: ServerResponse, refusal: Refusal): void =>
  send(response, refusal.status, JSON.stringify(refusal.body))

const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(RelayStreamFrame))
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(SessionInfo))
const encodeBackends = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(BackendStatus)))
const decodeRef = Schema.decodeUnknownEffect(ObjectRef)
const heartbeat = ": hb\n\n"
const frameOf = (tag: "StreamFailed" | "Unauthorized") => `data: ${JSON.stringify({ _tag: tag })}\n\n`

/**
 * Answers `request` when it is a `/v1/relay/*` route, and says whether it was. The caller mounts it on the
 * canonical listener only.
 */
export const handleRelayRoute = async <E, R>(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: RelayRouteContext<E, R>
): Promise<boolean> => {
  if (!url.pathname.startsWith("/v1/relay/")) return false
  const route = url.pathname.slice("/v1/relay/".length)
  const method = request.method ?? "GET"
  const reads = ["events", "session", "backends"]
  const writes = ["messages", "cancel", "decisions"]
  if (!(method === "GET" && reads.includes(route)) && !(method === "POST" && writes.includes(route))) {
    send(response, 404, JSON.stringify({ error: "not_found" }))
    return true
  }

  // Registered before the first wait: a browser that leaves while the checks run or Relay starts never gets a
  // subscription, and one that leaves mid-stream ends it.
  let left = false
  let onLeave = (): void => undefined
  response.once("close", () => {
    left = true
    onLeave()
  })

  const checked = await context.runtime.runPromiseExit(
    method === "POST" ? Effect.andThen(context.authorize, context.sameOrigin) : context.authorize
  )
  if (checked._tag === "Failure") {
    const failure = checked.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure !== undefined && failure._tag === "Fail") context.refuse(response, failure.error)
    else send(response, 500, JSON.stringify({ error: "internal" }))
    return true
  }

  /** The conversation the request names, when it is the hub's own. */
  const isHub = (ref: ObjectRef) => ref.product === "herdr" && ref.kind === "fleet" && ref.id === context.host
  const notHub = badRequest(`Relay here holds one conversation: product herdr, kind fleet, id ${context.host}.`)

  const answer = async (effect: Effect.Effect<{ readonly status: number; readonly json?: string }, Refusal, R>) => {
    const exit = await context.runtime.runPromiseExit(effect)
    if (exit._tag === "Success") send(response, exit.value.status, exit.value.json)
    else {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (failure !== undefined && failure._tag === "Fail") refuseWith(response, failure.error)
      else send(response, 500, JSON.stringify({ error: "internal" }))
    }
  }

  const harness = Effect.mapError(context.mount.harness, unavailableOf)
  const queryRef = decodeRef({
    product: url.searchParams.get("product"),
    kind: url.searchParams.get("kind"),
    id: url.searchParams.get("id")
  }).pipe(
    Effect.mapError(() => badRequest("Name the conversation: product, kind and id.")),
    Effect.filterOrFail(isHub, () => notHub)
  )
  /** A POST body, decoded, about the hub's own conversation. */
  const body = <A extends { readonly ref: ObjectRef }>(schema: Schema.Codec<A, unknown, never, never>) =>
    context.readJson(schema).pipe(
      Effect.mapError(() => badRequest("The request body is not one this route accepts.")),
      Effect.filterOrFail(({ ref }) => isHub(ref), () => notHub)
    )

  switch (route) {
    case "events": {
      const prepared = await context.runtime.runPromiseExit(
        Effect.all([queryRef, harness]).pipe(Effect.mapError((refusal) => refusal))
      )
      if (prepared._tag === "Failure") {
        const failure = prepared.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure !== undefined && failure._tag === "Fail") refuseWith(response, failure.error)
        else send(response, 500, JSON.stringify({ error: "internal" }))
        return true
      }
      if (left) return true
      const [ref, relay] = prepared.value
      onLeave = streamEvents(response, relay, ref, context)
      return true
    }
    case "session":
      await answer(
        Effect.gen(function*() {
          const ref = yield* queryRef
          const relay = yield* harness
          const info = yield* relay.session(ref).pipe(Effect.mapError(storeFailed))
          return { status: 200, json: yield* Effect.orDie(encodeSession(info)) }
        })
      )
      return true
    case "backends":
      await answer(
        Effect.gen(function*() {
          const relay = yield* harness
          const statuses = yield* relay.backends
          return { status: 200, json: yield* Effect.orDie(encodeBackends(statuses)) }
        })
      )
      return true
    case "messages":
      await answer(
        Effect.gen(function*() {
          const { backend, ref, requestId, text } = yield* body(RelayMessageRequest)
          const relay = yield* harness
          yield* relay.send(ref, text, requestId, backend === undefined ? {} : { backend }).pipe(
            Effect.catchTags({
              RelayBackendNotConfigured: ({ backend: refused }) =>
                Effect.fail(badRequest(`Backend ${refused} is not offered here.`)),
              RelayStoreFailed: (failure) => Effect.fail(storeFailed(failure))
            })
          )
          return { status: 202, json: JSON.stringify({ runId: requestId }) }
        })
      )
      return true
    case "cancel":
      await answer(
        Effect.gen(function*() {
          const { ref, runId } = yield* body(RelayCancelRequest)
          const relay = yield* harness
          yield* relay.cancel(ref, runId).pipe(
            Effect.catchTags({
              RelayRunNotActive: () => Effect.fail(conflict({ _tag: "NotRunning" })),
              RelayStoreFailed: (failure) => Effect.fail(storeFailed(failure))
            })
          )
          return { status: 204 }
        })
      )
      return true
    default:
      await answer(
        Effect.gen(function*() {
          const { allow, callId, ref } = yield* body(RelayDecisionRequest)
          const relay = yield* harness
          yield* relay.decide(ref, callId, allow).pipe(
            Effect.catchTags({
              RelayDecisionNotPending: ({ state }) => Effect.fail(conflict(state)),
              RelayStoreFailed: (failure) => Effect.fail(storeFailed(failure))
            })
          )
          return { status: 204 }
        })
      )
      return true
  }
}

/**
 * Streams the conversation's events until the session ends or the stream fails; returns what ends it early,
 * for when the browser leaves.
 */
const streamEvents = <E, R>(
  response: ServerResponse,
  relay: Relay.RelayHarnessService,
  ref: ObjectRef,
  context: RelayRouteContext<E, R>
): () => void => {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "content-type": "text/event-stream",
    "x-accel-buffering": "no"
  })
  const events = relay.events(ref).pipe(
    Stream.mapEffect((event) => Effect.orDie(encodeFrame(event))),
    Stream.map((frame) => `data: ${frame}\n\n`),
    Stream.catch((failure) =>
      Stream.fromEffect(
        Effect.logWarning("Relay event stream failed", failure).pipe(Effect.as(frameOf("StreamFailed")))
      )
    )
  )
  const unauthorized = frameOf("Unauthorized")
  // The authorization is re-run on the heartbeat; the stream ends after telling the panel it no longer holds.
  const liveness = Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
    Stream.mapEffect(() =>
      context.authorize.pipe(
        Effect.as(heartbeat),
        Effect.catch((refused) =>
          Effect.logInfo("Relay stream ended: the request is no longer authorized", refused).pipe(
            Effect.as(unauthorized)
          )
        )
      )
    ),
    Stream.takeUntil((chunk) => chunk === unauthorized)
  )
  const fiber = context.runtime.runFork(
    Stream.merge(events, liveness, { haltStrategy: "either" }).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => response.write(chunk))),
      Effect.ensuring(Effect.sync(() => response.end()))
    )
  )
  return () => {
    context.runtime.runFork(Fiber.interrupt(fiber))
  }
}
