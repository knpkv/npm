/**
 * The hub's app contract, against the fixture app on real unix sockets: registration, removal, every
 * unavailable reason, the manifest cache, the proxy and the grants. Each scenario is one the design names.
 */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AppId, AppStates, hubHeaders, type ModuleCaller } from "@knpkv/hub-app"
import { fixtureApp, type FixtureMode } from "@knpkv/hub-app-fixture"
import { serveAttached } from "@knpkv/hub-app/node"
import { Duration, Effect, Exit, FileSystem, Layer, Path, Schedule, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http"
import { createServer as createNetServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { makeAppTokens, makeGrants } from "../src/apps/grants.js"
import { makeAppRegistry } from "../src/apps/registry.js"
import { handleAppsRoute } from "../src/apps/routes.js"
import { getJson } from "../src/apps/socket.js"

const appId = Schema.decodeSync(AppId)
const ListeningPort = Schema.Struct({ port: Schema.Number })

/** A short temp directory: unix socket paths are limited to 107 bytes. */
const tempDirectory = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "hub-apps-" })
})

/** Run the fixture attached on `<directory>/<id>.sock` for the test's scope; returns once it answers. */
const startFixture = (directory: string, mode: FixtureMode, id = "fixture") =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const socket = path.join(directory, `${id}.sock`)
    const tokenFile = path.join(directory, `${id}.app-token`)
    yield* fileSystem.writeFileString(tokenFile, "fixture-token\n")
    yield* serveAttached(fixtureApp(mode, id), { _tag: "Attached", socket, hubUrl: "http://127.0.0.1:9", tokenFile })
      .pipe(
        Effect.forkScoped
      )
    yield* getJson(socket, "/app/health", 500).pipe(
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
    )
    return socket
  })

/** A socket that accepts and never answers; its connections are destroyed when the scope closes. */
const hangingSocket = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: ReturnType<typeof createNetServer>; readonly held: Set<Socket> }>((resume) => {
      const held = new Set<Socket>()
      const server = createNetServer((connection) => {
        held.add(connection)
      })
      server.listen(socket, () => resume(Effect.succeed({ server, held })))
    }),
    ({ held, server }) =>
      Effect.callback<void>((resume) => {
        for (const connection of held) connection.destroy()
        server.close(() => resume(Effect.void))
      })
  )

const makeHub = (directory: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const fileSystem = yield* FileSystem.FileSystem
    const configPath = path.join(directory, "apps.json")
    const cacheDirectory = path.join(directory, "cache")
    const tokens = yield* makeAppTokens(path.join(directory, "tokens"))
    const registry = yield* makeAppRegistry({
      configPath,
      cacheDirectory,
      tokens,
      coreIds: ["connect", "fleet"],
      supportedContracts: [1],
      probeTimeoutMillis: 300
    })
    const writeConfig = (apps: ReadonlyArray<{ readonly id: string; readonly socket: string }>) =>
      fileSystem.writeFileString(configPath, JSON.stringify({ v: 1, apps }))
    const states = Effect.map(registry.apps, (apps) => apps.map((app) => app.state))
    return { registry, writeConfig, states, cacheDirectory }
  })

