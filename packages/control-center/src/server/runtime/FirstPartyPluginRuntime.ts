import type * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import * as Layer from "effect/Layer"
import type * as HttpClient from "effect/unstable/http/HttpClient"

import {
  codeCommitClientsLayer,
  FirstPartyPluginRuntimeRegistry,
  makeFirstPartyPluginRuntimeRegistry
} from "../plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginConnectionMapLive, PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"
import { PluginRuntimeRegistry, type PluginRuntimeRegistryV1 } from "../plugins/internal/PluginRuntimeRegistry.js"

/** Production first-party registry with persisted runtime-authority publication. @internal */
export const firstPartyPluginRuntimeRegistryLayer = FirstPartyPluginRuntimeRegistry.pipe(
  Layer.provide(pluginRuntimeAuthoritySourceLayer)
)

/** Production registry with only CodeCommit routed through a dedicated transport. @internal */
export const firstPartyPluginRuntimeRegistryLayerWithCodeCommitHttpClient = (
  httpClient: HttpClient.HttpClient,
  awsConfiguration?: Layer.Layer<AwsClientConfig.AwsClientConfig>
) =>
  makeFirstPartyPluginRuntimeRegistry(codeCommitClientsLayer(httpClient, awsConfiguration)).pipe(
    Layer.provide(pluginRuntimeAuthoritySourceLayer)
  )

/**
 * Build public proposal and private execution projections over one server-owned cache.
 * Keeping this factory at the composition boundary prevents administration invalidation
 * from refreshing only one authority-bearing view of a connection.
 *
 * @internal
 */
export const firstPartyPluginRuntimeLayers = <Error, Requirements>(
  registry: Layer.Layer<PluginRuntimeRegistry, Error, Requirements>
) => {
  const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registry))
  return {
    connections: PluginConnectionMapLive.pipe(Layer.provide(runtimeMap)),
    runtimeMap
  }
}

/** Deterministic registry service accepted only by the server composition test seam. @internal */
export type FirstPartyPluginRuntimeRegistryOverride = PluginRuntimeRegistryV1

/** Project a deterministic registry service through the production cache factory. @internal */
export const firstPartyPluginRuntimeLayersFromRegistry = (
  registry: FirstPartyPluginRuntimeRegistryOverride
) => firstPartyPluginRuntimeLayers(Layer.succeed(PluginRuntimeRegistry, registry))

const firstPartyRuntime = firstPartyPluginRuntimeLayers(firstPartyPluginRuntimeRegistryLayer)

/** One server-lifetime cache projected as the production read-only plugin connection map. @internal */
export const firstPartyPluginConnectionMapLayer = firstPartyRuntime.connections
