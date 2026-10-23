import { Context, type Effect, Schema } from "effect"

/** The budget action's deny-all SCP could not be detached. */
export class BudgetLiftFailed extends Schema.TaggedError<BudgetLiftFailed>()("BudgetLiftFailed", {
  accountId: Schema.String,
  detail: Schema.String
}) {}

/**
 * Detaches the budget action's deny-all SCP from a pool account. Approval-gated by `sandbox.budget.lift`.
 * Must be idempotent: a policy that is already detached is success, so a rerun after a partial lift
 * converges instead of failing.
 */
export class BudgetControl extends Context.Service<
  BudgetControl,
  { readonly lift: (accountId: string) => Effect.Effect<void, BudgetLiftFailed> }
>()("SandboxPool/BudgetControl") {}
