/** Current durable workspace policy used immediately before agent execution. @module */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type { WorkspaceSettingsV1 } from "../../../domain/workspaceSettings.js"
import { Persistence, type PersistenceOperationFailure } from "../../persistence/Persistence.js"

type AgentSettings = typeof WorkspaceSettingsV1.Type["agent"]

/** Minimal policy reader kept separate from provider selection and job persistence. */
export class AgentJobWorkspacePolicy extends Context.Service<AgentJobWorkspacePolicy, {
  readonly read: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<AgentSettings, PersistenceOperationFailure>
}>()("@knpkv/control-center/server/agent/internal/AgentJobWorkspacePolicy") {
  /** Live policy reader over durable workspace settings. */
  static readonly live: Layer.Layer<AgentJobWorkspacePolicy, never, Persistence> = Layer.effect(
    AgentJobWorkspacePolicy,
    Effect.map(Persistence, (persistence) =>
      AgentJobWorkspacePolicy.of({
        read: (workspaceId) =>
          persistence.workspaceSettings.get(workspaceId).pipe(
            Effect.map(({ settings }) => settings.agent)
          )
      }))
  )
}
