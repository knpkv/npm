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

export type StreamConnection =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Live" }
  /** No owner session: the page was opened without (or after losing) the sign-in link. */
  | { readonly _tag: "Unauthenticated"; readonly detail: string | null }
  /** The stream broke for another reason; `retryAt` is when the next try starts, `null` once retries stop. */
  | { readonly _tag: "Failed"; readonly cause: string; readonly retryAt: number | null }

/** What the probe after a stream error learned. */
export type StreamProbe =
  | { readonly _tag: "Status"; readonly status: number }
  | { readonly _tag: "Unreachable" }

/** The state after a stream error, given the probe and when the next try would start. */
export const connectionAfterProbe = (probe: StreamProbe, retryAt: number | null): StreamConnection => {
  if (probe._tag === "Unreachable") {
    return { _tag: "Failed", cause: "The CodeCommit server isn't reachable.", retryAt }
  }
  if (probe.status === 401 || probe.status === 403) return { _tag: "Unauthenticated", detail: null }
  if (probe.status >= 500) return { _tag: "Failed", cause: `The CodeCommit server answered ${probe.status}.`, retryAt }
  return { _tag: "Failed", cause: "The live update stream closed.", retryAt }
}

/** Backoff before try `attempt` (0-based): 1s, 2s, 4s … capped at 30s. */
export const retryDelayMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30_000)

/** The header's status word. */
export const connectionLabel = (connection: StreamConnection): string => {
  switch (connection._tag) {
    case "Connecting":
      return "Connecting"
    case "Live":
      return "Live"
    case "Unauthenticated":
      return "Not signed in"
    case "Failed":
      return connection.retryAt === null ? "Disconnected" : "Reconnecting"
  }
}

/** The header's detail line, naming the cause and what fixes it. */
export const connectionDetail = (connection: StreamConnection): string | null => {
  switch (connection._tag) {
    case "Connecting":
    case "Live":
      return null
    case "Unauthenticated":
      return connection.detail ?? "Open the sign-in link that codecommit web printed."
    case "Failed":
      return connection.retryAt === null ? `${connection.cause} Retries stopped.` : connection.cause
  }
}

/** Written by `useSSE`; read by the header and the queue. */
export const streamConnectionAtom = Atom.make<StreamConnection>({ _tag: "Connecting" }).pipe(Atom.keepAlive)

/** Bumped by "Retry now"; `useSSE` reconnects when it changes. */
export const streamRetryAtom = Atom.make(0).pipe(Atom.keepAlive)

/** True once the stream delivered a snapshot; until then every count is unknown. */
export const streamSnapshotSeenAtom = Atom.make(false).pipe(Atom.keepAlive)

/** Why the queue shows no rows, and so which one action the page offers. */
export type EmptyQueueCause =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Unauthenticated"; readonly detail: string }
  | { readonly _tag: "Failed"; readonly cause: string; readonly retrying: boolean }
  | { readonly _tag: "NoAccounts" }
  | { readonly _tag: "Filtered"; readonly cached: number }
  | { readonly _tag: "NothingOpen"; readonly accounts: number }

/**
 * The cause behind an empty queue. Before any snapshot only the connection is known; after one, the
 * snapshot says whether accounts exist and whether filters hide rows.
 */
export const emptyQueueCause = (input: {
  readonly connection: StreamConnection
  readonly snapshotSeen: boolean
  readonly cachedPullRequests: number
  readonly enabledAccounts: number
}): EmptyQueueCause => {
  if (!input.snapshotSeen) {
    switch (input.connection._tag) {
      case "Unauthenticated":
        return { _tag: "Unauthenticated", detail: connectionDetail(input.connection) ?? "" }
      case "Failed":
        return { _tag: "Failed", cause: input.connection.cause, retrying: input.connection.retryAt !== null }
      case "Connecting":
      case "Live":
        return { _tag: "Connecting" }
    }
  }
  if (input.cachedPullRequests > 0) return { _tag: "Filtered", cached: input.cachedPullRequests }
  if (input.enabledAccounts === 0) return { _tag: "NoAccounts" }
  return { _tag: "NothingOpen", accounts: input.enabledAccounts }
}
