/**
 * The page's side of logging in to the hub (`/v1/session`).
 *
 * **Mental model**
 *
 * - **Over Tailscale the cookie carries the session.** The hub sets an HttpOnly `__Host-` cookie when the
 *   person presses Log in with Tailscale; this page never sees the token.
 * - **On loopback the page carries it.** `herdr-hub login` opens the page with a one-time code in the URL
 *   fragment. The page takes the code out of the address first ({@link takeLoginFragment}), spends it, and
 *   keeps the token it gets in its own session storage, sending it as `x-herdr-session`. Cookies don't
 *   separate ports, so a loopback cookie would reach every local server.
 * - **Writes carry the CSRF token** the session read returned.
 *
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/** The header the loopback page sends its session token in. */
const sessionHeader = "x-herdr-session"
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
    device: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    signedIn: Schema.Literal(true),
    kind: Schema.Literal("local"),
    expiresAt: Schema.Number,
    csrf: Credential
  }),
  Schema.Struct({ signedIn: Schema.Literal(false), kind: Schema.Literal("local") })
])
export type HubSessionView = typeof HubSessionView.Type

const LocalSessionMinted = Schema.Struct({ token: Credential })

/** Where the loopback page keeps its session token: the page's own session storage in the browser. */
export interface SessionTokenStore {
  readonly read: () => string | null
  readonly write: (token: string) => void
  readonly clear: () => void
}

/** The session read failed; the page keeps showing what it last knew. */
export class HubSessionReadFailed extends Schema.TaggedError<HubSessionReadFailed>()("HubSessionReadFailed", {
  detail: Schema.Literals(["network", "status", "invalid_response"])
}) {}

/** A log-in or log-out did not happen: the hub `refused` it, or it may not have reached the hub (`network`). */
export class HubSessionChangeFailed extends Schema.TaggedError<HubSessionChangeFailed>()("HubSessionChangeFailed", {
  reason: Schema.Literals(["refused", "network"])
}) {}

const withToken = (store: SessionTokenStore) => (request: HttpClientRequest.HttpClientRequest) => {
  const token = store.read()
  return token === null ? request : HttpClientRequest.setHeader(request, sessionHeader, token)
}

/** Who the caller is, and whether they are logged in. */
export const loadHubSession = Effect.fn("HubSessionClient.load")(function*(store: SessionTokenStore) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(withToken(store)(HttpClientRequest.get("/v1/session"))).pipe(
    Effect.mapError(() => new HubSessionReadFailed({ detail: "network" }))
  )
  if (response.status !== 200) return yield* new HubSessionReadFailed({ detail: "status" })
  return yield* decodeBoundedResponseJson(response, HubSessionView, 4_096).pipe(
    Effect.mapError(() => new HubSessionReadFailed({ detail: "invalid_response" }))
  )
})

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

/** Spends `herdr-hub login`'s one-time code, keeping the local session token it gets. */
export const spendLoginCode = Effect.fn("HubSessionClient.spendLoginCode")(function*(
  code: string,
  store: SessionTokenStore
) {
  const response = yield* post(HttpClientRequest.post("/v1/session/local"), { code })
  const minted = yield* decodeBoundedResponseJson(response, LocalSessionMinted, 4_096).pipe(
    Effect.mapError(() => new HubSessionChangeFailed({ reason: "refused" }))
  )
  store.write(minted.token)
})

/**
 * Logs out with the session's CSRF token, and forgets the kept local token. A refused logout means the hub
 * no longer holds that session, so the token goes then too; after a network failure it stays, since the
 * logout may not have happened.
 */
export const logOutOfHub = Effect.fn("HubSessionClient.logOut")(function*(csrf: string, store: SessionTokenStore) {
  const request = withToken(store)(
    HttpClientRequest.setHeader(HttpClientRequest.post("/v1/session/logout"), csrfHeader, csrf)
  )
  yield* post(request, {}).pipe(
    Effect.tapError((failure) => failure.reason === "refused" ? Effect.sync(store.clear) : Effect.void)
  )
  store.clear()
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
