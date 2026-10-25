/**
 * The hub's app contract, against the fixture app on real unix sockets: registration, removal, every
 * unavailable reason, the manifest cache, the proxy and the grants. Each scenario is one the design names. The
 * fixture runs in this process, attached through a handshake on a test stdin; a stub supervisor reports where it
 * listens. The supervisor itself, with real child processes, is `supervisor.test.ts`.
 */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { FleetLimits, UsageQuery } from "@knpkv/herdr-connect"
import { AppId, type AppId as AppIdType, AppManifest, AppStates, hubHeaders, type ModuleCaller } from "@knpkv/hub-app"
import { fixtureApp, type FixtureMode } from "@knpkv/hub-app-fixture"
import { serveAttached } from "@knpkv/hub-app/node"
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stdio,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server
} from "node:http"
import { createServer as createNetServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import process from "node:process"
import { answerFleetRead } from "../src/apps/fleet-read.js"
import { type AppTokens, makeAppTokens, makeGrants } from "../src/apps/grants.js"
import { type AppReach, logReloadFailure, makeAppRegistry, type RegisteredApp, stateOn } from "../src/apps/registry.js"
import { AppServiceRefused, handleAppServicesRoute, handleAppsRoute } from "../src/apps/routes.js"
import { appLocation, getJson, proxyToSocket } from "../src/apps/socket.js"
import type { AppRun, AppSupervisor } from "../src/apps/supervisor.js"
import type { ListenerMode } from "../src/internal/listener.js"

const appId = Schema.decodeSync(AppId)
const ListeningPort = Schema.Struct({ port: Schema.Number })

/** The request body, decoded with `schema`, as the hub's own `readJson` does. */
const readBody = <A>(request: IncomingMessage, schema: Schema.Codec<A, unknown, never, never>) =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString())))
  }).pipe(Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)))

/** A short temp directory: unix socket paths are limited to 107 bytes. */
const tempDirectory = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "hub-apps-" })
})

