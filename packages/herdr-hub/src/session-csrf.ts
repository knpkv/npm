/**
 * The page's copy of its session's CSRF token, and the HTTP client that sends it with every write.
 *
 * **Mental model**
 *
 * - **The session read is the only source.** `GET /v1/session` returns the token while the page is logged in;
 *   the session hook {@link CsrfStore.remember}s each read that lands, so a log-in fills the store, a log-out
 *   or an ended session empties it, and logging in as someone else replaces it.
 * - **Writes to the hub carry it; nothing else does.** {@link withSessionCsrf} adds `x-herdr-csrf` to a
 *   same-origin request that isn't a read, and only while the store holds a token. A request that already
 *   names one (log-out) keeps its own; a request to another origin never sees it.
 * - **One store per page.** The super-app's runtimes that write (the dashboard's, which Relay and the modules
 *   share, and the notification settings') take {@link sessionCsrfLayer}, so each sends what the one session
 *   hook read. herdr-connect's own runtimes only read.
 *
 * @module
 */
import { BrowserHttpClient } from "@effect/platform-browser"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { csrfHeader, type HubSessionView } from "./hub-session-client.js"

/** Where the page keeps the token its latest session read returned. */
export interface CsrfStore {
  /** The token, or null while the page is logged out or hasn't read its session yet. */
  readonly current: () => string | null
  /** Keeps what a session read says: its token when logged in, none otherwise. */
  readonly remember: (view: HubSessionView) => void
  /** Drops the token, as after logging out. */
  readonly forget: () => void
}

/** A store of its own; the page uses {@link sessionCsrf}. */
export const makeCsrfStore = (): CsrfStore => {
  let token: string | null = null
  return {
    current: () => token,
    remember: (view) => {
      token = view.signedIn ? view.csrf : null
    },
    forget: () => {
      token = null
    }
  }
}

/** The page's one store, filled by the session hook. */
export const sessionCsrf: CsrfStore = makeCsrfStore()

const reads: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/** Whether `url` (relative, or absolute) names a resource on `origin`. */
const onOrigin = (url: string, origin: string): boolean =>
  (url.startsWith("/") && !url.startsWith("//")) || url === origin || url.startsWith(`${origin}/`)

/** `request` with the store's token, when it is a write to the page's own origin and the store holds one. */
export const addSessionCsrf = (
  store: CsrfStore,
  origin: string
) =>
(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
  const token = store.current()
  return token === null || reads.has(request.method) || !onOrigin(request.url, origin) ||
      request.headers[csrfHeader] !== undefined
    ? request
    : HttpClientRequest.setHeader(request, csrfHeader, token)
}

/** `client`, sending the store's token with each write to `origin`. */
export const withSessionCsrf = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  store: CsrfStore,
  origin: string
): HttpClient.HttpClient.With<E, R> => HttpClient.mapRequest(client, addSessionCsrf(store, origin))

/** The browser's fetch client, sending the page's session token with its writes to the hub. */
export const sessionCsrfLayer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return withSessionCsrf(client, sessionCsrf, window.location.origin)
  })
).pipe(Layer.provide(BrowserHttpClient.layerFetch))
