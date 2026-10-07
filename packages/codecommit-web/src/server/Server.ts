import { NodeFileSystem, NodeHttpServer, NodeServices } from "@effect/platform-node"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
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
import { Config, Deferred, Effect, Layer, Option, Ref, Stream } from "effect"
import { Etag, FetchHttpClient, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"
import { createServer } from "node:http"
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
import { makeOwnerSession, ownerSessionAuthLayer } from "./internal/OwnerSession.js"
import { InnerCodeCommitReadClient, makePermissionedReadClient } from "./internal/PermissionedReadClient.js"
import { updatePortOnConflict } from "./internal/PortRetry.js"
import { resolveCodeCommitPublicOriginForBind } from "./internal/PublicOrigin.js"
import { staticClient } from "./internal/StaticClient.js"
import { makeRelayFindingPublisher, RelayFindingPublisher } from "./review/RelayFindingPublisher.js"

export { loopbackOrigin, requireLoopbackHostname } from "@knpkv/browser-pairing/owner-session"
export { makeOwnerSession } from "./internal/OwnerSession.js"

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
// Node's platform runs under both Node and Bun, so `codecommit web` starts with Node alone.
const PlatformLive = Layer.mergeAll(
  NodeServices.layer,
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

/** The client `vite build` writes next to the compiled server. */
const StaticRouter = Layer.unwrap(Effect.gen(function*() {
  const path = yield* Path.Path
  return staticClient(yield* path.fromFileUrl(new URL("../../dist/client", import.meta.url)))
}))

const AllowedOrigins = Config.String("ALLOWED_ORIGINS").pipe(
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
const AllRoutes = Layer.mergeAll(ApiLive, OwnerSession.BootstrapRouter, StaticRouter).pipe(
  Layer.provide(CorsLive),
  Layer.orDie
)

// HttpPlatform + Etag — required by addHttpApi for OpenAPI/multipart support
const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(NodeFileSystem.layer))

export interface CodeCommitServerOptions {
  readonly hostname?: string
  readonly port: number
  /** The origin the printed URL uses; the bound server's own when omitted. */
  readonly publicOrigin?: string
  /** Completed with the bootstrap URL once the server is listening. */
  readonly ready?: Deferred.Deferred<string>
  readonly security: OwnerSession.OwnerSessionService
}

export const makeServer = (options: CodeCommitServerOptions) => {
  const hostname = options.hostname ?? "127.0.0.1"
  return Layer.unwrap(
    OwnerSession.requireLoopbackHostname(hostname).pipe(
      // The printed URL carries the bootstrap code, so its origin must be the server or its dev proxy.
      Effect.andThen(OwnerSession.resolvePublicOrigin(options.publicOrigin, options.security.authorityOrigin)),
      Effect.map((publicOrigin) => {
        const server = HttpRouter.serve(AllRoutes, {
          // Coordinate tokens include provider-valid repository names up to 100
          // characters; keep one bounded segment for the review route.
          routerConfig: { maxParamLength: coordinateRouterMaxParamLength }
        }).pipe(
          // Node's default socket timeout is off, so server-sent events stay open as long as the page.
          Layer.provide(NodeHttpServer.layer(createServer, { host: hostname, port: options.port })),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatformLive),
          Layer.provide(Layer.succeed(OwnerSession.OwnerSession, options.security))
        )
        return server.pipe(
          Layer.tap(() =>
            // Minted only once the server is listening, so the printed code is one that can be spent.
            options.security.mintBootstrapCode.pipe(
              Effect.map((code) => OwnerSession.bootstrapUrl(publicOrigin, code)),
              Effect.flatMap((url) => options.ready === undefined ? Effect.void : Deferred.succeed(options.ready, url))
            )
          )
        )
      })
    )
  )
}

export const makeCodeCommitServer = (port: number, security: OwnerSession.OwnerSessionService) =>
  makeServer({ port, security })

export const Port = Config.Int("PORT").pipe(Config.withDefault(3000))
const PublicOrigin = Config.option(Config.String("CODECOMMIT_WEB_PUBLIC_ORIGIN"))

/** How `serveCodeCommit` binds. Every field is optional; the defaults are the web package's own entry. */
export interface CodeCommitServeOptions {
  /** Loopback hostname to listen on. Default `127.0.0.1`. */
  readonly hostname?: string
  /** First port to try; a taken port moves to the next, up to ten times. Default `PORT`, else 3000. */
  readonly port?: number
  /** Runs once the server is listening and the bootstrap URL is printed, e.g. to open a browser. */
  readonly onReady?: (url: string) => Effect.Effect<void>
}

/**
 * Serve CodeCommit web until the server stops: mint fresh owner secrets for each bind attempt, move
 * to the next port when one is taken, print the bootstrap URL (on `CODECOMMIT_WEB_PUBLIC_ORIGIN` when
 * set and the requested port was free), then run `onReady`. `codecommit web` and this package's
 * entry both start the server this way.
 */
export const serveCodeCommit = Effect.fn("CodeCommitServer.serve")(function*(options: CodeCommitServeOptions = {}) {
  const stdio = yield* Stdio.Stdio
  const hostname = options.hostname ?? "127.0.0.1"
  // The Vite dev proxy forwards to PORT, whatever port this server was asked to start on.
  const proxyPort = yield* Port.pipe(Effect.orDie)
  const portRef = yield* Ref.make(options.port ?? proxyPort)
  const retriesRef = yield* Ref.make(10)
  const listening = yield* Ref.make(false)
  const publicOriginOverride = yield* PublicOrigin.pipe(Effect.orDie)

  return yield* Effect.forever(
    Effect.gen(function*() {
      const p = yield* Ref.get(portRef)
      const directOrigin = OwnerSession.loopbackOrigin(hostname, p)
      // Rotate every authority-bearing secret on each bind attempt so a URL
      // emitted for an occupied port cannot authenticate to a later retry.
      const security = yield* makeOwnerSession(directOrigin)
      const publicOrigin = yield* resolveCodeCommitPublicOriginForBind(
        Option.getOrUndefined(publicOriginOverride),
        proxyPort,
        p,
        directOrigin
      )
      return yield* OwnerSession.serveWithBootstrapUrl(
        (ready) => makeServer({ hostname, port: p, publicOrigin, ready, security }),
        (url) =>
          Effect.gen(function*() {
            yield* Ref.set(listening, true)
            yield* Effect.logInfo(`Authenticated server ready at ${directOrigin}`)
            // The one line a new user needs, set apart from the logs above it.
            yield* Stream.make(
              `\nCodeCommit is ready. Open this sign-in link (it works once, within 60 seconds):\n\n  ${url}\n\n`
            ).pipe(Stream.run(stdio.stdout()))
            if (options.onReady !== undefined) yield* options.onReady(url)
          })
      )
    }).pipe(updatePortOnConflict(portRef, retriesRef, listening))
  )
})

/** The web package's entry: `serveCodeCommit` with its defaults. */
export const CodeCommitServerLive = serveCodeCommit()
