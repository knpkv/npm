/**
 * The browser side of a product's `/…/relay` routes: one conversation's event stream, and the writes.
 *
 * **Mental model**
 *
 * - **The stream is plain HTTP.** `events` is read through `HttpClient` and decoded as server-sent events,
 *   so the response status is visible: 401/403 stops with `Unauthorized`, a dropped or refused connection
 *   reconnects after `Disconnected`, and a frame this client can't read stops with `StreamFailed`.
 *   Every reconnect is a new subscription, which starts from a Snapshot.
 * - **The stream carries only the server's events.** It never waits on another request: the session's
 *   backend is read with `sessionBackend`, beside the stream, by whoever holds it.
 * - **Writes answer with what happened.** A refused write fails with the reason the server gave
 *   (`RelayConflictError` carries the state it found); a request that never got an answer fails with
 *   `RelayTransportFailed`.
 *
 * @module
 */
import {
  BackendStatus,
  type ObjectRef,
  RelayBadRequestError,
  type RelayCancelRequest,
  RelayConflictError,
  type RelayDecisionRequest,
  RelayMessageAccepted,
  type RelayMessageRequest,
  RelayStreamFrame,
  RelayUnavailableError,
  SessionInfo
} from "@knpkv/relay/wire"
import { Data, Duration, Effect, Schedule, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

import type { RelayClientEvent } from "./relay-fold.js"

/** The browser's session no longer opens Relay here (401 or 403). */
export class RelayUnauthorized extends Data.TaggedError("RelayUnauthorized")<{ readonly status: number }> {}

/** The request got no answer this client can read: unreachable, or a reply in an unexpected shape. */
export class RelayTransportFailed extends Data.TaggedError("RelayTransportFailed")<{
  readonly status: number
  readonly reason: "unreachable" | "unreadable" | "unexpected-status"
}> {}

export type RelayRequestFailure =
  | RelayBadRequestError
  | RelayConflictError
  | RelayTransportFailed
  | RelayUnauthorized
  | RelayUnavailableError

/** Where a product mounts its Relay routes, such as `/api/relay` or `/v1/relay`, on the page's origin. */
export interface RelayClientOptions {
  readonly base: string
  /** The page's URL, which `base` resolves against. */
  readonly origin: string
}

const ErrorBody = Schema.Union([RelayUnavailableError, RelayConflictError, RelayBadRequestError])
const decodeErrorBody = Schema.decodeUnknownEffect(ErrorBody)

/**
 * A product's Relay routes as typed calls. Each needs an `HttpClient`; the page provides the fetch one at
 * its edge.
 */
export const makeRelayClient = ({ base, origin }: RelayClientOptions) => {
  /** A route under `base`; with `ref`, the conversation it is about, as the query names it. */
  const url = (path: string, ref?: ObjectRef): string => {
    const resolved = new URL(`${base.replace(/\/$/u, "")}/${path}`, origin)
    if (ref !== undefined) {
      resolved.searchParams.set("product", ref.product)
      resolved.searchParams.set("kind", ref.kind)
      resolved.searchParams.set("id", ref.id)
    }
    return resolved.href
  }

  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(request).pipe(
        Effect.mapError(() => new RelayTransportFailed({ reason: "unreachable", status: 0 }))
      )
      if (response.status === 401 || response.status === 403) {
        return yield* new RelayUnauthorized({ status: response.status })
      }
      if (response.status >= 400) return yield* refusal(response)
      return response
    })

  /** A 4xx/5xx as the server's typed refusal, or as an unexpected status when its body isn't one. */
  const refusal = Effect.fn("RelayClient.refusal")(function*(response: HttpClientResponse.HttpClientResponse) {
    const unexpected = new RelayTransportFailed({ reason: "unreadable", status: response.status })
    const refused = yield* response.json.pipe(
      Effect.flatMap(decodeErrorBody),
      Effect.mapError(() => unexpected)
    )
    return yield* refused
  })

  /** A request whose 2xx body `schema` reads. */
  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    request: HttpClientRequest.HttpClientRequest,
    schema: S
  ) =>
    execute(request).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(() => new RelayTransportFailed({ reason: "unreadable", status: response.status }))
        )
      )
    )

  const post = (path: string, body: RelayCancelRequest | RelayDecisionRequest | RelayMessageRequest) =>
    HttpClientRequest.post(url(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body))

  /** The session's tools, the backend its next turn runs on, and whether a run can be stopped. */
  const session = (ref: ObjectRef) => read(HttpClientRequest.get(url("session", ref)), SessionInfo)

  /** Every backend this server offers, with its status. */
  const backends = read(HttpClientRequest.get(url("backends")), Schema.Array(BackendStatus))

  /** The status of the backend `ref`'s next turn runs on, or nothing when the server doesn't list it. */
  const sessionBackend = (ref: ObjectRef) =>
    Effect.all([session(ref), backends], { concurrency: 2 }).pipe(
      Effect.map(([info, all]) => all.find(({ backend }) => backend === info.backend) ?? null)
    )

  /**
   * Sends a message. `requestId` is the caller's, so a retry with the same one lands once; the run that
   * answers carries it. `backend` switches the session from its next turn on.
   */
  const message = (
    ref: ObjectRef,
    text: string,
    requestId: string,
    backend?: RelayMessageRequest["backend"]
  ) =>
    read(
      post("messages", backend === undefined ? { ref, requestId, text } : { backend, ref, requestId, text }),
      RelayMessageAccepted
    )

  /** Withdraws a queued message or stops the run in flight. */
  const cancel = (ref: ObjectRef, runId: string) => execute(post("cancel", { ref, runId })).pipe(Effect.asVoid)

  /** Answers one confirmation card. */
  const decide = (ref: ObjectRef, callId: string, allow: boolean) =>
    execute(post("decisions", { allow, callId, ref })).pipe(Effect.asVoid)

  /** One subscription: its frames until the stream ends, or the reason it couldn't open. */
  const subscription = (ref: ObjectRef) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get(url("events", ref))).pipe(
          Effect.mapError(() => new RelayTransportFailed({ reason: "unreachable", status: 0 }))
        )
        if (response.status === 401 || response.status === 403) {
          return Stream.succeed<RelayClientEvent>({ _tag: "Unauthorized" })
        }
        if (response.status >= 400) {
          return yield* new RelayTransportFailed({ reason: "unexpected-status", status: response.status })
        }
        return response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decodeDataSchema(RelayStreamFrame)),
          Stream.map((event): RelayClientEvent => event.data),
          Stream.catchTags({
            // The server never asks for a retry interval; a frame that does is not one of ours.
            Retry: () => Stream.succeed<RelayClientEvent>({ _tag: "StreamFailed" }),
            SseError: () => Stream.succeed<RelayClientEvent>({ _tag: "StreamFailed" }),
            SchemaError: () => Stream.succeed<RelayClientEvent>({ _tag: "StreamFailed" }),
            HttpClientError: () => Stream.fail(new RelayTransportFailed({ reason: "unreachable", status: 0 }))
          })
        )
      })
    )

  /**
   * `ref`'s events for as long as the stream can be kept: `Disconnected` and a fresh subscription (a new
   * Snapshot) after a drop, backing off from 1 to 30 seconds; a subscription that reached its Snapshot
   * starts the backoff over. It ends after `Unauthorized` or `StreamFailed`.
   */
  const events = (ref: ObjectRef): Stream.Stream<RelayClientEvent, never, HttpClient.HttpClient> =>
    Stream.suspend(() => {
      // Attempts since the last Snapshot.
      let failures = 0
      const once: Stream.Stream<RelayClientEvent, never, HttpClient.HttpClient> = subscription(ref).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event._tag === "Snapshot") failures = 0
          })
        ),
        Stream.catch(() => Stream.empty),
        // A stream that ends without saying why dropped: say so, then let the retry below take over.
        Stream.concat(Stream.succeed<RelayClientEvent>({ _tag: "Disconnected" }))
      )
      const backoff = Schedule.forever.pipe(
        Schedule.modifyDelay(() =>
          Effect.sync(() => {
            failures += 1
            return Duration.millis(Math.min(1000 * 2 ** (failures - 1), 30_000))
          })
        )
      )
      const ended = (event: RelayClientEvent) => event._tag === "Unauthorized" || event._tag === "StreamFailed"
      return Stream.repeat(once, backoff).pipe(Stream.takeUntil(ended))
    })

  return { backends, cancel, decide, events, message, session, sessionBackend }
}

export type RelayClient = ReturnType<typeof makeRelayClient>
