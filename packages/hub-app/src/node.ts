/**
 * The one runner every app uses. The same entry serves either way:
 *
 * - **attached** (`--socket <path>`): an owner-only unix socket the hub proxies to. The caller and grant
 *   come from the hub's `x-hub-*` headers, which only the socket listener trusts. Shell services go to
 *   `HUB_URL` with the token in `HUB_APP_TOKEN_FILE`.
 * - **standalone** (`[serve] [--port <n>] [--no-open]`): loopback TCP with its own owner session and the
 *   minimal shell at `/`. The caller is this machine's owner; shell services that need the hub are absent.
 *
 * Fixed surface: `GET /app/manifest`, `/app/health`, `/app/needs-you`, `/app/badge`, `/app/assets/*`, and
 * module routes under `/v1/modules/<id>/*`.
 *
 * @module
 */
import { NodeHttpServer } from "@effect/platform-node"
import type { BrowserLaunch, BrowserLaunchOutputError } from "@knpkv/browser-pairing/launch"
import { openOrServe } from "@knpkv/browser-pairing/launch"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Context, Deferred, Effect, FileSystem, Layer, Option, Path, Result, Schema } from "effect"
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { createServer } from "node:http"
import { hostname, userInfo } from "node:os"
import { parseArgs } from "node:util"
import type { ShellServices } from "./hub-client.js"
import { attachedLayer, standaloneLayer } from "./hub-client.js"
import { AppManifest, type AppManifestInput, AppStartError } from "./manifest.js"
import { validateModuleRegistry } from "./module.js"
import {
  CurrentGrant,
  dispatchToModule,
  Grant,
  isModuleRoute,
  ModuleCaller,
  ModuleHandlers,
  ModuleRouteFailure,
  type MountedModule
} from "./route.js"
import { standaloneShellHtml } from "./standalone-page.js"
import { appPaths, hubHeaders } from "./wire.js"

/** What an app hands the runner. Handlers may use {@link ShellServices}; the runner provides it. */
export interface AppServer<E, R> {
  readonly manifest: AppManifestInput
  readonly handlers: Layer.Layer<ModuleHandlers, E, R | ShellServices>
  readonly badge?: Effect.Effect<{ readonly text: string; readonly label: string } | null, never, ShellServices>
  /** The built client: a directory holding `client.js` and, optionally, `client.css`. */
  readonly clientDirectory: string
}

export const RunMode = Schema.Union([
  Schema.TaggedStruct("Attached", { socket: Schema.String, hubUrl: Schema.String, tokenFile: Schema.String }),
  Schema.TaggedStruct("Standalone", { port: Schema.Int, open: Schema.Boolean })
])
export type RunMode = typeof RunMode.Type

/** Read the mode from argv and environment. `--socket` means attached; anything else is standalone. */
export const readRunMode = (
  manifest: AppManifestInput,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>
): Result.Result<RunMode, AppStartError> => {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
          socket: { type: "string" },
          port: { type: "string" },
          "no-open": { type: "boolean", default: false }
        }
      }),
    catch: (cause) => new AppStartError({ reason: "invalid_arguments", cause })
  })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const { positionals, values } = parsed.success
  if (positionals.some((positional) => positional !== "serve")) {
    return Result.fail(new AppStartError({ reason: "invalid_arguments", cause: positionals }))
  }
  const decode = Schema.decodeUnknownResult(RunMode)
  const decoded = values.socket !== undefined
    ? decode({
      _tag: "Attached",
      socket: values.socket,
      hubUrl: env.HUB_URL,
      tokenFile: env.HUB_APP_TOKEN_FILE
    })
    : decode({
      _tag: "Standalone",
      port: values.port === undefined ? manifest.standalone.defaultPort : Number(values.port),
      open: values["no-open"] !== true
    })
  return Result.mapError(decoded, (cause) => new AppStartError({ reason: "invalid_arguments", cause }))
}

