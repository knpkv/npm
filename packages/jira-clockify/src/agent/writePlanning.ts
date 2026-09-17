import type { CreditedBlock, CreditedSpan } from "./sessions.js"

/** The provider scope explicitly selected by the caller. */
export interface WriteTargets {
  readonly clockify: boolean
  readonly jira: boolean
}

/** Concrete provider arguments. Zero seconds means this side has no write. */
export interface SideWrite {
  readonly seconds: number
  readonly startedAt: Date | undefined
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
}): PreparedProposal => {
  const { evidence, request } = options
  const blocks = selectedBlocks(evidence.blocks, request.blocks)
  if (blocks === undefined) return { _tag: "UnknownBlocks" }
  const targets = request.targets ?? options.targets
  if (!targets.clockify && !targets.jira) return { _tag: "NoTargets" }
  const selected = blocks.reduce((sum, block) => sum + block.seconds, 0)
  const partial = request.blocks !== undefined && blocks.length < evidence.blocks.length
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
      const heldClockifySeconds = bucket?.clockifySeconds ?? 0
      const heldJiraSeconds = bucket?.jiraSeconds ?? 0
      const sized = proposeWrite({
        credited: evidence.credited,
        selected,
        requested: request.seconds,
        heldClockifySeconds,
        heldJiraSeconds,
        targets
      })
      if (sized._tag !== "Write") return sized
      const side = (seconds: number, held: number): SideWrite => ({
        seconds,
        startedAt: partial ? writeAnchor(blocks, 0) : writeAnchor(blocks, held)
      })
      return {
        _tag: "Write",
        ticketKey,
        day: evidence.day,
        targets,
        clockify: side(sized.clockifyDelta, heldClockifySeconds),
        jira: side(sized.jiraDelta, heldJiraSeconds)
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
 * Below this a gap is noise rather than work: Jira floors worklogs to the minute, so a shorter write
 * could not be made faithfully even if it were offered. The same bound the engine proposes on.
 */
export const MINIMUM_WRITE_SECONDS = 60

export const proposeWrite = (options: {
  readonly credited: number
  /** The blocks being accepted now. Defaults to the whole row. */
  readonly selected?: number | undefined
  readonly requested: number | undefined
  readonly heldClockifySeconds: number
  readonly heldJiraSeconds: number
  /** Which systems are in play. A side that is out gets a zero delta, never a gap. */
  readonly targets?: { readonly clockify: boolean; readonly jira: boolean } | undefined
}): ProposedWrite => {
  const targets = options.targets ?? { clockify: true, jira: true }
  const selected = Math.min(options.selected ?? options.credited, options.credited)
  const requested = options.requested ?? selected
  if (requested > selected) return { _tag: "PastEvidence", maxSeconds: selected }
  if (requested < MINIMUM_WRITE_SECONDS) {
    return { _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS }
  }
  const owed = (held: number, asked: boolean): number => {
    if (!asked) return 0
    // Room left in the day, then as much of it as this selection asks for.
    const room = Math.max(0, options.credited - held)
    const delta = Math.min(requested, room)
    // Under a minute is a rounding artefact rather than work: Jira floors worklogs to the minute.
    return delta < MINIMUM_WRITE_SECONDS ? 0 : delta
  }
  const clockifyDelta = owed(options.heldClockifySeconds, targets.clockify)
  const jiraDelta = owed(options.heldJiraSeconds, targets.jira)
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
