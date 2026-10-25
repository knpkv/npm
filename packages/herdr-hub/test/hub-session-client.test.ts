// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { Schema } from "effect"
import { Effect } from "effect"
import type { HttpBody } from "effect/http"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
  loadHubSession,
  logInWithTailscale,
  logOutOfHub,
  type SessionTokenStore,
  spendLoginCode,
  takeLoginFragment
} from "../src/hub-session-client.js"

type Seen = {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: HttpBody.HttpBody
}

const answering = (status: number, body: Schema.Json, seen?: (request: Seen) => void) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      seen?.({ url: request.url, method: request.method, headers: request.headers, body: request.body })
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }))
    })
  )

/** A token store over a plain variable, standing in for the page's session storage. */
const memoryStore = (initial: string | null = null): SessionTokenStore & { readonly current: () => string | null } => {
  let token = initial
  return {
    read: () => token,
    write: (next) => {
      token = next
    },
    clear: () => {
      token = null
    },
    current: () => token
  }
}

const bodyText = (body: HttpBody.HttpBody | undefined) =>
  body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : null

const token = "a".repeat(64)
const csrf = "b".repeat(64)
const code = "c".repeat(64)

// Over Tailscale the cookie carries the session; on loopback the page sends the token it keeps.
it.effect("reads the session, sending the kept local token only when there is one", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const signedIn = { signedIn: true, kind: "local", expiresAt: 1, csrf }
    const view = yield* loadHubSession(memoryStore(token)).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, signedIn, (request) => seen.push(request)))
    )
    expect(view).toEqual(signedIn)
    expect(seen.map(({ headers, url }) => [url, headers["x-herdr-session"]])).toEqual([["/v1/session", token]])
    const tailnet = { signedIn: false, kind: "tailscale", login: "owner@example.test", device: "owner-phone" }
    const none: Array<Seen> = []
    expect(
      yield* loadHubSession(memoryStore()).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(200, tailnet, (request) => none.push(request)))
      )
    ).toEqual(tailnet)
    expect(none[0]?.headers["x-herdr-session"]).toBeUndefined()
  }))

it.effect("logs in with Tailscale by one POST, and says when the hub refused", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const answer = { signedIn: true, kind: "tailscale", expiresAt: 1, csrf }
    yield* logInWithTailscale.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, answer, (request) => seen.push(request)))
    )
    expect(seen.map(({ method, url }) => [url, method])).toEqual([["/v1/session/tailscale", "POST"]])
    const refused = yield* logInWithTailscale.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(403, { error: "forbidden" })),
      Effect.flip
    )
    expect(refused.reason).toBe("refused")
  }))

// The page trades the one-time code for a token it keeps in its own storage, never a cookie.
it.effect("spends a login code for a token it keeps, and keeps nothing when the code is refused", () =>
  Effect.gen(function*() {
    const store = memoryStore()
    const seen: Array<Seen> = []
    yield* spendLoginCode(code, store).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answering(200, { signedIn: true, kind: "local", expiresAt: 1, token, csrf }, (request) => seen.push(request))
      )
    )
    expect(store.current()).toBe(token)
    expect(bodyText(seen[0]?.body)).toBe(JSON.stringify({ code }))
    const empty = memoryStore()
    const refused = yield* spendLoginCode(code, empty).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(401, { error: "code_rejected" })),
      Effect.flip
    )
    expect([refused.reason, empty.current()]).toEqual(["refused", null])
  }))

it.effect("logs out with the session's CSRF token and forgets the kept token", () =>
  Effect.gen(function*() {
    const store = memoryStore(token)
    const seen: Array<Seen> = []
    yield* logOutOfHub(csrf, store).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, { signedIn: false }, (request) => seen.push(request)))
    )
    expect(seen.map(({ headers, url }) => [url, headers["x-herdr-csrf"], headers["x-herdr-session"]])).toEqual([
      ["/v1/session/logout", csrf, token]
    ])
    expect(store.current()).toBeNull()
  }))

// A refused logout means the session already ended on the hub: the dead token goes. A network failure may
// not have reached the hub, so the token stays.
it.effect("forgets the kept token when logout is refused, and keeps it when the hub wasn't reached", () =>
  Effect.gen(function*() {
    const refusedStore = memoryStore(token)
    yield* logOutOfHub(csrf, refusedStore).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(403, { error: "forbidden" })),
      Effect.flip
    )
    expect(refusedStore.current()).toBeNull()
    const offlineStore = memoryStore(token)
    const offline = HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
    )
    yield* logOutOfHub(csrf, offlineStore).pipe(Effect.provideService(HttpClient.HttpClient, offline), Effect.flip)
    expect(offlineStore.current()).toBe(token)
  }))

// The code must not stay in history, session restore or synced tabs: the fragment is gone before it is spent.
it("takes the login code out of the address, leaving the rest", () => {
  window.history.replaceState(null, "", `/?range=7d#login=${code}`)
  expect(takeLoginFragment(window.location, window.history)).toBe(code)
  expect(window.location.hash).toBe("")
  expect(window.location.search).toBe("?range=7d")
  window.history.replaceState(null, "", "/#fleet/approvals")
  expect(takeLoginFragment(window.location, window.history)).toBeNull()
  expect(window.location.hash).toBe("#fleet/approvals")
  window.history.replaceState(null, "", "/#login=not-a-code")
  expect(takeLoginFragment(window.location, window.history)).toBeNull()
  expect(window.location.hash).toBe("")
})
