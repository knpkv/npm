/**
 * What Relay is doing, for its mark and one status line, read from a conversation's folded state.
 *
 * **Mental model**
 *
 * - **Status is a view of state, never of events.** {@link relayStatusOf} reads the client's
 *   {@link RelayConversationState}, so a late reader or a reconnect shows the current status with no
 *   one-shot replays: a Snapshot that restores a finished run is not a new reply.
 * - **Words are fixed; the only free text is a tool's own summary.** The status line is a phase word
 *   ("Reading…", "Answering…", "Working…", "Sending…", "Relay needs you", "Relay replied") or the running tool's server-built,
 *   display-safe summary, capped at {@link RELAY_STATUS_LINE_MAX}. Reply text, queued or sent message
 *   text, failure detail and the confirmation's action never reach it.
 * - **Unread is the reader's fact, not Relay's.** A reply is unread when more replies have finished than
 *   the reader could see the last time the panel was open. A reply is a turn: a run of consecutive relay
 *   messages. Live, the client joins a turn's text into one message; a reconnect's Snapshot lists one per
 *   stored entry, so text split by a tool call or a dropped stream is two. Counting turns makes both agree,
 *   and counting rather than naming one ignores that the two carry different ids. The count starts from
 *   the first live state, so history loaded on mount is never unread.
 *
 * @module
 */
import type { RlyRelayMarkActivity } from "@knpkv/rly/patterns"

import type { RelayConversationState } from "./relay-fold.js"

/** The longest tool summary the status line shows; a longer one is cut with an ellipsis. */
export const RELAY_STATUS_LINE_MAX = 80

/** Relay's mark and status words for one conversation. */
export interface RelayStatusView {
  readonly activity: RlyRelayMarkActivity
  /** The phase in words, or null when there is nothing to say (idle, connecting). */
  readonly words: string | null
  /** The running tool's own summary under the words ("Reading 12 files"), or null. */
  readonly line: string | null
}

/** How many replies the reader could see: unknown until the conversation first goes live. */
export type RelaySeenReplies =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Seen"; readonly count: number }

/** Where a surface starts: nothing seen yet, and nothing unread until the conversation is live. */
export const relaySeenRepliesUnknown: RelaySeenReplies = { _tag: "Unknown" }

const quiet: RelayStatusView = { activity: "idle", line: null, words: null }
const said = (activity: RlyRelayMarkActivity, words: string, line: string | null = null): RelayStatusView => ({
  activity,
  line,
  words
})

/** The summary on one line, cut by code points (never inside a surrogate pair) with an ellipsis. */
const lineOf = (summary: string): string | null => {
  const points = Array.from(summary.trim().replace(/\s+/gu, " "))
  if (points.length === 0) return null
  return points.length <= RELAY_STATUS_LINE_MAX
    ? points.join("")
    : `${points.slice(0, RELAY_STATUS_LINE_MAX - 1).join("").trimEnd()}…`
}

/**
 * How many of Relay's replies have finished: runs of consecutive relay messages, none still streaming. The
 * last turn counts only once no run is in flight: text before a tool call can stop streaming while the run
 * that will add to the same turn is still going.
 */
export const finishedReplies = (state: RelayConversationState): number => {
  let turns = 0
  let open = false
  let streaming = false
  for (const message of state.messages) {
    if (message.role === "relay") {
      open = true
      streaming ||= message.streaming
    } else {
      if (open && !streaming) turns += 1
      open = false
      streaming = false
    }
  }
  return open && !streaming && state.runIds.length === 0 ? turns + 1 : turns
}

/**
 * The replies the reader could see after this state: every finished reply while the panel is open, the
 * conversation's history the first time it is live, else what it was. Returns `seen` itself when the
 * count is unchanged, so a caller holding it in React state can compare by identity.
 */
export const nextSeenReplies = (
  seen: RelaySeenReplies,
  state: RelayConversationState,
  panelOpen: boolean
): RelaySeenReplies => {
  if (!panelOpen && !(seen._tag === "Unknown" && state.connection === "live")) return seen
  const count = finishedReplies(state)
  return seen._tag === "Seen" && seen.count === count ? seen : { _tag: "Seen", count }
}

/** Relay's status for a conversation, given whether the panel is open and the replies the reader saw. */
export const relayStatusOf = (
  state: RelayConversationState,
  view: { readonly panelOpen: boolean; readonly seen: RelaySeenReplies }
): RelayStatusView => {
  switch (state.connection) {
    case "disconnected":
    case "failed":
      return said("idle", "Relay status unknown")
    case "unauthorized":
      return said("idle", "Sign in to use Relay")
    case "connecting":
    case "live":
      break
  }
  if (state.confirmations.some((card) => card.decision === "pending")) return said("attention", "Relay needs you")
  if (state.runIds.length > 0) {
    const tool = [...state.tools].reverse().find((row) => row.state === "running")
    if (tool !== undefined) return said("working", "Reading…", lineOf(tool.summary))
    if (state.messages.at(-1)?.streaming === true) return said("working", "Answering…")
    // A run with no tool and no text yet: Relay is working on it, not reading anything named.
    return said("working", "Working…")
  }
  // Queued only: the outbox keeps a send whose request failed so a retry has its text, and one never retried
  // must not read as Relay working forever.
  if (state.queued.length > 0) return said("working", "Sending…")
  if (state.failure !== null) {
    const backend = state.backend
    return backend?._tag === "Unavailable" && backend.cause === "SignedOut"
      ? said("idle", `Sign in to ${backend.label}`)
      : said("idle", "Relay hit an error")
  }
  if (!view.panelOpen && view.seen._tag === "Seen" && finishedReplies(state) > view.seen.count) {
    return said("unread", "Relay replied")
  }
  return quiet
}
