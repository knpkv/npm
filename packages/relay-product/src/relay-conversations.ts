/**
 * Every open Relay conversation on a page, shared: one stream per conversation however many parts of the
 * page read it.
 *
 * **Mental model**
 *
 * - **State lives here, not in a listener.** The store folds each conversation's events as they arrive.
 *   A reader that subscribes late (the panel opening after the header's mark started the stream) reads the
 *   current state at once, history and open cards included, then hears live events only. So nothing a
 *   reader shows as a one-off (a finished reply, a failure) replays for it.
 * - **The stream lives while someone reads it.** The first subscriber to a conversation starts its stream;
 *   the last one to leave stops it. A stream that ended for good (`Unauthorized`, `StreamFailed`) stays
 *   ended until someone calls `retry`.
 * - **The backend's status is read beside the stream, never inside it.** After each Snapshot, each run's
 *   end and each accepted send the store reads it in the background, so a slow read never holds back an
 *   event. A newer read interrupts an older one, and a read still running when the stream stops is
 *   interrupted with it.
 * - **The composer owns a message's request id.** `newRequestId` makes one per draft; `send` with the same
 *   id after a failure lands once, even when the first attempt reached the server and only its answer was
 *   lost.
 *
 * @module
 */
import { type BackendStatus, type ObjectRef, objectRefKey, type RelayBackendId } from "@knpkv/relay/wire"
import { Crypto, Data, Effect, type Exit, Fiber, type ManagedRuntime, Stream } from "effect"
import type { HttpClient } from "effect/http"

import type { RelayClient, RelayRequestFailure } from "./relay-client.js"
import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConversationState
} from "./relay-fold.js"

/** Called with the state after each event; `event` is null for the first call, which hands over the current state. */
export type RelayConversationListener = (state: RelayConversationState, event: RelayClientEvent | null) => void

/** What the page runs Relay's requests with: a fetch client and the browser's crypto, provided at its edge. */
export type RelayRuntime = ManagedRuntime.ManagedRuntime<HttpClient.HttpClient | Crypto.Crypto, never>

/** One message to send: its text, and the request id the composer made for this draft. */
export interface RelayOutgoingMessage {
  readonly text: string
  readonly requestId: string
  /** Switches the session to this backend from its next turn on. */
  readonly backend?: typeof RelayBackendId.Type
}

export interface RelayConversations {
  /** The conversation's current state; `initialRelayConversation` before anything was read. */
  readonly get: (ref: ObjectRef) => RelayConversationState
  /** Hears `ref`'s state now and after every event; returns the unsubscribe. */
  readonly subscribe: (ref: ObjectRef, listener: RelayConversationListener) => () => void
  /** A fresh request id for a new draft. */
  readonly newRequestId: () => Promise<Exit.Exit<string, SendIdUnavailable>>
  /**
   * Sends a message. To retry a failed send, pass the same `requestId`: the server takes it once. The
   * message shows when the stream reports it queued or placed, not when this resolves.
   */
  readonly send: (ref: ObjectRef, message: RelayOutgoingMessage) => Promise<Exit.Exit<void, RelayRequestFailure>>
  readonly cancel: (ref: ObjectRef, runId: string) => Promise<Exit.Exit<void, RelayRequestFailure>>
  readonly decide: (ref: ObjectRef, callId: string, allow: boolean) => Promise<Exit.Exit<void, RelayRequestFailure>>
  /** Reopens a stream that ended for good, for its current readers; a no-op while it is open or retrying. */
  readonly retry: (ref: ObjectRef) => void
  /** Stops every stream and backend read; for the page's teardown. */
  readonly dispose: () => void
}

/** The browser couldn't make a request id, so nothing was sent. */
export class SendIdUnavailable extends Data.TaggedError("SendIdUnavailable")<{}> {}

interface Entry {
  readonly ref: ObjectRef
  state: RelayConversationState
  readonly listeners: Set<RelayConversationListener>
  stream: Fiber.Fiber<void> | null
  /** The latest backend read; a newer one interrupts it. */
  backendRead: Fiber.Fiber<void> | null
  /** Counts backend reads; a read lands only while it is the newest. */
  backendReads: number
}

/** Events after which the backend's status may have changed. */
const readsBackend = (event: RelayClientEvent): boolean =>
  event._tag === "Snapshot" || event._tag === "RunFinished" || event._tag === "RunFailed" ||
  event._tag === "Cancelled"

