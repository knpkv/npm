/** Exact parsed-diff placement, not command or patch applicability authority. @module */
import {
  type CurrentReviewLineFinding,
  currentReviewLineFindings,
  type CurrentReviewRunReading,
  type ReviewAnchor,
  type ReviewFindingRow,
  type ReviewThread,
  type ReviewThreadIdentity,
  sameReviewThread
} from "@knpkv/review"
import type { FileDiff } from "@knpkv/rly/diff/patch"
import { Result, Schema } from "effect"

export interface ReviewParsedDiff {
  readonly identity: ReviewThreadIdentity
  /** Exact bounded parsed objects supplied to the renderer. Rejected/unread files are absent. */
  readonly files: ReadonlyArray<{ readonly index: number; readonly file: FileDiff }>
}

export interface ReviewPlacedFinding {
  readonly row: CurrentReviewLineFinding
  readonly fileIndex: number
  readonly side: "old" | "new"
  readonly line: number
}

export interface ReviewDiffPlacement {
  readonly placed: ReadonlyArray<ReviewPlacedFinding>
  readonly unplaced: ReadonlyArray<ReviewFindingRow>
}

export class ReviewDiffPlacementError
  extends Schema.TaggedError<ReviewDiffPlacementError>()("ReviewDiffPlacementError", {
    reason: Schema.Literals(["identity_mismatch", "duplicate_file"])
  })
{}

const validateParsedFiles = (
  identity: ReviewThreadIdentity,
  diff: ReviewParsedDiff
): ReviewDiffPlacementError | null => {
  if (!sameReviewThread(identity, diff.identity)) return new ReviewDiffPlacementError({ reason: "identity_mismatch" })
  const indices = new Set<number>()
  const paths = new Set<string>()
  for (const { file, index } of diff.files) {
    if (indices.has(index) || paths.has(file.path)) return new ReviewDiffPlacementError({ reason: "duplicate_file" })
    indices.add(index)
    paths.add(file.path)
  }
  return null
}

const matchingFile = (anchor: Extract<ReviewAnchor, { readonly _tag: "Line" }>, diff: ReviewParsedDiff) => {
  const side = anchor.side === "before" ? "old" : "new"
  const matching = diff.files.filter(({ file }) =>
    !file.binary &&
    (side === "old"
      ? file.status !== "added" && file.oldPath === anchor.path
      : file.status !== "deleted" && file.newPath === anchor.path) &&
    file.hunks.some((hunk) => hunk.lines.some((line) => (side === "old" ? line.oldNo : line.newNo) === anchor.line))
  )
  return matching.length === 1 ? matching[0] : undefined
}

interface ReviewPlacedConversation {
  readonly thread: ReviewThread
  readonly fileIndex: number
  readonly side: "old" | "new"
  readonly line: number
}

/**
 * Place caller-verified current-snapshot discussions at exact positions. The caller excludes rows
 * originating in a DifferentRevision run; current comments remain eligible independently of it.
 */
export const placeReviewConversations = (
  identity: ReviewThreadIdentity,
  threads: ReadonlyArray<ReviewThread>,
  diff: ReviewParsedDiff
): Result.Result<ReadonlyArray<ReviewPlacedConversation>, ReviewDiffPlacementError> => {
  const error = validateParsedFiles(identity, diff)
  if (error !== null) return Result.fail(error)
  const placed: Array<ReviewPlacedConversation> = []
  for (const thread of threads) {
    const anchor = thread.anchor
    if (thread.finding !== null || anchor._tag !== "Line" || anchor.outdated) continue
    const file = matchingFile(anchor, diff)
    if (file !== undefined) {
      placed.push({ thread, fileIndex: file.index, side: anchor.side === "before" ? "old" : "new", line: anchor.line })
    }
  }
  return Result.succeed(placed)
}

/**
 * Decide once after collecting all eligible parsed files, not once per file. Every finding appears
 * either inline exactly once or in the parent's one fallback. Sparse, absent, outdated and ambiguous
 * anchors stay separate; no line repair or head-only comparison. DifferentRevision cannot enter.
 */
export const placeCurrentReviewFindings = (
  reading: CurrentReviewRunReading,
  diff: ReviewParsedDiff
): Result.Result<ReviewDiffPlacement, ReviewDiffPlacementError> => {
  const error = validateParsedFiles(reading.run.identity, diff)
  if (error !== null) return Result.fail(error)
  const candidates = new Map(currentReviewLineFindings(reading).map((row) => [row.thread, row]))
  const placed: Array<ReviewPlacedFinding> = []
  const unplaced: Array<ReviewFindingRow> = []
  for (const thread of reading.run.threads) {
    if (thread.finding === null) continue
    const row = candidates.get(thread)
    if (row === undefined) {
      unplaced.push({ thread, finding: thread.finding })
      continue
    }
    const anchor = row.anchor
    const side = anchor.side === "before" ? "old" : "new"
    const match = matchingFile(anchor, diff)
    if (match !== undefined) {
      placed.push({ row, fileIndex: match.index, side, line: anchor.line })
    } else unplaced.push({ thread, finding: thread.finding })
  }
  return Result.succeed({ placed, unplaced })
}
