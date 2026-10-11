import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { Etag, HttpClient, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { CatalogReadError, StackDetail, StackList } from "../src/api.js"
import { Catalog } from "../src/server/Catalog.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"
import { FixtureSource, fixtureSourceLayer, state } from "./catalogFixture.js"

const routes = Layer.unwrap(Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  if (server.address._tag === "UnixPathAddress") return yield* Effect.die("fixture listener must use TCP")
  const session = yield* makeOwnerSession(OwnerSession.loopbackOrigin("127.0.0.1", server.address.port))
  return HttpRouter.serve(application, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(Layer.succeed(OwnerSession.OwnerSession, session)),
    Layer.provideMerge(Catalog.layer.pipe(Layer.provideMerge(fixtureSourceLayer))),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layer)
  )
}))

const fixtures = routes.pipe(
  Layer.provideMerge(HttpServer.layerTestClient),
  Layer.provide(NodeHttpClient.layerNodeHttp),
  Layer.provideMerge(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provide(NodeServices.layer)
)

const cookie = (session: OwnerSession.OwnerSessionService): string => session.sessionCookie.split(";")[0] ?? ""

layer(fixtures)("HTTP owner boundary", (it) => {
  it.effect("requires the owner cookie before any scan, and refuses cross-site reads and writes", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const session = yield* OwnerSession.OwnerSession
      const fixture = yield* FixtureSource
      const before = yield* Ref.get(fixture.calls)
      expect((yield* client.get("/api/stacks")).status).toBe(401)
      const headers = { cookie: cookie(session), "sec-fetch-site": "cross-site" }
      expect((yield* client.get("/api/stacks", { headers })).status).toBe(403)
      expect(
        (yield* client.get("/api/stacks", { headers: { cookie: cookie(session), origin: "https://fixture.invalid" } }))
          .status
      ).toBe(403)
      expect((yield* client.post("/api/stacks", { headers: { cookie: cookie(session) } })).status).toBe(403)
      expect((yield* client.del("/api/stacks/fixture", { headers: { cookie: cookie(session) } })).status).toBe(403)
      expect(
        (yield* client.get("/api/stacks", { headers: { cookie: cookie(session), host: "fixture.invalid" } })).status
      )
        .toBe(403)
      expect(yield* Ref.get(fixture.calls)).toBe(before)
    }))

  it.effect("spends a minted code once, sets a read-only cookie, and exposes only normalized list/detail metadata", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const session = yield* OwnerSession.OwnerSession
      const code = Redacted.value(yield* session.mintBootstrapCode)
      const headers = { authorization: `Bearer ${code}`, origin: session.browserOrigin }
      const exchange = yield* client.post("/auth/bootstrap", { headers })
      expect(exchange.status).toBe(200)
      expect(yield* exchange.json).toEqual({})
      expect(exchange.headers["set-cookie"]).toContain("HttpOnly")
      expect(exchange.headers["set-cookie"]).toContain("SameSite=Strict")
      expect(exchange.headers["set-cookie"]).toContain("Path=/api")
      expect((yield* client.post("/auth/bootstrap", { headers })).status).toBe(401)
      const owner = { cookie: (exchange.headers["set-cookie"] ?? "").split(";")[0] ?? "" }
      const listResponse = yield* client.get("/api/stacks", { headers: owner })
      const list = yield* Schema.decodeUnknownEffect(StackList)(yield* listResponse.json)
      expect(listResponse.status).toBe(200)
      const id = list.stacks[0]?.id
      if (id === undefined) return yield* Effect.die("fixture stack missing")
      const detailResponse = yield* client.get(`/api/stacks/${id}`, { headers: owner })
      const detail = yield* Schema.decodeUnknownEffect(StackDetail)(yield* detailResponse.json)
      expect(detail.state).toEqual(state)
      expect(JSON.stringify([list, detail])).not.toMatch(/fixture-secret|fixture-private-locator|__redacted__/)
    }))

  it.effect("marks data, errors, auth refusals and bootstrap assets uncacheable", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const session = yield* OwnerSession.OwnerSession
      const fixture = yield* FixtureSource
      for (const path of ["/", "/bootstrap.js", "/api/stacks", "/api/stacks/invalid", "/auth/bootstrap"]) {
        const response = yield* client.get(path)
        expect(response.headers["cache-control"]).toBe("private, no-store")
        expect(response.headers["referrer-policy"]).toBe("no-referrer")
      }
      yield* Ref.set(fixture.failure, new CatalogReadError({ reason: "denied" }))
      const failed = yield* client.get("/api/stacks", { headers: { cookie: cookie(session) } })
      expect(failed.status).toBe(503)
      expect(yield* failed.json).toEqual({ _tag: "CatalogReadError", reason: "denied" })
      expect(failed.headers["cache-control"]).toBe("private, no-store")
      yield* Ref.set(fixture.failure, null)
    }))

  it.effect("rejects a foreign bootstrap origin without spending the code", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const session = yield* OwnerSession.OwnerSession
      const authorization = `Bearer ${Redacted.value(yield* session.mintBootstrapCode)}`
      expect(
        (yield* client.post("/auth/bootstrap", { headers: { authorization, origin: "https://fixture.invalid" } }))
          .status
      ).toBe(403)
      expect(
        (yield* client.post("/auth/bootstrap", { headers: { authorization, origin: session.browserOrigin } }))
          .status
      ).toBe(200)
    }))
})
