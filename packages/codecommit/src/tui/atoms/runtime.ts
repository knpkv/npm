import { BunServices } from "@effect/platform-bun"
import {
  AwsClient,
  AwsClientConfig,
  CacheService,
  ConfigService,
  PRService,
  ReadClient,
  ReviewClient
} from "@knpkv/codecommit-core"
import {
  codeCommitMockAwsClientConfig,
  decodeCodeCommitMockEndpointEffect,
  withCodeCommitMock
} from "@knpkv/codecommit-core/MockTransport.js"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Atom from "effect/unstable/reactivity/Atom"
import { WorktreeService } from "../../WorktreeService.js"
import {
  tuiApplicationScopeLayer,
  tuiHostEnvironmentAtom,
  tuiHostEnvironmentLayer,
  tuiTerminalSessionLayer
} from "./applicationScope.js"

// Leaf layers — fully closed (R = never)
const EventsHubLive = CacheService.EventsHub.Default

export { TuiApplicationScope, TuiTerminalSession } from "./applicationScope.js"

const configuredMockEndpoint = (get: Atom.AtomContext) => get(tuiHostEnvironmentAtom)?.CODECOMMIT_MOCK_ENDPOINT?.trim()

const awsClientConfigLayer = (get: Atom.AtomContext) => {
  const configured = configuredMockEndpoint(get)
  return configured === undefined || configured.length === 0
    ? AwsClientConfig.Default
    : codeCommitMockAwsClientConfig
}

const outboundHttpClientLayer = (get: Atom.AtomContext) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const configured = configuredMockEndpoint(get)
      if (configured === undefined || configured.length === 0) return client
      return withCodeCommitMock(client, yield* decodeCodeCommitMockEndpointEffect(configured))
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))

const AwsLive = (get: Atom.AtomContext) =>
  AwsClient.AwsClientLive.pipe(
    Layer.provide(outboundHttpClientLayer(get)),
    Layer.provide(awsClientConfigLayer(get))
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
const PRLayer = (get: Atom.AtomContext) =>
  PRService.PRServiceLive.pipe(
    Layer.provide(AwsLive(get)),
    Layer.provide(ConfigLayer),
    Layer.provide(ReposLive),
    Layer.provide(EventsHubLive)
  )

const ReadLayer = (get: Atom.AtomContext) =>
  ReadClient.CodeCommitReadClient.live.pipe(
    Layer.provide(outboundHttpClientLayer(get)),
    Layer.provide(awsClientConfigLayer(get))
  )

const ReviewLayer = (get: Atom.AtomContext) =>
  ReviewClient.CodeCommitReviewClient.live.pipe(
    Layer.provide(ReadLayer(get)),
    Layer.provide(outboundHttpClientLayer(get)),
    Layer.provide(awsClientConfigLayer(get))
  )

const WorktreeLayer = WorktreeService.live

// Expose PRService + repos + EventsHub + AwsClient for atoms
const MainLayer = (get: Atom.AtomContext) =>
  Layer.mergeAll(
    PRLayer(get),
    ReposLive,
    EventsHubLive,
    AwsLive(get),
    ReadLayer(get),
    ReviewLayer(get),
    outboundHttpClientLayer(get),
    // WorktreeService's git spawns need the inherited environment, so it is provided to
    // that layer as well as merged for the atoms that resolve it directly.
    WorktreeLayer.pipe(Layer.provide(tuiHostEnvironmentLayer(get))),
    tuiApplicationScopeLayer(get),
    tuiTerminalSessionLayer(get),
    tuiHostEnvironmentLayer(get)
  )

// Merge BunServices into output for child process actions.
const AppLayer = (get: Atom.AtomContext) => MainLayer(get).pipe(Layer.provideMerge(BunServices.layer))

/**
 * Runtime atom providing Effect services to other atoms
 * @category atoms
 */
export const runtimeAtom = Atom.runtime((get) => AppLayer(get))
