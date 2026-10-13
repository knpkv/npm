/**
 * The one state language for agents, shared by Connect's directory and the hub. Each herdr agent
 * state maps to a word, an icon, a tone, whether it moves, and the Status filter bucket it counts in.
 * Rows and filters read this module with an explicit Fleet, Home or push policy for incomplete evidence.
 *
 * Only work in progress moves (and only with motion allowed); every settled state has a still,
 * distinct icon, so the state never rests on colour alone.
 *
 * @module
 */
import type { RlyIconName } from "@knpkv/rly/foundations"
import type { RlyStateTone } from "@knpkv/rly/primitives"

/** The Status filter's buckets, in the order the filter lists them. */
export type AgentBucket = "working" | "needs-you" | "ready" | "finished"

export const agentBuckets: ReadonlyArray<AgentBucket> = ["working", "needs-you", "ready", "finished"]

export interface AgentStatePresentation {
  readonly word: string
  readonly icon: RlyIconName
  readonly tone: RlyStateTone
  readonly spins: boolean
  readonly bucket: AgentBucket
}

const capitalised = (state: string): string =>
  state.length === 0 ? "Unknown" : `${state.charAt(0).toLocaleUpperCase("en-US")}${state.slice(1)}`

/**
 * An agent state, case-insensitively. `waiting` waits on a person, so it needs you rather than
 * reading as idle. An unknown or new state keeps its own word and asks for a look.
 */
const knownAgentStatePresentation = (state: string): AgentStatePresentation | null => {
  switch (state.toLocaleLowerCase("en-US")) {
    case "running":
      return { bucket: "working", icon: "loader", spins: true, tone: "progress", word: "Running" }
    case "working":
      return { bucket: "working", icon: "loader", spins: true, tone: "progress", word: "Working" }
    case "waiting":
      return { bucket: "needs-you", icon: "clock", spins: false, tone: "caution", word: "Waiting" }
    case "blocked":
      return { bucket: "needs-you", icon: "alert", spins: false, tone: "critical", word: "Blocked" }
    case "error":
      return { bucket: "needs-you", icon: "alert", spins: false, tone: "critical", word: "Error" }
    case "ready":
      return { bucket: "ready", icon: "minus", spins: false, tone: "neutral", word: "Ready" }
    case "idle":
      return { bucket: "ready", icon: "minus", spins: false, tone: "neutral", word: "Idle" }
    case "done":
      return { bucket: "finished", icon: "check", spins: false, tone: "positive", word: "Done" }
    case "needs-you":
      return { bucket: "needs-you", icon: "alert", spins: false, tone: "caution", word: capitalised(state) }
    default:
      return null
  }
}

/** Known states share their UI bucket with background consumers; unknown/new states return null as incomplete evidence. */
export const agentStateBucket = (state: string): AgentBucket | null =>
  knownAgentStatePresentation(state)?.bucket ?? null

export type ConnectAgentGroup = AgentBucket | "unknown"

/**
 * Fleet retains its unknown-state safety fallback. Home names incomplete evidence explicitly;
 * an offline host's remembered state cannot claim that its agent currently needs a person.
 */
export function connectAgentGroup(
  state: string,
  context: { readonly presentation: "fleet"; readonly offline?: boolean }
): AgentBucket
export function connectAgentGroup(
  state: string,
  context: { readonly presentation: "fleet" | "home" | "push"; readonly offline?: boolean }
): ConnectAgentGroup
export function connectAgentGroup(
  state: string,
  context: { readonly presentation: "fleet" | "home" | "push"; readonly offline?: boolean }
): ConnectAgentGroup {
  if (context.presentation === "home" && context.offline === true) return "unknown"
  return knownAgentStatePresentation(state)?.bucket ?? (context.presentation === "fleet" ? "needs-you" : "unknown")
}

type HomeStatePresentation = Omit<AgentStatePresentation, "bucket"> & { readonly bucket: ConnectAgentGroup }

/** Home names unknown evidence and settled Done neutrally; Fleet keeps its existing safety and success tones. */
export function agentStatePresentation(state: string, policy?: "fleet"): AgentStatePresentation
export function agentStatePresentation(state: string, policy: "home"): HomeStatePresentation
export function agentStatePresentation(state: string, policy: "fleet" | "home"): HomeStatePresentation
export function agentStatePresentation(state: string, policy: "fleet" | "home" = "fleet"): HomeStatePresentation {
  const known = knownAgentStatePresentation(state)
  if (known !== null) return policy === "home" && known.word === "Done" ? { ...known, tone: "neutral" } : known
  return {
    bucket: connectAgentGroup(state, { presentation: policy }),
    icon: "alert",
    spins: false,
    tone: "caution",
    word: capitalised(state)
  }
}

/**
 * What an agent's stage says before its work, in the state's fixed words: "Working on" a working agent's
 * work, "Waiting for you" when it waits on a person. A stale directory names the last state it knew.
 */
export const agentStageLead = (state: string, stale: boolean): string => {
  const presentation = agentStatePresentation(state)
  if (stale) return `Last known: ${presentation.word}`
  switch (presentation.bucket) {
    case "working":
      return "Working on"
    case "needs-you":
      return presentation.icon === "clock" ? "Waiting for you" : presentation.word
    case "ready":
      return "Ready"
    case "finished":
      return "Done"
  }
}

/** The Status filter's name for a bucket. */
export const agentBucketLabel = (bucket: AgentBucket): string => {
  switch (bucket) {
    case "working":
      return "Working"
    case "needs-you":
      return "Needs you"
    case "ready":
      return "Ready"
    case "finished":
      return "Finished"
  }
}
