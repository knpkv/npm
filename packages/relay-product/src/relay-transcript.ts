/**
 * A conversation's state as rly's transcript shows it.
 *
 * **Mental model**
 *
 * - **In the order it happened.** Each message, then the tool work that came after it as one activity burst,
 *   then the next message. A burst sits after the message its first call followed, so text before a tool and
 *   the reply after it read in order.
 * - **Waiting messages say so.** A queued message shows as yours, with a note that it waits for the run in
 *   flight; one another page sent shows only as the note, since this page doesn't have its text.
 * - **Every run's end is its own item** (finished, cancelled, or failed with its cause and fix), named by the
 *   run, so rly announces each once. Confirmation cards are not here: the panel shows them beside the
 *   transcript, where they can be answered.
 *
 * @module
 */
import type { RlyRelayTool, RlyRelayTranscriptItem } from "@knpkv/rly/patterns"

import type { RelayConversationState, RelayRunOutcome, RelayToolRow } from "./relay-fold.js"

const toolStatus = (row: RelayToolRow): RlyRelayTool["status"] =>
  row.state === "ok" ? "ok" : row.state === "failed" ? "failed" : "running"

/** One burst of tool work: the call's own summary when it is one, else how many there were. */
const activity = (rows: ReadonlyArray<RelayToolRow>): ReadonlyArray<RlyRelayTranscriptItem> => {
  const first = rows[0]
  if (first === undefined) return []
  const waiting = rows.filter((row) => row.state === "awaiting-approval").length
  const work = rows.length === 1 ? first.summary : `${String(rows.length)} steps`
  const approval = waiting === 0
    ? ""
    : rows.length === 1
    ? ", waiting for approval"
    : `, ${String(waiting)} waiting for approval`
  return [{
    _tag: "Activity",
    id: `activity:${first.call}`,
    summary: `${work}${approval}`,
    tools: rows.map((row) => ({ call: row.call, status: toolStatus(row), summary: row.summary }))
  }]
}

/** How a run ended, as its own item: rly announces each id once, so every run's end is heard. */
const ended = (outcome: RelayRunOutcome): RlyRelayTranscriptItem => {
  switch (outcome._tag) {
    case "Finished":
      return { _tag: "RunFinished", id: outcome.id }
    case "Cancelled":
      return { _tag: "RunCancelled", id: outcome.id }
    case "Failed":
      return { _tag: "RunFailed", cause: outcome.cause, fix: outcome.fix, id: outcome.id }
  }
}

/** The transcript items for `state`, in the order they happened. */
export const relayTranscriptItems = (state: RelayConversationState): ReadonlyArray<RlyRelayTranscriptItem> => {
  const known = new Set(state.messages.map(({ id }) => id))
  /** The tool work, then the run ends, that came after message `id` (null: before any message). */
  const after = (id: string | null): ReadonlyArray<RlyRelayTranscriptItem> => [
    ...activity(state.tools.filter((row) => row.after === id)),
    ...state.outcomes.filter((outcome) => outcome.after === id).map(ended)
  ]
  // Work whose message a Snapshot no longer holds goes at the end, with the newest work.
  const orphaned: ReadonlyArray<RlyRelayTranscriptItem> = [
    ...activity(state.tools.filter((row) => row.after !== null && !known.has(row.after))),
    ...state.outcomes.filter((outcome) => outcome.after !== null && !known.has(outcome.after)).map(ended)
  ]
  const queued = state.queued.flatMap((message): ReadonlyArray<RlyRelayTranscriptItem> =>
    message.text === null ? [] : [{ _tag: "You", id: `queued:${message.requestId}`, text: message.text }]
  )
  const waitingNote: ReadonlyArray<RlyRelayTranscriptItem> = state.queued.length === 0
    ? []
    : [{
      _tag: "Note",
      id: "queued-note",
      text: state.queued.length === 1
        ? "1 message waits for the run in flight."
        : `${String(state.queued.length)} messages wait for the run in flight.`
    }]
  return [
    ...after(null),
    ...state.messages.flatMap((message): ReadonlyArray<RlyRelayTranscriptItem> => [
      { _tag: message.role === "user" ? "You" : "Relay", id: message.id, text: message.text },
      ...after(message.id)
    ]),
    ...orphaned,
    ...queued,
    ...waitingNote
  ]
}
