import { Context, Effect, Layer, Result, Schema } from "effect"
import {
  connectModule,
  type ModuleDescriptor,
  type ModuleListener,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "./module-contract.js"
import { collectNeedsYou } from "./module-needs-you-server.js"
import { type NeedsYouProviderResult, NeedsYouResult } from "./module-needs-you.js"

/**
 * Authenticated login from the listener authorization result, never client-supplied selectors.
 * `sameNode` is true only when the server proved the caller is the hub's own tailnet node; an
 * authorizer that does not say decodes as false. `provenance` is `verified_local_listener` only for a
 * direct, unproxied loopback request; an authorizer that does not say decodes as remote.
 */
export const ModuleCaller = Schema.Struct({
  login: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(254), Schema.isPattern(/^[^\s\p{Cc}]+$/u)),
  sameNode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  provenance: Schema.Literals(["verified_local_listener", "authenticated_remote"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("authenticated_remote"))
  )
})
export type ModuleCaller = typeof ModuleCaller.Type

export interface ModuleResponse {
  readonly status: 200 | 201 | 202
  readonly body: Schema.Json
}

/** Safe route failures carry public copy only. Provider errors stay inside the module. */
export class ModuleRouteFailure extends Schema.TaggedError<ModuleRouteFailure>()("ModuleRouteFailure", {
  status: Schema.Literals([400, 403, 404, 409, 500, 503]),
  code: Schema.String
}) {}

/** Plain unavailable copy for a host-local module. `product` is a plural noun, such as "sandboxes". */
export const moduleUnavailableCopy = (
  product: string,
  setting: string,
  reason: "not_configured" | "other_host" | "not_hub" | "pool_mismatch" | "unavailable",
  host: string | null
): string => {
  const titled = product.length === 0 ? product : `${product.slice(0, 1).toUpperCase()}${product.slice(1)}`
  switch (reason) {
    case "not_configured":
      return `Set ${setting} to the host that reads ${product}.`
    case "other_host":
      return `${titled} are read on ${host ?? "the configured host"}.`
    case "not_hub":
      return `${setting} names this host, but ${product} are read by the hub only.`
    case "pool_mismatch":
      return `${setting} names this hub, but it has no sandbox pool configured.`
    case "unavailable":
      return `${titled} couldn't be read.`
  }
}

const ModuleRouteTypeId = Symbol("ModuleApiRoute")
/** The agent home owns the fleet-wide approvals summary; providers are composed once by the hub. */
export const needsYouRouteOwner = connectModule.id
const ApiPath = Schema.String.check(Schema.isPattern(/^(\/[a-z0-9][a-z0-9-]*)+$/))

/**
 * Construct routes with the schema-backed factories from the same server-entry instance as the mount.
 * `invalid_route` also means an unrecognized route identity, including a duplicate entry instance.
 */
export interface ModuleApiRoute {
  readonly [ModuleRouteTypeId]: true
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Relative to `/v1/modules/<module id>`. */
  readonly path: `/${string}`
}

type InternalHandler = (
  query: URLSearchParams,
  body: Schema.Json,
  caller: ModuleCaller
) => Effect.Effect<ModuleResponse, ModuleRouteFailure>
const routeHandlers = new WeakMap<ModuleApiRoute, InternalHandler>()

/** Keep the executable handler private; spread copies cannot replace schema decoding. */
const registerRoute = (
  method: ModuleApiRoute["method"],
  path: ModuleApiRoute["path"],
  handle: InternalHandler
): ModuleApiRoute => {
  const route = Object.freeze<ModuleApiRoute>({ [ModuleRouteTypeId]: true, method, path })
  routeHandlers.set(route, handle)
  return route
}

export class ModuleHandlers extends Context.Service<
  ModuleHandlers,
  {
    readonly routes: ReadonlyArray<ModuleApiRoute>
    /** Closed over services at layer build; expected source failures are returned as issues. */
    /** Expected source failures reject; the collector records them and keeps the other providers. */
    readonly needsYou?: Effect.Effect<NeedsYouProviderResult, unknown>
  }
