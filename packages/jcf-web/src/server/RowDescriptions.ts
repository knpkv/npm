/** Row-level suggestions use only the evidence and title retained by a scan. */
import type { ConfigService, ReconcileService } from "@knpkv/jira-clockify"
import type { SessionAgentSettings } from "@knpkv/jira-clockify/agent/agentSettings.js"
import { Cache, Effect, Exit } from "effect"
import { ApiError, PlanExpiredError } from "../shared/contracts.js"
import type { HeldPlan } from "./WeekPlan.js"

export const agentSettingsKey = (settings: SessionAgentSettings): string =>
  JSON.stringify([settings.provider, settings.model, settings.effort])

export interface DescriptionKey {
  readonly rowId: string
  readonly settings: string
  readonly revision: number
}

/** One cache per retained scan; concurrent selections share the same prompt-only operation. */
export const makeRowDescriptions = Effect.fn("RowDescriptions.make")(function*(options: {
  readonly plan: Effect.Effect<HeldPlan | undefined>
  readonly config: Pick<ConfigService.ConfigServiceContract, "get">
  readonly reconcile: Pick<ReconcileService.ReconcileServiceContract, "describeProposals">
  readonly revision: Effect.Effect<number>
}) {
  const lookup = Effect.fn("RowDescriptions.lookup")(function*(key: DescriptionKey) {
    const plan = yield* options.plan
    const evidence = plan?.evidence.get(key.rowId)
    if (plan === undefined || evidence === undefined) {
      return yield* new PlanExpiredError({ message: "That row is not part of this week — reload it" })
    }
    const unchanged = Effect.gen(function*() {
      const settings = (yield* options.config.get).sessionAgent
      if (agentSettingsKey(settings) !== key.settings || (yield* options.revision) !== key.revision) {
        return yield* new ApiError({ message: "Agent settings changed while generating the description. Retry." })
      }
    })
    yield* unchanged
    const title = plan.ownership.facts.get(evidence.proposal.ticketKey)?.title
    let unavailable: string | null = null
    const notes = yield* options.reconcile.describeProposals({
      proposals: [evidence.proposal],
      digests: plan.report.digests,
      summaries: new Map(title == null ? [] : [[evidence.proposal.ticketKey, title]]),
      onUnavailable: (message) =>
        Effect.sync(() => {
          unavailable = message
        })
    })
    // The engine reads its own config per call. Reject any result crossing a settings update,
    // including a change away and back through HTTP, instead of storing it under an earlier key.
    yield* unchanged
    if (unavailable !== null) {
      return yield* new ApiError({ message: `Could not generate the description: ${unavailable}. Retry.` })
    }
    return notes[0] ?? null
  })
  return yield* Cache.makeWith(lookup, {
    capacity: 512,
    timeToLive: (exit) => Exit.isSuccess(exit) ? Infinity : 0
  })
})
