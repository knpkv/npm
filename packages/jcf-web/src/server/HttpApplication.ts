/** The same authenticated routes, bootstrap exchange and static client in production and tests. */
import { Effect, FileSystem, Layer, Path } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JcfWebApi } from "./Api.js"
import { ConfigLive, EntriesLive, RowsLive, WeekLive } from "./Handlers.js"
import { ownerSessionAuthLayer, OwnerSessionBootstrapRouter } from "./OwnerSession.js"
import { layer as weekPlansLayer } from "./WeekPlans.js"

const mimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".ico", "image/x-icon"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"]
])

/** True only when `candidate` is `root` itself or one of its path-segment descendants. */
export const isWithinDirectory = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`))
}

/** The built client, served from the same origin so the session cookie applies to both. */
const serveStatic = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname).replace(/^\/+/u, "")
  const here = yield* path.fromFileUrl(new URL(".", import.meta.url))
  const staticDirectory = path.resolve(here, "../../dist/client")
  const resolved = path.resolve(staticDirectory, requested === "" ? "index.html" : requested)

  // A resolved path that escaped the directory is a traversal attempt, not a missing file.
  if (!isWithinDirectory(path, staticDirectory, resolved)) {
    return HttpServerResponse.text("Forbidden", { status: 403 })
  }

  if (yield* fileSystem.exists(resolved)) {
    const info = yield* fileSystem.stat(resolved)
    if (info.type === "File") {
      return HttpServerResponse.uint8Array(yield* fileSystem.readFile(resolved), {
        headers: { "content-type": mimeTypes.get(path.extname(resolved)) ?? "application/octet-stream" },
        status: 200
      })
    }
  }

  const index = path.join(staticDirectory, "index.html")
  if (yield* fileSystem.exists(index)) {
    return HttpServerResponse.uint8Array(yield* fileSystem.readFile(index), {
      headers: { "content-type": "text/html" },
      status: 200
    })
  }
  return HttpServerResponse.text("The client has not been built. Run: pnpm --filter @knpkv/jcf-web build", {
    status: 404
  })
})

const StaticRouter = HttpRouter.use((router) => router.add("GET", "/*", serveStatic))

const ApiRoutes = HttpApiBuilder.layer(JcfWebApi).pipe(
  Layer.provide(Layer.mergeAll(WeekLive, RowsLive, ConfigLive, EntriesLive)),
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(weekPlansLayer)
)

/** Supply engine services and owner secrets; listener and platform belong to the executable. */
export const application = Layer.mergeAll(ApiRoutes, OwnerSessionBootstrapRouter, StaticRouter).pipe(Layer.orDie)
