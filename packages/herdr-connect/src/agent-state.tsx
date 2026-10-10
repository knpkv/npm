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
import type { RlyIconName } from "@knpkv/rly/foundations"
import { type RlyStateTone, StateLabel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

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
export const agentStatePresentation = (state: string): AgentStatePresentation => {
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
    default:
      return { bucket: "needs-you", icon: "alert", spins: false, tone: "caution", word: capitalised(state) }
  }
}

/**
 * What an agent's stage says before its work, in the state's fixed words: "Working on" a working agent's
 * work, "Waiting for you" when it waits on a person. A stale directory says when the state was last seen.
 */
export const agentStageLead = (state: string, stale: boolean): string => {
  const presentation = agentStatePresentation(state)
  if (stale) return `Last seen ${presentation.word.toLocaleLowerCase("en-US")}`
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

/** An agent's state as its icon and word, in the state's tone. */
export const AgentStateLabel = ({
  className,
  state
}: {
  readonly className?: string
  readonly state: string
}): ReactElement => {
  const presentation = agentStatePresentation(state)
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
