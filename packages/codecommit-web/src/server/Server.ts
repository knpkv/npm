import { BunFileSystem, BunHttpServer, BunServices } from "@effect/platform-bun"
import {
  AwsClient,
  AwsClientConfig,
  CacheService,
  ConfigService,
  PermissionService,
  PRService,
  ReadClient,
  ReviewClient,
  SandboxService,
  StatsService
} from "@knpkv/codecommit-core"
import { AwsClientGatedLive, InnerAwsClient } from "@knpkv/codecommit-core/AwsClient/AwsClientGated.js"
import { AuditLogRepo } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import {
  PermissionGateLiveLayer,
  PermissionGateLiveTag
} from "@knpkv/codecommit-core/PermissionService/PermissionGateLive.js"
import { Config, Deferred, Effect, Fiber, Layer, Option, Predicate, Ref, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"
import {
  Etag,
  FetchHttpClient,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { coordinateRouterMaxParamLength } from "../pull-request-coordinates.js"
import { CodeCommitApi } from "./Api.js"
import {
  AccountsLive,
  AuditLive,
  ConfigLive,
  EventsLive,
  NotificationsLive,
  PermissionsLive,
  PrsLive,
  SandboxLive,
  StatsLive,
  SubscriptionsLive
} from "./handlers/index.js"
import { BackgroundScopeLive } from "./internal/BackgroundScope.js"
import { autoRefreshLayer, sandboxStartupLayer } from "./internal/BackgroundWorkers.js"
import {
  activateOwnerSessionBootstrap,
  makeOwnerSessionSecrets,
  ownerSessionAuthLayer,
  OwnerSessionBootstrapRouter,
  ownerSessionOrigin,
  OwnerSessionSecrets,
  type OwnerSessionSecretsContract,
  requireLoopbackHostname
} from "./internal/OwnerSessionSecurity.js"
import { InnerCodeCommitReadClient, makePermissionedReadClient } from "./internal/PermissionedReadClient.js"
import { resolveCodeCommitBootstrapUrl } from "./internal/PublicOrigin.js"
import { makeRelayFindingPublisher, RelayFindingPublisher } from "./review/RelayFindingPublisher.js"

export {
  makeOwnerSessionSecrets,
  ownerSessionOrigin,
  OwnerSessionSecrets,
  type OwnerSessionSecretsContract,
  ownerSessionUrl,
  ownerSessionUrlForOrigin,
  requireLoopbackHostname,
  requireLoopbackOrigin
} from "./internal/OwnerSessionSecurity.js"

// MIME types for common files
interface MimeTypeLookup extends Readonly<Record<string, string>> {}

const mimeTypes: MimeTypeLookup = {
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

  const __dirname = yield* path.fromFileUrl(new URL(".", import.meta.url))
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
  SubscriptionsLive,
  SandboxLive,
  StatsLive,
  PermissionsLive,
  AuditLive
).pipe(Layer.provideMerge(BackgroundScopeLive))

// Platform dependencies
const PlatformLive = Layer.mergeAll(
  BunServices.layer,
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

// Permission infrastructure
const PermissionLive = Layer.mergeAll(
  PermissionService.PermissionService.Default,
  PermissionGateLiveTag.Default,
  AuditLogRepo.Default
).pipe(
  Layer.provide(PlatformLive),
  Layer.provide(ReposLive)
)

// PermissionGate (abstract) provided from PermissionGateLive (concrete)
const PermissionGateLive_ = PermissionGateLiveLayer.pipe(
  Layer.provide(PermissionGateLiveTag.Default),
  Layer.provide(ReposLive)
)

// Original AwsClient → InnerAwsClient
const InnerAwsClientLive = Layer.effect(
  InnerAwsClient,
  AwsClient.AwsClient
).pipe(
  Layer.provide(AwsClient.AwsClientLive),
  Layer.provide(AwsClientConfig.Default),
  Layer.provide(FetchHttpClient.layer)
)

// Gated AwsClient wrapping InnerAwsClient with permission checks + audit
const GatedAwsClientLive = AwsClientGatedLive.pipe(
  Layer.provide(InnerAwsClientLive),
  Layer.provide(PermissionLive),
  Layer.provide(PermissionGateLive_)
)

// PRService dependencies
const PRServiceDeps = Layer.mergeAll(
  GatedAwsClientLive,
  ReposLive
).pipe(
  Layer.provideMerge(ConfigLive_),
  Layer.provide(AwsClientConfig.Default),
  Layer.provide(PlatformLive)
)

// PRService with all dependencies
const PRServiceLive_ = PRService.PRServiceLive.pipe(Layer.provideMerge(PRServiceDeps))

// AwsClient for handlers that call AWS directly (e.g., createPR)
const AwsClientLive_ = GatedAwsClientLive

// Immutable diff and Relay reads use the Schema-decoded provider boundary
// wrapped by the same permission and audit policy as the legacy AWS client.
const InnerReadClientLive = Layer.effect(
  InnerCodeCommitReadClient,
  ReadClient.CodeCommitReadClient
).pipe(
  Layer.provide(ReadClient.CodeCommitReadClient.live),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)
const ReadClientLive = Layer.effect(
  ReadClient.CodeCommitReadClient,
  Effect.flatMap(InnerCodeCommitReadClient, makePermissionedReadClient)
).pipe(
  Layer.provide(InnerReadClientLive),
  Layer.provide(PermissionLive),
  Layer.provide(PermissionGateLive_)
)

// The full core review client stays private to this layer. HTTP handlers receive
// only the permission-gated Relay comment capability, never approval or merge.
const CoreReviewClientLive = ReviewClient.CodeCommitReviewClient.layer.pipe(
  Layer.provide(ReviewClient.CodeCommitReviewProviderLive),
  Layer.provide(ReadClientLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)
const RelayFindingPublisherLive = Layer.effect(
  RelayFindingPublisher,
  makeRelayFindingPublisher()
).pipe(
  Layer.provide(CoreReviewClientLive),
  Layer.provide(PermissionLive),
  Layer.provide(PermissionGateLive_)
)

// Sandbox services — DockerService uses the `docker` CLI, no HttpClient needed
// SandboxService reads ConfigService at runtime for sandbox settings
const SandboxServicesLive = Layer.mergeAll(
  SandboxService.SandboxService.Default,
  SandboxService.DockerService.Default,
  CacheService.SandboxRepo.Default
).pipe(
  Layer.provide(ConfigLive_),
  Layer.provide(ReposLive),
  Layer.provide(PlatformLive)
)

// Stats service — StatsRepo provided first, then rest via PRServiceDeps
const StatsServiceLive = StatsService.StatsService.Default.pipe(
  Layer.provide(CacheService.StatsRepo.Default),
  Layer.provide(PRServiceDeps)
)

// All services needed by handlers
const AllServicesLive = Layer.mergeAll(
  PRServiceLive_,
  ConfigLive_,
  AwsClientLive_,
  ReadClientLive,
  SandboxServicesLive,
  StatsServiceLive,
  PermissionLive,
  PlatformLive
)

// Prune old audit log entries on startup
const AuditPrune = Layer.effectDiscard(
  Effect.gen(function*() {
    const auditLog = yield* AuditLogRepo
    const permService = yield* PermissionService.PermissionService
    const retentionDays = yield* permService.getAuditRetention()
    const deleted = yield* auditLog.prune(retentionDays).pipe(Effect.catchIf(() => true, () => Effect.succeed(0)))
    if (deleted > 0) yield* Effect.logInfo(`Pruned ${deleted} audit log entries older than ${retentionDays} days`)
  })
)

// API router with handlers — AutoRefresh shares AllServicesLive with handlers
const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(CodeCommitApi).pipe(
    Layer.provide(HandlersLive.pipe(Layer.provide(RelayFindingPublisherLive)))
  ),
  autoRefreshLayer,
  AuditPrune,
  sandboxStartupLayer
).pipe(
  Layer.provide(ownerSessionAuthLayer),
  Layer.provide(AllServicesLive),
  Layer.provide(FetchHttpClient.layer)
)

// Static file router - catches all non-API routes
const StaticRouter = HttpRouter.use((router) => router.add("GET", "/*", serveStatic))

const AllowedOrigins = Config.string("ALLOWED_ORIGINS").pipe(
  Config.map((s) => s.split(",")),
  Config.withDefault(["http://localhost:3000", "http://127.0.0.1:3000"])
)

// CORS layer via Effect Config — consistent with Port config
const CorsLive = Layer.unwrap(
  Effect.map(AllowedOrigins, (allowedOrigins) =>
    HttpRouter.cors({
      allowedOrigins,
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"]
    }))
)

// Combined routes with CORS — orDie for remaining service construction errors
const AllRoutes = Layer.mergeAll(ApiLive, OwnerSessionBootstrapRouter, StaticRouter).pipe(
  Layer.provide(CorsLive),
  Layer.orDie
)

// HttpPlatform + Etag — required by addHttpApi for OpenAPI/multipart support
const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(BunFileSystem.layer))

export interface CodeCommitServerOptions {
  readonly hostname?: string
  readonly port: number
  readonly ready?: Deferred.Deferred<void>
  readonly security: OwnerSessionSecretsContract
}

export const makeServer = (options: CodeCommitServerOptions) => {
  const hostname = options.hostname ?? "127.0.0.1"
  return Layer.unwrap(
    requireLoopbackHostname(hostname).pipe(
      Effect.map(() => {
        const server = HttpRouter.serve(AllRoutes, {
          // Coordinate tokens include provider-valid repository names up to 100
          // characters; keep one bounded segment for the review route.
          routerConfig: { maxParamLength: coordinateRouterMaxParamLength }
        }).pipe(
          // idleTimeout: 0 disables idle detection — required for long-lived SSE connections
          Layer.provide(BunHttpServer.layer({ hostname, port: options.port, idleTimeout: 0 })),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatformLive),
          Layer.provide(Layer.succeed(OwnerSessionSecrets, options.security))
        )
        return server.pipe(
          Layer.tap(() =>
            activateOwnerSessionBootstrap(options.security).pipe(
              Effect.andThen(
                options.ready === undefined
                  ? Effect.void
                  : Deferred.succeed(options.ready, undefined)
              )
            )
          )
        )
      })
    )
  )
}

export const makeCodeCommitServer = (port: number, security: OwnerSessionSecretsContract) =>
  makeServer({ port, security })

export const Port = Config.int("PORT").pipe(Config.withDefault(3000))
const PublicOrigin = Config.option(Config.string("CODECOMMIT_WEB_PUBLIC_ORIGIN"))

const updatePortOnConflict = (
  portRef: Ref.Ref<number>,
  retriesRef: Ref.Ref<number>
) =>
<A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchDefect((defect) =>
      Predicate.isError(defect) && defect.message.includes("port")
        ? Effect.gen(function*() {
          const remaining = yield* Ref.getAndUpdate(retriesRef, (r) => r - 1)
          if (remaining <= 0) return yield* Effect.die(defect)
          const p = yield* Ref.getAndUpdate(portRef, (prev) => prev + 1)
          yield* Effect.logWarning(`Port ${p} in use, trying ${p + 1}`)
        })
        : Effect.die(defect)
    )
  )