/** Where a test app listens: a unix socket in `directory`, or a uniquely named pipe on Windows. */
const endpointIn = (directory: string, name: string): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\hub-test-${name}-${Math.random().toString(16).slice(2)}`
    : `${directory}/${name}.sock`

/** A running fixture: where it listens, its spawn's secret, and the token the hub issued that spawn. */
interface Fixture extends AppReach {
  readonly token: Redacted.Redacted<string>
}

/** An endpoint the hub reaches with a secret nobody checks: an absent or a hanging socket. */
const atEndpoint = (endpoint: string): AppReach => ({ endpoint, secret: Redacted.make("unused-secret") })

/**
 * Run the fixture attached on `<directory>/<id>.sock` for the test's scope, as the supervisor would: a handshake
 * on its stdin with a fresh secret and, with `hub`, a token that hub issued. Returns once it answers.
 */
const startFixture = (
  directory: string,
  mode: FixtureMode,
  id = "fixture",
  hub?: { readonly url: string; readonly tokens: AppTokens }
) =>
  Effect.gen(function*() {
    const endpoint = endpointIn(directory, id)
    const secret = Redacted.make(`secret-of-${id}`.padEnd(32, "-"))
    const token = hub === undefined ? Redacted.make("fixture-token") : yield* hub.tokens.issue(appId(id), "spawn-1")
    const handshake = JSON.stringify({
      v: 1,
      endpoint,
      hubUrl: hub?.url ?? "http://127.0.0.1:9",
      hubToken: Redacted.value(token),
      appSecret: Redacted.value(secret)
    })
    const stdin = yield* Layer.build(
      Stdio.layerTest({
        stdin: Stream.make(new TextEncoder().encode(`${handshake}\n`)).pipe(Stream.concat(Stream.never))
      })
    )
    yield* serveAttached(fixtureApp(mode, id)).pipe(Effect.provideContext(stdin), Effect.forkScoped)
    yield* getJson(endpoint, "/app/health", 500, { [hubHeaders.appSecret]: Redacted.value(secret) }).pipe(
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
    )
    return { endpoint, secret, token } satisfies Fixture
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

/** The registry over a stub supervisor: `writeConfig` writes apps.json v2 and says each app runs at its reach. */
const makeHub = (directory: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const fileSystem = yield* FileSystem.FileSystem
    const configPath = path.join(directory, "apps.json")
    const cacheDirectory = path.join(directory, "cache")
    const tokens = yield* makeAppTokens
    const runs = new Map<AppIdType, AppRun>()
    /** What each reload handed the supervisor to run, in order. */
    const synced: Array<ReadonlyArray<string>> = []
    const supervisor: AppSupervisor = {
      sync: (entries) => Effect.sync(() => synced.push(entries.map((entry) => entry.id))),
      restart: () => Effect.succeed(false),
      run: (id) => Effect.sync(() => runs.get(id)),
      changes: Stream.never,
      recentLines: () => Effect.succeed([])
    }
    const registry = yield* makeAppRegistry({
      configPath,
      cacheDirectory,
      supervisor,
      coreIds: ["connect", "fleet"],
      supportedContracts: [1],
      probeTimeoutMillis: 300
    })
    /** `package` is what the installer verified; it defaults to a first-party name. */
    const writeConfig = (
      apps: ReadonlyArray<{ readonly id: string; readonly reach: AppReach; readonly package?: string }>
    ) =>
      Effect.gen(function*() {
        for (const app of apps) {
          runs.set(appId(app.id), { _tag: "Running", endpoint: app.reach.endpoint, secret: app.reach.secret })
        }
        yield* fileSystem.writeFileString(
          configPath,
          JSON.stringify({
            v: 2,
            managedBy: "cli",
            trust: { scopes: ["@knpkv"] },
            apps: apps.map((app) => ({
              id: app.id,
              package: app.package ?? "@knpkv/hub-app-fixture",
              version: "0.0.0",
              dir: directory,
              bin: "bin.mjs",
              enabled: true,
              memoryMb: 128,
              allowScripts: false
            }))
          })
        )
      })
    const states = Effect.map(registry.apps, (apps) => apps.map((app) => app.state))
    return { registry, tokens, writeConfig, states, cacheDirectory, synced }
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
        yield* hub.writeConfig([{ id: "fixture", reach: socket }])
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
        yield* hub.writeConfig([{ id: "fixture", reach: socket }])
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
        yield* hub.writeConfig([{ id: "fixture", reach: socket }])
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
        yield* hub.writeConfig([{ id: "fixture", reach: atEndpoint(endpointIn(directory, "absent")) }])
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
        const hanging = endpointIn(directory, "hang")
        yield* hangingSocket(hanging)
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([
          { id: "good", reach: ok },
          { id: "newer", reach: newer },
          { id: "imposter", reach: imposter },
          { id: "hang", reach: atEndpoint(hanging) },
          { id: "connect", reach: ok },
          { id: "good", reach: ok }
        ])
        yield* hub.registry.reload()
        const reasons = (yield* hub.states).map((state) => state._tag === "Ready" ? "ready" : state.reason)
        expect(reasons).toEqual(["ready", "incompatible", "id_mismatch", "timeout", "duplicate", "duplicate"])
      }).pipe(Effect.scoped))

    // While a core module holds an id (the built-in Usage until an app replaces it), an installed app with that id
    // is listed as a duplicate and never started, so no second process runs against the same state.
    it.effect("never starts an app whose id a core module or an earlier entry holds", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const ok = yield* startFixture(directory, "ok", "good")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([
          { id: "connect", reach: ok },
          { id: "good", reach: ok },
          { id: "good", reach: ok }
        ])
        yield* hub.registry.reload()
        expect(hub.synced).toEqual([["good"]])
        expect((yield* hub.states).map((state) => state._tag === "Ready" ? "ready" : state.reason)).toEqual([
          "duplicate",
          "ready",
          "duplicate"
        ])
      }).pipe(Effect.scoped))

    it.effect("a burst of failed requests runs one re-probe, not a queue", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const hanging = endpointIn(directory, "hang")
        const { held } = yield* hangingSocket(hanging)
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "hang", reach: atEndpoint(hanging) }])
        yield* hub.registry.reload()
        expect(held.size).toBe(1)
        yield* Effect.all([
          hub.registry.probeOne(appId("hang")),
          hub.registry.probeOne(appId("hang")),
          hub.registry.probeOne(appId("hang"))
        ], {
          concurrency: "unbounded"
        })
        expect(held.size).toBe(2)
      }).pipe(Effect.scoped))

    it.effect("an invalid apps.json keeps the previous list", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const fileSystem = yield* FileSystem.FileSystem
        const socket = yield* startFixture(directory, "ok")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", reach: socket }])
        yield* hub.registry.reload()
        yield* fileSystem.writeFileString(`${directory}/apps.json`, "{\"v\":1,\"apps\":[],\"extra\":true}")
        yield* hub.registry.reload()
        expect((yield* hub.states).map((state) => state._tag)).toEqual(["Ready"])
      }).pipe(Effect.scoped))
  })

  it.layer(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp), { excludeTestServices: true })((it) => {
    /**
     * The hub's app routes on a loopback port: app services first, then the proxy, admitting every browser
     * request as `viewer`. Jobs the app submits are recorded with the caller the hub resolved.
     */
    const serveHub = (
      directory: string,
      listener: "local" | "serve" = "local",
      cliRestart: NonNullable<Parameters<typeof handleAppsRoute<never, never>>[3]["cliRestart"]> = {
        token: null,
        restart: () => Effect.succeed(false)
      }
    ) =>
      Effect.gen(function*() {
        const hub = yield* makeHub(directory)
        const grants = yield* makeGrants
        const submitted: Array<{ readonly payload: Schema.Json; readonly caller: ModuleCaller }> = []
        const server = yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const created = createHttpServer((request, response) => {
              const url = new URL(request.url ?? "/", "http://hub.test")
              void handleAppServicesRoute<never>(request, response, url, {
                listener,
                registry: hub.registry,
                grants,
                tokens: hub.tokens,
                host: { host: "hub", isHub: true, hosts: ["hub"] },
                fleetRead: () => Effect.fail(new AppServiceRefused({ code: "unavailable" })),
                submitJob: (payload, caller) =>
                  Effect.sync(() => {
                    submitted.push({ payload, caller })
                    return { jobId: `job-${submitted.length}`, status: "queued" }
                  }),
                relayPost: () => Effect.void,
                readJson: (schema) => readBody(request, schema),
                runtime: { runPromiseExit: Effect.runPromiseExit }
              }).then((services) =>
                services ? true : handleAppsRoute<never, never>(request, response, url, {
                  listener,
                  registry: hub.registry,
                  grants,
                  authorize: Effect.succeed({ login: "viewer", sameNode: false, provenance: "authenticated_remote" }),
                  sameOrigin: Effect.void,
                  refuse: (target) => {
                    target.writeHead(403)
                    target.end()
                  },
                  runtime: { runPromiseExit: Effect.runPromiseExit },
                  proxyTimeoutMillis: 300,
                  cliRestart
                })
              ).then((handled) => {
                if (!handled) {
                  response.writeHead(418)
                  response.end()
                }
              })
            })
            created.once("error", (error) => resume(Effect.die(error)))
            created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)))
          }),
          (created) =>
            Effect.callback<void>((resume) => {
              created.close(() => resume(Effect.void))
            })
        )
        const { port } = Schema.decodeUnknownSync(ListeningPort)(server.address())
        return { hub, grants, port, submitted, url: `http://127.0.0.1:${port}` }
      })

    // `herdr-hub apps restart`: this machine's user only, on the loopback listener, holding this hub start's token.
    it.effect("restarts an app only for the CLI token on the loopback listener", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const restarted: Array<string> = []
        const cli = {
          token: Redacted.make("this-start-token"),
          restart: (id: AppIdType) =>
            id === "broken"
              ? Effect.die("the supervisor failed")
              : Effect.sync(() => {
                restarted.push(id)
                return id === "fixture"
              })
        }
        const local = yield* serveHub(directory, "local", cli)
        const served = yield* serveHub(directory, "serve", cli)
        const post = (url: string, path: string, token?: string) =>
          Effect.promise(() =>
            fetch(`${url}${path}`, { method: "POST", headers: token === undefined ? {} : { "x-hub-cli-token": token } })
          ).pipe(Effect.map((response) => response.status))
        expect([
          yield* post(local.url, "/v1/apps/fixture/restart"),
          yield* post(local.url, "/v1/apps/fixture/restart", "wrong"),
          yield* post(served.url, "/v1/apps/fixture/restart", "this-start-token"),
          yield* post(local.url, "/v1/apps/absent/restart", "this-start-token"),
          // A malformed escape is no app, not a crash.
          yield* post(local.url, "/v1/apps/%E0%A4%A/restart", "this-start-token"),
          yield* post(local.url, "/v1/apps/broken/restart", "this-start-token"),
          yield* post(local.url, "/v1/apps/fixture/restart", "this-start-token")
        ]).toEqual([403, 403, 403, 404, 404, 500, 202])
        expect(restarted).toEqual(["absent", "fixture"])
      }).pipe(Effect.scoped))

    /** The hub with the fixture registered and Ready, calling back into the hub for its services. */
    const serveHubWithFixture = (directory: string, mode: FixtureMode = "ok") =>
      Effect.gen(function*() {
        const served = yield* serveHub(directory)
        const socket = yield* startFixture(directory, mode, "fixture", { url: served.url, tokens: served.hub.tokens })
        yield* served.hub.writeConfig([{ id: "fixture", reach: socket }])
        yield* served.hub.registry.reload()
        return { ...served, socket }
      })

    /** Back-compat for the proxy tests: the hub with the fixture registered at `socket`, or nothing. */
    const serveHubRoutes = (directory: string, socket: AppReach | null) =>
      Effect.gen(function*() {
        const served = yield* serveHub(directory)
        if (socket !== null) yield* served.hub.writeConfig([{ id: "fixture", reach: socket }])
        yield* served.hub.registry.reload()
        return served
      })

    const call = (
      port: number,
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: string
    ) =>
      Effect.callback<{ readonly status: number; readonly body: string; readonly headers: IncomingHttpHeaders }>(
        (resume) => {
          const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (incoming) => {
            const chunks: Array<Buffer> = []
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
            incoming.on("end", () =>
              resume(Effect.succeed({
                status: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
                headers: incoming.headers
              })))
          })
          outgoing.end(body)
        }
      )
    const get = (port: number, path: string, headers: Record<string, string> = {}) => call(port, "GET", path, headers)

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

    // Until apps get their own origin, an app's page runs with the hub page's authority. On a listener that can
    // approve jobs only a first-party app's page opens, judged by the package the installer verified, never by
    // what the app says about itself (the fixture always claims @knpkv/hub-app-fixture).
    it.effect("opens a third-party app's page only on loopback, and a @knpkv app's everywhere", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const first = yield* startFixture(directory, "ok", "first")
        const third = yield* startFixture(directory, "ok", "third")
        const local = yield* serveHub(directory, "local")
        const served = yield* serveHub(directory, "serve")
        // One apps.json; each hub's stub supervisor learns where the apps run from its own write.
        for (const { hub } of [local, served]) {
          yield* hub.writeConfig([
            { id: "first", reach: first },
            { id: "third", reach: third, package: "elsewhere-app" }
          ])
          yield* hub.registry.reload()
        }
        const states = (port: number) =>
          get(port, "/v1/apps").pipe(
            Effect.map((list) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(AppStates))(list.body).apps.map((state) =>
                state._tag === "Ready" ? "ready" : `${state.reason}: ${state.detail}`
              )
            )
          )
        expect(yield* states(local.port)).toEqual(["ready", "ready"])
        expect(yield* states(served.port)).toEqual(["ready", "local_only: Fixture opens only on this machine for now."])
        const asset = (port: number, id: string) =>
          get(port, `/apps/${id}/app/assets/client.js`).pipe(Effect.map((answer) => [answer.status, answer.body]))
        expect((yield* asset(local.port, "third"))[0]).toBe(200)
        expect((yield* asset(served.port, "first"))[0]).toBe(200)
        const refused = yield* asset(served.port, "third")
        expect([refused[0], JSON.parse(String(refused[1]))]).toEqual([
          503,
          { error: "app_unavailable", reason: "local_only" }
        ])
        expect((yield* get(served.port, "/apps/third/v1/modules/third/echo")).status).toBe(503)
      }).pipe(Effect.scoped))

    it.effect("answers 404 for unknown apps and paths, and 503 for an app that is down", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { port } = yield* serveHubRoutes(directory, atEndpoint(endpointIn(directory, "absent")))
        expect((yield* get(port, "/apps/removed/v1/modules/removed/echo")).status).toBe(404)
        expect((yield* get(port, "/apps/fixture/app/manifest")).status).toBe(404)
        const down = yield* get(port, "/apps/fixture/v1/modules/fixture/echo")
        expect(down.status).toBe(503)
        expect(JSON.parse(down.body)).toEqual({ error: "app_unavailable", reason: "not_running" })
      }).pipe(Effect.scoped))

    it.effect("a job from a read is refused: a GET's grant is read-only, a POST's submits as the hub's caller", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { port, submitted } = yield* serveHubWithFixture(directory)
        const fromRead = yield* get(port, "/apps/fixture/v1/modules/fixture/job-on-read")
        expect(fromRead.status).toBe(403)
        expect(JSON.parse(fromRead.body)).toEqual({ code: "grant_read_only" })
        expect(submitted).toEqual([])

        const fromWrite = yield* call(port, "POST", "/apps/fixture/v1/modules/fixture/job", {
          "content-type": "application/json",
          [hubHeaders.caller]: JSON.stringify({ login: "spoofed", sameNode: true })
        }, JSON.stringify({ payload: { kind: "noop" } }))
        expect(JSON.parse(fromWrite.body)).toEqual({ jobId: "job-1", status: "queued" })
        expect(submitted).toEqual([{
          payload: { kind: "noop" },
          caller: { login: "viewer", sameNode: false, owner: false, provenance: "authenticated_remote" }
        }])
      }).pipe(Effect.scoped))

    it.effect("one slow route answers 504 and leaves the app Ready", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { hub, port } = yield* serveHubWithFixture(directory)
        const slow = yield* get(port, "/apps/fixture/v1/modules/fixture/slow")
        expect(slow.status).toBe(504)
        yield* Effect.sleep("400 millis")
        expect((yield* hub.states).map((state) => state._tag)).toEqual(["Ready"])
      }).pipe(Effect.scoped))

    it.effect("passes only allowed response headers, keeping redirects inside the app", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const socket = endpointIn(directory, "raw")
        // An app answering with headers it may not set on the hub's origin.
        yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const raw = createHttpServer((_request, response) => {
              response.writeHead(200, {
                "content-type": "text/plain",
                "cache-control": "no-cache",
                "clear-site-data": "\"*\"",
                "set-cookie": "hub=gone",
                "strict-transport-security": "max-age=1",
                "service-worker-allowed": "/",
                "access-control-allow-origin": "*",
                "location": "https://elsewhere.test/",
                "x-app-trace": "kept",
                "x-hub-caller": "forged"
              })
              response.end("ok")
            })
            // A bind failure fails the test now instead of leaving it to time out.
            raw.once("error", (error) => resume(Effect.die(error)))
            raw.listen(socket, () => resume(Effect.succeed(raw)))
          }),
          (raw) =>
            Effect.callback<void>((resume) => {
              raw.close(() => resume(Effect.void))
            })
        )
        const outer = yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const created = createHttpServer((request, response) => {
              void Effect.runPromiseExit(proxyToSocket(socket, "/apps/raw/", "/x", request, response, {}, 1_000))
            })
            created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)))
          }),
          (created) =>
            Effect.callback<void>((resume) => {
              created.close(() => resume(Effect.void))
            })
        )
        const { port } = Schema.decodeUnknownSync(ListeningPort)(outer.address())
        const answer = yield* get(port, "/x")
        expect(answer.body).toBe("ok")
        expect(answer.headers["clear-site-data"]).toBeUndefined()
        expect(answer.headers["set-cookie"]).toBeUndefined()
        expect(answer.headers["strict-transport-security"]).toBeUndefined()
        expect(answer.headers["service-worker-allowed"]).toBeUndefined()
        expect(answer.headers["access-control-allow-origin"]).toBeUndefined()
        expect(answer.headers["location"]).toBeUndefined()
        expect(answer.headers["x-hub-caller"]).toBeUndefined()
        expect(answer.headers["x-app-trace"]).toBe("kept")
        expect(answer.headers["cache-control"]).toBe("no-cache")
        expect(answer.headers["x-content-type-options"]).toBe("nosniff")
      }).pipe(Effect.scoped))

    it.effect("app services: token and app name, declared services, grant ownership and reuse", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { grants, hub, port, submitted } = yield* serveHub(directory)
        const hubSide = { url: `http://127.0.0.1:${port}`, tokens: hub.tokens }
        const first = yield* startFixture(directory, "ok", "fixture", hubSide)
        const second = yield* startFixture(directory, "ok", "second", hubSide)
        yield* hub.writeConfig([{ id: "fixture", reach: first }, { id: "second", reach: second }])
        yield* hub.registry.reload()
        const token = Redacted.value(first.token)
        const asApp = (app: string, bearer: string) => ({
          authorization: `Bearer ${bearer}`,
          [hubHeaders.app]: app,
          "content-type": "application/json"
        })
        const viewer: ModuleCaller = {
          login: "viewer",
          sameNode: false,
          owner: false,
          provenance: "authenticated_remote"
        }
        const job = (headers: Record<string, string>, grant: string) =>
          call(port, "POST", "/v1/app-services/jobs", headers, JSON.stringify({ grant, payload: { kind: "noop" } }))
        const code = (answer: { readonly body: string }) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ code: Schema.String })))(answer.body).code

        expect((yield* get(port, "/v1/app-services/host")).status).toBe(401)
        expect((yield* get(port, "/v1/app-services/host", asApp("fixture", "wrong"))).status).toBe(401)
        expect((yield* get(port, "/v1/app-services/host", asApp("second", token))).status).toBe(401)
        expect((yield* get(port, "/v1/app-services/host", asApp("fixture", token))).status).toBe(200)
        const undeclared = yield* call(port, "POST", "/v1/app-services/fleet-read", asApp("fixture", token), "{}")
        expect([undeclared.status, code(undeclared)]).toEqual([403, "undeclared"])

        const others = yield* grants.mint(appId("second"), viewer, "POST")
        expect(code(yield* job(asApp("fixture", token), others.grant))).toBe("grant_app_mismatch")
        const mine = yield* grants.mint(appId("fixture"), viewer, "POST")
        expect((yield* job(asApp("fixture", token), mine.grant)).status).toBe(200)
        expect(code(yield* job(asApp("fixture", token), mine.grant))).toBe("grant_used")
        expect(submitted.map((entry) => entry.caller)).toEqual([viewer])
      }).pipe(Effect.scoped))

    it.effect("app services are not served on any listener but loopback", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const { port } = yield* serveHub(directory, "serve")
        expect((yield* get(port, "/v1/app-services/host")).status).toBe(418)
      }).pipe(Effect.scoped))

    it.effect("a probe that finds the same manifest doesn't rewrite the cache", () =>
      Effect.gen(function*() {
        const directory = yield* tempDirectory
        const fileSystem = yield* FileSystem.FileSystem
        const socket = yield* startFixture(directory, "ok")
        const hub = yield* makeHub(directory)
        yield* hub.writeConfig([{ id: "fixture", reach: socket }])
        yield* hub.registry.reload()
        const cache = `${hub.cacheDirectory}/fixture.manifest.json`
        const before = yield* fileSystem.stat(cache)
        yield* Effect.sleep("20 millis")
        yield* hub.registry.refresh()
        const after = yield* fileSystem.stat(cache)
        expect(after.mtime).toEqual(before.mtime)
      }).pipe(Effect.scoped))
  })

  // Crypto from Node; the test clock stays, so expiry is exact.
  it.layer(NodeServices.layer)((it) => {
    it.effect("grants: one use for jobs, bound to their app, gone after 60 s", () =>
      Effect.gen(function*() {
        const grants = yield* makeGrants
        const caller: ModuleCaller = {
          login: "viewer",
          sameNode: false,
          owner: false,
          provenance: "authenticated_remote"
        }
        const fixture = appId("fixture")
        const { grant } = yield* grants.mint(fixture, caller, "POST")
        const reason = (use: Effect.Effect<unknown, { readonly reason: string }>) =>
          Effect.map(Effect.flip(use), (error) => error.reason)

        expect(yield* reason(grants.use({ grant: "b".repeat(40), app: fixture, purpose: "spend" }))).toBe("unknown")
        expect(yield* reason(grants.use({ grant, app: appId("other"), purpose: "spend" }))).toBe("app_mismatch")
        expect(yield* grants.use({ grant, app: fixture, purpose: "read" })).toEqual(caller)
        expect(yield* grants.use({ grant, app: fixture, purpose: "spend" })).toEqual(caller)
        expect(yield* reason(grants.use({ grant, app: fixture, purpose: "spend" }))).toBe("used")
        // Reading the caller, or a Relay post as the caller, still works with a spent grant while it lives.
        expect(yield* grants.use({ grant, app: fixture, purpose: "read" })).toEqual(caller)
        expect(yield* grants.use({ grant, app: fixture, purpose: "write" })).toEqual(caller)

        const read = yield* grants.mint(fixture, caller, "GET")
        expect(yield* reason(grants.use({ grant: read.grant, app: fixture, purpose: "spend" }))).toBe("read_only")
        // A cross-site GET can't post to Relay as the user either.
        expect(yield* reason(grants.use({ grant: read.grant, app: fixture, purpose: "write" }))).toBe("read_only")
        expect(yield* grants.use({ grant: read.grant, app: fixture, purpose: "read" })).toEqual(caller)

        const { grant: later } = yield* grants.mint(fixture, caller, "POST")
        yield* TestClock.adjust(Duration.seconds(61))
        expect(yield* reason(grants.use({ grant: later, app: fixture, purpose: "spend" }))).toBe("expired")
      }))
  })

  it.effect("a failed reload is logged and the loop goes on; an interruption ends it", () =>
    Effect.gen(function*() {
      expect(Exit.isSuccess(yield* Effect.exit(logReloadFailure(Effect.die("boom"))))).toBe(true)
      expect(Exit.isSuccess(yield* Effect.exit(logReloadFailure(Effect.fail("unreadable"))))).toBe(true)
      expect(Exit.hasInterrupts(yield* Effect.exit(logReloadFailure(Effect.interrupt)))).toBe(true)
    }))

  it("keeps redirects inside the app: its root moves under its prefix, other origins are dropped", () => {
    expect(appLocation("/v1/modules/usage/limits", "/apps/usage/")).toBe("/apps/usage/v1/modules/usage/limits")
    expect(appLocation("/apps/usage/app/assets/x", "/apps/usage/")).toBe("/apps/usage/app/assets/x")
    expect(appLocation("limits?range=7d", "/apps/usage/")).toBe("/apps/usage/limits?range=7d")
    // Moved under the prefix first, then resolved: the app's root can't climb out either.
    expect(appLocation("/v1/../../connect", "/apps/usage/")).toBeNull()
    expect(appLocation("//elsewhere.test/", "/apps/usage/")).toBeNull()
    expect(appLocation("https://elsewhere.test/", "/apps/usage/")).toBeNull()
  })

  it.effect("fleet.read answers the hub's fleet reads, decoding usage selectors and refusing bad ones", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const offline: FleetLimits = { hosts: [], failures: [{ host: "cedar", reason: "offline" }], peersListed: true }
      const sources = {
        limits: Effect.succeed(offline),
        usage: (query: UsageQuery) =>
          Effect.sync(() => {
            asked.push(`${query.range} ${query.timeZone}`)
            return { hosts: [], failures: [], peersListed: false }
          })
      }
      expect(yield* answerFleetRead(sources, { read: "limits", query: {} })).toEqual({
        hosts: [],
        failures: [{ host: "cedar", reason: "offline" }],
        peersListed: true
      })
      expect(yield* answerFleetRead(sources, { read: "usage", query: { timeZone: "Europe/Amsterdam" } })).toEqual({
        hosts: [],
        failures: [],
        peersListed: false
      })
      yield* answerFleetRead(sources, { read: "usage", query: { range: "30d", timeZone: "UTC" } })
      expect(asked).toEqual(["7d Europe/Amsterdam", "30d UTC"])
      const refused = yield* Effect.flip(
        answerFleetRead(sources, { read: "usage", query: { range: "1y", timeZone: "UTC" } })
      )
      expect(refused.code).toBe("rejected")
    }))
  it("passes a redirect only if it resolves inside the app's prefix", () => {
    expect(appLocation("/apps/raw/ok?a=1#b", "/apps/raw/")).toBe("/apps/raw/ok?a=1#b")
    expect(appLocation("next", "/apps/raw/")).toBe("/apps/raw/next")
    expect(appLocation("/apps/raw/../../v1/anything", "/apps/raw/")).toBeNull()
    expect(appLocation("../connect", "/apps/raw/")).toBeNull()
    expect(appLocation("//elsewhere.test/", "/apps/raw/")).toBeNull()
    expect(appLocation("https://elsewhere.test/apps/raw/", "/apps/raw/")).toBeNull()
  })
})

