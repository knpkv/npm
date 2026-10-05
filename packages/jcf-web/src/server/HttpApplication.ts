/** The same authenticated routes, bootstrap exchange and static client in production and tests. */
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Path } from "effect"
import { HttpStaticServer } from "effect/http"
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
export const staticClient = (root: string) => HttpStaticServer.layer({ cacheControl: "no-cache", root, spa: true })

/**
 * The client `vite build` writes next to the compiled server. It reads host files, so give it the
 * host's FileSystem even where the engine runs on another one.
 */
export const StaticRouter = Layer.unwrap(Effect.gen(function*() {
  const path = yield* Path.Path
  return staticClient(yield* path.fromFileUrl(new URL("../../dist/client", import.meta.url)))
}))

const ApiRoutes = HttpApiBuilder.layer(JcfWebApi).pipe(
  Layer.provide(Layer.mergeAll(WeekLive, RowsLive, ConfigLive, EntriesLive)),
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(weekPlansLayer)
)

/** The authenticated API and the bootstrap exchange: everything that runs on the engine's services. */
export const apiApplication = Layer.mergeAll(ApiRoutes, OwnerSession.BootstrapRouter).pipe(Layer.orDie)

/** Supply engine services and owner secrets; listener and platform belong to the executable. */
export const application = Layer.mergeAll(apiApplication, StaticRouter).pipe(Layer.orDie)
