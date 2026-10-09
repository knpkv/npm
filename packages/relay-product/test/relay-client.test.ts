import { describe, expect, it } from "@effect/vitest"
import type { ObjectRef, RelayStreamFrame } from "@knpkv/relay/wire"
import type { Schema } from "effect"
import { Crypto, Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"

import { makeRelayClient, RelayTransportFailed } from "../src/relay-client.js"
import { makeRelayConversations } from "../src/relay-conversations.js"
import type { RelayClientEvent, RelayConversationState } from "../src/relay-fold.js"

const ref: ObjectRef = { product: "herdr", kind: "fleet", id: "ser8" }
const at = { seq: 0, session: "s1" }
const frame = (value: typeof RelayStreamFrame.Encoded): string => `data: ${JSON.stringify(value)}\n\n`
const snapshotFrame = frame({
  _tag: "Snapshot",
  ...at,
  messages: [{ id: "1", role: "user", text: "hi" }],
  runIds: [],
  queued: []
})
const cardFrame = frame({
  _tag: "ConfirmationRequired",
  ...at,
  call: "c1",
  action: { verb: "prompt_agent", target: ref, args: {} },
  reversible: false
})
const runFinishedFrame = frame({ _tag: "RunFinished", ...at, runIds: ["r0"] })
const session = (backend: string) => ({ backend, cancel: true, tools: [] })
const backends = [
  { _tag: "Ready", backend: "claude-code", label: "Claude Code", version: "1" },
  { _tag: "Unavailable", backend: "codex-cli", label: "Codex", cause: "SignedOut", fix: "Run codex login" }
]

/** A response whose body the test writes to and closes. */
const openBody = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
  return {
    body,
    write: (text: string) => controller?.enqueue(new TextEncoder().encode(text)),
    close: () => controller?.close()
  }
}

/** A promise the test settles by hand. */
const gate = <A>() => {
  let open: (value: A) => void = () => undefined
  const promise = new Promise<A>((resolve) => (open = resolve))
  return { open, promise }
}

/** Answers one request; `signal` aborts when the client gives up on it. */
type Route = (request: Request, signal: AbortSignal) => Response | Promise<Response>
interface FakeServer {
  readonly client: HttpClient.HttpClient
  readonly hits: (path: string) => number
}

/** A scripted `/v1/relay` server; each path answers from its route, or 404. */
const fakeServer = (routes: Record<string, Route>): FakeServer => {
  const counts = new Map<string, number>()
  const client = HttpClient.make((request, url, signal) =>
    Effect.promise(async () => {
      const path = url.pathname.replace("/v1/relay/", "")
      counts.set(path, (counts.get(path) ?? 0) + 1)
      const route = routes[path]
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : null
      const web = new Request(url.href, { method: request.method, body })
      return HttpClientResponse.fromWeb(
        request,
        route === undefined ? new Response(null, { status: 404 }) : await route(web, signal)
      )
    })
  )
  return { client, hits: (path) => counts.get(path) ?? 0 }
}

/** A reply as a Relay route sends it: a JSON value. */
const json = (body: Schema.Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })

const relay = makeRelayClient({ base: "/v1/relay", origin: "https://hub.example.test/" })

const collect = (server: FakeServer, take: number) =>
  relay.events(ref).pipe(
    Stream.take(take),
    Stream.runCollect,
    Effect.provideService(HttpClient.HttpClient, server.client)
  )

