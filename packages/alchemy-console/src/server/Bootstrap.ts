import { Effect, Layer, Path } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"

/** Serve the built browser shell and assets under the same constrained loopback listener. */
export const BootstrapRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/favicon.ico", HttpServerResponse.empty({ status: 204 })),
  Layer.unwrap(Effect.gen(function*() {
    const path = yield* Path.Path
    return HttpStaticServer.layer({
      root: yield* path.fromFileUrl(new URL("../../dist/client", import.meta.url)),
      cacheControl: "no-store"
    })
  }))
)
