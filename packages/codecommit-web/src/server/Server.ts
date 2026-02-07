import {
  FetchHttpClient,
  FileSystem,
  HttpLayerRouter,
  HttpServerRequest,
  HttpServerResponse,
  Path
} from "@effect/platform"
import { BunContext, BunFileSystem, BunHttpServer } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, ConfigService, NotificationsService, PRService } from "@knpkv/codecommit-core"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { CodeCommitApi } from "./Api.js"
import { AccountsLive, ConfigLive, EventsLive, PrsLive } from "./handlers/index.js"

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

// Static file serving — async Effect FileSystem, no sync node:fs
const serveStatic = Effect.gen(function*() {
  const req = yield* HttpServerRequest.HttpServerRequest
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

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

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const staticDir = path.resolve(__dirname, "../../dist/client")
  const fullPath = path.join(staticDir, filePath)

  if (yield* fileSystem.exists(fullPath)) {
    const stat = yield* fileSystem.stat(fullPath)
    if (stat.type === "File") {
      const content = yield* fileSystem.readFile(fullPath)
      const ext = path.extname(fullPath)
      const contentType = mimeTypes[ext] || "application/octet-stream"
      return HttpServerResponse.uint8Array(content, {
        status: 200,
        headers: { "content-type": contentType }
      })
    }
  }

  // SPA Fallback
  const index = path.join(staticDir, "index.html")
  if (yield* fileSystem.exists(index)) {
    const content = yield* fileSystem.readFile(index)
    return HttpServerResponse.uint8Array(content, {
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
const ConfigLive_ = ConfigService.ConfigServiceLive.pipe(Layer.provide(PlatformLive))

// PRService dependencies
const PRServiceDeps = Layer.mergeAll(
  AwsClient.AwsClientLive,
  NotificationsService.NotificationsServiceLive
).pipe(
  Layer.provideMerge(ConfigLive_),
  Layer.provide(AwsClientConfig.Default),
  Layer.provide(PlatformLive)
)

// PRService with all dependencies
const PRServiceLive_ = PRService.PRServiceLive.pipe(Layer.provide(PRServiceDeps))

// AwsClient for handlers that call AWS directly (e.g., createPR)
const AwsClientLive_ = AwsClient.AwsClientLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

// All services needed by handlers
const AllServicesLive = Layer.mergeAll(
  PRServiceLive_,
  ConfigLive_,
  AwsClientLive_
)

// Fork initial PR refresh when services are built
const InitialRefresh = Layer.effectDiscard(
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(
      prService.refresh.pipe(
        Effect.tap(() => Effect.logInfo("Initial PR refresh complete"))
      )
    )
  })
)

// API router with handlers — InitialRefresh shares AllServicesLive with handlers
const ApiLive = Layer.merge(
  HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(Layer.provide(HandlersLive)),
  InitialRefresh
).pipe(
  Layer.provide(AllServicesLive),
  Layer.provide(FetchHttpClient.layer)
)

// Static file router - catches all non-API routes
const StaticRouter = HttpLayerRouter.use((router) => router.add("GET", "/*", serveStatic))

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
    Layer.provide(BunHttpServer.layer({ ...options, idleTimeout: 255 })),
    Layer.provide(BunContext.layer)
  )

export const makeCodeCommitServer = (port: number) => makeServer({ port })

// Default export
export const CodeCommitServerLive = makeCodeCommitServer(3000)
