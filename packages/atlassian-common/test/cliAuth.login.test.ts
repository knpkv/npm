/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * Browser login through the shared Atlassian CLI auth.
 *
 * The login prints the authorization URL before it tries to open a browser, so
 * a browser that will not open must not end the login: the user can still visit
 * the URL. A callback server that cannot bind, on the other hand, must end it
 * before any URL is advertised, and the server must stop whenever the login's
 * scope closes.
 */
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider } from "effect"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServer, HttpServerError } from "effect/http"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process"
import * as Ref from "effect/Ref"
import type * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { createServer } from "node:http"
import { makeAtlassianCliAuth, makeHttpServerFactory } from "../src/cli-auth/index.js"
import { loadActiveProfileToken } from "../src/config/AuthProfiles.js"
import { HomeDirectoryLive } from "../src/config/ConfigPaths.js"
import { saveOAuthConfig } from "../src/config/TokenStorage.js"

const TOOL = "test-cli"

class TestAuthMissing extends Data.TaggedError("TestAuthMissing") {}

const authOptions = {
  toolName: TOOL,
  commandName: "test",
  productName: "Test",
  scopes: ["read:me", "offline_access"],
  authMissing: () => new TestAuthMissing()
}

const storage = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, HomeDirectoryLive)

const withHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "atlassian-cli-login-" })
    return yield* effect.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

const seedConfig = saveOAuthConfig(TOOL, { clientId: "client-1", clientSecret: "secret-1" }).pipe(
  Effect.provide(storage)
)

const json = (request: HttpClientRequest.HttpClientRequest, body: Schema.Json) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  )

// Atlassian's side of a successful login: token exchange, one site, the user.
const atlassianClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    if (request.url.endsWith("/oauth/token")) {
      return Effect.succeed(json(request, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "read:me offline_access",
        token_type: "Bearer"
      }))
    }
    if (request.url.endsWith("/accessible-resources")) {
      return Effect.succeed(
        json(request, [{ id: "cloud-1", name: "Site", url: "https://site.atlassian.net", scopes: [] }])
      )
    }
    return Effect.succeed(json(request, { account_id: "acc-1", name: "Ada", email: "ada@example.com" }))
  })
)

// Every launcher runs and reports failure — merged after NodeServices so it
// replaces the real spawner rather than being replaced by it, the way `xdg-open` does on a host
// with no browser. The first launch hands its URL to the test.
const failingLaunchers = (launched: Deferred.Deferred<string>, attempts: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function*() {
        if (command._tag === "StandardCommand") {
          yield* Ref.update(attempts, (all) => [...all, command.command])
          yield* Deferred.succeed(launched, command.args[command.args.length - 1] ?? "")
        }
        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          reref: Effect.void,
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )

// An ephemeral real server whose shutdown the test can observe.
const observedServerFactory = (stopped: Ref.Ref<boolean>) =>
  makeHttpServerFactory(() =>
    Layer.merge(
      NodeHttpServer.layerServer(createServer, { port: 0 }),
      Layer.effectDiscard(Effect.addFinalizer(() => Ref.set(stopped, true)))
    )
  )

const captureConsole = (lines: Array<string>): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => lines.push(args.join(" ")),
    error: (...args: ReadonlyArray<unknown>) => lines.push(`stderr: ${args.join(" ")}`)
  })

const deliverCallback = (authUrl: string) =>
  Effect.gen(function*() {
    const url = new URL(authUrl)
    const redirect = url.searchParams.get("redirect_uri") ?? ""
    const state = url.searchParams.get("state") ?? ""
    const port = new URL(redirect).port
    const client = yield* HttpClient.HttpClient
    yield* client.execute(
      HttpClientRequest.get(`http://127.0.0.1:${port}/callback`).pipe(
        HttpClientRequest.setUrlParam("code", "code-1"),
        HttpClientRequest.setUrlParam("state", state)
      )
    )
  }).pipe(Effect.provide(NodeHttpClient.layerUndici))

