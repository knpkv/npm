/**
 * The plans this process still holds.
 *
 * A confirmation names a row of a plan rather than carrying its own evidence, so the evidence has to
 * live somewhere between the read and the write. Here, in memory, for a bounded number of recent
 * weeks: paging back and forth then confirming a row from either week works, and a plan from an hour
 * ago has fallen out — by which time re-reading is the honest thing to do anyway, because a watch or
 * the CLI may have written since.
 *
 * Deliberately not persisted. Held evidence is a convenience, never a source of truth: every write
 * re-reads what Jira and Clockify hold, so losing a plan costs a page reload and nothing else.
 *
 * @module
 */
import { Context, Effect, Layer, Ref } from "effect"
import type { HeldPlan } from "./WeekPlan.js"

/** Weeks kept at once. Enough for stepping back through a month one week at a time. */
const RETAINED_PLANS = 6

export interface WeekPlansContract {
  readonly nextPlanId: Effect.Effect<string>
  readonly keep: (plan: HeldPlan) => Effect.Effect<void>
  readonly find: (planId: string) => Effect.Effect<HeldPlan | undefined>
}

export class WeekPlans extends Context.Service<WeekPlans, WeekPlansContract>()("@knpkv/jcf-web/WeekPlans") {}

export const layer = Layer.effect(
  WeekPlans,
  Effect.gen(function*() {
    const plans = yield* Ref.make<ReadonlyArray<HeldPlan>>([])
    return WeekPlans.of({
      find: (planId) => Ref.get(plans).pipe(Effect.map((held) => held.find((plan) => plan.planId === planId))),
      keep: (plan) =>
        Ref.update(plans, (held) =>
          [
            plan,
            // Re-reading the same week replaces its plan rather than filling the window with copies.
            ...held.filter((existing) => existing.planId !== plan.planId && existing.plan.monday !== plan.plan.monday)
          ].slice(0, RETAINED_PLANS)),
      nextPlanId: Effect.sync(() => crypto.randomUUID())
    })
  })
)
