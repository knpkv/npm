/** Compatibility exports; the engine owns confirmation planning for every caller. */
export {
  MINIMUM_WRITE_SECONDS,
  prepareProposal,
  type ProposedWrite,
  proposeWrite,
  selectedBlocks
} from "@knpkv/jira-clockify/agent/writePlanning.js"