describe("hub apps", () => {
  it.layer(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp), { excludeTestServices: true })((it) => {
    it.effect("no apps.json means no apps: today's navigation", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const hub = yield* makeHub(directory)
        yield* hub.registry.reload()
        expect(yield* hub.states).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("an app added to apps.json is Ready after a reload, with its manifest cached", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const fileSystem = yield* FileSystem.FileSystem
        const socket = yield* startFixture(directory, "ok")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", socket }])
        yield* hub.registry.reload()
        const [state] = yield* hub.states
        expect(state?._tag).toBe("Ready")
        expect(state?.manifest?.module.label).toBe("Fixture")
        expect(state?.manifest?.client).toEqual({ entry: "client.js", css: [] })
        expect(yield* fileSystem.exists(`${hub.cacheDirectory}/fixture.manifest.json`)).toBe(true)
      }).pipe(Effect.scoped))

    it.effect("an app removed from apps.json is gone, with its cache entry", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const fileSystem = yield* FileSystem.FileSystem
        const socket = yield* startFixture(directory, "ok")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", socket }])
        yield* hub.registry.reload()
        yield* hub.writeConfig([])
        yield* hub.registry.reload()
        expect(yield* hub.states).toEqual([])
        expect(yield* fileSystem.exists(`${hub.cacheDirectory}/fixture.manifest.json`)).toBe(false)
      }).pipe(Effect.scoped))

    it.effect("an app that stops keeps its cached label and is not_running; the hub keeps going", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const hub = yield* makeHub(directory)
        const appScope = yield* Scope.make()
        const socket = yield* startFixture(directory, "ok").pipe(Scope.provide(appScope))
        yield* hub.writeConfig([{ id: "fixture", socket }])
        yield* hub.registry.reload()
        yield* Scope.close(appScope, Exit.void)
        yield* hub.registry.refresh()
        const [state] = yield* hub.states
        expect(state?._tag).toBe("Unavailable")
        expect(state?._tag === "Unavailable" ? state.reason : null).toBe("not_running")
        expect(state?.manifest?.module.label).toBe("Fixture")
      }).pipe(Effect.scoped))

    it.effect("an app that throws at load never answers: not_running, with no cached label", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", socket: `${directory}/absent.sock` }])
        yield* hub.registry.reload()
        expect(yield* hub.states).toEqual([{
          _tag: "Unavailable",
          id: "fixture",
          manifest: null,
          reason: "not_running",
          detail: "fixture isn't running."
        }])
      }).pipe(Effect.scoped))

    it.effect("each bad answer has its own reason, and one bad app leaves the others Ready", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const ok = yield* startFixture(directory, "ok", "good")
        const newer = yield* startFixture(directory, "contract-2", "newer")
        const imposter = yield* startFixture(directory, "wrong-id", "imposter")
        const hanging = `${directory}/hang.sock`
        yield* hangingSocket(hanging)
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([
          { id: "good", socket: ok },
          { id: "newer", socket: newer },
          { id: "imposter", socket: imposter },
          { id: "hang", socket: hanging },
          { id: "connect", socket: ok },
          { id: "good", socket: ok }
        ])
        yield* hub.registry.reload()
        const reasons = (yield* hub.states).map((state) => state._tag === "Ready" ? "ready" : state.reason)
        expect(reasons).toEqual(["ready", "incompatible", "id_mismatch", "timeout", "duplicate", "duplicate"])
      }).pipe(Effect.scoped))

    it.effect("an invalid apps.json keeps the previous list", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const fileSystem = yield* FileSystem.FileSystem
        const socket = yield* startFixture(directory, "ok")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", socket }])
        yield* hub.registry.reload()
        yield* fileSystem.writeFileString(`${directory}/apps.json`, "{\"v\":1,\"apps\":[],\"extra\":true}")
        yield* hub.registry.reload()
        expect((yield* hub.states).map((state) => state._tag)).toEqual(["Ready"])
      }).pipe(Effect.scoped))
  })

  it.layer(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp), { excludeTestServices: true })((it) => {
    /** The hub's route on a loopback port, admitting every request as `viewer`. */
    const serveHubRoutes = (directory: string, socket: string | null) =>
      Effect.gen(function*() {
        const hub = yield* makeHub(directory)
        if (socket !== null) yield* hub.writeConfig([{ id: "fixture", socket }])
        yield* hub.registry.reload()
        const grants = yield* makeGrants
        const server = yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const created = createHttpServer((request, response) => {
              void handleAppsRoute<never, never>(request, response, new URL(request.url ?? "/", "http://hub.test"), {
                listener: "local",
                registry: hub.registry,
                grants,
                authorize: Effect.succeed({ login: "viewer", sameNode: false, provenance: "authenticated_remote" }),
                sameOrigin: Effect.void,
                refuse: (target) => {
                  target.writeHead(403)
                  target.end()
                },
                runtime: { runPromiseExit: Effect.runPromiseExit }
              }).then((handled) => {
                if (!handled) {
                  response.writeHead(418)
                  response.end()
                }
              })
            })
            created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)))
          }),
          (created) =>
            Effect.callback<void>((resume) => {
              created.close(() => resume(Effect.void))
            })
        )
        const { port } = Schema.decodeUnknownSync(ListeningPort)(server.address())
        return { hub, port }
      })

    const get = (port: number, path: string, headers: Record<string, string> = {}) =>
      Effect.callback<{ readonly status: number; readonly body: string }>((resume) => {
        const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers }, (incoming) => {
          const chunks: Array<Buffer> = []
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
          incoming.on(
            "end",
            () => resume(Effect.succeed({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
          )
        })
        outgoing.end()
      })

    it.effect("proxies a module route with the hub's caller, ignoring one the browser claims", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const socket = yield* startFixture(directory, "ok")
        const { port } = yield* serveHubRoutes(directory, socket)
        const answer = yield* get(port, "/apps/fixture/v1/modules/fixture/echo", {
          [hubHeaders.caller]: JSON.stringify({ login: "spoofed", sameNode: true }),
          [hubHeaders.grant]: "a".repeat(40)
        })
        expect(answer.status).toBe(200)
        expect(JSON.parse(answer.body)).toEqual({
          login: "viewer",
          sameNode: false,
          provenance: "authenticated_remote"
        })
      }).pipe(Effect.scoped))

    it.effect("serves /v1/apps and the app's client asset", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const socket = yield* startFixture(directory, "ok")
        const { port } = yield* serveHubRoutes(directory, socket)
        const list = yield* get(port, "/v1/apps")
        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(AppStates))(list.body)
        expect(decoded.apps.map((app) => app._tag)).toEqual(["Ready"])
        const asset = yield* get(port, "/apps/fixture/app/assets/client.js")
        expect(asset.status).toBe(200)
        expect(asset.body).toContain("contract: 1")
      }).pipe(Effect.scoped))

    it.effect("answers 404 for unknown apps and paths, and 503 for an app that is down", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { port } = yield* serveHubRoutes(directory, `${directory}/absent.sock`)
        expect((yield* get(port, "/apps/removed/v1/modules/removed/echo")).status).toBe(404)
        expect((yield* get(port, "/apps/fixture/app/manifest")).status).toBe(404)
        const down = yield* get(port, "/apps/fixture/v1/modules/fixture/echo")
        expect(down.status).toBe(503)
        expect(JSON.parse(down.body)).toEqual({ error: "app_unavailable", reason: "not_running" })
      }).pipe(Effect.scoped))
  })

  // Crypto from Node; the test clock stays, so expiry is exact.
  it.layer(NodeServices.layer)((it) => {
    it.effect("grants: one use for jobs, bound to their app, gone after 60 s", () =>
      Effect.gen(function*() {
        const grants = yield* makeGrants
        const caller: ModuleCaller = { login: "viewer", sameNode: false, provenance: "authenticated_remote" }
        const fixture = appId("fixture")
        const { grant } = yield* grants.mint(fixture, caller)
        const reason = (use: Effect.Effect<unknown, { readonly reason: string }>) =>
          Effect.map(Effect.flip(use), (error) => error.reason)

        expect(yield* reason(grants.use({ grant: "b".repeat(40), app: fixture, once: true }))).toBe("unknown")
        expect(yield* reason(grants.use({ grant, app: appId("other"), once: true }))).toBe("app_mismatch")
        expect(yield* grants.use({ grant, app: fixture, once: false })).toEqual(caller)
        expect(yield* grants.use({ grant, app: fixture, once: true })).toEqual(caller)
        expect(yield* reason(grants.use({ grant, app: fixture, once: true }))).toBe("used")

        const { grant: later } = yield* grants.mint(fixture, caller)
        yield* TestClock.adjust(Duration.seconds(61))
        expect(yield* reason(grants.use({ grant: later, app: fixture, once: true }))).toBe("expired")
      }))
  })
})