describe("Atlassian CLI login", () => {
  it.live("keeps waiting for the callback when no browser launcher succeeds", () =>
    withHome(Effect.gen(function*() {
      yield* seedConfig
      const launched = yield* Deferred.make<string>()
      const attempts = yield* Ref.make<ReadonlyArray<string>>([])
      const lines: Array<string> = []
      const stopped = yield* Ref.make(false)

      const login = yield* makeAtlassianCliAuth(authOptions).pipe(
        Effect.flatMap((auth) => auth.login()),
        Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          HomeDirectoryLive,
          atlassianClient,
          failingLaunchers(launched, attempts),
          observedServerFactory(stopped)
        )),
        Effect.provideService(Console.Console, captureConsole(lines)),
        Effect.forkChild({ startImmediately: true })
      )

      const authUrl = yield* Deferred.await(launched)
      yield* deliverCallback(authUrl)
      const result = yield* Fiber.join(login)

      expect(result).toBeUndefined()
      expect(yield* Ref.get(attempts)).toEqual(["open", "xdg-open", "rundll32.exe"])
      const printed = lines
      expect(printed.some((line) => line.includes(`visit: ${authUrl}`))).toBe(true)
      expect(printed).toContain("stderr: Could not open a browser (rundll32.exe exited 1); visit the URL above.")
      expect(printed).toContain("Logged in as Ada (ada@example.com)")
      expect(yield* Ref.get(stopped)).toBe(true)
      const stored = yield* loadActiveProfileToken(TOOL).pipe(Effect.provide(storage))
      expect(stored?.cloud_id).toBe("cloud-1")
    })))

  it.effect("fails before advertising a URL when the callback server cannot bind", () =>
    withHome(Effect.gen(function*() {
      yield* seedConfig
      const launched = yield* Deferred.make<string>()
      const attempts = yield* Ref.make<ReadonlyArray<string>>([])
      const lines: Array<string> = []
      const refused = makeHttpServerFactory(() =>
        Layer.effect(
          HttpServer.HttpServer,
          Effect.fail(new HttpServerError.ServeError({ cause: { code: "EACCES" } }))
        )
      )

      const error = yield* makeAtlassianCliAuth(authOptions).pipe(
        Effect.flatMap((auth) => auth.login()),
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            HomeDirectoryLive,
            atlassianClient,
            failingLaunchers(launched, attempts),
            refused
          )
        ),
        Effect.provideService(Console.Console, captureConsole(lines)),
        Effect.flip
      )

      expect(error._tag).toBe("OAuthError")
      expect(yield* Ref.get(attempts)).toEqual([])
      expect(lines).toEqual([])
    })))

  it.effect("stops the callback server when authorization times out", () =>
    withHome(Effect.gen(function*() {
      yield* seedConfig
      const launched = yield* Deferred.make<string>()
      const attempts = yield* Ref.make<ReadonlyArray<string>>([])
      const lines: Array<string> = []
      const stopped = yield* Ref.make(false)

      const login = yield* makeAtlassianCliAuth(authOptions).pipe(
        Effect.flatMap((auth) => auth.login()),
        Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          HomeDirectoryLive,
          atlassianClient,
          failingLaunchers(launched, attempts),
          observedServerFactory(stopped)
        )),
        Effect.provideService(Console.Console, captureConsole(lines)),
        Effect.flip,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(launched)
      // The deadline is registered just after the launch; step the clock past it
      // in increments so it fires wherever in that window it was set.
      for (let minute = 0; minute < 10; minute++) {
        yield* TestClock.adjust("1 minute")
        yield* Effect.yieldNow
      }
      const error = yield* Fiber.join(login)

      expect(error._tag).toBe("OAuthError")
      expect(String(error.cause)).toBe("Authorization timed out")
      expect(yield* Ref.get(stopped)).toBe(true)
    })))
})
