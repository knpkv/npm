import type { RlyIconName } from "@knpkv/rly/foundations"
import type { RlyStateTone } from "@knpkv/rly/primitives"

/** How an agent card shows a herdr agent state: its own icon and tone, with the state's word beside it. */
export type AgentStatePresentation = {
  readonly icon: RlyIconName
  readonly spins: boolean
  readonly tone: RlyStateTone
}

/**
 * Group herdr's free-form agent states the way Connect does. Only work in progress moves; every
 * settled state is a distinct static icon, so the state never rests on colour alone.
 */
export const agentStatePresentation = (status: string): AgentStatePresentation => {
  switch (status.toLocaleLowerCase("en-US")) {
    case "running":
    case "working":
      return { icon: "loader", spins: true, tone: "progress" }
    case "idle":
    case "waiting":
    case "ready":
      return { icon: "minus", spins: false, tone: "neutral" }
    case "done":
      return { icon: "check", spins: false, tone: "positive" }
    default:
      // blocked, unknown, and anything herdr adds later: needs a look.
      return { icon: "alert", spins: false, tone: "caution" }
  }
}
