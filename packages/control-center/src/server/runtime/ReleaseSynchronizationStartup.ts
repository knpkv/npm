import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { ReleaseId } from "../../domain/identifiers.js"
import {
  type ReleaseSynchronizationFailure,
  type ReleaseSynchronizationInput,
  type ReleaseSynchronizationOutcome,
  synchronizeFakeReleaseFromMap
} from "../application/releaseSynchronization.js"
import { Persistence, type PersistenceOperationFailure } from "../persistence/Persistence.js"
import { PluginConnectionMap, type PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { ControlCenterBootstrap } from "./Bootstrap.js"

/** Explicit configured startup synchronization; absent options keep normal runtime startup inert. */
export interface ReleaseSynchronizationStartupOptions {
  readonly input: ReleaseSynchronizationInput
  readonly pluginConnections: PluginConnectionMapV1
}

/** Bounded startup configuration mismatch that must be fixed before listening. */
export class ReleaseSynchronizationStartupConfigurationError extends Schema.TaggedErrorClass<
  ReleaseSynchronizationStartupConfigurationError
>()("ReleaseSynchronizationStartupConfigurationError", {
  diagnosticCode: Schema.Literals([
    "bootstrap-disabled",
    "workspace-mismatch"
  ])
}) {}

/** Startup synchronization state retained for diagnostics and runtime tests. */
export type ReleaseSynchronizationStartupState =
  | { readonly _tag: "disabled" }
  | { readonly _tag: "connection-disabled" }
  | { readonly _tag: "completed"; readonly outcome: ReleaseSynchronizationOutcome }

/** Startup synchronization result, available only inside the server composition. */
export class ReleaseSynchronizationStartup extends Context.Service<
  ReleaseSynchronizationStartup,
  ReleaseSynchronizationStartupState
>()("@knpkv/control-center/server/runtime/ReleaseSynchronizationStartup") {}

export type ReleaseSynchronizationStartupError =
  | PersistenceOperationFailure
  | ReleaseSynchronizationFailure
  | ReleaseSynchronizationStartupConfigurationError

const makeReleaseSynchronizationStartup = Effect.fn(
  "ReleaseSynchronizationStartup.make"
)(function*(options: ReleaseSynchronizationStartupOptions) {
  const bootstrap = yield* ControlCenterBootstrap
  if (bootstrap._tag === "disabled") {
    return yield* new ReleaseSynchronizationStartupConfigurationError({
      diagnosticCode: "bootstrap-disabled"
    })
  }
  if (bootstrap.workspaceId !== options.input.workspaceId) {
    return yield* new ReleaseSynchronizationStartupConfigurationError({
      diagnosticCode: "workspace-mismatch"
    })
  }
  const persistence = yield* Persistence
  const connection = yield* persistence.pluginConnections.get(
    options.input.workspaceId,
    options.input.pluginConnectionId
  )
  if (!connection.isEnabled) {
    return { _tag: "connection-disabled" } satisfies ReleaseSynchronizationStartupState
  }
  const outcome = yield* synchronizeFakeReleaseFromMap(options.input).pipe(
    Effect.provideService(PluginConnectionMap, options.pluginConnections)
  )
  return { _tag: "completed", outcome } satisfies ReleaseSynchronizationStartupState
})

/** Build the ordered optional startup service after workspace bootstrap. */
export const releaseSynchronizationStartupLayer = (
  options: ReleaseSynchronizationStartupOptions | null
): Layer.Layer<
  ReleaseSynchronizationStartup,
  ReleaseSynchronizationStartupError,
  ControlCenterBootstrap | Persistence
> =>
  options === null
    ? Layer.succeed(ReleaseSynchronizationStartup, { _tag: "disabled" })
    : Layer.effect(ReleaseSynchronizationStartup, makeReleaseSynchronizationStartup(options))

/** Read the projected release identity without exposing provider runtime internals. */
export const releaseIdFromStartupState = (
  state: ReleaseSynchronizationStartupState
): ReleaseId | null => state._tag === "completed" ? state.outcome.releaseId : null
