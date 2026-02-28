import { Atom } from "@effect-atom/atom-react"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, CacheService, ConfigService, PRService } from "@knpkv/codecommit-core"
import { Layer } from "effect"

// Leaf layers — fully closed (R = never)
const EventsHubLive = CacheService.EventsHub.Default

const AwsLive = AwsClient.AwsClientLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

const ConfigLayer = ConfigService.ConfigServiceLive.pipe(
  Layer.provide(BunContext.layer),
  Layer.provide(EventsHubLive)
)

// Repos need FileSystem (from DatabaseLive → EnsureDbDir) — close with BunContext
const ReposLive = Layer.mergeAll(
  CacheService.PullRequestRepo.Default,
  CacheService.CommentRepo.Default,
  CacheService.NotificationRepo.Default,
  CacheService.SubscriptionRepo.Default,
  CacheService.SyncMetadataRepo.Default
).pipe(Layer.provide(BunContext.layer))

// PRService — all deps pre-closed
const PRLayer = PRService.PRServiceLive.pipe(
  Layer.provide(AwsLive),
  Layer.provide(ConfigLayer),
  Layer.provide(ReposLive),
  Layer.provide(EventsHubLive)
)

// Expose PRService + repos + EventsHub + AwsClient for atoms
const MainLayer = Layer.mergeAll(PRLayer, ReposLive, EventsHubLive, AwsLive)

// Merge BunContext into output for CommandExecutor (used by Command.make in actions)
const AppLayer = MainLayer.pipe(Layer.provideMerge(BunContext.layer))

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime(AppLayer)
