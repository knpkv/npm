import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as LayerMap from "effect/LayerMap"

import type { PluginFailure } from "../failures.js"
import { PluginConnection } from "../PluginConnection.js"
import type { PluginRuntimeScope } from "../PluginConnectionMap.js"
import { PluginConnectionMap } from "../PluginConnectionMap.js"
import type { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"
import type { PluginRuntimeAuthority } from "./PluginRuntimeAuthority.js"
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.js"

/** Value-equality cache key preventing connection-ID aliasing across workspaces. */
export class PluginRuntimeKey extends Data.Class<PluginRuntimeScope> {}

/** Canonical value-equality key for public and internal registry projections. */
export const pluginRuntimeKey = (scope: PluginRuntimeScope): PluginRuntimeKey => new PluginRuntimeKey(scope)

const lookupPluginRuntime = (
  scope: PluginRuntimeKey
): Layer.Layer<
  PluginConnection | AuthorizedPluginExecutor | PluginRuntimeAuthority,
  PluginFailure,
  PluginRuntimeRegistry
> => Layer.unwrap(Effect.map(PluginRuntimeRegistry, (registry) => registry.layer(scope)))

/** Shared scoped runtime cache used by the separately projected public and internal facades. */
export class PluginRuntimeMap extends LayerMap.Service<PluginRuntimeMap>()(
  "@knpkv/control-center/internal/PluginRuntimeMap",
  {
    lookup: lookupPluginRuntime,
    idleTimeToLive: "5 minutes"
  }
) {}

/** Public read-only projection over the internal shared runtime cache. */
export const PluginConnectionMapLive = Layer.effect(
  PluginConnectionMap,
  Effect.map(PluginRuntimeMap, (runtimeMap) => ({
    contextEffect: (scope: PluginRuntimeScope) =>
      Effect.map(
        runtimeMap.contextEffect(pluginRuntimeKey(scope)),
        (context) => Context.make(PluginConnection, Context.get(context, PluginConnection))
      ),
    invalidate: (scope: PluginRuntimeScope) => runtimeMap.invalidate(pluginRuntimeKey(scope))
  }))
)
