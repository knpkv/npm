import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { staticClient } from "../src/server/HttpApplication.js"

// The guard itself is Effect's HttpStaticServer; this pins the options agent-usage mounts it with.
it.layer(NodeServices.layer)("static client", (it) => {
  it.effect("serves the client, falls back for navigations, and never leaves its root", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped()
      const root = path.join(parent, "client")
      yield* fs.makeDirectory(path.join(root, "assets"), { recursive: true })
      yield* fs.writeFileString(path.join(root, "index.html"), "index")
      yield* fs.writeFileString(path.join(root, "assets", "app.js"), "app")
      yield* fs.makeDirectory(path.join(parent, "client-secret"))
      yield* fs.writeFileString(path.join(parent, "client-secret", "index.html"), "secret")
      const web = HttpRouter.toWebHandler(
        staticClient(root).pipe(
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Etag.layer),
          Layer.provide(NodeServices.layer)
        ),
        { disableLogger: true }
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
      const get = (pathname: string, accept = "text/html") =>
        Effect.promise(async () => {
          const response = await web.handler(new Request(`http://127.0.0.1${pathname}`, { headers: { accept } }))
          return {
            body: await response.text(),
            cacheControl: response.headers.get("cache-control"),
            status: response.status
          }
        })

      expect(yield* get("/")).toEqual({ body: "index", cacheControl: "no-cache", status: 200 })
      expect(yield* get("/assets/app.js", "*/*")).toMatchObject({ body: "app", status: 200 })
      expect(yield* get("/some/deep/link")).toMatchObject({ body: "index", status: 200 })
      expect((yield* get("/missing.js", "*/*")).status).toBe(404)
      for (
        const escape of [
          "/..%2fclient-secret%2findex.html",
          "/%2e%2e%2fclient-secret%2findex.html",
          "/%00",
          "/%E0%A4%A"
        ]
      ) {
        const response = yield* get(escape)
        expect(response.status, escape).toBe(404)
        expect(response.body, escape).not.toContain("secret")
      }
    }))
})