/** The manifest served at `/app/manifest`: the app's own, with `client` read from its build. */
const servedManifest = Effect.fn("HubApp.servedManifest")(
  function*(app: AppServer<unknown, unknown>) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const hasCss = yield* fileSystem.exists(path.join(app.clientDirectory, "client.css"))
    const manifest = yield* Schema.decodeUnknownEffect(AppManifest)({
      ...app.manifest,
      client: { entry: "client.js", css: hasCss ? ["client.css"] : [] }
    })
    const registry = validateModuleRegistry([manifest.module])
    if (Result.isFailure(registry) || manifest.module.id !== manifest.id) {
      return yield* new AppStartError({ reason: "invalid_manifest", cause: manifest.id })
    }
    return manifest
  },
  Effect.mapError((cause) =>
    cause._tag === "AppStartError" ? cause : new AppStartError({ reason: "invalid_manifest", cause })
  )
)

/** Build the handler layer once, at startup, and refuse routes this package didn't build. */
const mountModule = Effect.fn("HubApp.mountModule")(function*<E, R>(
  manifest: AppManifest,
  handlers: Layer.Layer<ModuleHandlers, E, R | ShellServices>
) {
  const context = yield* Layer.build(handlers).pipe(
    Effect.mapError((cause) => new AppStartError({ reason: "layer", cause }))
  )
  const built = Context.get(context, ModuleHandlers)
  const identities = new Set<string>()
  for (const route of built.routes) {
    const identity = `${route.method} ${route.path}`
    if (!isModuleRoute(route) || identities.has(identity)) {
      return yield* new AppStartError({ reason: "invalid_manifest", cause: identity })
    }
    identities.add(identity)
  }
  const mounted: MountedModule = { descriptor: manifest.module, routes: built.routes }
  return { mounted, needsYou: built.needsYou }
})

const failureResponse = (failure: ModuleRouteFailure) =>
  HttpServerResponse.json({ code: failure.code }, { status: failure.status })

const notFound = HttpServerResponse.json({ code: "not_found" }, { status: 404 })

/** The caller the hub authenticated, from the socket listener's `x-hub-caller` header. */
const hubCaller = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const header = request.headers[hubHeaders.caller]
  if (header === undefined) return yield* new ModuleRouteFailure({ status: 403, code: "no_caller" })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModuleCaller))(header).pipe(
    Effect.mapError(() => new ModuleRouteFailure({ status: 403, code: "invalid_caller" }))
  )
})

const hubGrant = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const header = request.headers[hubHeaders.grant]
  return header === undefined ? null : Option.getOrNull(Schema.decodeUnknownOption(Grant)(header))
})

interface ListenerPolicy<E, R> {
  readonly listener: "local" | "serve"
  readonly authorize: Effect.Effect<typeof ModuleCaller.Encoded, E | ModuleRouteFailure, R>
  readonly sameOrigin: Effect.Effect<void, E | ModuleRouteFailure, R>
}

/** `/app/*` and module routes; the listener decides who the caller is. */
const appRoutes = (
  manifest: AppManifest,
  mounted: MountedModule,
  needsYou: Effect.Effect<unknown, unknown> | undefined,
  badge: Effect.Effect<{ readonly text: string; readonly label: string } | null> | undefined,
  policy: ListenerPolicy<never, HttpServerRequest.HttpServerRequest>
) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      yield* router.add("GET", appPaths.manifest, HttpServerResponse.json(manifest))
      yield* router.add("GET", appPaths.health, HttpServerResponse.json({ ok: true }))
      yield* router.add(
        "GET",
        appPaths.needsYou,
        needsYou === undefined
          ? notFound
          : needsYou.pipe(
            Effect.flatMap((result) => HttpServerResponse.json(result)),
            Effect.catch(() => HttpServerResponse.json({ code: "needs_you_failed" }, { status: 503 }))
          )
      )
      yield* router.add(
        "GET",
        appPaths.badge,
        badge === undefined
          ? HttpServerResponse.json(null)
          : Effect.flatMap(badge, (value) => HttpServerResponse.json(value))
      )
      yield* router.add(
        "*",
        `/v1/modules/${manifest.id}/*`,
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const grant = yield* hubGrant
          const response = yield* dispatchToModule(mounted, {
            method: request.method,
            url: new URL(request.url, "http://app.invalid"),
            listener: policy.listener,
            authorize: policy.authorize,
            sameOrigin: policy.sameOrigin,
            readJson: () =>
              request.json.pipe(Effect.mapError(() => new ModuleRouteFailure({ status: 400, code: "invalid_body" })))
          }).pipe(Effect.provideService(CurrentGrant, grant))
          return response === null
            ? yield* notFound
            : yield* HttpServerResponse.json(response.body, { status: response.status })
        }).pipe(Effect.catchTag("ModuleRouteFailure", failureResponse))
      )
    })
  )

