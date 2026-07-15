import * as Context from "effect/Context"
import type * as Layer from "effect/Layer"

import type { PluginFailure } from "../failures.js"
import type { PluginConnection } from "../PluginConnection.js"
import type { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"
import type { PluginRuntimeAuthority } from "./PluginRuntimeAuthority.js"
import type { PluginRuntimeKey } from "./PluginRuntimeMap.js"

/**
 * Internal factory registry for the fixed first-party plugin catalog.
 * Every layer must bind `PluginRuntimeAuthority` to a canonical token that changes with
 * connection revision, configuration, credential generation, negotiated adapter, or account.
 */
export interface PluginRuntimeRegistryV1 {
  readonly layer: (
    scope: PluginRuntimeKey
  ) => Layer.Layer<PluginConnection | AuthorizedPluginExecutor | PluginRuntimeAuthority, PluginFailure>
}

/** Internal runtime registry; it is deliberately absent from every package barrel. */
export class PluginRuntimeRegistry extends Context.Service<PluginRuntimeRegistry, PluginRuntimeRegistryV1>()(
  "@knpkv/control-center/internal/PluginRuntimeRegistry"
) {}
