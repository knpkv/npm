// @vitest-environment happy-dom

import { Effect, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HubSessionReadFailed, type HubSessionView } from "../src/hub-session-client.js"
import { type HubSessionActions, useHubSession } from "../src/hub-session-view.js"
import { addSessionCsrf, makeCsrfStore, sessionCsrf, sessionCsrfLayer } from "../src/session-csrf.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}
window.IS_REACT_ACT_ENVIRONMENT = true

const origin = "http://127.0.0.1:7000"
const first = "a".repeat(64)
const second = "b".repeat(64)
const signedIn = (csrf: string): HubSessionView => ({ signedIn: true, kind: "local", expiresAt: 0, csrf })
const signedOut: HubSessionView = { signedIn: false, kind: "local" }

afterEach(() => {
  sessionCsrf.forget()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe("session CSRF", () => {
  const filled = () => {
    const store = makeCsrfStore()
    store.remember(signedIn(first))
    return store
  }
  const sent = (request: HttpClientRequest.HttpClientRequest, store = filled()) =>
    addSessionCsrf(store, origin)(request).headers["x-herdr-csrf"]

  // Every write to the hub carries the token: a path, or the hub's own absolute URL (Relay's client).
  it("adds the token to a write to the page's own origin", () => {
    expect(sent(HttpClientRequest.post("/v1/jobs/job-1/approve"))).toBe(first)
    expect(sent(HttpClientRequest.delete(`${origin}/v1/push/subscriptions`))).toBe(first)
    expect(sent(HttpClientRequest.patch(origin))).toBe(first)
  })

  // Reads don't need it, and it never leaves the hub's origin.
  it("leaves reads and other origins without it", () => {
    expect(sent(HttpClientRequest.get("/v1/dashboard"))).toBeUndefined()
    expect(sent(HttpClientRequest.head("/v1/dashboard"))).toBeUndefined()
    expect(sent(HttpClientRequest.post("https://push.example.test/send"))).toBeUndefined()
    expect(sent(HttpClientRequest.post("//push.example.test/send"))).toBeUndefined()
    expect(sent(HttpClientRequest.post("http://127.0.0.1:7001/v1/jobs"))).toBeUndefined()
    expect(sent(HttpClientRequest.post(`${origin}.example.test/v1/jobs`))).toBeUndefined()
  })

  // Logged out, there is nothing to send; a request that names its own token (log-out) keeps it.
  it("sends nothing while logged out and keeps a token the request names", () => {
    const store = makeCsrfStore()
    expect(sent(HttpClientRequest.post("/v1/jobs"), store)).toBeUndefined()
    store.remember(signedIn(first))
    store.remember(signedOut)
    expect(sent(HttpClientRequest.post("/v1/jobs"), store)).toBeUndefined()
    const named = HttpClientRequest.setHeader(HttpClientRequest.post("/v1/session/logout"), "x-herdr-csrf", second)
    expect(sent(named)).toBe(second)
  })

  // The browser runtimes' client: the page's store, the page's origin, the browser's fetch.
  it("sends the page's token through the browser client", async () => {
    const seen: Array<string | null> = []
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("x-herdr-csrf"))
      return Promise.resolve(new Response("{}"))
    })
    // The page's runtimes are built the same way, from the layer.
    const runtime = ManagedRuntime.make(sessionCsrfLayer)
    const post = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      yield* client.execute(HttpClientRequest.post("/v1/jobs/job-1/approve"))
    })
    await runtime.runPromise(post)
    sessionCsrf.remember(signedIn(first))
    await runtime.runPromise(post)
    await runtime.dispose()
    expect(seen).toEqual([null, first])
  })

  // The session hook fills the store: a log-in fills it, a switch replaces it, a log-out clears it at once.
  it("follows the session hook through log-in, a session switch and log-out", async () => {
    const store = makeCsrfStore()
    const reads = [signedIn(first), signedIn(second)]
    let current: HubSessionView = signedOut
    let reachable = true
    const actions: HubSessionActions = {
      load: Effect.suspend(() =>
        reachable ? Effect.succeed(current) : Effect.fail(new HubSessionReadFailed({ detail: "network" }))
      ),
      logIn: Effect.sync(() => {
        current = reads.shift() ?? signedOut
      }),
      logOut: () => Effect.void,
      spendLoginCode: () => Effect.void,
      csrf: store
    }
    let session: ReturnType<typeof useHubSession> | undefined
    const Probe = () => {
      session = useHubSession(actions)
      return null
    }
    const settle = () =>
      act(async () => {
        for (let index = 0; index < 24; index += 1) await Promise.resolve()
      })
    const root = createRoot(document.body.appendChild(document.createElement("div")))
    await act(async () => root.render(<Probe />))
    await settle()
    expect(store.current()).toBeNull()

    await act(async () => session?.logIn())
    await settle()
    expect(store.current()).toBe(first)

    // Logged in as another session: the next read replaces the token.
    await act(async () => session?.logIn())
    await settle()
    expect(store.current()).toBe(second)

    // The hub confirmed the log-out: the store is empty even when the read after it doesn't land.
    reachable = false
    await act(async () => session?.logOut())
    await settle()
    expect(store.current()).toBeNull()
    await act(async () => root.unmount())
  })
})
