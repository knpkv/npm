/** The same authenticated routes, bootstrap exchange and static client in production and tests. */
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Path } from "effect"
import { HttpPlatform, HttpRouter, HttpServerRespondable, HttpServerResponse, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AgentUsageApi } from "./Api.js"
import { UsageLive } from "./Handlers.js"
import { LiveRouter } from "./Live.js"
import { ownerSessionAuthLayer } from "./OwnerSession.js"

/**
 * Serves the built client at `root`, from the same origin as the API so the session cookie applies to
 * both. Extensionless HTML navigations fall back to `index.html`; `no-cache` makes the browser
 * revalidate, so a rebuilt `index.html` never points at hashed assets that no longer exist.
 */
export const staticClient = (root: string) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const platform = yield* HttpPlatform.HttpPlatform
    // FileSystem and Path resolve per request, from the server rather than from whatever an engine
    // layer provides to the application (the jcf-web fixtures provide an in-memory FileSystem).
    const serve = HttpStaticServer.make({ cacheControl: "no-cache", root, spa: true }).pipe(
      Effect.provideService(HttpPlatform.HttpPlatform, platform),
      Effect.orDie,
      Effect.flatten,
      Effect.catchTag("HttpServerError", HttpServerRespondable.toResponse)
    )
    yield* router.add("GET", "/*", serve)
  }))

/** The client `vite build` writes next to the compiled server. */
const StaticRouter = Layer.unwrap(Effect.gen(function*() {
  const path = yield* Path.Path
  return staticClient(yield* path.fromFileUrl(new URL("../../dist/client", import.meta.url)))
}))

/** Usage, tickets and paths are private to the owner: no API response may be kept by a cache. */
const NoStore = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, HttpServerResponse.setHeader("cache-control", "private, no-store"))
)

const ApiRoutes = HttpApiBuilder.layer(AgentUsageApi).pipe(
  Layer.provide(UsageLive),
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(NoStore.layer)
)

/** Supply the store, runtime state and owner secrets; listener and platform belong to the executable. */
export const application = Layer.mergeAll(ApiRoutes, OwnerSession.BootstrapRouter, LiveRouter, StaticRouter).pipe(
  Layer.orDie
)
