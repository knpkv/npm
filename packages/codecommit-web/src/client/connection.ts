/**
 * The event stream's connection, as the page shows it.
 *
 * `useSSE` owns the stream and writes {@link streamConnectionAtom}; the header and the queue read it.
 * An EventSource can't see the HTTP status of a refused connection, so after an error the hook asks a
 * cheap authenticated endpoint and {@link connectionAfterProbe} turns that answer into the state:
 * a 401/403 means this browser has no session (retrying can't fix it), anything else is a failure that
 * is retried with backoff.
 *
 * Until the first snapshot arrives nothing about the accounts is known, so counts render as unknown,
 * never 0.
 *
 * @module
 */
import * as Atom from "effect/reactivity/Atom"
import type { StreamConnection } from "./connection-presentation.js"

export {
  connectionAfterProbe,
  connectionDetail,
  connectionLabel,
  type EmptyQueueCause,
  emptyQueueCause,
  retryDelayMs,
  type StreamConnection,
  type StreamProbe
} from "./connection-presentation.js"

/** Written by `useSSE`; read by the header and the queue. */
export const streamConnectionAtom = Atom.make<StreamConnection>({ _tag: "Connecting" }).pipe(Atom.keepAlive)

/** Bumped by "Retry now"; `useSSE` reconnects when it changes. */
export const streamRetryAtom = Atom.make(0).pipe(Atom.keepAlive)

/** True once the stream delivered a snapshot; until then every count is unknown. */
export const streamSnapshotSeenAtom = Atom.make(false).pipe(Atom.keepAlive)
