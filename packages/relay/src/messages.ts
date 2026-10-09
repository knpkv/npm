/**
 * Which accepted message became which transcript entry, for one event subscription.
 *
 * **Mental model**
 *
 * - **A message is placed when both halves have arrived.** Pi commits a person's message as a `pi.user`
 *   entry (the text) and, later in the same batch, a submission record naming that entry (the requestId).
 *   Either order is handled, and a coalesced batch may carry the record already `done` or `unanswered`, so
 *   any input record with an entry counts.
 * - **Each entry is announced once.** Entries placed before the subscription are in its Snapshot; their
 *   later records find no text here and announce nothing.
 * - **No entry means not in the transcript.** A record without one is queued, or was withdrawn before any
 *   run took it.
 *
 * @module
 */
import { Predicate } from "effect"

export type MessageEvent =
  | { readonly _tag: "MessageQueued"; readonly requestId: string }
  | { readonly _tag: "MessagePlaced"; readonly id: string; readonly requestId: string; readonly text: string }
  | { readonly _tag: "MessageWithdrawn"; readonly requestId: string }

/** What the tracker reads of a stored message; Pi's messages fit it, and no Pi type leaves the bundle. */
export interface StoredMessage {
  readonly role: string
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

/** What the tracker reads of a committed entry. */
export interface CommittedEntry {
  readonly id: number
  readonly kind: string
  readonly model?: ReadonlyArray<StoredMessage>
}

/** What the tracker reads of a submission record. */
export interface SubmissionState {
  readonly id: number
  readonly type: "input" | "write"
  readonly status: "queued" | "placed" | "done" | "unanswered"
  readonly requestId?: string
  readonly entry?: number
}

/** The visible text of a stored user or assistant entry. */
export const entryText = (messages: ReadonlyArray<StoredMessage> | undefined): string =>
  (messages ?? [])
    .flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? Predicate.isString(message.content)
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
        : []
    )
    .join("\n")

/** One subscription's tracker: feed it each committed entry and submission record, in stream order. */
export const makeMessageTracker = () => {
  const texts = new Map<string, string>()
  const requests = new Map<string, string>()
  const announced = new Set<string>()
  const placed = (entry: string): ReadonlyArray<MessageEvent> => {
    const text = texts.get(entry)
    const requestId = requests.get(entry)
    if (text === undefined || requestId === undefined || announced.has(entry)) return []
    announced.add(entry)
    texts.delete(entry)
    requests.delete(entry)
    return [{ _tag: "MessagePlaced", id: entry, requestId, text }]
  }
  return {
    /** A committed entry; only a person's message can place one. */
    entry: (entry: CommittedEntry): ReadonlyArray<MessageEvent> => {
      if (entry.kind !== "pi.user" || announced.has(String(entry.id))) return []
      texts.set(String(entry.id), entryText(entry.model))
      return placed(String(entry.id))
    },
    /** A submission record; Relay submits every input with the dock's requestId, its id is the fallback. */
    record: (record: SubmissionState): ReadonlyArray<MessageEvent> => {
      if (record.type !== "input") return []
      const requestId = record.requestId ?? String(record.id)
      if (record.entry === undefined) {
        return [{ _tag: record.status === "queued" ? "MessageQueued" : "MessageWithdrawn", requestId }]
      }
      const entry = String(record.entry)
      if (announced.has(entry)) return []
      requests.set(entry, requestId)
      return placed(entry)
    }
  }
}
