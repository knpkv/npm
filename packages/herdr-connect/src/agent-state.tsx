/**
 * The one state language for agents, shared by Connect's directory and the hub. Each herdr agent
 * state maps to a word, an icon, a tone, whether it moves, and the Status filter bucket it counts in.
 * Rows and filters read only this module, so a row never looks idle while its filter says it needs you.
 *
 * Only work in progress moves (and only with motion allowed); every settled state has a still,
 * distinct icon, so the state never rests on colour alone.
 *
 * @module
 */
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { agentStatePresentation } from "./agent-state-core.js"

export {
  agentBuckets,
  agentBucketLabel,
  agentStageLead,
  agentStatePresentation,
  type AgentBucket,
  type AgentStatePresentation
} from "./agent-state-core.js"

/** An agent's state as its icon and word, in the state's tone. */
export const AgentStateLabel = ({
  className,
  state,
  statePolicy = "fleet"
}: {
  readonly className?: string
  readonly state: string
  /** Fleet by default; Home uses neutral Done and names unknown evidence without the needs-you bucket. */
  readonly statePolicy?: "fleet" | "home"
}): ReactElement => {
  const presentation = agentStatePresentation(state, statePolicy)
  const classes = [presentation.spins ? "agent-state-spinning" : undefined, className].filter(
    (name) => name !== undefined
  )
  return (
    <StateLabel
      className={classes.length === 0 ? undefined : classes.join(" ")}
      icon={presentation.icon}
      label={presentation.word}
      size="compact"
      tone={presentation.tone}
    />
  )
}
