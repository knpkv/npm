import * as Layer from "effect/Layer"

import { FirstPartyPluginRuntimeRegistry } from "../plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginConnectionMapLive, PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"
import type { PluginRuntimeRegistry } from "../plugins/internal/PluginRuntimeRegistry.js"

/** Production first-party registry with persisted runtime-authority publication. @internal */
export const firstPartyPluginRuntimeRegistryLayer = FirstPartyPluginRuntimeRegistry.pipe(
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

const firstPartyRuntime = firstPartyPluginRuntimeLayers(firstPartyPluginRuntimeRegistryLayer)

/** One server-lifetime cache projected as the production read-only plugin connection map. @internal */
export const firstPartyPluginConnectionMapLayer = firstPartyRuntime.connections
