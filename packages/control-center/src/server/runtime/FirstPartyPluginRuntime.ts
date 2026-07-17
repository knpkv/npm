import * as Layer from "effect/Layer"

import { FirstPartyPluginRuntimeRegistry } from "../plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { PluginConnectionMapLive, PluginRuntimeMap } from "../plugins/internal/PluginRuntimeMap.js"

/** One server-lifetime cache projected as the production read-only plugin connection map. @internal */
export const firstPartyPluginConnectionMapLayer = PluginConnectionMapLive.pipe(
  Layer.provide(PluginRuntimeMap.layer.pipe(Layer.provide(FirstPartyPluginRuntimeRegistry)))
)
