/**
 * What the transcript and rollout readers share: the line they are handed and the result they give
 * back. Readers are pure, so a chunk of a file and the state carried from the previous chunk are all
 * they need; file access and cursors live in the ingest pass.
 *
 * @module
 */
import type { BalanceReading, LimitSnapshot, UsageEvent } from "./Model.js"

/** One complete line of a source file and the byte offset it starts at. */
export interface SourceLine {
  readonly offset: number
  readonly text: string
}

/** Which source file a chunk came from, as the reader stamps it onto what it records. */
export interface SourceFile {
  /** The file's path relative to its source root, unique per Agent. */
  readonly fileKey: string
  readonly machine: string
  readonly sessionId: string
}

/** How many lines that looked relevant were not recorded, by reason. */
export interface SkipCounts {
  readonly unparseableLine: number
  readonly missingTimestamp: number
}

export type SkipReason = keyof SkipCounts

export const noSkips: SkipCounts = { unparseableLine: 0, missingTimestamp: 0 }

export interface ReadResult<State> {
  readonly events: ReadonlyArray<UsageEvent>
  readonly snapshots: ReadonlyArray<LimitSnapshot>
  readonly balances: ReadonlyArray<BalanceReading>
  readonly skipped: SkipCounts
  readonly state: State
}

/** Adds one skip to a count, returning a new count. */
export const countSkip = (counts: SkipCounts, reason: SkipReason): SkipCounts => ({
  ...counts,
  [reason]: counts[reason] + 1
})

/** Sums two skip counts. */
export const mergeSkips = (left: SkipCounts, right: SkipCounts): SkipCounts => ({
  unparseableLine: left.unparseableLine + right.unparseableLine,
  missingTimestamp: left.missingTimestamp + right.missingTimestamp
})

/** Epoch milliseconds of an ISO timestamp, or null when it does not parse. */
export const parseInstant = (iso: string): number | null => {
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? millis : null
}
