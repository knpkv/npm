/**
 * One Relay conversation as the panel shows it, folded from the events the client delivers.
 *
 * **Mental model**
 *
 * - **A Snapshot replaces, never merges.** `seq` is not comparable across subscriptions, so a reconnect
 *   starts over from its Snapshot. Running tool rows and open confirmation cards then arrive again as their
 *   own events, so a card decided while the panel was away never returns.
 * - **A person's message is the server's.** It shows when the stream says so: queued (`MessageQueued`, or a
 *   Snapshot's `queued`), then placed in the transcript (`MessagePlaced`) or withdrawn. The page never adds
 *   a message on its own guess, so a Snapshot can't race a send. The only thing the page adds is the text of
 *   its own sends (`Sending`), because the stream names a queued message by its request id alone.
 * - **The stream's order is the transcript's.** A reply's text joins the reply streaming at the end of the
 *   transcript. A tool call ends it (its start, or its finish when it never started), as does a message
 *   placed after it, and the next text starts a new reply. So the live transcript has the rows a reconnect's
 *   Snapshot will show: Pi stores the text before and after a tool call as separate replies.
 * - **Connection state is a fact, not a guess.** `Disconnected` means a retry is coming; `Unauthorized` and
 *   `StreamFailed` mean it isn't. Nothing here ever reads as working while the stream is down.
 *
 * @module
 */
import type { BackendStatus, RelayEvent, WriteReceipt } from "@knpkv/relay/wire"

/** Everything the client delivers for one conversation, in order. */
export type RelayClientEvent =
  | RelayEvent
  /** The stream dropped; the client is reconnecting and will start over from a Snapshot. */
  | { readonly _tag: "Disconnected" }
  /** The browser's session no longer opens this conversation. The client stops. */
  | { readonly _tag: "Unauthorized" }
  /** The server could not read the session's events, or sent a frame this client can't read. The client stops. */
  | { readonly _tag: "StreamFailed" }
  /** The status of the backend the session's next turn runs on, re-read after each Snapshot, send and run end. */
  | { readonly _tag: "Backend"; readonly status: BackendStatus }
  /** This page is sending a message; its text shows once the server queues or places it. */
  | { readonly _tag: "Sending"; readonly requestId: string; readonly text: string }
  /** A retry after a terminal end: a fresh subscription is opening. */
  | { readonly _tag: "Reconnecting" }

/** Where the stream stands. */
export type RelayConnection = "connecting" | "live" | "disconnected" | "unauthorized" | "failed"

export interface RelayTranscriptMessage {
  readonly id: string
  readonly role: "user" | "relay"
  readonly text: string
  /** A reply still streaming in. */
  readonly streaming: boolean
}

export interface RelayToolRow {
  readonly call: string
  readonly capability: string
  readonly summary: string
  readonly state: "running" | "awaiting-approval" | "ok" | "failed"
  /** What a finished write made, when its capability reports one. */
  readonly receipt: WriteReceipt | null
}

export interface RelayConfirmationCard {
  readonly call: string
  readonly action: Extract<RelayEvent, { readonly _tag: "ConfirmationRequired" }>["action"]
  readonly reversible: boolean
  readonly decision: "pending" | "confirmed" | "declined" | "expired"
}

/** A message waiting for the run in flight; `text` is null when another page sent it. */
export interface RelayQueuedMessage {
  readonly requestId: string
  readonly text: string | null
}

export interface RelayConversationState {
  readonly connection: RelayConnection
  readonly messages: ReadonlyArray<RelayTranscriptMessage>
  /** Accepted messages no run has taken yet, oldest first. */
  readonly queued: ReadonlyArray<RelayQueuedMessage>
  /** The text of this page's sends the server hasn't placed or withdrawn yet. */
  readonly outbox: ReadonlyArray<{ readonly requestId: string; readonly text: string }>
  /** The run in flight: the request ids it answers, empty when idle. */
  readonly runIds: ReadonlyArray<string>
  readonly tools: ReadonlyArray<RelayToolRow>
  readonly confirmations: ReadonlyArray<RelayConfirmationCard>
  /** Why the last run failed, until the next one starts. */
  readonly failure: { readonly cause: string; readonly fix: string } | null
  /** The session's backend, once the client has read it. */
  readonly backend: BackendStatus | null
}

export const initialRelayConversation: RelayConversationState = {
  backend: null,
  confirmations: [],
  connection: "connecting",
  failure: null,
  messages: [],
  outbox: [],
  queued: [],
  runIds: [],
  tools: []
}

const endStreaming = (messages: ReadonlyArray<RelayTranscriptMessage>): ReadonlyArray<RelayTranscriptMessage> =>
  messages.map((message) => (message.streaming ? { ...message, streaming: false } : message))

const withTool = (
  tools: ReadonlyArray<RelayToolRow>,
  call: string,
  update: (row: RelayToolRow) => RelayToolRow
): ReadonlyArray<RelayToolRow> => tools.map((row) => (row.call === call ? update(row) : row))

