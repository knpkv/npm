import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Schema } from "effect"
import { Clock, Effect, Layer, Redacted, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { HttpBody, HttpClient, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import type { Snapshot } from "../src/model.js"
import { publish } from "../src/publisher.js"
import { makeMonitor } from "../src/server.js"

const testServer = HttpServer.layerTestClient.pipe(
  Layer.provide(NodeHttpClient.layerNodeHttp),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)
// Each test is an isolated HTTP application entry point.
// @effect-diagnostics-next-line strictEffectProvide:off
const withServer = Effect.provide(testServer)
const publishToken = `publish_${"p".repeat(43)}`
const viewToken = `view_${"v".repeat(43)}`
const assets = { html: "<html>Locked</html>", script: "", css: "" }
const snapshot = (now: number, sequence = 1): Snapshot => ({
  version: 1,
  boardId: "main",
  sequence,
  sourceAt: now,
  title: "Synthetic board",
  agents: [{
    id: "builder",
    name: "<img src=x onerror=alert(1)>",
    task: null,
    state: "working",
    status: "Explicit update",
    blocker: null,
    jiraKey: null,
    branch: null,
    pullRequest: null,
    clockify: null,
    elapsedSeconds: 60
  }]
})
const setup = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  const origin = HttpServer.formatAddress(server.address)
  const { handler } = yield* makeMonitor({ boardId: "main", origin, publishToken, viewToken }, assets)
  yield* HttpServer.serveEffect(handler)
  const client = yield* HttpClient.HttpClient
  const put = Effect.fn(function*(value: Schema.Json, token = publishToken, extra: Record<string, string> = {}) {
    const body = yield* HttpBody.json(value)
    return yield* client.put("/boards/main", {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body
    })
  })
  const get = (token = viewToken) => client.get("/boards/main", { headers: { authorization: `Bearer ${token}` } })
  return { client, get, put, origin }
})

