/**
 * Binding the week view to a loopback port.
 *
 * **Mental model**
 *
 * - **One process, one operator, one origin.** The server listens on loopback, mints its own session
 *   at startup, and prints the URL that spends it. There is nothing to configure and nobody to
 *   authenticate against.
 * - **The engine is the same one the CLI runs.** `HeadlessLayer` from `@knpkv/jira-clockify` is
 *   provided whole, so a week read here and a `jcf sync reconcile --agent` in a terminal derive from
 *   the same services against the same config.
 *
 * @module
 */
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Layers } from "@knpkv/jira-clockify"
import { Config, Deferred, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { JcfWebApi } from "./Api.js"
import { ConfigLive, RowsLive, WeekLive } from "./Handlers.js"
import {
  activateOwnerSessionBootstrap,
  ownerSessionAuthLayer,
  OwnerSessionBootstrapRouter,
  OwnerSessionSecrets,
  type OwnerSessionSecretsContract
} from "./OwnerSession.js"
import { layer as weekPlansLayer } from "./WeekPlans.js"

const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
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
  if (!resolved.startsWith(staticDirectory)) return HttpServerResponse.text("Forbidden", { status: 403 })

  if (yield* fileSystem.exists(resolved)) {
    const info = yield* fileSystem.stat(resolved)
    if (info.type === "File") {
      return HttpServerResponse.uint8Array(yield* fileSystem.readFile(resolved), {
        headers: { "content-type": mimeTypes[path.extname(resolved)] ?? "application/octet-stream" },
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

const EngineLive = Layer.mergeAll(Layers.HeadlessLayer, weekPlansLayer)

const ApiLive = HttpApiBuilder.layer(JcfWebApi).pipe(
  Layer.provide(Layer.mergeAll(WeekLive, RowsLive, ConfigLive)),
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(EngineLive)
)

const AllRoutes = Layer.mergeAll(ApiLive, OwnerSessionBootstrapRouter, StaticRouter).pipe(Layer.orDie)

const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))

export interface JcfWebServerOptions {
  readonly hostname?: string
  readonly port: number
  readonly ready?: Deferred.Deferred<void>
  readonly security: OwnerSessionSecretsContract
}

export const makeServer = (options: JcfWebServerOptions) =>
  HttpRouter.serve(AllRoutes).pipe(
    Layer.provide(
      NodeHttpServer.layerServer(createServer, { host: options.hostname ?? "127.0.0.1", port: options.port })
    ),
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatformLive),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(OwnerSessionSecrets, options.security)),
    Layer.tap(() =>
      activateOwnerSessionBootstrap(options.security).pipe(
        Effect.andThen(options.ready === undefined ? Effect.void : Deferred.succeed(options.ready, undefined))
      )
    )
  )

/** The port to bind. Deliberately not 3000: the CodeCommit web app already lives there. */
export const Port = Config.int("PORT").pipe(Config.withDefault(3111))

/** Set by `pnpm dev` so the printed URL points at the Vite dev server that proxies here. */
export const PublicOrigin = Config.option(Config.string("JCF_WEB_PUBLIC_ORIGIN"))
