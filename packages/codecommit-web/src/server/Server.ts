import {
  Etag,
  FetchHttpClient,
  FileSystem,
  HttpLayerRouter,
  HttpPlatform,
  HttpServerRequest,
  HttpServerResponse,
  Path
} from "@effect/platform"
import { BunContext, BunFileSystem, BunHttpServer } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, CacheService, ConfigService, PRService } from "@knpkv/codecommit-core"
import { Config, Duration, Effect, Layer, Option, Predicate, Ref } from "effect"
import { fileURLToPath } from "node:url"
import { CodeCommitApi } from "./Api.js"
import {
  AccountsLive,
  ConfigLive,
  EventsLive,
  NotificationsLive,
  PrsLive,
  SubscriptionsLive
} from "./handlers/index.js"

// MIME types for common files
const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
}

// Static file serving — async Effect FileSystem, no sync node:fs
const serveStatic = Effect.gen(function*() {
  const req = yield* HttpServerRequest.HttpServerRequest
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const url = new URL(req.url, "http://localhost")
  let filePath = decodeURIComponent(url.pathname)

  // Remove leading slash
  if (filePath.startsWith("/")) {
    filePath = filePath.slice(1)
  }
  if (filePath === "") {
    filePath = "index.html"
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const staticDir = path.resolve(__dirname, "../../dist/client")
  const fullPath = path.resolve(staticDir, filePath)

  // Path traversal guard — resolved path must stay within staticDir
  if (!fullPath.startsWith(staticDir)) {
    return HttpServerResponse.text("Forbidden", { status: 403 })
  }

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
const HandlersLive = Layer.mergeAll(
  PrsLive,
  ConfigLive,
  AccountsLive,
  EventsLive,
  NotificationsLive,
  SubscriptionsLive
)

// Platform dependencies
const PlatformLive = Layer.mergeAll(
  Path.layer,
  BunFileSystem.layer,
  FetchHttpClient.layer
)

// Base services - ConfigService needs Platform + EventsHub
const ConfigLive_ = ConfigService.ConfigServiceLive.pipe(
  Layer.provide(PlatformLive),
  Layer.provide(CacheService.EventsHub.Default)
)

// Cache repos + EventsHub — each auto-wires DatabaseLive via Effect.Service dependencies
// EventsHub.Default is shared across all repos via layer memoization
// orDie scoped to cache layers only: DB/migration errors become defects here
const ReposLive = Layer.mergeAll(
  CacheService.PullRequestRepo.Default,
  CacheService.CommentRepo.Default,
  CacheService.NotificationRepo.Default,
  CacheService.SubscriptionRepo.Default,
  CacheService.SyncMetadataRepo.Default,
  CacheService.EventsHub.Default
).pipe(Layer.orDie)

// PRService dependencies
const PRServiceDeps = Layer.mergeAll(
  AwsClient.AwsClientLive,
  ReposLive
).pipe(
  Layer.provideMerge(ConfigLive_),
  Layer.provide(AwsClientConfig.Default),
  Layer.provide(PlatformLive)
)

// PRService with all dependencies
const PRServiceLive_ = PRService.PRServiceLive.pipe(Layer.provideMerge(PRServiceDeps))

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

// Fork auto-refresh loop: initial refresh + recurring based on config
const AutoRefresh = Layer.effectDiscard(
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const configService = yield* ConfigService.ConfigService

    const refreshIteration = Effect.gen(function*() {
      const config = yield* configService.load.pipe(
        Effect.catchAll(() => Effect.succeed({ autoRefresh: true, refreshIntervalSeconds: 300 } as const))
      )
      if (config.autoRefresh) {
        yield* Effect.sleep(Duration.seconds(config.refreshIntervalSeconds))
        yield* prService.refresh
        yield* Effect.logInfo("Auto-refresh complete")
      } else {
        yield* Effect.sleep(Duration.seconds(30))
      }
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError("Auto-refresh failed", cause).pipe(
          Effect.zipRight(Effect.sleep(Duration.seconds(10)))
        )
      )
    )

    yield* Effect.forkDaemon(
      Effect.gen(function*() {
        yield* prService.refresh
        yield* Effect.logInfo("Initial PR refresh complete")
        return yield* Effect.forever(refreshIteration)
      })
    )
  })
)

// API router with handlers — AutoRefresh shares AllServicesLive with handlers
const ApiLive = Layer.merge(
  HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(Layer.provide(HandlersLive)),
  AutoRefresh
).pipe(
  Layer.provide(AllServicesLive),
  Layer.provide(FetchHttpClient.layer)
)

// Static file router - catches all non-API routes
const StaticRouter = HttpLayerRouter.use((router) => router.add("GET", "/*", serveStatic))

const AllowedOrigins = Config.string("ALLOWED_ORIGINS").pipe(
  Config.map((s) => s.split(",")),
  Config.withDefault(["http://localhost:3000", "http://127.0.0.1:3000"])
)

// CORS layer via Effect Config — consistent with Port config
const CorsLive = Layer.unwrapEffect(
  Effect.map(AllowedOrigins, (allowedOrigins) =>
    HttpLayerRouter.cors({
      allowedOrigins,
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    }))
)

// Combined routes with CORS — orDie for remaining service construction errors
const AllRoutes = Layer.mergeAll(ApiLive, StaticRouter).pipe(
  Layer.provide(CorsLive),
  Layer.orDie
)

// HttpPlatform + Etag — required by addHttpApi for OpenAPI/multipart support
const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(BunFileSystem.layer))

export const makeServer = (options: { port: number; hostname?: string }) =>
  HttpLayerRouter.serve(AllRoutes).pipe(
    // idleTimeout: 0 disables idle detection — required for long-lived SSE connections
    Layer.provide(BunHttpServer.layer({ ...options, idleTimeout: 0 })),
    Layer.provide(BunContext.layer),
    Layer.provide(Etag.layer),
    Layer.provide(HttpPlatformLive)
  )

export const makeCodeCommitServer = (port: number) => makeServer({ port })

export const Port = Config.integer("PORT").pipe(Config.withDefault(3000))

const updatePortOnConflict = (
  portRef: Ref.Ref<number>,
  retriesRef: Ref.Ref<number>
) =>
<A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchSomeDefect((defect) =>
      Predicate.isError(defect) && defect.message.includes("port")
        ? Option.some(Effect.gen(function*() {
          const remaining = yield* Ref.getAndUpdate(retriesRef, (r) => r - 1)
          if (remaining <= 0) return yield* Effect.die(defect)
          const p = yield* Ref.getAndUpdate(portRef, (prev) => prev + 1)
          yield* Effect.logWarning(`Port ${p} in use, trying ${p + 1}`)
        }))
        : Option.none()
    )
  )

export const CodeCommitServerLive = Effect.gen(function*() {
  const portRef = yield* Ref.make(yield* Port.pipe(Effect.orDie))
  const retriesRef = yield* Ref.make(10)

  return yield* Effect.forever(
    Effect.gen(function*() {
      const p = yield* Ref.get(portRef)
      yield* Effect.logInfo(`Starting server on http://localhost:${p}`)
      return yield* Layer.launch(makeCodeCommitServer(p))
    }).pipe(updatePortOnConflict(portRef, retriesRef))
  )
})
