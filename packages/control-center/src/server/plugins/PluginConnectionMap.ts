import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"

import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import type { PluginFailure } from "./failures.js"
import type { PluginConnection } from "./PluginConnection.js"

/** Workspace-scoped configured runtime identity. */
export interface PluginRuntimeScope {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
}

/** Public projection of one cached runtime; no executor service can escape this context. */
export interface PluginConnectionMapV1 {
  readonly contextEffect: (
    scope: PluginRuntimeScope
  ) => Effect.Effect<Context.Context<PluginConnection>, PluginFailure, Scope.Scope>
  readonly invalidate: (scope: PluginRuntimeScope) => Effect.Effect<void>
}

/** Scoped connection registry backed by a shared, idle-evicted runtime map. */
export class PluginConnectionMap extends Context.Service<PluginConnectionMap, PluginConnectionMapV1>()(
  "@knpkv/control-center/PluginConnectionMap"
) {}
