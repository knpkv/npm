import { dispatchToModule, isModuleRoute, ModuleHandlers, moduleReadRoute } from "@knpkv/hub-app"
import type { ModuleCaller, ModuleListener, ModuleResponse, ModuleRouteFailure, MountedModule } from "@knpkv/hub-app"
import { Context, Effect, Layer, Result, Schema } from "effect"
import {
  connectModule,
  type ModuleDescriptor,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "./module-contract.js"
import { collectNeedsYou, type NeedsYouProvider } from "./module-needs-you-server.js"
import { NeedsYouResult } from "./module-needs-you.js"

/** Route contract moved to @knpkv/hub-app; re-exported for one release. */
export {
  type ModuleApiRoute,
  ModuleCaller,
  ModuleHandlers,
  moduleReadRoute,
  type ModuleResponse,
  ModuleRouteFailure,
  moduleWriteRoute
} from "@knpkv/hub-app"

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

/** The agent home owns the fleet-wide approvals summary; providers are composed once by the hub. */
export const needsYouRouteOwner = connectModule.id

/** Product layers acquire stable services at startup and close handler requirements. */
export interface ServerModule<E = never, R = never> {
  readonly descriptor: ModuleDescriptor
  readonly handlers: Layer.Layer<ModuleHandlers, E, R>
}

export class ModuleRegistry extends Context.Service<
  ModuleRegistry,
  {
    readonly modules: ReadonlyArray<MountedModule>
  }
>()("@knpkv/herdr-hub/ModuleRegistry") {}

/**
 * Validate both registrations before acquiring any module layer; metadata must be shared.
 * `appProviders` adds needs-you providers that change at runtime (installed apps), read per request.
 */
export const makeModuleLayer = <E, R>(
  descriptors: ReadonlyArray<ModuleDescriptor>,
  modules: ReadonlyArray<ServerModule<E, R>>,
  appProviders: Effect.Effect<ReadonlyArray<NeedsYouProvider>> = Effect.succeed([])
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
            if (!isModuleRoute(route)) {
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
      const readNeedsYou = Effect.flatMap(appProviders, (apps) => collectNeedsYou([...providers, ...apps]))
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
      if (!request.url.pathname.startsWith(`/v1/modules/${module.descriptor.id}/`)) continue
      return yield* dispatchToModule(module, request)
    }
    return null
  }
)
