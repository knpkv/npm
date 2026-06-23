import { BunServices } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, CacheService, ConfigService, PRService } from "@knpkv/codecommit-core"
import { Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Atom from "effect/unstable/reactivity/Atom"

// Leaf layers — fully closed (R = never)
const EventsHubLive = CacheService.EventsHub.Default

const AwsLive = AwsClient.AwsClientLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

const ConfigLayer = ConfigService.ConfigServiceLive.pipe(
  Layer.provide(BunServices.layer),
  Layer.provide(EventsHubLive)
)

// Repos need FileSystem (from DatabaseLive -> EnsureDbDir) - close with BunServices
const ReposLive = Layer.mergeAll(
  CacheService.PullRequestRepo.Default,
  CacheService.CommentRepo.Default,
  CacheService.NotificationRepo.Default,
  CacheService.SubscriptionRepo.Default,
  CacheService.SyncMetadataRepo.Default
).pipe(Layer.provide(BunServices.layer))

// PRService — all deps pre-closed
const PRLayer = PRService.PRServiceLive.pipe(
  Layer.provide(AwsLive),
  Layer.provide(ConfigLayer),
  Layer.provide(ReposLive),
  Layer.provide(EventsHubLive)
)

// Expose PRService + repos + EventsHub + AwsClient for atoms
const MainLayer = Layer.mergeAll(PRLayer, ReposLive, EventsHubLive, AwsLive)

// Merge BunServices into output for child process actions.
const AppLayer = MainLayer.pipe(Layer.provideMerge(BunServices.layer))

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime(AppLayer)
