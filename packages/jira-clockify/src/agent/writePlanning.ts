import type { CreditedBlock, CreditedSpan } from "./sessions.js"
import * as SourceConsumption from "./sourceConsumption.js"

/** The provider scope explicitly selected by the caller. */
export interface WriteTargets {
  readonly clockify: boolean
  readonly jira: boolean
}

/** Concrete provider arguments. Zero seconds means this side has no write. */
export interface SideWrite {
  readonly seconds: number
  /** Owed seconds that cannot be represented by this provider's minimum segment size. */
  readonly withheldSeconds?: number | undefined
  /** A safety hold on selected source blocks; not an amount already logged. */
  readonly refusal?: "unlinked-overlap" | undefined
  readonly startedAt: Date | undefined
  /** Uncovered source pieces to write in order; kept separate across recorded gaps and blocks. */
  readonly segments: ReadonlyArray<{
    readonly block: CreditedBlock
    readonly seconds: number
    readonly startedAt: Date
    /** Provider-visible description override for this exact segment. */
    readonly description?: string | undefined
  }>
}

/** Sizing and anchoring are finished before a provider executes this plan. */
export interface PlannedWrite {
  readonly _tag: "Write"
  readonly ticketKey: string
  readonly day: string
  readonly targets: WriteTargets
  readonly clockify: SideWrite
  readonly jira: SideWrite
}

interface RecordedBucket {
  readonly ticketKey: string
  readonly day: string
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  readonly intervals: ReadonlyArray<{
    readonly startMs: number
    readonly endMs: number
    readonly source: "clockify" | "jira"
  }>
}

/** Recorded seconds that overlap the selected evidence, unioned per block and capped by its credit. */
const recordedIn = (
  blocks: ReadonlyArray<CreditedBlock>,
  intervals: RecordedBucket["intervals"],
  source: "clockify" | "jira"
): number =>
  blocks.reduce(
    (total, block) => total + SourceConsumption.recordedSecondsInBlock(block, intervals, source),
    0
  )

