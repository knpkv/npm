import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"

import { StaticAssetStore, type StaticAssetStoreService } from "../../src/server/http/security/StaticAssetStore.js"
import { staticApplicationLayer } from "../../src/server/http/StaticApplication.js"

const documentBytes = new TextEncoder().encode("<main>Control Center</main>")

const assetStoreService: StaticAssetStoreService = {
  assetCount: 1,
  totalBytes: documentBytes.byteLength,
  resolve: (requestPath, accept) => {
    const isDocument = requestPath === "/" || requestPath === "/releases"
    if (!isDocument || accept?.includes("text/html") !== true) return Option.none()
    return Option.some({
      bytes: Uint8Array.from(documentBytes),
      cacheControl: "no-store",
      kind: requestPath === "/" ? "asset" : "spa",
      mimeType: "text/html; charset=utf-8",
      path: "/index.html"
    })
  }
}
const requestContext = Context.make(StaticAssetStore, assetStoreService)

const staticApplicationTestLayer = Layer.mergeAll(
  staticApplicationLayer,
  HttpServer.layerServices
).pipe(
  Layer.provide([
    NodeHttpServer.layerHttpServices,
    NodeServices.layer
  ])
)

describe("static application", () => {
  it("serves GET and implicit HEAD with identical metadata and no HEAD body", async () => {
    const webHandler = HttpRouter.toWebHandler(staticApplicationTestLayer, { disableLogger: true })
    try {
      const headers = { accept: "text/html" }
      const getResponse = await webHandler.handler(new Request("http://control.local/", { headers }), requestContext)
      const headResponse = await webHandler.handler(
        new Request("http://control.local/", { headers, method: "HEAD" }),
        requestContext
      )

      assert.strictEqual(getResponse.status, 200)
      assert.strictEqual(await getResponse.text(), "<main>Control Center</main>")
      assert.strictEqual(headResponse.status, 200)
      assert.strictEqual(headResponse.headers.get("content-length"), String(documentBytes.byteLength))
      assert.strictEqual(headResponse.headers.get("content-type"), "text/html; charset=utf-8")
      assert.strictEqual(headResponse.headers.get("cache-control"), "no-store")
      assert.strictEqual(await headResponse.text(), "")
    } finally {
      await webHandler.dispose()
    }
  })

  it("marks SPA fallbacks by Accept and keeps missing assets uncached", async () => {
    const webHandler = HttpRouter.toWebHandler(staticApplicationTestLayer, { disableLogger: true })
    try {
      const spaResponse = await webHandler.handler(
        new Request("http://control.local/releases", { headers: { accept: "text/html" } }),
        requestContext
      )
      const missingResponse = await webHandler.handler(
        new Request("http://control.local/missing.js", { headers: { accept: "text/html" } }),
        requestContext
      )

      assert.strictEqual(spaResponse.status, 200)
      assert.strictEqual(spaResponse.headers.get("vary"), "accept")
      assert.strictEqual(missingResponse.status, 404)
      assert.strictEqual(missingResponse.headers.get("cache-control"), "no-store")
      assert.strictEqual(await missingResponse.text(), "Not Found")
    } finally {
      await webHandler.dispose()
    }
  })
})
