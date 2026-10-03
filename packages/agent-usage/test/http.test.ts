import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { Etag, HttpClient, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { UsageStore } from "../src/core/Store.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSessionSecrets, OwnerSessionSecrets } from "../src/server/OwnerSession.js"
import { RuntimeState } from "../src/server/Runtime.js"

const secrets = makeOwnerSessionSecrets("http://127.0.0.1:3112")

const TestApp = Layer.unwrap(Effect.map(secrets, (security) =>
  HttpRouter.serve(application).pipe(
    Layer.provide(UsageStore.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })))),
    Layer.provide(RuntimeState.layer("ser8")),
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatform.layer),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, security))
  ))).pipe(
    Layer.provideMerge(HttpServer.layerTestClient),
    Layer.provide(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer)
  )

const usagePath = (timeZone: string) =>
  `/api/usage?from=${Date.parse("2026-09-01T00:00:00Z")}&to=${Date.parse("2026-09-08T00:00:00Z")}&timeZone=${
    encodeURIComponent(timeZone)
  }&bucket=day&agent=all`

describe("HTTP boundary", () => {
  it.layer(TestApp)((it) => {
    it.effect("refuses usage without the owner session cookie", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.get(usagePath("UTC"))
        expect(response.status).toBe(401)
      }))

    it.effect("serves an empty week to the owner, one period per local day", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSessionSecrets
        const response = yield* client.get(usagePath("Europe/Berlin"), {
          headers: { cookie: `agent_usage_owner=${Redacted.value(security.ownerToken)}` }
        })
        expect(response.status).toBe(200)
        const body = yield* response.json
        expect(body).toMatchObject({ bookings: [], cells: [], unpriced: { tokens: 0, models: [] }, ignoredKeys: [] })
        expect(body).toHaveProperty("periods.length", 8)
      }))

    it.effect("rejects an unknown time zone as a typed API error", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSessionSecrets
        const response = yield* client.get(usagePath("Mars/Olympus"), {
          headers: { cookie: `agent_usage_owner=${Redacted.value(security.ownerToken)}` }
        })
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({ _tag: "ApiError" })
      }))

    it.effect("refuses a browser read started by another site", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSessionSecrets
        const response = yield* client.get("/api/status", {
          headers: {
            cookie: `agent_usage_owner=${Redacted.value(security.ownerToken)}`,
            "sec-fetch-site": "cross-site"
          }
        })
        expect(response.status).toBe(403)
      }))
  })
})
