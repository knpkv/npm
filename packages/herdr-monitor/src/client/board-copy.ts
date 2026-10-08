/**
 * What the board says, as plain data: the one-fact line, the state words, card facts and the
 * connection line. Rendering lives in `main.ts`; everything here is a pure function of a snapshot.
 *
 * @module
 */
import type { AgentStatus } from "../model.js"

type Agent = AgentStatus

/** Sentence-case word for each published state; the card leads with it, in its state ink. */
export const stateWord = {
  working: "Working",
  blocked: "Blocked",
  idle: "Idle",
  done: "Done",
  unknown: "Unknown"
} satisfies Record<Agent["state"], string>

/** `45m`, or `1h 30m` once an hour has passed. */
export const duration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`
}

/**
 * The board's one fact, at heading size. Blocked agents lead, by name with the first blocker;
 * otherwise who is working; otherwise that nothing is running.
 */
export const headline = (agents: ReadonlyArray<Agent>): string => {
  const blocked = agents.filter((agent) => agent.state === "blocked")
  const first = blocked[0]
  if (first !== undefined) {
    const others = blocked.length - 1
    const reason = first.blocker === null ? "" : `: ${first.blocker}`
    return `${first.name} is blocked${reason}${others === 0 ? "" : `, and ${others} more`}`
  }
  const working = agents.filter((agent) => agent.state === "working").length
  // An agent that published no state is neither idle nor clear of blockers; say so instead.
  const unknown = agents.filter((agent) => agent.state === "unknown").length
  const unknownPart = `${unknown} ${unknown === 1 ? "agent has" : "agents have"} no published state`
  if (agents.length === 0) return "No agents published"
  if (working === 0) {
    const settled = agents.length - unknown
    if (unknown === 0) {
      return `Nothing running; ${agents.length} ${agents.length === 1 ? "agent is" : "agents are"} idle or done`
    }
    return settled === 0 ? unknownPart : `${unknownPart}; ${settled} idle or done`
  }
  const of = `${working} of ${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`
  return unknown === 0 ? `${of}, none blocked` : `${of}; ${unknownPart}`
}

/** `5 agents, 1 working, 1 blocked`. */
export const totals = (agents: ReadonlyArray<Agent>): string => {
  const count = (state: Agent["state"]) => agents.filter((agent) => agent.state === state).length
  return `${agents.length} ${agents.length === 1 ? "agent" : "agents"}, ${count("working")} working, ${
    count("blocked")
  } blocked`
}

/** The facts a card shows: only published values. Missing ones are named once, not as rows. */
export interface CardFacts {
  readonly known: ReadonlyArray<readonly [label: string, value: string]>
  readonly unpublished: ReadonlyArray<string>
}

export const cardFacts = (agent: Agent): CardFacts => {
  const fields: ReadonlyArray<readonly [string, string | null]> = [
    ["Jira", agent.jiraKey],
    ["Branch", agent.branch],
    ["PR", agent.pullRequest],
    ["Clockify recorded", agent.clockify === null ? null : duration(agent.clockify.seconds)],
    ["Agent elapsed", agent.elapsedSeconds === null ? null : duration(agent.elapsedSeconds)]
  ]
  return {
    known: fields.flatMap(([label, value]): ReadonlyArray<readonly [string, string]> =>
      value === null ? [] : [[label, value]]
    ),
    unpublished: fields.flatMap(([label, value]) => (value === null ? [label] : []))
  }
}

/**
 * An identifier split where a reader would break it: after `/`, `-`, `_` and `.`, and between a
 * lower-case letter or digit and the capital that starts the next word. `feat/CheckpointRecovery`
 * gives `["feat/", "Checkpoint", "Recovery"]`, so a narrow tile breaks it there, never inside a word.
 */
export const breakSegments = (value: string): ReadonlyArray<string> =>
  value.split(/(?<=[/_.-])|(?<=[a-z0-9])(?=[A-Z])/u).filter((segment) => segment !== "")

/** Card facts whose values are identifiers, which wrap at their own separators. */
export const identifierFacts: ReadonlySet<string> = new Set(["Jira", "Branch", "PR"])

/** The connection line: the state word first, then what it means and when the shown copy is from. */
export type Connection =
  | { readonly _tag: "Locked" }
  | { readonly _tag: "Opening" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Current"; readonly receivedAt: number }
  | { readonly _tag: "Stale"; readonly receivedAt: number }
  | { readonly _tag: "Offline"; readonly shownFrom: number | null }

/** 24-hour `13:05`, the clock jcf and Control Center use too. */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** The connection state's word, which leads in its tone, and the rest of the line. */
export interface ConnectionLine {
  readonly word: string
  readonly rest: string
}

export const connectionLine = (state: Connection): ConnectionLine => {
  switch (state._tag) {
    case "Locked":
      return { word: "Locked", rest: "" }
    case "Opening":
      return { word: "Opening", rest: "the board" }
    case "Waiting":
      return { word: "Waiting", rest: "for the publisher's first snapshot" }
    case "Current":
      return { word: "Current", rest: `updated ${clock(state.receivedAt)}` }
    case "Stale":
      return { word: "Stale", rest: `the publisher last updated at ${clock(state.receivedAt)}` }
    case "Offline":
      return {
        word: "Offline",
        rest: state.shownFrom === null
          ? "the monitor cannot be reached; retrying every 10 seconds"
          : `showing the snapshot from ${clock(state.shownFrom)}; retrying every 10 seconds`
      }
  }
}
