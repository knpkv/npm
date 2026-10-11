import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Queue,
  Redacted,
  Ref,
  Schema
} from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import { controlAwareCors, loginControlRouter, makeWebControl } from "../src/control.js"
import { serveWithBootstrapUrl } from "../src/owner-session.js"

import * as TestClock from "effect/testing/TestClock"
import * as OwnerSession from "../src/owner-session.js"

class Home extends Context.Service<
  Home,
  {
    readonly path: string
    readonly control: ReturnType<typeof makeWebControl>
    readonly mode: Ref.Ref<"running" | "stopped" | "refused">
    readonly reply: Ref.Ref<string>
    readonly requests: Ref.Ref<number>
    readonly held: Queue.Queue<void>
    readonly logs: Array<string>
  }
>()(
  "BrowserPairing/test/ControlHome"
) {}
const fixture = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "control-" })
  const mode = yield* Ref.make<"running" | "stopped" | "refused">("running")
  const reply = yield* Ref.make(JSON.stringify({ url: `http://127.0.0.1:3001/#bootstrap_token=${"a".repeat(64)}` }))
  const requests = yield* Ref.make(0)
  const held = yield* Queue.unbounded<void>()
  const logs: Array<string> = []
  return Layer.mergeAll(
    Logger.layer([Logger.make<unknown, void>(({ cause, message }) => {
      logs.push(`${JSON.stringify({ message, cause })} ${Cause.pretty(cause)}`)
    })]),
    Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      writeFileString: (...args) =>
        fs.writeFileString(...args).pipe(
          Effect.tapError((error) =>
            args[0].endsWith("/web.lock") && error.reason._tag === "AlreadyExists"
              ? Queue.offer(held, undefined)
              : Effect.void
          )
        )
    }),
    Layer.succeed(Home, {
      path,
      mode,
      reply,
      requests,
      held,
      logs,
      control: makeWebControl({
        directory: `${path}/private`,
        file: `${path}/private/web.json`,
        messages: {
          notRunning: "Not running",
          loginRefused: (status) => `Refused ${status}`,
          controlFile: "Control file failed"
        }
      })
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function*() {
          yield* Ref.update(requests, (count) => count + 1)
          const current = yield* Ref.get(mode)
          if (current === "stopped") {
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "connection refused" })
            })
          }
          expect(request.method).toBe("POST")
          expect(request.url).toBe("http://127.0.0.1:3001/control/login")
          const refused = current === "refused" || request.headers.authorization !== `Bearer ${"a1".repeat(32)}`
          return HttpClientResponse.fromWeb(
            request,
            refused
              ? new Response(null, { status: 401 })
              : new Response(yield* Ref.get(reply), { headers: { "content-type": "application/json" } })
          )
        })
      )
    )
  )
})).pipe(Layer.provideMerge(NodeServices.layer))
const control = { origin: "http://127.0.0.1:3001", token: "a1".repeat(32) }

