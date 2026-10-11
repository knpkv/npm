import { NodeCrypto } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as TestClock from "effect/testing/TestClock"
import { controlAwareCors, loginControlRouter } from "../src/server/internal/LoginControl.js"
import { makeOwnerSession } from "../src/server/internal/OwnerSession.js"

const authority = "http://127.0.0.1:3001"
const publicOrigin = "http://localhost:5173"
const token = "c0".repeat(32)
const makeHarness = Effect.gen(function*() {
  const session = yield* makeOwnerSession(authority)
  const routed = yield* HttpRouter.toHttpEffect(
    Layer.mergeAll(
      loginControlRouter(Redacted.make(token), publicOrigin),
      HttpRouter.use((router) => router.add("GET", "/api/example", Effect.succeed(HttpServerResponse.empty())))
    ).pipe(
      Layer.provide(
        controlAwareCors({
          allowedOrigins: [publicOrigin],
          allowedMethods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["authorization"]
        })
      ),
      Layer.provide(Layer.succeed(OwnerSession.OwnerSession, session))
    )
  )
  const route = routed.pipe(Effect.provideService(OwnerSession.OwnerSession, session))
  return { session, route }
})
class Harness extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("CodeCommitWeb/test/LoginRoute") {}
const fixture = Layer.effect(Harness, makeHarness).pipe(Layer.provide(NodeCrypto.layer))
const post = (authorization?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`${authority}/control/login`, {
      method: "POST",
      headers: authorization === undefined ? { origin: publicOrigin } : { authorization, origin: publicOrigin }
    })
  )
/** Observe the sent response, including CORS pre-response handlers. */
const respond = Effect.fn("LoginControlTest.respond")(function*(request: HttpServerRequest.HttpServerRequest) {
  const harness = yield* Harness
  const sent = yield* Ref.make<HttpServerResponse.HttpServerResponse | undefined>(undefined)
  yield* HttpEffect.toHandled(harness.route, (_request, response) => Ref.set(sent, response)).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  )
  const response = yield* Ref.get(sent)
  if (response === undefined) return yield* Effect.die("No HTTP response was sent")
  return response
})

const Answer = Schema.Struct({ url: Schema.String })
const urlFrom = Effect.fn("LoginControlTest.url")(function*(request: HttpServerRequest.HttpServerRequest) {
  const response = yield* respond(request)
  expect(response.status).toBe(200)
  expect(response.headers["cache-control"]).toBe("no-store")
  expect(response.headers["access-control-allow-origin"]).toBeUndefined()
  if (response.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON response")
  const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(
    new TextDecoder().decode(response.body.body)
  )
  return new URL(answer.url)
})
const spend = (session: OwnerSession.OwnerSessionService, url: URL) =>
  session.authorizeBootstrap({
    authorization: `Bearer ${url.hash.slice("#bootstrap_token=".length)}`,
    origin: authority
  })

describe("CodeCommit owner login route", () => {
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("requires the bearer token without consuming or replacing an existing code", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const normal = yield* respond(
          HttpServerRequest.fromWeb(new Request(`${authority}/api/example`, { headers: { origin: publicOrigin } }))
        )
        expect(normal.headers["access-control-allow-origin"]).toBe(publicOrigin)
        const preflight = yield* Effect.flip(harness.route.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${authority}/control/login`, {
                method: "OPTIONS",
                headers: { origin: publicOrigin, "access-control-request-method": "POST" }
              })
            )
          )
        ))
        expect(preflight.reason._tag).toBe("RouteNotFound")
        const previous = yield* harness.session.mintBootstrapCode
        for (const authorization of [undefined, "Bearer wrong", `Basic ${token}`]) {
          const response = yield* respond(post(authorization))
          expect(response.status).toBe(401)
          expect(response.headers["access-control-allow-origin"]).toBeUndefined()
        }
        yield* harness.session.authorizeBootstrap({
          authorization: `Bearer ${Redacted.value(previous)}`,
          origin: authority
        })
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("mints on the startup public origin, exchanges once and preserves the session", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const url = yield* urlFrom(post(`Bearer ${token}`))
        expect(url.origin).toBe(publicOrigin)
        expect(url.hash).toMatch(/^#bootstrap_token=[0-9a-f]{64}$/u)
        yield* spend(harness.session, url)
        expect((yield* Effect.flip(spend(harness.session, url)))._tag).toBe("OwnerSessionUnauthorizedError")
        const fresh = yield* urlFrom(post(`Bearer ${token}`))
        expect(fresh.href).not.toBe(url.href)
        yield* spend(harness.session, fresh)
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("fresh login codes expire at the same 60-second boundary as startup", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const url = yield* urlFrom(post(`Bearer ${token}`))
        yield* TestClock.adjust("60 seconds")
        expect((yield* Effect.flip(spend(harness.session, url)))._tag).toBe("OwnerSessionUnauthorizedError")
        yield* spend(harness.session, yield* urlFrom(post(`Bearer ${token}`)))
      }))
  })
})