/** Append a reply's text to the reply streaming at the end, or start a new one named after this event. */
const appendText = (
  messages: ReadonlyArray<RelayTranscriptMessage>,
  event: Extract<RelayEvent, { readonly _tag: "TextDelta" }>
): ReadonlyArray<RelayTranscriptMessage> => {
  const last = messages.at(-1)
  return last !== undefined && last.role === "relay" && last.streaming
    ? [...messages.slice(0, -1), { ...last, text: last.text + event.text }]
    : [...messages, {
      id: `reply:${event.session}:${String(event.seq)}`,
      role: "relay",
      streaming: true,
      text: event.text
    }]
}

const textOf = (state: RelayConversationState, requestId: string): string | null =>
  state.outbox.find((sent) => sent.requestId === requestId)?.text ?? null

/** Drops `requestId` from the queue and the outbox: it was placed or withdrawn. */
const settle = (state: RelayConversationState, requestId: string): RelayConversationState => ({
  ...state,
  outbox: state.outbox.filter((sent) => sent.requestId !== requestId),
  queued: state.queued.filter((queued) => queued.requestId !== requestId)
})

/** The conversation after one event. Pure: the same events always give the same state. */
export const foldRelayConversation = (
  state: RelayConversationState,
  event: RelayClientEvent
): RelayConversationState => {
  switch (event._tag) {
    case "Snapshot":
      return {
        ...state,
        confirmations: [],
        connection: "live",
        failure: null,
        // A turn that only called tools has no text to show.
        messages: event.messages.flatMap((message) =>
          message.role === "relay" && message.text === "" ? [] : [{ ...message, streaming: false }]
        ),
        queued: event.queued.map((requestId) => ({ requestId, text: textOf(state, requestId) })),
        runIds: event.runIds,
        tools: []
      }
    case "RunStarted":
      return { ...state, failure: null, runIds: event.runIds }
    case "TextDelta":
      return { ...state, messages: appendText(state.messages, event) }
    case "ToolStarted":
      return state.tools.some(({ call }) => call === event.call)
        ? state
        : {
          ...state,
          messages: endStreaming(state.messages),
          tools: [...state.tools, {
            call: event.call,
            capability: event.capability,
            receipt: null,
            state: "running",
            summary: event.summary
          }]
        }
    case "ToolFinished":
      // A blocked or unoffered call finishes without having started; it still splits the reply.
      return {
        ...state,
        messages: endStreaming(state.messages),
        tools: withTool(state.tools, event.call, (row) => ({
          ...row,
          receipt: event.receipt ?? null,
          state: event.ok ? "ok" : "failed",
          summary: event.summary
        }))
      }
    case "ApprovalPending":
      return { ...state, tools: withTool(state.tools, event.call, (row) => ({ ...row, state: "awaiting-approval" })) }
    case "ConfirmationRequired":
      return state.confirmations.some(({ call }) => call === event.call)
        ? state
        : {
          ...state,
          confirmations: [...state.confirmations, {
            action: event.action,
            call: event.call,
            decision: "pending",
            reversible: event.reversible
          }]
        }
    case "ConfirmationResolved":
      return {
        ...state,
        confirmations: state.confirmations.map((card) =>
          card.call === event.call ? { ...card, decision: event.decision } : card
        )
      }
    case "RunFinished":
    case "Cancelled":
      return { ...state, messages: endStreaming(state.messages), runIds: [] }
    case "RunFailed":
      return {
        ...state,
        failure: { cause: event.cause, fix: event.fix },
        messages: endStreaming(state.messages),
        runIds: []
      }
    case "Sending":
      return state.outbox.some(({ requestId }) => requestId === event.requestId)
        ? state
        : {
          ...state,
          outbox: [...state.outbox, { requestId: event.requestId, text: event.text }],
          queued: state.queued.map((queued) =>
            queued.requestId === event.requestId ? { ...queued, text: event.text } : queued
          )
        }
    case "MessageQueued":
      return state.queued.some(({ requestId }) => requestId === event.requestId)
        ? state
        : { ...state, queued: [...state.queued, { requestId: event.requestId, text: textOf(state, event.requestId) }] }
    case "MessagePlaced": {
      const settled = settle(state, event.requestId)
      return state.messages.some(({ id }) => id === event.id)
        ? settled
        : {
          ...settled,
          messages: [...endStreaming(settled.messages), {
            id: event.id,
            role: "user",
            streaming: false,
            text: event.text
          }]
        }
    }
    case "MessageWithdrawn":
      return settle(state, event.requestId)
    case "Reconnecting":
      return { ...state, connection: "connecting" }
    case "Backend":
      return { ...state, backend: event.status }
    case "Disconnected":
      return { ...state, connection: "disconnected", messages: endStreaming(state.messages), runIds: [] }
    case "Unauthorized":
      return { ...state, connection: "unauthorized", messages: endStreaming(state.messages), runIds: [] }
    case "StreamFailed":
      return { ...state, connection: "failed", messages: endStreaming(state.messages), runIds: [] }
  }
}