describe("Shared owner control file", () => {
  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("publishes atomically with owner-only permissions and removes only its own token", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const WebControl = home.control
        const file = `${(yield* Home).path}/private/web.json`
        yield* WebControl.writeControlFile(control)
        expect((yield* fs.stat(`${home.path}/private`)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(control)
        const next = { origin: "http://127.0.0.1:3002", token: "b2".repeat(32) }
        yield* WebControl.writeControlFile(next)
        yield* WebControl.removeControlFile(control.token)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(next)
        yield* WebControl.removeControlFile(next.token)
        expect(yield* fs.exists(file)).toBe(false)
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("refuses linked private directories without changing the target", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const WebControl = home.control
        const target = yield* fs.makeTempDirectoryScoped({ prefix: "control-target-" })
        const before = (yield* fs.stat(target)).mode
        yield* fs.symlink(target, `${home.path}/private`)
        const error = yield* Effect.flip(WebControl.writeControlFile(control))
        expect(error._tag).toBe("ControlFileError")
        expect((yield* fs.stat(target)).mode).toBe(before)
        expect(yield* fs.exists(`${target}/web.json`)).toBe(false)
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("refuses a linked control file without reading or replacing its target", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const WebControl = home.control
        yield* fs.makeDirectory(`${home.path}/private`, { mode: 0o700 })
        const target = `${home.path}/outside.json`
        yield* fs.writeFileString(target, "untouched")
        const file = `${(yield* Home).path}/private/web.json`
        yield* fs.symlink(target, file)
        expect((yield* Effect.flip(WebControl.writeControlFile(control)))._tag).toBe("ControlFileError")
        expect((yield* Effect.flip(WebControl.requestLoginUrl))._tag).toBe("WebNotRunning")
        expect(yield* fs.readFileString(target)).toBe("untouched")
        expect(yield* fs.readLink(file)).toBe(target)
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("refuses a directory whose permissions expose the control token", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const WebControl = home.control
        yield* fs.makeDirectory(`${home.path}/private`, { mode: 0o755 })
        yield* fs.chmod(`${home.path}/private`, 0o755)
        expect((yield* Effect.flip(WebControl.writeControlFile(control)))._tag).toBe("ControlFileError")
        expect((yield* fs.stat(`${home.path}/private`)).mode & 0o777).toBe(0o755)
      }))
  )
  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("publishes only after listening, stays foreground and cleans up on interruption", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const WebControl = (yield* Home).control
        const file = `${(yield* Home).path}/private/web.json`
        const started = yield* Deferred.make<void>()
        const listening = yield* Deferred.make<void>()
        const announced = yield* Deferred.make<void>()
        const stopped = yield* Ref.make(false)
        const calls = yield* Ref.make(0)
        const url = `${control.origin}/#bootstrap_token=${"a".repeat(64)}`
        const serving = serveWithBootstrapUrl(
          (ready) =>
            Layer.effectDiscard(Effect.gen(function*() {
              yield* Effect.addFinalizer(() => Ref.set(stopped, true))
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(listening)
              yield* Deferred.succeed(ready, url)
            })),
          (link) =>
            Effect.gen(function*() {
              expect(link).toBe(url)
              yield* WebControl.registerControlFile(control)
              yield* Ref.update(calls, (count) => count + 1)
              yield* Deferred.succeed(announced, undefined)
            })
        )
        const running = yield* Effect.scoped(serving).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        expect(yield* fs.exists(file)).toBe(false)
        yield* Deferred.succeed(listening, undefined)
        yield* Deferred.await(announced)
        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* Ref.get(calls)).toBe(1)
        expect(yield* Ref.get(stopped)).toBe(false)
        yield* Fiber.interrupt(running)
        expect(yield* Ref.get(stopped)).toBe(true)
        expect(yield* fs.exists(file)).toBe(false)
      }))
  )
})

