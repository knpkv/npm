/**
 * The live-updates socket: `GET /api/live` upgrades to a WebSocket that sends the current
 * {@link LiveVersions} and then every change, so the page refetches a read only when it moved.
 *
 * **Mental model**
 *
 * - **The same door as every read.** The upgrade is admitted by the owner-session check the API
 *   uses, unchanged: the session cookie, the page's own origin, Fetch Metadata, a read method.
 *   Anything else is refused before the socket exists.
 * - **Versions, not data.** A message names which reads moved; the page fetches them through the
 *   ordinary authenticated routes, so the socket adds no second path to the data.
 * - **Moved after commit.** The runtime moves a counter once the store holds the change, so a
 *   refetch triggered by a message always sees it.
 *
 * @module
 */
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Schema, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { LiveVersions } from "../shared/contracts.js"
import { RuntimeState } from "./Runtime.js"

const encodeVersions = Schema.encodeSync(Schema.fromJsonString(LiveVersions))

const refusal = (status: 401 | 403, message: string) =>
  HttpServerResponse.text(message, { status, headers: { "cache-control": "private, no-store" } })

const live = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const session = yield* OwnerSession.OwnerSession
  const state = yield* RuntimeState
  const admitted = yield* Effect.result(session.authorizeHttp(request.cookies[session.cookieName] ?? ""))
  if (admitted._tag === "Failure") {
    return admitted.failure._tag === "OwnerSessionUnauthorizedError"
      ? refusal(401, admitted.failure.message)
      : refusal(403, admitted.failure.message)
  }
  const socket = yield* request.upgrade
  const write = yield* socket.writer
  const reader = yield* socket.reader
  // Messages from the page are not expected; reading only notices that it went away.
  // best-effort: the read failing is how a closed page is noticed, so its error is the expected end.
  const closed = Effect.forever(reader.pull).pipe(Effect.ignore)
  // best-effort: a write fails once the page has gone, which ends this connection like the read does.
  const pushing = SubscriptionRef.changes(state.versions).pipe(
    Stream.runForEach((versions) => write.write(encodeVersions(versions))),
    Effect.ignore
  )
  yield* Effect.raceFirst(pushing, closed)
  return HttpServerResponse.empty()
}).pipe(
  Effect.scoped,
  Effect.catchTag("HttpServerError", () => Effect.succeed(refusal(403, "Not a WebSocket upgrade")))
)

export const LiveRouter = HttpRouter.use((router) => router.add("GET", "/api/live", live))
