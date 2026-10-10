/**
 * Which agents just started needing you, from one directory poll to the next.
 *
 * **Mental model**
 *
 * - **An arrival is a transition, never a state.** An agent arrives when it needs you now and didn't on the
 *   previous poll: it moved into the needs-you bucket, or it appeared already needing you. The creature turns
 *   to you once for it; on every later poll it just keeps its halo.
 * - **The first list is history.** Nothing arrives on the first poll a surface sees, so opening Connect never
 *   makes every waiting agent lean at once.
 *
 * @module
 */
import { type AgentBucket, agentStatePresentation } from "./agent-state.js"
import type { ConnectAgent } from "./model.js"
import { connectAgentKey } from "./view.js"

/** Each agent's bucket on a poll, by `connectAgentKey`. */
export type AgentBuckets = ReadonlyMap<string, AgentBucket>

/** The buckets of one poll. */
export const agentBucketsOf = (agents: ReadonlyArray<ConnectAgent>): AgentBuckets =>
  new Map(agents.map((agent) => [connectAgentKey(agent), agentStatePresentation(agent.state).bucket]))

/**
 * The agents that started needing you between `previous` and `current`. `previous` is null before the first
 * poll, and then nothing arrives.
 */
export const arrivalsBetween = (previous: AgentBuckets | null, current: AgentBuckets): ReadonlySet<string> => {
  if (previous === null) return new Set()
  return new Set(
    [...current].flatMap(([key, bucket]) => (bucket === "needs-you" && previous.get(key) !== "needs-you" ? [key] : []))
  )
}