describe("Relay client stream", () => {
  it.effect("stops with Unauthorized when the session no longer opens Relay", () =>
    Effect.gen(function*() {
      const server = fakeServer({ events: () => new Response(null, { status: 401 }) })
      const events = yield* relay.events(ref).pipe(
        Stream.runCollect,
        Effect.provideService(HttpClient.HttpClient, server.client)
      )
      expect(events.map(({ _tag }) => _tag)).toEqual(["Unauthorized"])
      expect(server.hits("events")).toBe(1)
    }))

  it.effect("carries only the server's events, and never waits on a backend read", () =>
    Effect.gen(function*() {
      const server = fakeServer({ events: () => stream(snapshotFrame + cardFrame) })
      const events = yield* collect(server, 2)
      expect(events.map(({ _tag }) => _tag)).toEqual(["Snapshot", "ConfirmationRequired"])
      expect(server.hits("session")).toBe(0)
    }))

  it.effect("stops with StreamFailed on a frame it can't read, and doesn't reconnect", () =>
    Effect.gen(function*() {
      const server = fakeServer({ events: () => stream(`data: {"_tag":"Nonsense"}\n\n`) })
      const events = yield* relay.events(ref).pipe(
        Stream.runCollect,
        Effect.provideService(HttpClient.HttpClient, server.client)
      )
      expect(events.map(({ _tag }) => _tag)).toEqual(["StreamFailed"])
      expect(server.hits("events")).toBe(1)
    }))

  it.effect("says Disconnected when the stream drops, then starts over from a new Snapshot", () =>
    Effect.gen(function*() {
      const server = fakeServer({ events: () => stream(snapshotFrame) })
      const collecting = yield* Effect.forkChild(collect(server, 3))
      yield* TestClock.adjust("1 second")
      const events = yield* Fiber.join(collecting)
      expect(events.map(({ _tag }) => _tag)).toEqual(["Snapshot", "Disconnected", "Snapshot"])
      expect(server.hits("events")).toBe(2)
    }))

  it.effect("backs off while reconnects fail, and starts over once one reaches its Snapshot", () =>
    Effect.gen(function*() {
      // Calls 2 and 3 fail; every other call opens with a Snapshot and drops.
      let calls = 0
      const server = fakeServer({
        events: () => {
          calls += 1
          return calls === 2 || calls === 3 ? new Response(null, { status: 503 }) : stream(snapshotFrame)
        }
      })
      yield* Effect.forkChild(
        relay.events(ref).pipe(Stream.runDrain, Effect.provideService(HttpClient.HttpClient, server.client))
      )
      const after = (duration: "1 second" | "2 seconds" | "3 seconds") =>
        TestClock.adjust(duration).pipe(
          Effect.andThen(TestClock.withLive(Effect.sleep("5 millis"))),
          Effect.andThen(Effect.sync(() => server.hits("events")))
        )
      yield* TestClock.withLive(Effect.sleep("5 millis"))
      expect(server.hits("events")).toBe(1)
      // A dropped live stream retries after 1 second, then failures back off: 2, then 4 seconds.
      expect(yield* after("1 second")).toBe(2)
      expect(yield* after("1 second")).toBe(2)
      expect(yield* after("1 second")).toBe(3)
      expect(yield* after("3 seconds")).toBe(3)
      expect(yield* after("1 second")).toBe(4)
      // Call 4 reached its Snapshot, so its drop retries after 1 second again, not 8.
      expect(yield* after("1 second")).toBe(5)
    }))
})

describe("Relay client writes", () => {
  const provide = <A, E>(server: FakeServer, effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, server.client))
  const run = <A, E>(server: FakeServer, effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.exit(provide(server, effect))

  it.effect("answers a send with the run id", () =>
    Effect.gen(function*() {
      const server = fakeServer({ messages: () => json({ runId: "r1" }, 202) })
      expect(yield* run(server, relay.message(ref, "status?", "r1"))).toEqual(Exit.succeed({ runId: "r1" }))
    }))

  it.effect("names the state a refused decision found", () =>
    Effect.gen(function*() {
      const server = fakeServer({
        decisions: () => json({ _tag: "RelayConflictError", state: { _tag: "Decided", allow: true } }, 409)
      })
      const exit = yield* run(server, relay.decide(ref, "c1", false))
      expect(exit).toMatchObject({ _tag: "Failure" })
      expect(JSON.stringify(exit)).toContain("RelayConflictError")
      expect(JSON.stringify(exit)).toContain("Decided")
    }))

  it.effect("passes on the fix when Relay could not start", () =>
    Effect.gen(function*() {
      const server = fakeServer({
        cancel: () => json({ _tag: "RelayUnavailableError", message: "locked", fix: "Stop the other hostd" }, 503)
      })
      expect(JSON.stringify(yield* run(server, relay.cancel(ref, "r1")))).toContain("Stop the other hostd")
    }))

  it.effect("tells an unreachable server from a reply it can't read", () =>
    Effect.gen(function*() {
      const offline: FakeServer = {
        client: HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: new TypeError("Failed to fetch") })
            })
          )
        ),
        hits: () => 0
      }
      expect(yield* Effect.flip(provide(offline, relay.message(ref, "x", "r1")))).toEqual(
        new RelayTransportFailed({ reason: "unreachable", status: 0 })
      )
      const proxy = fakeServer({ messages: () => new Response("<html>proxy</html>", { status: 502 }) })
      expect(yield* Effect.flip(provide(proxy, relay.message(ref, "x", "r1")))).toEqual(
        new RelayTransportFailed({ reason: "unreadable", status: 502 })
      )
    }))
})