const authority = "http://127.0.0.1:3001"
const publicOrigin = "http://localhost:5173"
const token = "c0".repeat(32)
const makeHarness = Effect.gen(function*() {
  const session = yield* OwnerSession.make({
    authorityOrigin: authority,
    browserOrigin: authority,
    cookieName: "test_owner",
    freshUrlHint: "restart for a fresh URL",
    product: "test",
    writes: "csrf"
  })
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
class Harness
  extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("BrowserPairing/test/LoginRoute")
{}
const routeFixture = Layer.effect(Harness, makeHarness).pipe(Layer.provide(NodeCrypto.layer))
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

describe("Shared owner login route", () => {
  it.layer(Layer.fresh(routeFixture))((it) => {
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
  it.layer(Layer.fresh(routeFixture))((it) => {
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
  it.layer(Layer.fresh(routeFixture))((it) => {
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

describe("Shared control client and lock", () => {
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("gets a validated credential URL using only the persisted bearer token", () =>
      Effect.gen(function*() {
        const home = yield* Home
        yield* home.control.writeControlFile(control)
        expect(yield* home.control.requestLoginUrl).toBe(`http://127.0.0.1:3001/#bootstrap_token=${"a".repeat(64)}`)
        yield* Ref.set(home.reply, JSON.stringify({ url: `http://localhost:5173/#bootstrap_token=${"b".repeat(64)}` }))
        expect(yield* home.control.requestLoginUrl).toBe(`http://localhost:5173/#bootstrap_token=${"b".repeat(64)}`)
        expect(yield* Ref.get(home.requests)).toBe(2)
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("classifies missing files and unreachable servers separately from refused login", () =>
      Effect.gen(function*() {
        const home = yield* Home
        expect((yield* Effect.flip(home.control.requestLoginUrl))._tag).toBe("WebNotRunning")
        expect(yield* Ref.get(home.requests)).toBe(0)
        yield* home.control.writeControlFile(control)
        yield* Ref.set(home.mode, "stopped")
        expect((yield* Effect.flip(home.control.requestLoginUrl))._tag).toBe("WebNotRunning")
        yield* Ref.set(home.mode, "running")
        yield* home.control.writeControlFile({ ...control, token: "b2".repeat(32) })
        const error = yield* Effect.flip(home.control.requestLoginUrl)
        expect(error._tag).toBe("WebLoginRefused")
        expect(error.message).toBe("Refused 401")
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("refuses malformed and foreign credential replies rather than permitting another server", () =>
      Effect.gen(function*() {
        const home = yield* Home
        yield* home.control.writeControlFile(control)
        for (
          const reply of [
            "not json",
            "{}",
            JSON.stringify({ url: "not a URL" }),
            ...[
              `https://outside.example/#bootstrap_token=${"a".repeat(64)}`,
              `http://owner@127.0.0.1:3001/#bootstrap_token=${"a".repeat(64)}`,
              `http://127.0.0.1:3001/other#bootstrap_token=${"a".repeat(64)}`,
              `http://127.0.0.1:3001/?secret=value#bootstrap_token=${"a".repeat(64)}`,
              "http://127.0.0.1:3001/#bootstrap_token=invalid",
              "http://127.0.0.1:3001/"
            ].map((url) => JSON.stringify({ url }))
          ]
        ) {
          yield* Ref.set(home.reply, reply)
          expect((yield* Effect.flip(home.control.requestLoginUrl))._tag).toBe("WebLoginRefused")
        }
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("rejects exposed files and non-loopback persisted origins before making a request", () =>
      Effect.gen(function*() {
        const home = yield* Home
        const fs = yield* FileSystem.FileSystem
        const file = `${home.path}/private/web.json`
        yield* home.control.writeControlFile(control)
        yield* fs.chmod(file, 0o644)
        expect((yield* Effect.flip(home.control.requestLoginUrl))._tag).toBe("WebNotRunning")
        expect((yield* Effect.flip(home.control.writeControlFile(control)))._tag).toBe("ControlFileError")
        yield* fs.chmod(file, 0o600)
        yield* fs.writeFileString(file, JSON.stringify({ ...control, origin: "http://outside.example" }))
        expect((yield* Effect.flip(home.control.requestLoginUrl))._tag).toBe("WebNotRunning")
        expect(yield* Ref.get(home.requests)).toBe(0)
      }))
  })
  it.layer(Layer.fresh(fixture), { excludeTestServices: true })((it) => {
    it.effect("serializes an older server's removal with a newer server's publication", () =>
      Effect.gen(function*() {
        const home = yield* Home
        const fs = yield* FileSystem.FileSystem
        const lock = `${home.path}/private/web.lock`
        const file = `${home.path}/private/web.json`
        yield* home.control.writeControlFile(control)
        yield* fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 })
        const newer = { ...control, token: "b2".repeat(32) }
        const removing = yield* home.control.removeControlFile(control.token).pipe(Effect.forkScoped)
        const writing = yield* home.control.writeControlFile(newer).pipe(Effect.forkScoped)
        yield* Queue.take(home.held)
        yield* Queue.take(home.held)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(control)
        yield* fs.remove(lock)
        yield* Fiber.join(removing)
        yield* Fiber.join(writing)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(newer)
      }))
  })
  it.layer(Layer.fresh(fixture), { excludeTestServices: true })((it) => {
    it.effect("reclaims an owner-private stale lock and removes it after publication", () =>
      Effect.gen(function*() {
        const home = yield* Home
        const fs = yield* FileSystem.FileSystem
        const lock = `${home.path}/private/web.lock`
        yield* fs.makeDirectory(`${home.path}/private`, { mode: 0o700 })
        yield* fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 })
        yield* fs.utimes(lock, new Date(0), new Date(0))
        const writing = yield* home.control.writeControlFile(control).pipe(Effect.forkScoped)
        yield* Fiber.join(writing)
        expect(yield* fs.exists(lock)).toBe(false)
        expect(yield* home.control.requestLoginUrl).toContain("#bootstrap_token=")
      }))
  })
})

it.layer(Layer.fresh(fixture))((it) => {
  it.effect("keeps malformed control credentials out of cleanup warnings", () =>
    Effect.gen(function*() {
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      yield* home.control.writeControlFile(control)
      const credential = "private-fixture-credential"
      yield* fs.writeFileString(`${home.path}/private/web.json`, JSON.stringify({ ...control, token: credential }))
      yield* home.control.removeControlFile(control.token)
      expect(home.logs.join("\n")).toContain("Could not remove the owner-only web control file")
      expect(home.logs.join("\n")).not.toContain(credential)
    }))
})