const assetRoutes = (clientDirectory: string) =>
  HttpStaticServer.layer({ root: clientDirectory, prefix: appPaths.assets, cacheControl: "no-cache" })

/** Remove a stale socket from a previous run; refuse to touch anything that isn't one. */
const clearSocket = Effect.fn("HubApp.clearSocket")(function*(socket: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(socket))) return
  const info = yield* fileSystem.stat(socket)
  if (info.type !== "Socket") return yield* new AppStartError({ reason: "listen", cause: "not a socket" })
  yield* fileSystem.remove(socket)
}, Effect.mapError((cause) => cause._tag === "AppStartError" ? cause : new AppStartError({ reason: "listen", cause })))

/** Attached mode alone: what the hub and its tests run. Needs no browser opener. */
export const serveAttached = Effect.fn("HubApp.serveAttached")(function*<E, R>(
  app: AppServer<E, R>,
  mode: Extract<RunMode, { readonly _tag: "Attached" }>
) {
  const manifest = yield* servedManifest(app)
  const services = yield* Layer.build(
    attachedLayer({ app: manifest.id, hubUrl: mode.hubUrl, tokenFile: mode.tokenFile, declared: manifest.services })
  )
  const { mounted, needsYou } = yield* mountModule(manifest, app.handlers).pipe(Effect.provideContext(services))
  const badge = app.badge?.pipe(Effect.provideContext(services))
  yield* clearSocket(mode.socket)
  const policy: ListenerPolicy<never, HttpServerRequest.HttpServerRequest> = {
    // The hub forwards only requests its own listener admitted, and checked same-origin first.
    listener: "local",
    authorize: hubCaller,
    sameOrigin: Effect.void
  }
  return yield* Layer.launch(
    HttpRouter.serve(
      Layer.mergeAll(appRoutes(manifest, mounted, needsYou, badge, policy), assetRoutes(app.clientDirectory)),
      {
        disableListenLog: true,
        disableLogger: true
      }
    ).pipe(
      Layer.provide(NodeHttpServer.layerServer(createServer, { path: mode.socket })),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layer)
    )
  )
})

const ownerCaller = (login: string): typeof ModuleCaller.Encoded => ({
  login,
  sameNode: true,
  provenance: "verified_local_listener"
})