>()("@knpkv/herdr-hub/ModuleHandlers") {}

/** Product layers acquire stable services at startup and close handler requirements. */
export interface ServerModule<E = never, R = never> {
  readonly descriptor: ModuleDescriptor
  readonly handlers: Layer.Layer<ModuleHandlers, E, R>
}

interface MountedModule {
  readonly descriptor: ModuleDescriptor
  readonly routes: ReadonlyArray<ModuleApiRoute>
}

export class ModuleRegistry extends Context.Service<
  ModuleRegistry,
  {
    readonly modules: ReadonlyArray<MountedModule>
  }
>()("@knpkv/herdr-hub/ModuleRegistry") {}

/** Validate both registrations before acquiring any module layer; metadata must be shared. */
export const makeModuleLayer = <E, R>(
  descriptors: ReadonlyArray<ModuleDescriptor>,
  modules: ReadonlyArray<ServerModule<E, R>>
): Layer.Layer<ModuleRegistry, E | ModuleRegistrationError, R> =>
  Layer.effect(
    ModuleRegistry,
    Effect.gen(function*() {
      const validated = validateModuleRegistry(descriptors)
      if (Result.isFailure(validated)) return yield* validated.failure
      const serverDescriptors = validateModuleRegistry(modules.map((module) => module.descriptor))
      if (Result.isFailure(serverDescriptors)) return yield* serverDescriptors.failure
      if (
        moduleRegistryFingerprint(descriptors) !== moduleRegistryFingerprint(modules.map((module) => module.descriptor))
      ) {
        return yield* new ModuleRegistrationError({ module: "registry", reason: "server_mismatch" })
      }
      const mounted = yield* Effect.forEach(
        modules,
        Effect.fnUntraced(function*(module) {
          const context = yield* Layer.build(module.handlers)
          const handlers = Context.get(context, ModuleHandlers)
          const identities = new Set<string>()
          for (const route of handlers.routes) {
            if (!routeHandlers.has(route) || Result.isFailure(Schema.decodeUnknownResult(ApiPath)(route.path))) {
              return yield* new ModuleRegistrationError({ module: module.descriptor.id, reason: "invalid_route" })
            }
            if (module.descriptor.id === needsYouRouteOwner && route.method === "GET" && route.path === "/needs-you") {
              return yield* new ModuleRegistrationError({ module: module.descriptor.id, reason: "duplicate_route" })
            }
            const identity = `${route.method} ${route.path}`
            if (identities.has(identity)) {
              return yield* new ModuleRegistrationError({ module: module.descriptor.id, reason: "duplicate_route" })
            }
            identities.add(identity)
          }
          return { descriptor: module.descriptor, routes: handlers.routes, needsYou: handlers.needsYou }
        })
      )
      const providers = mounted.flatMap((module) =>
        module.needsYou === undefined
          ? [] :
          [{
            id: module.descriptor.id,
            pages: module.descriptor.pages.map((page) => page.id),
            read: module.needsYou
          }]
      )
      const readNeedsYou = collectNeedsYou(providers)
      return {
        modules: mounted.map((module) => ({
          descriptor: module.descriptor,
          routes: module.descriptor.id === needsYouRouteOwner
            ? [
              ...module.routes,
              moduleReadRoute(
                "/needs-you",
                Schema.fromURLSearchParams(Schema.Record(Schema.String, Schema.Never)),
                NeedsYouResult,
                () => readNeedsYou
              )
            ]
            : module.routes
        }))
      }
    })
  )

/** Decode query selectors before the handler; unknown keys fail instead of being discarded. */
const decodeModuleQuery = <Q>(schema: Schema.Codec<Q, URLSearchParams, never, never>, query: URLSearchParams) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(query).pipe(
    Effect.mapError(() => new ModuleRouteFailure({ status: 400, code: "invalid_query" }))
  )

