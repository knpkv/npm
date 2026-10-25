/**
 * The page's copy of its session's CSRF token, and the HTTP client that sends it with every write.
 *
 * **Mental model**
 *
 * - **The session read is the only source.** `GET /v1/session` returns the token while the page is logged in.
 *   The session hook {@link CsrfStore.remember}s each read that lands (a log-in fills the store, logging in as
 *   someone else replaces it) and {@link CsrfStore.forget}s on a confirmed log-out.
 * - **The transport doesn't wait for the hook.** A page without the session hook (`/connect/`), or a write
 *   sent before the hook's first read lands, finds the store empty: {@link sessionCsrfClient} then reads the
 *   session itself, once for all the writes waiting, and sends the write with what it read. A write the hub
 *   refuses as `csrf_required` (the session changed, in this tab or another) reads the session again and is
 *   sent once more.
 * - **Writes to the hub carry it; nothing else does.** Only a request that isn't a read, to the page's own
 *   origin, outside `/apps/` (apps are never given the token), gets `x-herdr-csrf`. A request that already
 *   names one (log-out) keeps its own and is never retried.
 * - **One store per page.** The super-app's runtimes that write (the dashboard's, which Relay and the modules
 *   share, and the notification settings') take {@link sessionCsrfLayer}, so each sends what the one store
 *   holds. herdr-connect's own runtimes only read.
 *
 * @module
 */
import { BrowserHttpClient } from "@effect/platform-browser"
import { boundedResponseText } from "@knpkv/herdr-fleet/response"
import { Effect, Layer, Option, Schema, Semaphore } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { csrfHeader, type HubSessionView, loadHubSession } from "./hub-session-client.js"

/** Where the page keeps the token its latest session read returned. */
export interface CsrfStore {
  /** The token, or null while the page is logged out or hasn't read its session yet. */
  readonly current: () => string | null
  /** Keeps what a session read says: its token when logged in, none otherwise. */
  readonly remember: (view: HubSessionView) => void
  /** Drops the token, as after logging out. */
  readonly forget: () => void
  /** Lets one session read at a time fill the store, so writes waiting on it share one read. */
  readonly reading: Semaphore.Semaphore
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
    },
    reading: Semaphore.makeUnsafe(1)
  }
}

/** The page's one store, filled by the session hook. */
export const sessionCsrf: CsrfStore = makeCsrfStore()

const reads: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

const resolve = (url: string, origin: string) => Option.liftThrowable(() => new URL(url, origin))()

/**
 * Whether `url` (relative, or absolute) names one of the hub's own routes on `origin`: resolved as the browser
 * resolves it (`/\host/x` is another host), and not an app's (`/apps/<id>/…`).
 */
const onHub = (url: string, origin: string): boolean =>
  Option.match(resolve(url, origin), {
    onNone: () => false,
    onSome: (resolved) => resolved.origin === origin && !resolved.pathname.startsWith("/apps/")
  })

/** Whether `request` is a write to the hub that the transport gives the store's token. */
const takesToken = (request: HttpClientRequest.HttpClientRequest, origin: string): boolean =>
  !reads.has(request.method) && request.headers[csrfHeader] === undefined && onHub(request.url, origin)

/** `request` with the store's token, when it is a write to the page's own origin and the store holds one. */
export const addSessionCsrf = (
  store: CsrfStore,
  origin: string
) =>
(request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
  const token = store.current()
  return token === null || !takesToken(request, origin)
    ? request
    : HttpClientRequest.setHeader(request, csrfHeader, token)
}

const CsrfRefusal = Schema.fromJsonString(Schema.Struct({ error: Schema.Literal("csrf_required") }))

/**
 * Reads the session into `store` with `client`, unless the store no longer holds `stale` (another write read
 * it meanwhile). A read that fails leaves the store as it was; the write goes out without a token and the
 * hub's refusal reaches its caller.
 */
const readSession = (client: HttpClient.HttpClient, store: CsrfStore, stale: string | null) =>
  store.reading.withPermit(
    Effect.suspend(() =>
      store.current() !== stale
        ? Effect.void
        : loadHubSession.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.matchEffect({
            onFailure: (error) => Effect.logWarning("session CSRF: couldn't read the session", error),
            onSuccess: (view) => Effect.sync(() => store.remember(view))
          })
        )
    )
  )

/**
 * `response` whole, when it may be the hub refusing the session's token: whether it is, and the response with
 * its body still readable. Any other response is passed on untouched.
 */
const refusal = (request: HttpClientRequest.HttpClientRequest, response: HttpClientResponse.HttpClientResponse) =>
  response.status !== 403
    ? Effect.succeed({ refused: false, response })
    : boundedResponseText(response, 4_096).pipe(
      Effect.mapError((cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request, response, cause, description: "403 body unreadable" })
        })
      ),
      Effect.map((body) => ({
        refused: Option.isSome(Schema.decodeUnknownOption(CsrfRefusal)(body)),
        response: HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: response.status, headers: response.headers })
        )
      }))
    )

/**
 * `client`, sending the store's token with each write to the hub on `origin`: read first when the store is
 * empty, and read again (and sent once more) when the hub refuses it as `csrf_required`.
 */
export const sessionCsrfClient = (client: HttpClient.HttpClient, store: CsrfStore, origin: string) => {
  const withToken = addSessionCsrf(store, origin)
  return HttpClient.transform(client, (effect, request) =>
    !takesToken(request, origin)
      ? effect
      : Effect.gen(function*() {
        if (store.current() === null) yield* readSession(client, store, null)
        const sent = store.current()
        const first = yield* refusal(request, yield* client.execute(withToken(request)))
        if (!first.refused) return first.response
        yield* readSession(client, store, sent)
        return yield* client.execute(withToken(request))
      }))
}

/** The browser's fetch client, sending the page's session token with its writes to the hub. */
export const sessionCsrfLayer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return sessionCsrfClient(client, sessionCsrf, window.location.origin)
  })
).pipe(Layer.provide(BrowserHttpClient.layerFetch))