/** A stream that ended for good: only `retry` reopens it. */
const ended = (state: RelayConversationState): boolean =>
  state.connection === "unauthorized" || state.connection === "failed"

export const makeRelayConversations = (client: RelayClient, runtime: RelayRuntime): RelayConversations => {
  const entries = new Map<string, Entry>()

  const entryFor = (ref: ObjectRef): Entry => {
    const key = objectRefKey(ref)
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const created: Entry = {
      backendRead: null,
      backendReads: 0,
      listeners: new Set(),
      ref,
      state: initialRelayConversation,
      stream: null
    }
    entries.set(key, created)
    return created
  }

  const interrupt = (fiber: Fiber.Fiber<void> | null): void => {
    if (fiber !== null) runtime.runFork(Fiber.interrupt(fiber))
  }

  const dispatch = (entry: Entry, event: RelayClientEvent): void => {
    entry.state = foldRelayConversation(entry.state, event)
    for (const listener of entry.listeners) listener(entry.state, event)
    if (readsBackend(event)) refreshBackend(entry)
  }

  /**
   * Reads the session's backend in the background; only the newest read may land. Nothing reads for a
   * conversation nobody holds open, such as a send answered after its panel closed.
   */
  const refreshBackend = (entry: Entry): void => {
    if (entry.listeners.size === 0 || entries.get(objectRefKey(entry.ref)) !== entry) return
    interrupt(entry.backendRead)
    entry.backendReads += 1
    const read = entry.backendReads
    // best-effort: a backend read that fails keeps the last status; the next Snapshot or run end reads it again.
    entry.backendRead = runtime.runFork(
      client.sessionBackend(entry.ref).pipe(
        Effect.flatMap((status: BackendStatus | null) =>
          Effect.sync(() => {
            if (status !== null && read === entry.backendReads) dispatch(entry, { _tag: "Backend", status })
          })
        ),
        Effect.ignore
      )
    )
  }

  const open = (entry: Entry): void => {
    entry.stream = runtime.runFork(
      client.events(entry.ref).pipe(Stream.runForEach((event) => Effect.sync(() => dispatch(entry, event))))
    )
  }

  const close = (entry: Entry): void => {
    interrupt(entry.stream)
    interrupt(entry.backendRead)
    // An interrupted read that already has its answer must not land after the close.
    entry.backendReads += 1
    entry.stream = null
    entry.backendRead = null
  }

  const subscribe = (ref: ObjectRef, listener: RelayConversationListener): () => void => {
    const entry = entryFor(ref)
    entry.listeners.add(listener)
    listener(entry.state, null)
    if (entry.stream === null && !ended(entry.state)) open(entry)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0) close(entry)
    }
  }

  const retry = (ref: ObjectRef): void => {
    const entry = entries.get(objectRefKey(ref))
    if (entry === undefined || entry.listeners.size === 0 || !ended(entry.state)) return
    interrupt(entry.stream)
    dispatch(entry, { _tag: "Reconnecting" })
    open(entry)
  }

  const send: RelayConversations["send"] = (ref, { backend, requestId, text }) => {
    const entry = entryFor(ref)
    dispatch(entry, { _tag: "Sending", requestId, text })
    return runtime.runPromiseExit(
      client.message(ref, text, requestId, backend).pipe(
        Effect.tap(() => Effect.sync(() => refreshBackend(entry))),
        Effect.asVoid
      )
    )
  }

  return {
    cancel: (ref, runId) => runtime.runPromiseExit(client.cancel(ref, runId)),
    decide: (ref, callId, allow) => runtime.runPromiseExit(client.decide(ref, callId, allow)),
    dispose: () => {
      for (const entry of entries.values()) {
        close(entry)
        entry.listeners.clear()
      }
      entries.clear()
    },
    get: (ref) => entries.get(objectRefKey(ref))?.state ?? initialRelayConversation,
    newRequestId: () =>
      runtime.runPromiseExit(
        Effect.gen(function*() {
          const ids = yield* Crypto.Crypto
          return yield* ids.randomUUIDv7
        }).pipe(Effect.mapError(() => new SendIdUnavailable()))
      ),
    retry,
    send,
    subscribe
  }
}
