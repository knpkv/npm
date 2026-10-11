import { Effect, Layer, Path } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"

/** Auth handoff only. The design-backed stack UI will replace the JSON navigation in a later PR. */
const document =
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Alchemy console</title><body><main><p id="status">Signing in…</p><noscript>Enable JavaScript to sign in.</noscript></main><script type="module" src="/bootstrap.js"></script></body></html>`

export const BootstrapRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.html(document)),
  HttpRouter.add("GET", "/favicon.ico", HttpServerResponse.empty({ status: 204 })),
  Layer.unwrap(Effect.gen(function*() {
    const path = yield* Path.Path
    return HttpStaticServer.layer({
      root: yield* path.fromFileUrl(new URL("../../dist/client", import.meta.url)),
      cacheControl: "no-store"
    })
  }))
)
