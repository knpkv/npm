import { Context, Effect, Layer, Result, Schema } from "effect"
import {
  type ModuleDescriptor,
  type ModuleListener,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "./module-contract.js"

export interface ModuleResponse {
  readonly status: 200 | 201 | 202
  readonly body: Schema.Json
}

/** Safe route failures carry public copy only. Provider errors stay inside the module. */
export class ModuleRouteFailure extends Schema.TaggedError<ModuleRouteFailure>()("ModuleRouteFailure", {
  status: Schema.Literals([400, 404, 409, 500, 503]),
  code: Schema.String
}) {}

const ModuleRouteTypeId = Symbol("ModuleApiRoute")
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

type InternalHandler = (query: URLSearchParams, body: Schema.Json) => Effect.Effect<ModuleResponse, ModuleRouteFailure>
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
            const identity = `${route.method} ${route.path}`
            if (identities.has(identity)) {
              return yield* new ModuleRegistrationError({ module: module.descriptor.id, reason: "duplicate_route" })
            }
            identities.add(identity)
          }
          return { descriptor: module.descriptor, routes: handlers.routes }
        })
      )
      return { modules: mounted }
    })
  )

/** Read routes encode the declared success schema; handlers close over services acquired by their layer. */
export const moduleReadRoute = <A>(
  path: ModuleApiRoute["path"],
  success: Schema.Codec<A, Schema.Json, never, never>,
  handle: (query: URLSearchParams) => Effect.Effect<A, ModuleRouteFailure>,
  status: ModuleResponse["status"] = 200
): ModuleApiRoute =>
  registerRoute("GET", path, (query) =>
    handle(query).pipe(
      Effect.flatMap((body) => Schema.encodeEffect(success)(body)),
      Effect.mapError((error) =>
        error._tag === "ModuleRouteFailure" ? error : new ModuleRouteFailure({ status: 500, code: "invalid_response" })
      ),
      Effect.map((body) => ({ status, body }))
    ))

/** Decode a mutation body after authorization, then encode the declared success schema. */
export const moduleWriteRoute = <A, B>(
  method: Exclude<ModuleApiRoute["method"], "GET">,
  path: ModuleApiRoute["path"],
  schema: Schema.Codec<A, unknown, never, never>,
  success: Schema.Codec<B, Schema.Json, never, never>,
  handle: (body: A, query: URLSearchParams) => Effect.Effect<B, ModuleRouteFailure>,
  status: ModuleResponse["status"] = 200
): ModuleApiRoute =>
  registerRoute(method, path, (query, body) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => new ModuleRouteFailure({ status: 400, code: "invalid_body" })),
      Effect.flatMap((decoded) => handle(decoded, query)),
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
export const dispatchModuleRoute = Effect.fn("ModuleRegistry.dispatch")(function*<E, R>(request: {
  readonly method: string
  readonly url: URL
  readonly listener: ModuleListener
  readonly authorize: Effect.Effect<unknown, E, R>
  readonly sameOrigin: Effect.Effect<unknown, E, R>
  readonly readJson: () => Effect.Effect<Schema.Json, E, R>
}): Effect.fn.Return<ModuleResponse | null, E | ModuleRouteFailure, R | ModuleRegistry> {
  const registry = yield* ModuleRegistry
  for (const module of registry.modules) {
    const prefix = `/v1/modules/${module.descriptor.id}`
    if (!request.url.pathname.startsWith(`${prefix}/`)) continue
    if (!module.descriptor.listeners.includes(request.listener)) return null
    const route = module.routes.find(
      (candidate) => candidate.method === request.method && `${prefix}${candidate.path}` === request.url.pathname
    )
    if (route === undefined) return null
    yield* request.authorize
    const mutation = route.method !== "GET"
    if (mutation) yield* request.sameOrigin
    const body = mutation ? yield* request.readJson() : null
    const handle = routeHandlers.get(route)
    if (handle === undefined) return yield* new ModuleRouteFailure({ status: 500, code: "invalid_route" })
    return yield* handle(request.url.searchParams, body)
  }
  return null
})