// Closed by default: a listener added later opens no third-party page until it is listed here as loopback.
describe("stateOn", () => {
  const manifest = Schema.decodeUnknownSync(AppManifest)({
    contract: 1,
    id: "fixture",
    package: "@knpkv/hub-app-fixture",
    version: "0.0.0",
    module: {
      id: "fixture",
      label: "Fixture",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Overview" }],
      listeners: ["serve", "local"],
      requires: ["read"]
    },
    client: { entry: "client.js", css: [] },
    services: [],
    nav: { order: 100, primary: false, mobile: false },
    standalone: { defaultPort: 3199 }
  })
  const ready = (pkg: string): RegisteredApp => ({
    id: appId("fixture"),
    package: pkg,
    state: { _tag: "Ready", manifest },
    reach: null
  })
  const listeners: ReadonlyArray<ListenerMode> = ["local", "tailnet", "approval", "serve", "work", "lan"]
  const tags = (app: RegisteredApp) =>
    listeners.map((listener) => {
      const state = stateOn(listener)(app)
      return state._tag === "Ready" ? "ready" : state.reason
    })

  it("keeps a third-party page on loopback only, a @knpkv page everywhere, and other states as they are", () => {
    expect(tags(ready("elsewhere-app"))).toEqual(["ready", ...Array(5).fill("local_only")])
    expect(tags(ready("@knpkv/hub-app-fixture"))).toEqual(Array(6).fill("ready"))
    const down: RegisteredApp = {
      ...ready("elsewhere-app"),
      state: { _tag: "Unavailable", id: appId("fixture"), manifest, reason: "crashloop", detail: "" }
    }
    expect(tags(down)).toEqual(Array(6).fill("crashloop"))
  })
})
