import * as Layer from "effect/Layer"

import { FirstPartyPluginRuntimeRegistry } from "../plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginConnectionMapLive, PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"

/** Production first-party registry with persisted runtime-authority publication. @internal */
export const firstPartyPluginRuntimeRegistryLayer = FirstPartyPluginRuntimeRegistry.pipe(
  Layer.provide(pluginRuntimeAuthoritySourceLayer)
)

/** One server-lifetime cache projected as the production read-only plugin connection map. @internal */
export const firstPartyPluginConnectionMapLayer = PluginConnectionMapLive.pipe(
  Layer.provide(
    PluginRuntimeMap.layer.pipe(
      Layer.provide(firstPartyPluginRuntimeRegistryLayer)
    )
  )
)
