import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type {
  AtlassianOAuthGrantExchangeResponse,
  AtlassianOAuthGrantId,
  AtlassianOAuthGrantStartResponse,
  AtlassianOAuthProviderIntent,
  AtlassianProfileDiscoveryResponse,
  AwsProfileDiscoveryResponse,
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginOverviewResponse
} from "../../api/index.js"
import type { DiscoveredAtlassianProfile } from "../../api/plugins.js"
import { PluginConnectionId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Browser boundary for connection administration reads and live tests. */
export interface ConnectionTestTransport {
  /** Optional only for injected legacy/test transports; the browser transport always discovers profiles. */
  readonly discoverAwsProfiles?: (signal: AbortSignal) => Promise<AwsProfileDiscoveryResponse>
  readonly discoverAtlassianProfiles?: (signal: AbortSignal) => Promise<AtlassianProfileDiscoveryResponse>
  readonly startAtlassianOAuthGrant?: (
    providers: AtlassianOAuthProviderIntent,
    signal: AbortSignal
  ) => Promise<AtlassianOAuthGrantStartResponse>
  readonly exchangeAtlassianOAuthGrant?: (
    grantId: AtlassianOAuthGrantId,
    code: string,
    signal: AbortSignal
  ) => Promise<AtlassianOAuthGrantExchangeResponse>
  readonly completeAtlassianOAuthGrant?: (
    grantId: AtlassianOAuthGrantId,
    cloudId: string,
    signal: AbortSignal
  ) => Promise<DiscoveredAtlassianProfile>
  readonly overview: (signal: AbortSignal) => Promise<PluginOverviewResponse>
  readonly create: (
    request: CreatePluginConnectionRequest,
    signal: AbortSignal
  ) => Promise<CreatePluginConnectionResponse>
  readonly makeConnectionId: () => Promise<PluginConnectionId>
  readonly setEnabled: (
    pluginConnectionId: PluginConnectionId,
    isEnabled: boolean,
    signal: AbortSignal
  ) => Promise<PluginConnectionSummary>
  readonly test: (pluginConnectionId: PluginConnectionId, signal: AbortSignal) => Promise<PluginConnectionTestResult>
}

/** Generated-client transport carrying cookies and the current tab's mutation proof. */
export const browserConnectionTestTransport: ConnectionTestTransport = {
  startAtlassianOAuthGrant: (providers, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.createAtlassianOAuthGrant({ payload: { providers } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  exchangeAtlassianOAuthGrant: (grantId, code, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.exchangeAtlassianOAuthGrant({
          params: { grantId },
          payload: { code }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  completeAtlassianOAuthGrant: (grantId, cloudId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.completeAtlassianOAuthGrant({
          params: { grantId },
          payload: { cloudId }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  discoverAtlassianProfiles: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.plugins.discoverAtlassianProfiles()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  discoverAwsProfiles: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.plugins.discoverAwsProfiles()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  overview: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.plugins.overview()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  create: (request, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.createConnection({ payload: request })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  makeConnectionId: () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const cryptoService = yield* Crypto.Crypto
        return yield* Schema.decodeUnknownEffect(PluginConnectionId)(yield* cryptoService.randomUUIDv7)
      }).pipe(Effect.provide(BrowserCrypto.layer))
    ),
  setEnabled: (pluginConnectionId, isEnabled, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.setConnectionEnabled({
          params: { pluginConnectionId },
          payload: { isEnabled }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  test: (pluginConnectionId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.testConnection({ params: { pluginConnectionId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
