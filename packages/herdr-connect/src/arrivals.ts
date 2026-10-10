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
 * - **A silent host is not a fresh start.** A host that missed a poll keeps the buckets it last reported
 *   ({@link nextAgentBuckets}), so when it answers again its agents that were already waiting do not arrive
 *   again, however often it flaps.
 *
 * @module
 */
import { type AgentBucket, agentStatePresentation } from "./agent-state.js"
import type { ConnectAgent } from "./model.js"
import { connectAgentKey } from "./view.js"

/** One agent's bucket on a poll, with the host that reported it. */
export interface AgentBucketEntry {
  readonly host: string
  readonly bucket: AgentBucket
}

/** Each agent's bucket on a poll, by `connectAgentKey`. */
export type AgentBuckets = ReadonlyMap<string, AgentBucketEntry>

/** The buckets of one poll. */
export const agentBucketsOf = (agents: ReadonlyArray<ConnectAgent>): AgentBuckets =>
  new Map(
    agents.map((agent) => [
      connectAgentKey(agent),
      { bucket: agentStatePresentation(agent.state).bucket, host: agent.host }
    ])
  )

/**
 * What the next poll compares against: this poll's buckets, plus the last known buckets of every host that
 * didn't answer it.
 */
export const nextAgentBuckets = (
  previous: AgentBuckets | null,
  current: AgentBuckets,
  silentHosts: ReadonlySet<string>
): AgentBuckets => {
  if (previous === null || silentHosts.size === 0) return current
  const carried = [...previous].filter(([key, entry]) => silentHosts.has(entry.host) && !current.has(key))
  return new Map([...carried, ...current])
}

/**
 * The agents that started needing you between `previous` and `current`. `previous` is null before the first
 * poll, and then nothing arrives.
 */
export const arrivalsBetween = (previous: AgentBuckets | null, current: AgentBuckets): ReadonlySet<string> => {
  if (previous === null) return new Set()
  return new Set(
    [...current].flatMap(([key, entry]) =>
      entry.bucket === "needs-you" && previous.get(key)?.bucket !== "needs-you" ? [key] : []
    )
  )
}
