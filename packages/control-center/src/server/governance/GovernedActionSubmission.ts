/** Identity-only submission ports implemented by private server composition. @module */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { Role } from "../../domain/actors.js"
import type { GovernedActionPolicyBinding } from "../../domain/governedAction/index.js"
import type { GovernedActionId, PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"

/** Private execution is disabled or cannot advance the requested durable identity. */
export class GovernedActionSubmissionUnavailable extends Schema.TaggedErrorClass<GovernedActionSubmissionUnavailable>()(
  "GovernedActionSubmissionUnavailable",
  {}
) {}

/** Safe identity-only signal into the private governed-action worker. */
export class GovernedActionSubmission extends Context.Service<
  GovernedActionSubmission,
  {
    readonly advance: (reference: {
      readonly workspaceId: WorkspaceId
      readonly actionId: GovernedActionId
    }) => Effect.Effect<void, GovernedActionSubmissionUnavailable>
  }
>()("@knpkv/control-center/server/governance/GovernedActionSubmission") {}

/**
 * Database-only proposal commit boundary that verifies one exact runtime generation.
 * Provider, filesystem, and network effects must remain outside the callback.
 */
export class GovernedActionProposalAuthority extends Context.Service<
  GovernedActionProposalAuthority,
  {
    readonly transactCurrent: <Success, Failure, Requirements>(
      input: {
        readonly workspaceId: WorkspaceId
        readonly pluginConnectionId: PluginConnectionId
        readonly runtimeAuthorityToken: string
      },
      use: () => Effect.Effect<Success, Failure, Requirements>
    ) => Effect.Effect<
      Success,
      Failure | GovernedActionSubmissionUnavailable,
      Requirements
    >
  }
>()("@knpkv/control-center/server/governance/GovernedActionProposalAuthority") {}

/** Current server-owned policy binding used when constructing immutable proposals. */
export class GovernedActionPolicyBindingSource extends Context.Service<
  GovernedActionPolicyBindingSource,
  {
    readonly current: Effect.Effect<GovernedActionPolicyBinding, GovernedActionSubmissionUnavailable>
    readonly forPermission: (
      requiredPermission: Role
    ) => Effect.Effect<GovernedActionPolicyBinding, GovernedActionSubmissionUnavailable>
  }
>()("@knpkv/control-center/server/governance/GovernedActionPolicyBindingSource") {}
