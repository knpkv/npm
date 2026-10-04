/**
 * What the page does with a live-updates message: which reads to refetch, and how long to wait
 * before reconnecting a dropped socket.
 *
 * @module
 */
import type { LiveVersions } from "../shared/contracts.js"

export type LiveRead = keyof LiveVersions

const READS: ReadonlyArray<LiveRead> = ["usage", "limits", "status"]

/**
 * The reads to refetch for a message. The first message of a connection refetches everything:
 * whatever changed while the socket was down was never announced. After that, a read is
 * refetched when its counter differs from the last one seen (a restarted server counts from zero).
 */
export const readsToRefresh = (
  previous: LiveVersions | null,
  next: LiveVersions
): ReadonlyArray<LiveRead> => previous === null ? READS : READS.filter((read) => previous[read] !== next[read])

const FIRST_DELAY_MILLIS = 1_000
const MAX_DELAY_MILLIS = 30_000

/** Milliseconds to wait before reconnect attempt `attempt` (0-based): 1 s doubling to 30 s. */
export const reconnectDelay = (attempt: number): number =>
  Math.min(MAX_DELAY_MILLIS, FIRST_DELAY_MILLIS * 2 ** Math.min(attempt, 10))
