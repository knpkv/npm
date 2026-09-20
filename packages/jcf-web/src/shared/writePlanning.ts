import type { CreditedBlock } from "@knpkv/jira-clockify/agent/sessions.js"
import { Data } from "effect"
import type { ProposalBlockResponse } from "./contracts.js"

class MissingProjectedConsumptionError extends Data.TaggedError("MissingProjectedConsumptionError")<{}> {}

/** Use only the server-projected consumption for the same block objects given to the planner. */
export const consumedFromWeekBlocks = (blocks: ReadonlyArray<ProposalBlockResponse>) => {
  const byBlock = new Map(blocks.map((block): readonly [CreditedBlock, ProposalBlockResponse["consumed"]] => [
    block,
    block.consumed
  ]))
  return (block: CreditedBlock, source: "clockify" | "jira"): number => {
    const consumed = byBlock.get(block)
    if (consumed === undefined) throw new MissingProjectedConsumptionError()
    return consumed[source]
  }
}

/** Compatibility exports; the engine owns confirmation planning for every caller. */
export {
  MINIMUM_WRITE_SECONDS,
  prepareProposal,
  type ProposedWrite,
  proposeWrite,
  selectedBlocks
} from "@knpkv/jira-clockify/agent/writePlanning.js"