/** Read routes decode a query codec and encode success; stable services are acquired by the product layer. */
export const moduleReadRoute = <Q, A>(
  path: ModuleApiRoute["path"],
  querySchema: Schema.Codec<Q, URLSearchParams, never, never>,
  success: Schema.Codec<A, Schema.Json, never, never>,
  handle: (query: Q, caller: ModuleCaller) => Effect.Effect<A, ModuleRouteFailure>,
  status: ModuleResponse["status"] = 200
): ModuleApiRoute =>
  registerRoute("GET", path, (query, _body, caller) =>
    decodeModuleQuery(querySchema, query).pipe(
      Effect.flatMap((decoded) => handle(decoded, caller)),
      Effect.flatMap((body) => Schema.encodeEffect(success)(body)),
      Effect.mapError((error) =>
        error._tag === "ModuleRouteFailure" ? error : new ModuleRouteFailure({ status: 500, code: "invalid_response" })
      ),
      Effect.map((body) => ({ status, body }))
    ))

/** Decode query and body after authorization; handlers receive the validated selectors and body. */
export const moduleWriteRoute = <Q, A, B>(
  method: Exclude<ModuleApiRoute["method"], "GET">,
  path: ModuleApiRoute["path"],
  querySchema: Schema.Codec<Q, URLSearchParams, never, never>,
  schema: Schema.Codec<A, unknown, never, never>,
  success: Schema.Codec<B, Schema.Json, never, never>,
  handle: (body: A, query: Q, caller: ModuleCaller) => Effect.Effect<B, ModuleRouteFailure>,
  status: ModuleResponse["status"] = 200
): ModuleApiRoute =>
  registerRoute(method, path, (query, body, caller) =>
    decodeModuleQuery(querySchema, query).pipe(
      Effect.flatMap((decodedQuery) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => new ModuleRouteFailure({ status: 400, code: "invalid_body" })),
          Effect.flatMap((decoded) => handle(decoded, decodedQuery, caller))
        )
      ),
      Effect.flatMap((response) =>
        Schema.encodeEffect(success)(response).pipe(
          Effect.mapError(() => new ModuleRouteFailure({ status: 500, code: "invalid_response" }))
        )
      ),
      Effect.map((body) => ({ status, body }))
    ))

/**
 * Return null for unmatched methods, modules or listeners. For `/v1/modules/*`, callers must
 * answer 404 on null, never delegate that namespace to another handler. A work-mode listener
 * remains restricted to its existing peer API and must not invoke this mount.
 */
export const dispatchModuleRoute = Effect.fn("ModuleRegistry.dispatch")(
  function*<E, R, OriginError = E, BodyError = E>(request: {
    readonly method: string
    readonly url: URL
    readonly listener: ModuleListener | "work"
    readonly authorize: Effect.Effect<typeof ModuleCaller.Encoded, E, R>
    readonly sameOrigin: Effect.Effect<unknown, OriginError, R>
    readonly readJson: () => Effect.Effect<Schema.Json, BodyError, R>
  }): Effect.fn.Return<ModuleResponse | null, E | OriginError | BodyError | ModuleRouteFailure, R | ModuleRegistry> {
    const registry = yield* ModuleRegistry
    for (const module of registry.modules) {
      const prefix = `/v1/modules/${module.descriptor.id}`
      if (!request.url.pathname.startsWith(`${prefix}/`)) continue
      if (!module.descriptor.listeners.some((listener) => listener === request.listener)) return null
      const route = module.routes.find(
        (candidate) => candidate.method === request.method && `${prefix}${candidate.path}` === request.url.pathname
      )
      if (route === undefined) return null
      const authorizedCaller = yield* request.authorize
      const caller = yield* Schema.decodeUnknownEffect(ModuleCaller)(authorizedCaller).pipe(
        Effect.mapError(() => new ModuleRouteFailure({ status: 500, code: "invalid_caller" }))
      )
      const mutation = route.method !== "GET"
      if (mutation) yield* request.sameOrigin
      const body = mutation ? yield* request.readJson() : null
      const handle = routeHandlers.get(route)
      if (handle === undefined) return yield* new ModuleRouteFailure({ status: 500, code: "invalid_route" })
      return yield* handle(request.url.searchParams, body, caller)
    }
    return null
  }
)