export const CodeCommitServerLive = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const portRef = yield* Ref.make(yield* Port.pipe(Effect.orDie))
  const retriesRef = yield* Ref.make(10)
  const publicOriginOverride = yield* PublicOrigin.pipe(Effect.orDie)

  return yield* Effect.forever(
    Effect.gen(function*() {
      const p = yield* Ref.get(portRef)
      const directOrigin = ownerSessionOrigin("127.0.0.1", p)
      // Rotate every authority-bearing secret on each bind attempt so a URL
      // emitted for an occupied port cannot authenticate to a later retry.
      const security = yield* makeOwnerSessionSecrets(directOrigin)
      const bootstrapUrl = yield* resolveCodeCommitBootstrapUrl(
        Option.getOrUndefined(publicOriginOverride),
        p,
        security
      )
      const ready = yield* Deferred.make<void>()
      const serverFiber = yield* Layer.launch(makeServer({ port: p, ready, security })).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(serverFiber))
      yield* Effect.logInfo(`Authenticated server ready at ${ownerSessionOrigin("127.0.0.1", p)}`)
      yield* Stream.make(`Authenticated bootstrap URL: ${bootstrapUrl}\n`).pipe(
        Stream.run(stdio.stdout())
      )
      return yield* Fiber.join(serverFiber)
    }).pipe(updatePortOnConflict(portRef, retriesRef))
  )
})
