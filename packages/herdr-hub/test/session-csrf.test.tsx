// @vitest-environment happy-dom

import { Effect, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { HubSessionReadFailed, type HubSessionView } from "../src/hub-session-client.js"
import { type HubSessionActions, useHubSession } from "../src/hub-session-view.js"
import { addSessionCsrf, makeCsrfStore, sessionCsrf, sessionCsrfClient, sessionCsrfLayer } from "../src/session-csrf.js"

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
    // The browser resolves a backslash like a slash: this is another host, not a path.
    expect(sent(HttpClientRequest.post("/\\evil.test/x"))).toBeUndefined()
    expect(sent(HttpClientRequest.post("http://[::1/x"))).toBeUndefined()
    // Apps are never given the token; their writes need the hub's Origin instead.
    expect(sent(HttpClientRequest.post("/apps/notes/save"))).toBeUndefined()
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

  /** A hub that answers the session read with `session()` and each write with `write(token)`, recording both. */
  const scriptedHub = (session: () => HubSessionView, write: (token: string | null) => Response) => {
    const calls: Array<{ readonly method: string; readonly path: string; readonly token: string | null }> = []
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const token = request.headers["x-herdr-csrf"] ?? null
        calls.push({ method: request.method, path: url.pathname, token })
        return HttpClientResponse.fromWeb(
          request,
          url.pathname === "/v1/session" ? new Response(JSON.stringify(session())) : write(token)
        )
      })
    )
    return { calls, client }
  }
  const approve = (client: HttpClient.HttpClient) =>
    client.execute(HttpClientRequest.post(`${origin}/v1/jobs/job-1/approve`))

  // A page without the session hook (/connect/), or a write before the hook's first read lands: the write
  // waits for one session read, shared by every write waiting, and carries its token.
  it.effect("reads the session once for the writes that find the store empty", () =>
    Effect.gen(function* () {
      const store = makeCsrfStore()
      const hub = scriptedHub(
        () => signedIn(first),
        () => new Response("{}")
      )
      const client = sessionCsrfClient(hub.client, store, origin)
      const answers = yield* Effect.all([approve(client), approve(client)], { concurrency: "unbounded" })
      expect(answers.map((answer) => answer.status)).toEqual([200, 200])
      expect(hub.calls).toEqual([
        { method: "GET", path: "/v1/session", token: null },
        { method: "POST", path: "/v1/jobs/job-1/approve", token: first },
        { method: "POST", path: "/v1/jobs/job-1/approve", token: first }
      ])
      expect(store.current()).toBe(first)
    })
  )

  // The session changed (a log-in in another tab): the hub refuses the old token, the page reads the
  // session again and sends the write once more.
  it.effect("reads the session again and retries once when the hub refuses a stale token", () =>
    Effect.gen(function* () {
      const store = makeCsrfStore()
      store.remember(signedIn(first))
      const hub = scriptedHub(
        () => signedIn(second),
        (token) => (token === second ? new Response("{}") : Response.json({ error: "csrf_required" }, { status: 403 }))
      )
      const answer = yield* approve(sessionCsrfClient(hub.client, store, origin))
      expect(answer.status).toBe(200)
      expect(hub.calls.map(({ path, token }) => [path, token])).toEqual([
        ["/v1/jobs/job-1/approve", first],
        ["/v1/session", null],
        ["/v1/jobs/job-1/approve", second]
      ])
    })
  )

  // Once only: a refusal after the re-read reaches the caller, with its body.
  it.effect("retries once, and passes any other refusal on readable", () =>
    Effect.gen(function* () {
      const store = makeCsrfStore()
      store.remember(signedIn(first))
      const refusing = scriptedHub(
        () => signedIn(first),
        () => Response.json({ error: "csrf_required" }, { status: 403 })
      )
      const refused = yield* approve(sessionCsrfClient(refusing.client, store, origin))
      expect(refused.status).toBe(403)
      expect(refusing.calls.map(({ path }) => path)).toEqual([
        "/v1/jobs/job-1/approve",
        "/v1/session",
        "/v1/jobs/job-1/approve"
      ])
      const forbidding = scriptedHub(
        () => signedIn(first),
        () => Response.json({ error: "forbidden" }, { status: 403 })
      )
      const forbidden = yield* approve(sessionCsrfClient(forbidding.client, store, origin))
      expect(yield* forbidden.json).toEqual({ error: "forbidden" })
      expect(forbidding.calls.map(({ path }) => path)).toEqual(["/v1/jobs/job-1/approve"])
    })
  )

  // Log-out names the token it ends, and a read never needs one: neither waits for nor repeats a read.
  it.effect("leaves log-out and reads alone", () =>
    Effect.gen(function* () {
      const store = makeCsrfStore()
      const hub = scriptedHub(
        () => signedIn(first),
        () => Response.json({ error: "csrf_required" }, { status: 403 })
      )
      const client = sessionCsrfClient(hub.client, store, origin)
      yield* client.execute(
        HttpClientRequest.setHeader(HttpClientRequest.post("/v1/session/logout"), "x-herdr-csrf", second)
      )
      yield* client.execute(HttpClientRequest.get("/v1/dashboard"))
      expect(hub.calls.map(({ path, token }) => [path, token])).toEqual([
        ["/v1/session/logout", second],
        ["/v1/dashboard", null]
      ])
    })
  )

  // The browser runtimes' client: the page's store, the page's origin, the browser's fetch.
  it("sends the page's token through the browser client", async () => {
    const seen: Array<string | null> = []
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname
      if (path === "/v1/session") return Promise.resolve(Response.json(signedIn(first)))
      seen.push(new Headers(init?.headers).get("x-herdr-csrf"))
      return Promise.resolve(new Response("{}"))
    })
    // The page's runtimes are built the same way, from the layer.
    const runtime = ManagedRuntime.make(sessionCsrfLayer)
    await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(HttpClientRequest.post("/v1/jobs/job-1/approve"))
      })
    )
    await runtime.dispose()
    expect(seen).toEqual([first])
    expect(sessionCsrf.current()).toBe(first)
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
