/**
 * The page's side of logging in to the hub (`/v1/session`).
 *
 * **Mental model**
 *
 * - **A cookie carries the session on both listeners.** The hub sets an HttpOnly cookie when the person
 *   presses Log in with Tailscale, or when the page spends `herdr-hub login`'s one-time code on loopback; this
 *   page never sees the token, and every request it makes, the terminal included, sends it.
 * - **The code leaves the address first.** `herdr-hub login` opens the page with the code in the URL fragment;
 *   the page takes it out ({@link takeLoginFragment}) before spending it.
 * - **Writes carry the CSRF token** the session read returned.
 *
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/** The header a session's writes carry its CSRF token in. */
const csrfHeader = "x-herdr-csrf"
const Credential = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

/** What `GET /v1/session` says about the caller. */
export const HubSessionView = Schema.Union([
  Schema.Struct({
    signedIn: Schema.Literal(true),
    kind: Schema.Literal("tailscale"),
    login: Schema.String,
    device: Schema.optionalKey(Schema.String),
    expiresAt: Schema.Number,
    csrf: Credential
  }),
  Schema.Struct({
    signedIn: Schema.Literal(false),
    kind: Schema.Literal("tailscale"),
    login: Schema.String,
    device: Schema.optionalKey(Schema.String),
    /** The caller's node runs agents. */
    fleetHost: Schema.optionalKey(Schema.Boolean),
    /** The request carried a session that has ended. */
    ended: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.Struct({
    signedIn: Schema.Literal(true),
    kind: Schema.Literal("local"),
    expiresAt: Schema.Number,
    csrf: Credential
  }),
  Schema.Struct({
    signedIn: Schema.Literal(false),
    kind: Schema.Literal("local"),
    ended: Schema.optionalKey(Schema.Boolean)
  })
])
export type HubSessionView = typeof HubSessionView.Type

/** The session read failed; the page keeps showing what it last knew. */
export class HubSessionReadFailed extends Schema.TaggedError<HubSessionReadFailed>()("HubSessionReadFailed", {
  detail: Schema.Literals(["network", "status", "invalid_response"])
}) {}

/** A log-in or log-out did not happen: the hub `refused` it, or it may not have reached the hub (`network`). */
export class HubSessionChangeFailed extends Schema.TaggedError<HubSessionChangeFailed>()("HubSessionChangeFailed", {
  reason: Schema.Literals(["refused", "network"])
}) {}

/** Who the caller is, and whether they are logged in. */
export const loadHubSession = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.get("/v1/session")).pipe(
    Effect.mapError(() => new HubSessionReadFailed({ detail: "network" }))
  )
  if (response.status !== 200) return yield* new HubSessionReadFailed({ detail: "status" })
  return yield* decodeBoundedResponseJson(response, HubSessionView, 4_096).pipe(
    Effect.mapError(() => new HubSessionReadFailed({ detail: "invalid_response" }))
  )
}).pipe(Effect.withSpan("HubSessionClient.load"))

/** One POST with a JSON body; anything but 200 is refused. */
const post = Effect.fn("HubSessionClient.post")(function*(
  request: HttpClientRequest.HttpClientRequest,
  body: Schema.Json
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.bodyJsonUnsafe(request, body)).pipe(
    Effect.mapError(() => new HubSessionChangeFailed({ reason: "network" }))
  )
  if (response.status !== 200) return yield* new HubSessionChangeFailed({ reason: "refused" })
  return response
})

/** Logs the Tailscale person in on this device; the hub sets the session cookie. */
export const logInWithTailscale = post(HttpClientRequest.post("/v1/session/tailscale"), {}).pipe(
  Effect.asVoid,
  Effect.withSpan("HubSessionClient.logInWithTailscale")
)

/** Spends `herdr-hub login`'s one-time code; the hub sets the local session cookie. */
export const spendLoginCode = Effect.fn("HubSessionClient.spendLoginCode")(function*(code: string) {
  yield* post(HttpClientRequest.post("/v1/session/local"), { code })
})

/** Logs out with the session's CSRF token; the hub clears the session cookie. */
export const logOutOfHub = Effect.fn("HubSessionClient.logOut")(function*(csrf: string) {
  yield* post(HttpClientRequest.setHeader(HttpClientRequest.post("/v1/session/logout"), csrfHeader, csrf), {})
})

/**
 * The one-time code in a `#login=<code>` fragment, taken out of the address first so it stays in no
 * history entry, restored session or synced tab. Null when the fragment carries none; a malformed
 * `#login=` is removed too.
 */
export const takeLoginFragment = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">
): string | null => {
  if (!location.hash.startsWith("#login=")) return null
  const code = location.hash.slice("#login=".length)
  history.replaceState(null, "", `${location.pathname}${location.search}`)
  return Schema.is(Credential)(code) ? code : null
}