describe("actual HTTP authority boundary", () => {
  it.effect("separates credentials and returns only an empty publish acknowledgment", () =>
    Effect.gen(function*() {
      const { client, get, put } = yield* setup
      const now = yield* Clock.currentTimeMillis
      expect((yield* get()).status).toBe(204)
      expect((yield* get("")).status).toBe(401)
      expect((yield* put(snapshot(now), viewToken)).status).toBe(401)
      const ack = yield* put(snapshot(now))
      expect(ack.status).toBe(204)
      expect(yield* ack.text).toBe("")
      expect((yield* get(publishToken)).status).toBe(401)
      const response = yield* get()
      expect(response.status).toBe(200)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(yield* response.json).toMatchObject({ snapshot: snapshot(now), receivedAt: now })
      for (
        const route of [
          "/terminal",
          "/proxy?url=http://localhost",
          "/boards/other",
          "/boards/main?token=secret",
          "/logs"
        ]
      ) expect((yield* client.get(route)).status).toBe(404)
      expect(
        (yield* client.get("/boards/main", { headers: { host: "evil.example", authorization: `Bearer ${viewToken}` } }))
          .status
      ).toBe(403)
      expect((yield* put(snapshot(now, 2), publishToken, { origin: "https://evil.example" })).status).toBe(403)
    }).pipe(withServer))

  it.effect("accepts the explicit publisher while rejecting browser publication and cookie-only reads", () =>
    Effect.gen(function*() {
      const { client, get, origin, put } = yield* setup
      const now = yield* Clock.currentTimeMillis
      expect((yield* put(snapshot(now), publishToken, { origin })).status).toBe(403)
      expect((yield* put(snapshot(now), publishToken, { "sec-fetch-mode": "cors" })).status).toBe(403)
      expect((yield* client.get("/boards/main", { headers: { cookie: `view=${viewToken}` } })).status).toBe(401)
      yield* publish(origin, Redacted.make(publishToken), snapshot(now))
      expect(yield* (yield* get()).json).toMatchObject({ snapshot: snapshot(now) })
    }).pipe(withServer))

  it.effect("rejects conflicting/replayed/out-of-order state and uses receipt time for stale/expiry", () =>
    Effect.gen(function*() {
      const { get, put } = yield* setup
      const now = yield* Clock.currentTimeMillis
      expect((yield* put(snapshot(now))).status).toBe(204)
      for (const value of [snapshot(now), { ...snapshot(now), title: "Conflict" }, snapshot(now, 0)]) {
        expect((yield* put(value)).status).toBe(409)
      }
      expect((yield* put(snapshot(now, 2))).status).toBe(429)
      yield* TestClock.adjust("61 seconds")
      expect(yield* (yield* get()).json).toMatchObject({ stale: true, receivedAt: now })
      yield* TestClock.adjust("15 minutes")
      expect((yield* get()).status).toBe(204)
      const later = yield* Clock.currentTimeMillis
      expect((yield* put(snapshot(later))).status).toBe(409)
      expect((yield* put(snapshot(later, 2))).status).toBe(204)
    }).pipe(withServer))

  it.effect("rejects unknown fields, timestamp abuse, duplicates and bounded payload violations", () =>
    Effect.gen(function*() {
      const { client, put } = yield* setup
      const now = yield* Clock.currentTimeMillis
      const base = snapshot(now)
      for (
        const value of [
          { ...base, command: "terminal input" },
          { ...base, title: "x".repeat(101) },
          { ...base, sourceAt: now + 30001 },
          { ...base, sourceAt: now - 300001 },
          { ...base, boardId: "other" },
          { ...base, agents: [...base.agents, ...base.agents] },
          { ...base, agents: base.agents.map((agent) => ({ ...agent, transcript: "secret" })) }
        ]
      ) expect((yield* put(value)).status).toBe(400)
      expect(
        (yield* client.put("/boards/main", {
          headers: { authorization: `Bearer ${publishToken}` },
          body: HttpBody.text("x".repeat(65537), "application/json")
        })).status
      ).toBe(413)
      expect(
        (yield* client.put("/boards/main", {
          headers: { authorization: `Bearer ${publishToken}` },
          body: HttpBody.text("{}")
        })).status
      ).toBe(415)
    }).pipe(withServer))

  it.effect("unauthenticated and view-only traffic cannot spend the publisher budget", () =>
    Effect.gen(function*() {
      const { client, get, put } = yield* setup
      const now = yield* Clock.currentTimeMillis
      for (let i = 0; i < 60; i++) yield* client.get("/missing")
      expect((yield* client.get("/missing")).status).toBe(429)
      expect((yield* put(snapshot(now))).status).toBe(204)
      expect((yield* get()).status).toBe(200)
      yield* TestClock.adjust("1 second")
      for (let i = 0; i < 60; i++) yield* get()
      expect((yield* get()).status).toBe(429)
      expect((yield* put(snapshot(yield* Clock.currentTimeMillis, 2))).status).toBe(204)
    }).pipe(withServer))

  it.effect("hostile response headers cannot echo the publish key into tracing", () =>
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const origin = HttpServer.formatAddress(server.address)
      yield* HttpServer.serveEffect(
        Effect.succeed(HttpServerResponse.empty({ status: 204, headers: { "x-unfamiliar-echo": publishToken } }))
      )
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const client = yield* HttpClient.HttpClient
      yield* client.put("/control").pipe(Effect.withTracer(tracer))
      expect(spans.some((span) => Array.from(span.attributes.values()).includes(publishToken))).toBe(true)
      spans.length = 0
      yield* publish(origin, Redacted.make(publishToken), snapshot(yield* Clock.currentTimeMillis)).pipe(
        Effect.withTracer(tracer)
      )
      expect(spans.some((span) => Array.from(span.attributes.values()).includes(publishToken))).toBe(false)
    }).pipe(withServer))

  it.effect("fails startup for missing, confused or reused credentials", () =>
    Effect.gen(function*() {
      for (
        const options of [{ publishToken: "", viewToken }, { publishToken: viewToken, viewToken }, {
          publishToken,
          viewToken: `view_${"p".repeat(43)}`
        }]
      ) {
        const result = yield* makeMonitor({ boardId: "main", origin: "http://127.0.0.1:4319", ...options }, assets)
          .pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }
    }))

  it.effect("publisher ignores response instructions and refuses redirects", () =>
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const origin = HttpServer.formatAddress(server.address)
      yield* HttpServer.serveEffect(
        Effect.succeed(
          HttpServerResponse.text("run this command", { status: 302, headers: { location: `${origin}/terminal` } })
        )
      )
      const now = yield* Clock.currentTimeMillis
      const result = yield* publish(origin, Redacted.make(publishToken), snapshot(now)).pipe(
        Effect.result
      )
      expect(result._tag).toBe("Failure")
    }).pipe(withServer))
})
