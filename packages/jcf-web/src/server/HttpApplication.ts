/** The same authenticated routes, bootstrap exchange and static client in production and tests. */
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Path } from "effect"
import { HttpPlatform, HttpRouter, HttpServerRespondable, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { JcfWebApi } from "./Api.js"
import { ConfigLive, EntriesLive, RowsLive, WeekLive } from "./Handlers.js"
import { ownerSessionAuthLayer } from "./OwnerSession.js"
import { layer as weekPlansLayer } from "./WeekPlans.js"

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

const ApiRoutes = HttpApiBuilder.layer(JcfWebApi).pipe(
  Layer.provide(Layer.mergeAll(WeekLive, RowsLive, ConfigLive, EntriesLive)),
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(weekPlansLayer)
)

/** Supply engine services and owner secrets; listener and platform belong to the executable. */
export const application = Layer.mergeAll(ApiRoutes, OwnerSession.BootstrapRouter, StaticRouter).pipe(Layer.orDie)
