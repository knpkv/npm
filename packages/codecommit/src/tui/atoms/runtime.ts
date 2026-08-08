import { BunServices } from "@effect/platform-bun"
import { AwsClient, AwsClientConfig, CacheService, ConfigService, PRService, ReadClient } from "@knpkv/codecommit-core"
import { Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Atom from "effect/unstable/reactivity/Atom"
import { WorktreeService } from "../../WorktreeService.js"
import { tuiApplicationScopeLayer } from "./applicationScope.js"

// Leaf layers — fully closed (R = never)
const EventsHubLive = CacheService.EventsHub.Default

export { TuiApplicationScope } from "./applicationScope.js"

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

const ReadLayer = ReadClient.CodeCommitReadClient.live.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

const WorktreeLayer = WorktreeService.live.pipe(Layer.provide(BunServices.layer))

// Expose PRService + repos + EventsHub + AwsClient for atoms
const MainLayer = (get: Atom.AtomContext) =>
  Layer.mergeAll(PRLayer, ReposLive, EventsHubLive, AwsLive, ReadLayer, WorktreeLayer, tuiApplicationScopeLayer(get))

// Merge BunServices into output for child process actions.
const AppLayer = (get: Atom.AtomContext) => MainLayer(get).pipe(Layer.provideMerge(BunServices.layer))

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime((get) => AppLayer(get))
