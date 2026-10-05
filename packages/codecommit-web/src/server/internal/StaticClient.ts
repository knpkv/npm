import { Effect, Layer } from "effect"
import { HttpPlatform, HttpRouter, HttpServerRespondable, HttpStaticServer } from "effect/http"

/**
 * Serves the built client at `root` for every non-API route. Extensionless HTML navigations fall back
 * to `index.html`; `no-cache` makes the browser revalidate, so a rebuilt `index.html` never points at
 * hashed assets that no longer exist.
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