const serveStandalone = Effect.fn("HubApp.serveStandalone")(function*<E, R>(
  app: AppServer<E, R>,
  mode: Extract<RunMode, { readonly _tag: "Standalone" }>,
  launch: BrowserLaunch
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // This package's own built browser module, read when asked for: a missing build fails that request only.
  const shellScript = path.fromFileUrl(new URL("./standalone-shell.js", import.meta.url)).pipe(
    Effect.flatMap((file) => fileSystem.readFileString(file)),
    Effect.map((script) => HttpServerResponse.text(script, { contentType: "text/javascript; charset=utf-8" })),
    Effect.catchTag("PlatformError", () => HttpServerResponse.json({ code: "shell_missing" }, { status: 500 }))
  )
  const manifest = yield* servedManifest(app)
  const host = hostname()
  const services = yield* Layer.build(standaloneLayer({ host, isHub: false, hosts: [host] }))
  const { mounted, needsYou } = yield* mountModule(manifest, app.handlers).pipe(Effect.provideContext(services))
  const badge = app.badge?.pipe(Effect.provideContext(services))
  const login = userInfo().username
  const page = standaloneShellHtml(manifest)
  const shell = HttpRouter.use((router) =>
    Effect.gen(function*() {
      yield* router.add("GET", "/", HttpServerResponse.html(page))
      yield* router.add("GET", "/app/shell.js", shellScript)
    })
  )
  /** The owner session is made once the port is bound, so `--port 0` gets a real origin and cookie. */
  const server = (ready: Deferred.Deferred<string>) =>
    Layer.unwrap(
      Effect.gen(function*() {
        const bound = yield* HttpServer.HttpServer
        if (bound.address._tag === "UnixPathAddress") {
          return yield* new AppStartError({ reason: "listen", cause: "standalone needs a TCP listener" })
        }
        const origin = OwnerSession.loopbackOrigin("127.0.0.1", bound.address.port)
        const session = yield* OwnerSession.make({
          product: manifest.package,
          cookieName: `hub_app_${manifest.id.replaceAll("-", "_")}_${bound.address.port}`,
          writes: "csrf",
          freshUrlHint: `restart ${manifest.package} for a fresh URL`,
          authorityOrigin: origin,
          browserOrigin: origin
        })
        // The owner's session cookie is the only credential here; `x-hub-*` headers are never read.
        const authorizeOwner = Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* session.authorizeHttp(request.cookies[session.cookieName] ?? "").pipe(
            Effect.catchTags({
              OwnerSessionUnauthorizedError: () =>
                Effect.fail(new ModuleRouteFailure({ status: 403, code: "unauthorized" })),
              OwnerSessionForbiddenError: () => Effect.fail(new ModuleRouteFailure({ status: 403, code: "forbidden" }))
            })
          )
          return ownerCaller(login)
        })
        const policy: ListenerPolicy<never, HttpServerRequest.HttpServerRequest> = {
          listener: "local",
          authorize: authorizeOwner,
          // authorizeHttp checks Origin, Fetch Metadata and the CSRF token for unsafe methods.
          sameOrigin: Effect.void
        }
        return HttpRouter.serve(
          Layer.mergeAll(
            appRoutes(manifest, mounted, needsYou, badge, policy),
            assetRoutes(app.clientDirectory),
            OwnerSession.BootstrapRouter,
            shell
          ),
          { disableListenLog: true, disableLogger: true }
        ).pipe(
          Layer.provide(Layer.succeed(OwnerSession.OwnerSession, session)),
          Layer.tap(() =>
            session.mintBootstrapCode.pipe(
              Effect.flatMap((code) => Deferred.succeed(ready, OwnerSession.bootstrapUrl(origin, code)))
            )
          )
        )
      })
    ).pipe(
      Layer.provide(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: mode.port })),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layer)
    )
  const serve = (onReady: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>) =>
    OwnerSession.serveWithBootstrapUrl(server, onReady)
  return yield* openOrServe({ login: Effect.succeedNone, serve, launch })
})

/**
 * Serve the app in `mode` until interrupted. `launch` says whether standalone mode opens a browser for its
 * sign-in link; the executable decides it from its terminal and environment.
 */
export const serveApp = Effect.fn("HubApp.serveApp")(function*<E, R>(
  app: AppServer<E, R>,
  mode: RunMode,
  launch: BrowserLaunch
) {
  return mode._tag === "Attached" ? yield* serveAttached(app, mode) : yield* serveStandalone(app, mode, launch)
}, Effect.mapError((cause) => cause._tag === "AppStartError" ? cause : new AppStartError({ reason: "listen", cause })))

export { runApp } from "./main.js"
