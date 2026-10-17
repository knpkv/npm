/**
 * Contracts for hosting the stacks read model inside another server, such as a Relay Hub module. Results
 * are tagged so the caller renders each outcome; none carries a provider locator or credential.
 */
import { Schema } from "effect"
import { SourceFailureReason, StackDetail, StackId, StackList } from "./api.js"
import { PlanState } from "./plan.js"

export { SourceFailureReason, StackDetail, StackId, StackList, StackSummary } from "./api.js"
export { PlanState } from "./plan.js"

/** Why the host can't read stacks at all: not configured, configured for another host, or its reader failed. */
export const StacksUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.Literals(["not_configured", "other_host", "unavailable"]),
  host: Schema.NullOr(Schema.String)
})
export type StacksUnavailable = typeof StacksUnavailable.Type

/** A read that ran and failed, with the source's reason (expired sign-in, denied, unreachable…). */
export const StacksReadFailed = Schema.TaggedStruct("Failed", { reason: SourceFailureReason })

export const StacksOverviewResult = Schema.Union([
  StacksUnavailable,
  StacksReadFailed,
  Schema.TaggedStruct("Ready", { list: StackList })
])
export type StacksOverviewResult = typeof StacksOverviewResult.Type

export const StackDetailResult = Schema.Union([
  StacksUnavailable,
  StacksReadFailed,
  Schema.TaggedStruct("Ready", { detail: StackDetail })
])
export type StackDetailResult = typeof StackDetailResult.Type

export const StackPlanResult = Schema.Union([StacksUnavailable, Schema.TaggedStruct("Ready", { plan: PlanState })])
export type StackPlanResult = typeof StackPlanResult.Type

/** The overview takes no selectors. */
export const StacksOverviewQuery = Schema.fromURLSearchParams(Schema.Struct({}))
export type StacksOverviewQuery = typeof StacksOverviewQuery.Type

/** One stack, by the process-scoped id the overview returned. */
export const StackQuery = Schema.fromURLSearchParams(Schema.Struct({ id: StackId }))
export type StackQuery = typeof StackQuery.Type
