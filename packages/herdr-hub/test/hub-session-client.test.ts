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

const bodyText = (body: HttpBody.HttpBody | undefined) =>
  body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : null

const csrf = "b".repeat(64)
const code = "c".repeat(64)

// A cookie carries the session on both listeners: the page sends no credential of its own.
it.effect("reads the session without a credential header, and decodes what the gate needs", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    const signedIn = { signedIn: true, kind: "local", expiresAt: 1, csrf }
    const view = yield* loadHubSession.pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, signedIn, (request) => seen.push(request)))
    )
    expect(view).toEqual(signedIn)
    expect(seen.map(({ headers, url }) => [url, headers["x-herdr-session"]])).toEqual([["/v1/session", undefined]])
    const ended = {
      signedIn: false,
      kind: "tailscale",
      login: "owner@example.test",
      device: "owner-phone",
      fleetHost: true,
      ended: true
    }
    expect(
      yield* loadHubSession.pipe(Effect.provideService(HttpClient.HttpClient, answering(200, ended)))
    ).toEqual(ended)
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

// The page spends the one-time code; the hub answers with the session cookie, which the page never sees.
it.effect("spends a login code by one POST, and says when the code was refused", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    yield* spendLoginCode(code).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answering(200, { signedIn: true, kind: "local", expiresAt: 1, csrf }, (request) => seen.push(request))
      )
    )
    expect(seen.map(({ method, url }) => [url, method])).toEqual([["/v1/session/local", "POST"]])
    expect(bodyText(seen[0]?.body)).toBe(JSON.stringify({ code }))
    const refused = yield* spendLoginCode(code).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(401, { error: "code_rejected" })),
      Effect.flip
    )
    expect(refused.reason).toBe("refused")
  }))

it.effect("logs out with the session's CSRF token", () =>
  Effect.gen(function*() {
    const seen: Array<Seen> = []
    yield* logOutOfHub(csrf).pipe(
      Effect.provideService(HttpClient.HttpClient, answering(200, { signedIn: false }, (request) => seen.push(request)))
    )
    expect(seen.map(({ headers, url }) => [url, headers["x-herdr-csrf"]])).toEqual([["/v1/session/logout", csrf]])
    const offline = HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
    )
    const failed = yield* logOutOfHub(csrf).pipe(Effect.provideService(HttpClient.HttpClient, offline), Effect.flip)
    expect(failed.reason).toBe("network")
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
