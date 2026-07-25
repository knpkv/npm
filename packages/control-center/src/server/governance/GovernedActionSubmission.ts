/** Identity-only submission ports implemented by private server composition. @module */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { GovernedActionPolicyBinding } from "../../domain/governedAction/index.js"
import type { GovernedActionId, WorkspaceId } from "../../domain/identifiers.js"

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

/** Current server-owned policy binding used when constructing immutable proposals. */
export class GovernedActionPolicyBindingSource extends Context.Service<
  GovernedActionPolicyBindingSource,
  {
    readonly current: Effect.Effect<GovernedActionPolicyBinding, GovernedActionSubmissionUnavailable>
  }
>()("@knpkv/control-center/server/governance/GovernedActionPolicyBindingSource") {}
