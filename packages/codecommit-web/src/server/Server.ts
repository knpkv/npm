import {
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
  Path,
  FetchHttpClient
} from "@effect/platform"
import { BunHttpServer, BunContext, BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import * as nodePath from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { CodeCommitApi } from "./Api.js"
import { PrsLive, ConfigLive, AccountsLive, EventsLive } from "./handlers/index.js"
import {
  PRServiceLive,
  ConfigServiceLive,
  AwsClientLive,
  NotificationsServiceLive
} from "@knpkv/codecommit-core"

// Get directory name for static file resolution
const __filename = fileURLToPath(import.meta.url)
const __dirname = nodePath.dirname(__filename)

// MIME types for common files
const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
}

// Static file serving
const serveStatic = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest

  const url = new URL(req.url, "http://localhost")
  let filePath = url.pathname

  // Security check
  if (filePath.includes("..")) {
    return HttpServerResponse.text("Forbidden", { status: 403 })
  }

  // Remove leading slash
  if (filePath.startsWith("/")) {
    filePath = filePath.slice(1)
  }
  if (filePath === "") {
    filePath = "index.html"
  }

  const staticDir = nodePath.resolve(__dirname, "../../dist/client")
  const fullPath = nodePath.join(staticDir, filePath)

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const content = fs.readFileSync(fullPath)
    const ext = nodePath.extname(fullPath)
    const contentType = mimeTypes[ext] || "application/octet-stream"
    return HttpServerResponse.raw(content, {
      status: 200,
      headers: { "content-type": contentType }
    })
  }

  // SPA Fallback
  const index = nodePath.join(staticDir, "index.html")
  if (fs.existsSync(index)) {
    const content = fs.readFileSync(index)
    return HttpServerResponse.raw(content, {
      status: 200,
      headers: { "content-type": "text/html" }
    })
  }

  return HttpServerResponse.text("Not Found", { status: 404 })
})

// API handlers layer
const HandlersLive = Layer.mergeAll(PrsLive, ConfigLive, AccountsLive, EventsLive)

// Platform dependencies
const PlatformLive = Layer.mergeAll(
  Path.layer,
  BunFileSystem.layer,
  FetchHttpClient.layer
)

// Base services - ConfigService needs Platform
const ConfigLive_ = ConfigServiceLive.pipe(Layer.provide(PlatformLive))

// PRService dependencies
const PRServiceDeps = Layer.mergeAll(
  AwsClientLive,
  NotificationsServiceLive
).pipe(
  Layer.provideMerge(ConfigLive_),
  Layer.provide(PlatformLive)
)

// PRService with all dependencies
const PRServiceLive_ = PRServiceLive.pipe(Layer.provide(PRServiceDeps))

// All services needed by handlers
const AllServicesLive = Layer.mergeAll(
  PRServiceLive_,
  ConfigLive_
)

// API router with handlers
const ApiLive = HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(AllServicesLive),
  Layer.provide(FetchHttpClient.layer)
)

// Static file router - catches all non-API routes
const StaticRouter = HttpLayerRouter.use((router) =>
  router.add("GET", "/*", serveStatic)
)

// Combined routes with CORS
const AllRoutes = Layer.mergeAll(ApiLive, StaticRouter).pipe(
  Layer.provide(
    HttpLayerRouter.cors({
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true
    })
  )
)

export const makeServer = (options: { port: number; hostname?: string }) =>
  HttpLayerRouter.serve(AllRoutes).pipe(
    Layer.provide(BunHttpServer.layer(options)),
    Layer.provide(BunContext.layer)
  )

// Default export
export const CodeCommitServerLive = makeServer({ port: 3000 })
