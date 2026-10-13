import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { createServer } from "node:http"

import { type VerifiedBodies, verifiedBody } from "./references.js"
import { BrowserFailure, type ReferenceFailure, RunnerFailure } from "./schema.js"

const serveBodies = Effect.fn("DesignConformance.serveBodies")(
  function*(
    files: Readonly<Record<string, string>>,
    read: (file: string) => Effect.Effect<Uint8Array, PlatformError.PlatformError | ReferenceFailure>
  ) {
    const routes = Object.entries(files).map(([route, file]) =>
      HttpRouter.add(
        "GET",
        `/${route.replace(/^\//u, "")}`,
        read(file).pipe(
          Effect.map((body) =>
            HttpServerResponse.uint8Array(body, {
              contentType: file.endsWith(".html")
                ? "text/html"
                : file.endsWith(".js") || file.endsWith(".mjs")
                ? "text/javascript"
                : file.endsWith(".css")
                ? "text/css"
                : file.endsWith(".json")
                ? "application/json"
                : file.endsWith(".woff2")
                ? "font/woff2"
                : file.endsWith(".png")
                ? "image/png"
                : file.endsWith(".svg")
                ? "image/svg+xml"
                : "application/octet-stream"
            })
          )
        )
      )
    )
    const [first, ...rest] = routes
    if (first === undefined) return yield* new RunnerFailure({ detail: "Static server needs at least one file" })
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" })
    const context = yield* HttpRouter.serve(Layer.mergeAll(first, ...rest), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provideMerge(serverLayer),
      Layer.build,
      Effect.mapError((cause) => new BrowserFailure({ operation: "static server", cause }))
    )
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context))
    return HttpServer.formatAddress(server.address)
  }
)

/** Live product files may change with application state; their routes stay explicit. */
export const serveFiles = Effect.fn("DesignConformance.serveFiles")(
  function*(root: string, files: Readonly<Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* serveBodies(files, (file) => fs.readFile(path.join(root, file)))
  }
)

/** Serve only verified memory bodies; disk rewrites cannot change approved reference content. */
export const serveVerifiedFiles = (bodies: VerifiedBodies) =>
  serveBodies(
    Object.fromEntries(Array.from(bodies.keys(), (file) => [`/${file}`, file])),
    (file) => verifiedBody(bodies, file)
  )