/** Wall-clock pieces of one block not covered by this provider's existing target-bucket entries. */
const uncovered = (
  block: CreditedBlock,
  intervals: RecordedBucket["intervals"],
  source: "clockify" | "jira"
): ReadonlyArray<{ readonly startMs: number; readonly endMs: number }> => {
  const covered = intervals
    .filter((interval) => interval.source === source)
    .map((interval) => ({
      startMs: Math.max(block.startMs, interval.startMs),
      endMs: Math.min(block.endMs, interval.endMs)
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const result: Array<{ startMs: number; endMs: number }> = []
  let cursor = block.startMs
  for (const interval of covered) {
    if (interval.startMs > cursor) result.push({ startMs: cursor, endMs: interval.startMs })
    cursor = Math.max(cursor, interval.endMs)
  }
  if (cursor < block.endMs) result.push({ startMs: cursor, endMs: block.endMs })
  return result
}

export type PreparedProposal =
  | { readonly _tag: "UnknownBlocks" }
  | { readonly _tag: "NoTargets" }
  | {
    readonly _tag: "Prepared"
    readonly ticketKey: string
    readonly day: string
    readonly targets: WriteTargets
    readonly provenance: {
      readonly evidence: "session"
      readonly amountSetByHand: boolean
      readonly ticketSetByHand: boolean
    }
    readonly plan: (
      recorded: ReadonlyArray<RecordedBucket>
    ) => PlannedWrite | Exclude<ProposedWrite, { readonly _tag: "Write" }>
  }

/**
 * Resolve the selected evidence before reading providers, then plan against their answers.
 * Server callers supply fresh totals; previews supply cached totals. Neither caller computes
 * selection credit or anchors. A selected subset starts where the person pointed; a whole row
 * advances past each provider's recorded time. No evidence or provider state is mutated.
 */
export const prepareProposal = (options: {
  readonly evidence: {
    readonly blocks: ReadonlyArray<CreditedBlock>
    readonly credited: number
    readonly ticketKey: string
    readonly day: string
  }
  readonly request: {
    readonly blocks?: ReadonlyArray<number> | undefined
    readonly seconds?: number | undefined
    readonly ticketKey?: string | undefined
    readonly targets?: WriteTargets | undefined
  }
  readonly targets: WriteTargets
  /** Server-retained source credit already written under a corrected ticket. */
  readonly consumed?: ((block: CreditedBlock, source: "clockify" | "jira") => number) | undefined
}): PreparedProposal => {
  const { evidence, request } = options
  const blocks = selectedBlocks(evidence.blocks, request.blocks)
  if (blocks === undefined) return { _tag: "UnknownBlocks" }
  const targets = request.targets ?? options.targets
  if (!targets.clockify && !targets.jira) return { _tag: "NoTargets" }
  const selected = blocks.reduce((sum, block) => sum + block.seconds, 0)
  const ticketKey = request.ticketKey ?? evidence.ticketKey
  return {
    _tag: "Prepared",
    ticketKey,
    day: evidence.day,
    targets,
    provenance: {
      evidence: "session",
      amountSetByHand: request.seconds !== undefined && request.seconds !== selected,
      ticketSetByHand: ticketKey !== evidence.ticketKey
    },
    plan: (
      recorded: ReadonlyArray<RecordedBucket>
    ): PlannedWrite | Exclude<ProposedWrite, { readonly _tag: "Write" }> => {
      const bucket = recorded.find((row) => row.ticketKey === ticketKey && row.day === evidence.day)
      const correctedBeyondTarget = (source: "clockify" | "jira"): number =>
        evidence.blocks.reduce((total, block) =>
          total + Math.max(
            0,
            (options.consumed?.(block, source) ?? 0) - recordedIn([block], bucket?.intervals ?? [], source)
          ), 0)
      const heldClockifySeconds = (bucket?.clockifySeconds ?? 0) + correctedBeyondTarget("clockify")
      const heldJiraSeconds = (bucket?.jiraSeconds ?? 0) + correctedBeyondTarget("jira")
      const heldInSelection = (source: "clockify" | "jira"): number =>
        blocks.reduce((total, block) =>
          total + Math.max(
            recordedIn([block], bucket?.intervals ?? [], source),
            options.consumed?.(block, source) ?? 0
          ), 0)
      const heldSelectedClockifySeconds = heldInSelection("clockify")
      const heldSelectedJiraSeconds = heldInSelection("jira")
      const sized = proposeWrite({
        credited: evidence.credited,
        selected,
        requested: request.seconds,
        heldClockifySeconds,
        heldJiraSeconds,
        heldSelectedClockifySeconds,
        heldSelectedJiraSeconds,
        targets
      })
      if (sized._tag !== "Write") return sized
      const side = (seconds: number, source: "clockify" | "jira"): SideWrite => {
        let remaining = seconds
        let refused = false
        const segments: Array<{ block: CreditedBlock; seconds: number; startedAt: Date }> = []
        for (const block of blocks) {
          if (remaining <= 0) break
          const recorded = recordedIn([block], bucket?.intervals ?? [], source)
          const consumed = options.consumed?.(block, source) ?? 0
          let skip = Math.max(0, consumed - recorded)
          let availableCredit = Math.max(0, block.seconds - Math.max(recorded, consumed))
          if (source === "clockify" && block.clockifyRefusal === "unlinked-overlap" && availableCredit > 0) {
            refused = true
            continue
          }
          for (const range of uncovered(block, bucket?.intervals ?? [], source)) {
            const rangeSeconds = (range.endMs - range.startMs) / 1000
            const skipped = Math.min(skip, rangeSeconds)
            skip -= skipped
            const capacity = Math.min(rangeSeconds - skipped, availableCredit)
            const allocated = Math.min(remaining, capacity)
            if (allocated > 0) {
              // Jira rounds every worklog up to its one-minute floor. A shorter executable segment
              // would write more than this evidence permits, even when several short gaps total a
              // minute, so it must stay withheld.
              if (source === "jira" && allocated < MINIMUM_WRITE_SECONDS) continue
              segments.push({
                block,
                seconds: allocated,
                startedAt: new Date(range.startMs + skipped * 1000)
              })
              remaining -= allocated
              availableCredit -= allocated
            }
          }
        }
        const executableSeconds = segments.reduce((sum, segment) => sum + segment.seconds, 0)
        return {
          seconds: executableSeconds,
          withheldSeconds: Math.max(0, seconds - executableSeconds),
          ...(refused && { refusal: "unlinked-overlap" }),
          segments,
          startedAt: segments[0]?.startedAt
        }
      }
      const clockify = side(sized.clockifyDelta, "clockify")
      const jira = side(sized.jiraDelta, "jira")
      if (clockify.seconds === 0 && jira.seconds === 0 && clockify.refusal === undefined) {
        return { _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS }
      }
      return {
        _tag: "Write",
        ticketKey,
        day: evidence.day,
        targets,
        clockify,
        jira
      }
    }
  }
}

/**
 * The blocks a confirmation named, or every block when it named none.
 *
 * `undefined` for an index that is not a block of this row: a stale page confirming against a plan
 * that has been re-read is a case to refuse, not to write a guess for.
 */
export const selectedBlocks = (
  blocks: ReadonlyArray<CreditedBlock>,
  chosen: ReadonlyArray<number> | undefined
): ReadonlyArray<CreditedBlock> | undefined => {
  if (chosen === undefined) return blocks
  const picked: Array<CreditedBlock> = []
  for (const index of [...new Set(chosen)].sort((a, b) => a - b)) {
    const block = blocks[index]
    if (block === undefined) return undefined
    picked.push(block)
  }
  return picked.length === 0 ? undefined : picked
}

/**
 * What accepting a row would write, given a live re-tally of the target bucket.
 *
 * Every number here is the server's: `credited` is the evidence the plan was built from, `selected`
 * is the part of it a person is accepting now, and `held` is what the two systems answered a moment
 * ago. `requested` is the only input a person supplies, and it is capped by the selection rather
 * than clamped to it — silently writing less than someone asked for is its own kind of wrong.
 *
 * **Why a side is sized against the whole row and not against the selection.** `credited - held` is
 * the room left in the day; the selection only says how much of that room to use now. Sizing a
 * block against `selected - held` instead would report "already logged" for the second block of any
 * row whose first block is already in — the arithmetic would treat the morning's entry as evidence
 * that the afternoon had been written too.
 */
export type ProposedWrite =
  | {
    readonly _tag: "Write"
    readonly clockifyDelta: number
    readonly jiraDelta: number
  }
  | { readonly _tag: "NothingOwed" }
  | { readonly _tag: "PastEvidence"; readonly maxSeconds: number }
  | { readonly _tag: "BelowMinimum"; readonly minimumSeconds: number }

/**
 * Jira's minimum worklog duration. Clockify retains exact positive seconds below this floor.
 */
export const MINIMUM_WRITE_SECONDS = 60

export const proposeWrite = (options: {
  readonly credited: number
  /** The blocks being accepted now. Defaults to the whole row. */
  readonly selected?: number | undefined
  readonly requested: number | undefined
  readonly heldClockifySeconds: number
  readonly heldJiraSeconds: number
  /** Provider time already overlapping this selection. Omitted for a whole-row write. */
  readonly heldSelectedClockifySeconds?: number | undefined
  readonly heldSelectedJiraSeconds?: number | undefined
  /** Which systems are in play. A side that is out gets a zero delta, never a gap. */
  readonly targets?: { readonly clockify: boolean; readonly jira: boolean } | undefined
}): ProposedWrite => {
  const targets = options.targets ?? { clockify: true, jira: true }
  const selected = Math.min(options.selected ?? options.credited, options.credited)
  const requested = options.requested ?? selected
  if (requested > selected) return { _tag: "PastEvidence", maxSeconds: selected }
  if (requested < (targets.clockify ? 1 : MINIMUM_WRITE_SECONDS)) {
    return { _tag: "BelowMinimum", minimumSeconds: targets.clockify ? 1 : MINIMUM_WRITE_SECONDS }
  }
  const owed = (held: number, heldSelected: number, asked: boolean, minimum: number): number => {
    if (!asked) return 0
    // Room left in the day, then as much of it as this selection asks for.
    const room = Math.max(0, options.credited - held)
    const delta = Math.min(Math.max(0, requested - heldSelected), room)
    return delta < minimum ? 0 : delta
  }
  const clockifyDelta = owed(
    options.heldClockifySeconds,
    options.heldSelectedClockifySeconds ?? 0,
    targets.clockify,
    1
  )
  const jiraDelta = owed(
    options.heldJiraSeconds,
    options.heldSelectedJiraSeconds ?? 0,
    targets.jira,
    MINIMUM_WRITE_SECONDS
  )
  // Nothing left on either side asked for: the ordinary outcome of confirming a row twice, or of a
  // watch having taken it in between. Not a failure, and not a write.
  if (clockifyDelta === 0 && jiraDelta === 0) return { _tag: "NothingOwed" }
  return { _tag: "Write", clockifyDelta, jiraDelta }
}

/**
 * Where a write should say the work began, given what that side already holds.
 *
 * A proposal covers a whole `(Issue Key, day)` bucket, but the amount written is only the gap. Under
 * `jcf watch` that gap arrives block by block: the morning is written when it settles, and the
 * afternoon follows as its own write against the same bucket. Anchoring both at the bucket's first
 * instant would file the afternoon's hours at 09:00 — a second Clockify entry laid directly over the
 * first, and a Jira worklog dated to work that had not started yet.
 *
 * So the anchor skips the blocks that side already accounts for and starts at the first one it does
 * not. Approximate where work ran in parallel, because `seconds` is a *share* of those blocks rather
 * than their wall clock — but the error is then bounded by one block, against a whole day before.
 */
export const writeAnchor = (
  spans: ReadonlyArray<CreditedSpan>,
  alreadyRecordedSeconds: number
): Date | undefined => {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs)
  let remaining = alreadyRecordedSeconds
  for (const span of ordered) {
    const seconds = (span.endMs - span.startMs) / 1000
    if (remaining >= seconds) {
      remaining -= seconds
      continue
    }
    return new Date(span.startMs + remaining * 1000)
  }
  // Every block is already spoken for. Reached only when a side is not short, so nothing is written
  // with this anchor — but the end of the last block is the one instant that cannot overlap what is
  // already recorded, where the first block is the one instant guaranteed to.
  const last = ordered[ordered.length - 1]
  return last === undefined ? undefined : new Date(last.endMs)
}
