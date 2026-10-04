/**
 * The real application over an in-memory store seeded with synthetic usage. Test-only routes hand
 * out the bootstrap URL and the owner cookie; everything else is the production router.
 */
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Clock, Effect, Layer, Redacted, SubscriptionRef } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import type { UsageEvent } from "../../src/core/Model.js"
import { UsageStore } from "../../src/core/Store.js"
import { application } from "../../src/server/HttpApplication.js"
import {
  activateOwnerSessionBootstrap,
  makeOwnerSessionSecrets,
  OwnerSessionSecrets,
  ownerSessionUrl
} from "../../src/server/OwnerSession.js"
import { RuntimeState } from "../../src/server/Runtime.js"

// This executable composes a seeded store and a real loopback HTTP listener.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4180"
const HOUR = 3_600_000

const event = (now: number, key: string, overrides: Partial<UsageEvent>): UsageEvent => ({
  agent: "claude",
  dedupeKey: key,
  machine: "fixture",
  sessionId: "session-1",
  occurredAt: now - 2 * HOUR,
  model: "claude-opus-5",
  fast: false,
  tokens: { input: 200_000, output: 20_000, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  attribution: { cwd: "/home/dev/worktrees/app/feat/RPS-12", branch: "feat/RPS-12", activeTicket: null },
  ...overrides
})

const seed = Effect.gen(function*() {
  const store = yield* UsageStore
  const now = yield* Clock.currentTimeMillis
  yield* store.commitChunk({
    agent: "claude",
    fileKey: "fixture.jsonl",
    cursor: { identity: "0:0", offset: 0, state: "{}" },
    events: [
      event(now, "a", {}),
      event(now, "b", { occurredAt: now - 30 * HOUR }),
      event(now, "c", { attribution: { cwd: "/home/dev/code/tools", branch: "main", activeTicket: "GPT-6" } }),
      event(now, "d", { agent: "codex", model: "gpt-6-sol", sessionId: "session-2" }),
      event(now, "e", { model: "claude-unreleased-9" }),
      // A middle column holding several long-named bookings, so tooltip placement is exercised away from the edges.
      ...["a-rather-long-repository-name", "another-long-repository-name"].map((repo, index) =>
        event(now, `m${index}`, {
          occurredAt: now - 84 * HOUR,
          attribution: { cwd: `/home/dev/code/${repo}`, branch: "main", activeTicket: null }
        })
      )
    ],
    snapshots: [],
    balances: []
  })
  yield* store.recordObservations(
    [{
      agent: "claude",
      machine: "fixture",
      source: "claude-oauth-usage",
      label: "five_hour",
      windowMinutes: 300,
      observedAt: now - 4 * HOUR,
      reading: { _tag: "Known", usedPercent: 30, resetsAt: now + 3 * HOUR }
    }, {
      // A poll the Keychain refused, between two good readings: the gap must say why.
      agent: "claude",
      machine: "fixture",
      source: "claude-oauth-usage",
      label: "*",
      windowMinutes: null,
      observedAt: now - 3 * HOUR,
      reading: {
        _tag: "Unknown",
        reason: "KeychainDenied",
        detail: "the Keychain refused access (security exited 36)"
      }
    }, {
      agent: "claude",
      machine: "fixture",
      source: "claude-oauth-usage",
      label: "five_hour",
      windowMinutes: 300,
      observedAt: now - HOUR,
      reading: { _tag: "Known", usedPercent: 42, resetsAt: now + 3 * HOUR }
    }],
    [{
      kind: "codex-credits",
      machine: "fixture",
      observedAt: now - HOUR,
      value: { _tag: "Known", balance: { _tag: "Credits", credits: 5000 } }
    }]
  )
})

const run = Effect.gen(function*() {
  const security = yield* makeOwnerSessionSecrets(origin)
  const testRoutes = HttpRouter.use((router) =>
    Effect.gen(function*() {
      yield* router.add(
        "GET",
        "/__test/bootstrap",
        Effect.succeed(HttpServerResponse.text(ownerSessionUrl(origin, security)))
      )
      yield* router.add(
        "GET",
        "/__test/session",
        Effect.succeed(HttpServerResponse.text(Redacted.value(security.ownerToken)))
      )
      // Stands in for a Claude poll some minutes ago: failed, or read again, then announced.
      yield* router.add(
        "GET",
        "/__test/limits",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, origin)
          const usage = yield* UsageStore
          const state = yield* RuntimeState
          const now = yield* Clock.currentTimeMillis
          const observedAt = now - Number(url.searchParams.get("ago") ?? "0")
          yield* usage.recordObservations(
            [
              url.searchParams.get("reading") === "recover"
                ? {
                  agent: "claude",
                  machine: "fixture",
                  source: "claude-oauth-usage",
                  label: "five_hour",
                  windowMinutes: 300,
                  observedAt,
                  reading: { _tag: "Known", usedPercent: 50, resetsAt: now + 3 * HOUR }
                }
                : {
                  agent: "claude",
                  machine: "fixture",
                  source: "claude-oauth-usage",
                  label: "*",
                  windowMinutes: null,
                  observedAt,
                  reading: { _tag: "Unknown", reason: "Fetch", detail: "HTTP 500" }
                }
            ],
            []
          )
          yield* SubscriptionRef.update(state.versions, (versions) => ({ ...versions, limits: versions.limits + 1 }))
          return HttpServerResponse.text("recorded")
        })
      )
      // Stands in for an ingest pass: a new booking committed, then announced on the live socket.
      yield* router.add(
        "GET",
        "/__test/push",
        Effect.gen(function*() {
          const usage = yield* UsageStore
          const state = yield* RuntimeState
          const now = yield* Clock.currentTimeMillis
          const pushed = event(now, `pushed-${now}`, {
            occurredAt: now - 1_000,
            attribution: { cwd: "/home/dev/code/pushed-repository", branch: "main", activeTicket: null }
          })
          yield* usage.commitChunk({
            agent: "claude",
            fileKey: `pushed-${now}.jsonl`,
            cursor: { identity: "0:0", offset: 0, state: "{}" },
            events: [pushed],
            snapshots: [],
            balances: []
          })
          yield* SubscriptionRef.update(state.versions, (versions) => ({ ...versions, usage: versions.usage + 1 }))
          return HttpServerResponse.text("pushed")
        })
      )
    })
  )
  const store = UsageStore.layer.pipe(
    Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    Layer.tap((context) => Effect.provide(seed, context))
  )
  return yield* Layer.launch(
    HttpRouter.serve(Layer.mergeAll(testRoutes, application)).pipe(
      Layer.provide(store),
      Layer.provide(RuntimeState.layer("fixture")),
      Layer.provide(Layer.succeed(OwnerSessionSecrets, security)),
      Layer.provide(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: 4180 })),
      Layer.provide(Etag.layer),
      Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      Layer.provide(NodeServices.layer),
      Layer.tap(() => activateOwnerSessionBootstrap(security))
    )
  )
})

NodeRuntime.runMain(run.pipe(Effect.provide(NodeServices.layer)))
