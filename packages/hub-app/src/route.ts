/**
 * Module API routes: schema-checked handlers under `/v1/modules/<module id>`, shared by the hub's core
 * modules and every app server. Moved from herdr-hub's module-server.
 *
 * **Mental model**
 *
 * - A route is a frozen `{ method, path }` identity; its handler stays in a private table, so a spread copy
 *   can't swap the decoding out. Build routes with {@link moduleReadRoute} and {@link moduleWriteRoute}.
 * - The caller comes from whoever authenticated the request (the hub's listener, or a standalone app's
 *   owner session), never from the client.
 * - A grant is the hub's handle for the request it proxied. Shell services that act for the caller read it
 *   from {@link CurrentGrant}; handlers never see or forward a caller themselves.
 *
 * @module
 */
import { Context, Effect, Schema } from "effect"
import type { ModuleDescriptor, ModuleListener } from "./module.js"

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

/** The hub's opaque handle for one proxied request; null outside a hub-proxied request. */
export const Grant = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/)).pipe(Schema.brand("HubGrant"))
export type Grant = typeof Grant.Type

/** Set by the app runner for each request the hub proxied with an `x-hub-grant` header. */
export const CurrentGrant = Context.Reference<Grant | null>("@knpkv/hub-app/CurrentGrant", {
  defaultValue: () => null
})

const ModuleRouteTypeId = Symbol("ModuleApiRoute")
const ApiPath = Schema.String.check(Schema.isPattern(/^(\/[a-z0-9][a-z0-9-]*)+$/))

/**
 * Construct routes with the schema-backed factories. `invalid_route` at registration means an
 * unrecognized route identity, including one built by a second copy of this package.
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

/** True for a route built by this package instance with a well-formed path. */
export const isModuleRoute = (route: ModuleApiRoute): boolean =>
  routeHandlers.has(route) && Schema.is(ApiPath)(route.path)

/** Run a registered route with an already-authorized caller. */
export const invokeModuleRoute = (
  route: ModuleApiRoute,
  query: URLSearchParams,
  body: Schema.Json,
  caller: ModuleCaller
): Effect.Effect<ModuleResponse, ModuleRouteFailure> => {
  const handle = routeHandlers.get(route)
  return handle === undefined
    ? Effect.fail(new ModuleRouteFailure({ status: 500, code: "invalid_route" }))
    : handle(query, body, caller)
}

export class ModuleHandlers extends Context.Service<
  ModuleHandlers,
  {
    readonly routes: ReadonlyArray<ModuleApiRoute>
    /** Expected source failures reject; the hub's collector records them and keeps the other providers. */
    readonly needsYou?: Effect.Effect<unknown, unknown>
  }
>()("@knpkv/hub-app/ModuleHandlers") {}

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

/** One module as a listener serves it: its metadata and the routes its handler layer built. */
export interface MountedModule {
  readonly descriptor: ModuleDescriptor
  readonly routes: ReadonlyArray<ModuleApiRoute>
}

/**
 * Serve one request against one module. Null when the path is outside the module, the listener isn't
 * declared, or no route matches; callers answer 404 on null for `/v1/modules/*`. Authorization runs
 * only for a matched route; same-origin and the body only for mutations.
 */
export const dispatchToModule = Effect.fn("ModuleRoute.dispatch")(
  function*<E, R, OriginError = E, BodyError = E>(module: MountedModule, request: {
    readonly method: string
    readonly url: URL
    readonly listener: ModuleListener | "work"
    readonly authorize: Effect.Effect<typeof ModuleCaller.Encoded, E, R>
    readonly sameOrigin: Effect.Effect<unknown, OriginError, R>
    readonly readJson: () => Effect.Effect<Schema.Json, BodyError, R>
  }): Effect.fn.Return<ModuleResponse | null, E | OriginError | BodyError | ModuleRouteFailure, R> {
    const prefix = `/v1/modules/${module.descriptor.id}`
    if (!request.url.pathname.startsWith(`${prefix}/`)) return null
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
    return yield* invokeModuleRoute(route, request.url.searchParams, body, caller)
  }
)
