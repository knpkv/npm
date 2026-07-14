import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

import { StaticAssetStore } from "./security/StaticAssetStore.js"

const notFound = HttpServerResponse.text("Not Found", {
  status: 404,
  headers: {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  }
})

const serveStaticAsset = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const assets = yield* StaticAssetStore
  const resolved = assets.resolve(request.url, request.headers.accept ?? null)
  if (Option.isNone(resolved)) return notFound

  const asset = resolved.value
  return HttpServerResponse.uint8Array(asset.bytes, {
    status: 200,
    headers: {
      "cache-control": asset.cacheControl,
      "content-length": String(asset.bytes.byteLength),
      "content-type": asset.mimeType,
      "x-content-type-options": "nosniff",
      ...(asset.kind === "spa" ? { vary: "accept" } : {})
    }
  })
})

/** Register immutable GET assets; Effect's router serves matching HEAD requests without a body. */
export const staticApplicationLayer = HttpRouter.use((router) => router.add("GET", "/*", serveStaticAsset))

/** Supply the immutable asset service to the static browser route. */
export const staticApplicationWithAssetsLayer = <Error, Requirements>(
  assets: Layer.Layer<StaticAssetStore, Error, Requirements>
) => staticApplicationLayer.pipe(Layer.provide(assets))