describe("Relay conversations", () => {
  const testCrypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: (_, data) => Effect.succeed(data) })
  )
  const runtimeFor = (server: FakeServer) =>
    ManagedRuntime.make(Layer.merge(Layer.succeed(HttpClient.HttpClient, server.client), testCrypto))

  /** Resolves once the store's state for `ref` satisfies `done`. */
  const until = (
    conversations: ReturnType<typeof makeRelayConversations>,
    done: (state: RelayConversationState) => boolean
  ) =>
    new Promise<RelayConversationState>((resolve) => {
      const stop = conversations.subscribe(ref, (state) => {
        if (!done(state)) return
        queueMicrotask(() => stop())
        resolve(state)
      })
    })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

  it("opens one stream for every reader, and a late reader gets the open card at once", async () => {
    const body = openBody()
    const server = fakeServer({
      events: () => new Response(body.body),
      session: () => json(session("codex-cli")),
      backends: () => json(backends)
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const heard: Array<RelayClientEvent["_tag"]> = []
    const stopFirst = conversations.subscribe(ref, (_state, event) => {
      if (event !== null) heard.push(event._tag)
    })
    body.write(snapshotFrame + cardFrame)
    await until(conversations, (state) => state.confirmations.length === 1)

    const late: Array<RelayClientEvent | null> = []
    const stopLate = conversations.subscribe(ref, (state, event) => {
      late.push(event)
      if (event === null) expect(state.confirmations.map(({ call }) => call)).toEqual(["c1"])
    })
    expect(late).toEqual([null])
    expect(server.hits("events")).toBe(1)
    expect(heard).toContain("ConfirmationRequired")

    stopFirst()
    stopLate()
    conversations.dispose()
    await runtime.dispose()
  })

  it("closes the stream when its last reader leaves, and opens a fresh one for the next", async () => {
    const server = fakeServer({ events: () => new Response(openBody().body) })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const first = conversations.subscribe(ref, () => undefined)
    const second = conversations.subscribe(ref, () => undefined)
    await tick()
    expect(server.hits("events")).toBe(1)
    first()
    second()
    const again = conversations.subscribe(ref, () => undefined)
    await tick()
    expect(server.hits("events")).toBe(2)
    again()
    conversations.dispose()
    await runtime.dispose()
  })

  it("delivers events while a backend read stalls, and stops the read with the stream", async () => {
    const body = openBody()
    const reads: Array<AbortSignal> = []
    const server = fakeServer({
      events: () => new Response(body.body),
      session: (_request, signal) => {
        reads.push(signal)
        return new Promise<Response>(() => undefined)
      },
      backends: () => json(backends)
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const stop = conversations.subscribe(ref, () => undefined)
    body.write(snapshotFrame + cardFrame)
    const state = await until(conversations, (state) => state.confirmations.length === 1)
    expect(state.connection).toBe("live")
    expect(reads).toHaveLength(1)
    stop()
    await tick()
    expect(reads[0]?.aborted).toBe(true)
    conversations.dispose()
    await runtime.dispose()
  })

  it("keeps the newest backend status when an older read answers after it", async () => {
    const body = openBody()
    const first = gate<Response>()
    let reads = 0
    const server = fakeServer({
      events: () => new Response(body.body),
      session: () => {
        reads += 1
        // The Snapshot's read answers late, with the backend the session had before.
        return reads === 1 ? first.promise : json(session("codex-cli"))
      },
      backends: () => json(backends)
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const stop = conversations.subscribe(ref, () => undefined)
    body.write(snapshotFrame)
    await until(conversations, (state) => state.connection === "live")
    body.write(runFinishedFrame)
    await until(conversations, (state) => state.backend?.backend === "codex-cli")
    first.open(json(session("claude-code")))
    await tick()
    expect(conversations.get(ref).backend?.backend).toBe("codex-cli")
    stop()
    conversations.dispose()
    await runtime.dispose()
  })

  it("shows a message when the stream queues and places it, not when the send is answered", async () => {
    const body = openBody()
    const server = fakeServer({
      events: () => new Response(body.body),
      messages: () => json({ runId: "r7" }, 202),
      session: () => json(session("codex-cli")),
      backends: () => json(backends)
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const stop = conversations.subscribe(ref, () => undefined)
    body.write(snapshotFrame)
    await until(conversations, (state) => state.connection === "live")

    expect(await conversations.send(ref, { text: "What needs me?", requestId: "r7" })).toEqual(Exit.void)
    expect(conversations.get(ref).messages.map(({ id }) => id)).toEqual(["1"])
    body.write(frame({ _tag: "MessageQueued", ...at, requestId: "r7" }))
    const queued = await until(conversations, (state) => state.queued.length === 1)
    expect(queued.queued).toEqual([{ requestId: "r7", text: "What needs me?" }])
    body.write(frame({ _tag: "MessagePlaced", ...at, id: "2", requestId: "r7", text: "What needs me?" }))
    const placed = await until(conversations, (state) => state.queued.length === 0)
    expect(placed.messages.at(-1)).toEqual({ id: "2", role: "user", streaming: false, text: "What needs me?" })
    stop()
    conversations.dispose()
    await runtime.dispose()
  })

  it("retries a send with its own request id after the answer was lost", async () => {
    const sent: Array<unknown> = []
    let attempts = 0
    const server = fakeServer({
      events: () => new Response(openBody().body),
      messages: async (request) => {
        sent.push(await request.json())
        attempts += 1
        // The first attempt reached the server, but a proxy lost its answer.
        return attempts === 1 ? new Response("<html>proxy</html>", { status: 502 }) : json({ runId: "r8" }, 202)
      }
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const id = await conversations.newRequestId()
    const requestId = Exit.isSuccess(id) ? id.value : "unavailable"
    const first = await conversations.send(ref, { text: "Status?", requestId })
    expect(Exit.isFailure(first)).toBe(true)
    expect(await conversations.send(ref, { text: "Status?", requestId })).toEqual(Exit.void)
    expect(sent).toEqual([{ ref, requestId, text: "Status?" }, { ref, requestId, text: "Status?" }])
    expect(conversations.get(ref).outbox).toEqual([{ requestId, text: "Status?" }])
    conversations.dispose()
    await runtime.dispose()
  })

  it("stays failed after a terminal end until retried, then reopens one stream for its readers", async () => {
    let calls = 0
    const server = fakeServer({
      events: () => {
        calls += 1
        return calls === 1 ? stream(`data: {"_tag":"Nonsense"}\n\n`) : stream(snapshotFrame)
      }
    })
    const runtime = runtimeFor(server)
    const conversations = makeRelayConversations(relay, runtime)
    const masthead = conversations.subscribe(ref, () => undefined)
    await until(conversations, (state) => state.connection === "failed")
    // Another reader arriving doesn't reopen it on its own.
    const panel = conversations.subscribe(ref, () => undefined)
    await tick()
    expect(server.hits("events")).toBe(1)
    conversations.retry(ref)
    const live = await until(conversations, (state) => state.connection === "live")
    expect(live.messages.map(({ id }) => id)).toEqual(["1"])
    expect(server.hits("events")).toBe(2)
    masthead()
    panel()
    conversations.dispose()
    await runtime.dispose()
  })
})
