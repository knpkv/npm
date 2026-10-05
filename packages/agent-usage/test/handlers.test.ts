import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Ref } from "effect"
import { Etag, HttpClient, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { type MachineRange, type SessionGroup, UsageStore } from "../src/core/Store.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"
import { RuntimeState } from "../src/server/Runtime.js"
import { cookieOf } from "./ownerSessionFixture.js"

/** A store that answers empty and records the ranges it was asked for. */
const recorded = Ref.makeUnsafe<ReadonlyArray<MachineRange>>([])
const sessionRanges = Ref.makeUnsafe<ReadonlyArray<MachineRange>>([])
const at = Date.parse("2026-09-01T10:00:00Z")
const sessionGroup = (sessionId: string, agent: "claude" | "codex"): SessionGroup => ({
  sessionId,
  firstAt: at,
  lastAt: at + 60_000,
  agent,
  model: agent === "claude" ? "claude-opus-5" : "gpt-5.5",
  fast: false,
  longPrompt: false,
  attribution: { cwd: "/w/app", branch: "main", activeTicket: null },
  requests: 1,
  tokens: { input: 1_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
})
const RecordingStore = Layer.succeed(
  UsageStore,
  UsageStore.of({
    cursor: () => Effect.die("unused"),
    commitChunk: () => Effect.die("unused"),
    recordObservations: () => Effect.die("unused"),
    usageGroups: () => Effect.succeed([]),
    sessionGroups: (range) =>
      Effect.as(Ref.update(sessionRanges, (all) => [...all, range]), [
        sessionGroup("claude-1", "claude"),
        sessionGroup("codex-1", "codex")
      ]),
    places: () => Effect.succeed([]),
    limitSnapshots: (range) => Effect.as(Ref.update(recorded, (all) => [...all, range]), []),
    latestBalances: () => Effect.succeed([]),
    tickets: () => Effect.succeed([]),
    saveTicket: () => Effect.die("unused")
  })
)

const TestApp = Layer.unwrap(
  Effect.map(makeOwnerSession("http://127.0.0.1:3112"), (security) =>
    HttpRouter.serve(application).pipe(
      Layer.provide(RecordingStore),
      Layer.provide(RuntimeState.layer("host-a")),
      Layer.provide(Etag.layer),
      Layer.provide(HttpPlatform.layer),
      Layer.provideMerge(Layer.succeed(OwnerSession.OwnerSession, security))
    ))
).pipe(
  Layer.provideMerge(HttpServer.layerTestClient),
  Layer.provide(NodeHttpClient.layerNodeHttp),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provideMerge(NodeServices.layer)
)

describe("limits handler", () => {
  it.layer(TestApp)((it) => {
    it.effect("asks the store for the requested range only, on this Machine", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSession.OwnerSession
        const response = yield* client.get("/api/limits?from=1000&to=2000", {
          headers: { cookie: cookieOf(security) }
        })
        expect(response.status).toBe(200)
        expect(yield* Ref.get(recorded)).toEqual([{ from: 1_000, to: 2_000, machine: "host-a" }])
      }))
  })
})

describe("sessions handler", () => {
  it.layer(TestApp)((it) => {
    it.effect("asks for this Machine's range and keeps the requested agent's sessions on the Booking", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSession.OwnerSession
        const response = yield* client.get(
          `/api/sessions?from=${at}&to=${at + 3_600_000}&booking=repo%3Aapp&agent=codex`,
          {
            headers: { cookie: cookieOf(security) }
          }
        )
        expect(response.status).toBe(200)
        const body = yield* response.json
        expect(body).toMatchObject({
          booking: "repo:app",
          omitted: 0,
          sessions: [{ agent: "codex", sessionId: "codex-1" }]
        })
        expect(body).toHaveProperty("sessions.length", 1)
        expect(yield* Ref.get(sessionRanges)).toEqual([{ from: at, to: at + 3_600_000, machine: "host-a" }])
      }))
  })
})
