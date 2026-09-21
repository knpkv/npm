/**
 * The HTTP contract of the week view.
 *
 * **Mental model**
 *
 * - **Reads and reviewed writes.** `week` shows what each system holds, what the sessions say is
 *   missing, and what could not be placed. Description suggestions reuse that scan's evidence;
 *   confirmation, manual entry and saved-entry update requests write provider time.
 * - **The server owns expected state.** Confirmations name retained row evidence. Saved-entry edits
 *   name a retained provider entry; the engine rechecks that snapshot before updating it.
 * - **Edits are explicit.** Confirmations may override amount, Issue Key and note. Saved-entry edits
 *   change time and exact description. Generating a description never saves it.
 *
 * @module
 */
import { Schema } from "effect"

/** A local calendar day, `YYYY-MM-DD` — the unit every bucket in jcf is keyed by. */
export const Day = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)))

/**
 * An Issue Key as Jira writes them. Checked here as well as in the engine so a malformed override
 * is refused at the boundary, before it can become a Clockify description nothing can read back.
 */
export const TicketKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/)))

/** Seconds of work: whole, positive, and under a day. */
export const WorkSeconds = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 24 * 60 * 60, minimum: 1 }))
)

/** Free text a person typed, bounded so a description cannot be used to write a novel into Jira. */
export const Note = Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))

/** Request a row-level note from the scan's retained evidence, without reading sessions again. */
export const DescribeRowRequest = Schema.Struct({ planId: Schema.String, rowId: Schema.String })
export interface DescribeRowRequest extends Schema.Schema.Type<typeof DescribeRowRequest> {}

/** A suggestion for review, never an instruction to write it to a provider. */
export const DescribeRowResponse = Schema.Struct({
  planId: Schema.String,
  rowId: Schema.String,
  note: Schema.NullOr(Note)
})
export interface DescribeRowResponse extends Schema.Schema.Type<typeof DescribeRowResponse> {}

/** Whole provider entry, retained on every visible slice. Description includes provider prefixes. */
export const SavedEntry = Schema.Struct({
  /** Opaque retained snapshot handle. Send unchanged when saving; use the returned handle afterward. */
  revision: Schema.String,
  id: Schema.String,
  source: Schema.Literals(["jira", "clockify"]),
  ticketKey: Schema.NullOr(Schema.String),
  startMs: Schema.Number,
  endMs: Schema.Number,
  description: Schema.NullOr(Schema.String)
})
export interface SavedEntry extends Schema.Schema.Type<typeof SavedEntry> {}

export const DescribeSavedEntryRequest = Schema.Struct({
  planId: Schema.String,
  source: SavedEntry.fields.source,
  entryId: Schema.String
})
export interface DescribeSavedEntryRequest extends Schema.Schema.Type<typeof DescribeSavedEntryRequest> {}

export const DescribeSavedEntryResponse = Schema.Struct({
  ...DescribeSavedEntryRequest.fields,
  note: Schema.NullOr(Note),
  sessionCount: Schema.Number
})
export interface DescribeSavedEntryResponse extends Schema.Schema.Type<typeof DescribeSavedEntryResponse> {}

/** Server resolves the expected entry; the client can change only its interval and exact description. */
export const UpdateSavedEntryRequest = Schema.Struct({
  ...DescribeSavedEntryRequest.fields,
  revision: SavedEntry.fields.revision,
  startMs: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8640000000000000 }))
  ),
  endMs: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8640000000000000 }))),
  description: Schema.String.pipe(Schema.check(Schema.isMaxLength(32000)))
})
export interface UpdateSavedEntryRequest extends Schema.Schema.Type<typeof UpdateSavedEntryRequest> {}

export const UpdateSavedEntryResponse = Schema.Struct({ planId: Schema.String, entry: SavedEntry })
export interface UpdateSavedEntryResponse extends Schema.Schema.Type<typeof UpdateSavedEntryResponse> {}

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String
}) {}

export class UnauthorizedApiError extends Schema.TaggedError<UnauthorizedApiError>()(
  "UnauthorizedApiError",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class ForbiddenApiError extends Schema.TaggedError<ForbiddenApiError>()(
  "ForbiddenApiError",
  { message: Schema.String },
  { httpApiStatus: 403 }
) {}

/**
 * The plan a confirmation names is gone, or the row in it is.
 *
 * Separate from a rejected write because the repair is different and the browser can do it without
 * asking anyone: re-read the week and offer the row again.
 */
export class PlanExpiredError extends Schema.TaggedError<PlanExpiredError>()(
  "PlanExpiredError",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

/**
 * The write was refused on its own terms — an amount past what the evidence supports, an Issue Key
 * the engine will not write. `maxSeconds` is present when a cap is what refused it, so the browser
 * can say what the ceiling is rather than only that there is one.
 */
export class ProposalRejectedError extends Schema.TaggedError<ProposalRejectedError>()(
  "ProposalRejectedError",
  { message: Schema.String, maxSeconds: Schema.optional(Schema.Number) },
  { httpApiStatus: 422 }
) {}

/**
 * One stretch of credited work: when it happened, and what it is worth.
 *
 * Epoch milliseconds because the browser draws these on a grid, and `seconds` because a block is
 * what a person accepts on its own — `seconds` is its share of the row, which on time worked in
 * parallel is less than the interval it spans.
 */
export const ProposalBlock = Schema.Struct({
  /** Normalized seconds this source block already supplied to each provider, including corrected-ticket writes. */
  consumed: Schema.Struct({ clockify: Schema.Number, jira: Schema.Number }),
  /** A provider-specific safety hold, never a consumed-seconds estimate. */
  clockifyRefusal: Schema.optionalKey(Schema.Literal("unlinked-overlap")),
  endMs: Schema.Number,
  seconds: Schema.Number,
  startMs: Schema.Number,
  /** Stable source-cluster identity; rendered starts may move as overlapping work grows. */
  sourceStartMs: Schema.optional(Schema.Number)
})

/** Which evidence placed a row on its Issue Key. */
export const AttributionSignal = Schema.Literals(["branch", "path", "standing", "agent", "none"])

/**
 * Which systems a week is about.
 *
 * One name rather than two booleans in the query string, because "neither" is not a week anyone
 * asked for. A side that is out is not read, not proposed for, and not written to — so a week with
 * `only=jira` never touches Clockify at all.
 */
export const WeekScope = Schema.Literals(["both", "clockify", "jira"])

/** Which systems a single write may touch. Defaults to the scope the week was read under. */
export const WriteTargets = Schema.Struct({
  clockify: Schema.Boolean,
  jira: Schema.Boolean
})

/** When recorded time happened, and which system says so. */
export const RecordedInterval = Schema.Struct({
  entry: Schema.optionalKey(SavedEntry),
  endMs: Schema.Number,
  source: Schema.Literals(["clockify", "jira"]),
  startMs: Schema.Number
})

/**
 * What a row's sessions say, and what accepting it would write.
 *
 * `maxSeconds` is the credited evidence: the ceiling on an edited amount. Editing below it is a
 * person saying the evidence overstates the work; editing above it would be the tool inventing
 * hours, which is the one thing every rule here exists to prevent.
 */
export const RowProposal = Schema.Struct({
  activeSeconds: Schema.Number,
  /**
   * The stretches behind this row, ascending. They sum to `maxSeconds`, and a confirmation may name
   * a subset of them by position — which is how a morning gets written without the afternoon.
   */
  blocks: Schema.Array(ProposalBlock),
  clockifyDelta: Schema.Number,
  confidence: Schema.NullOr(Schema.Number),
  jiraDelta: Schema.Number,
  maxSeconds: Schema.Number,
  sessionCount: Schema.Number,
  signal: AttributionSignal
})

/**
 * One `(Issue Key, day)` cell of the week.
 *
 * Rows exist for time that is only recorded, only evidenced, or both — a day tracked with a Timer
 * has no proposal, and a day nobody logged has no allocated seconds. Which is the point of showing
 * them together.
 */
export const WeekRow = Schema.Struct({
  clockifyDescription: Schema.NullOr(Schema.String),
  clockifySeconds: Schema.Number,
  day: Day,
  /**
   * When the recorded time happened — the entries behind the totals, so a week can be drawn as a
   * calendar. Empty when the systems reported no usable interval, never fabricated from the total.
   */
  intervals: Schema.Array(RecordedInterval),
  jiraSeconds: Schema.Number,
  proposal: Schema.optional(RowProposal),
  rowId: Schema.String,
  ticketKey: Schema.String,
  /**
   * The issue title, or null when Jira could not be asked — logged out, unreachable, or out of
   * scope for this week. Null is "unknown", never "untitled": an Issue Key alone is a lookup nobody
   * can do six months later, so it is worth saying when it is missing.
   */
  ticketTitle: Schema.NullOr(Schema.String)
})

/** Hours that happened on a day and no signal could place, with the directories behind them. */
export const UnattributedDay = Schema.Struct({
  cwds: Schema.Array(Schema.String),
  day: Day,
  seconds: Schema.Number,
  sessionCount: Schema.Number
})

/** Attributed by a Coding Agent below the confidence floor: shown so the hours stay visible. */
export const WithheldRow = Schema.Struct({
  confidence: Schema.NullOr(Schema.Number),
  day: Day,
  seconds: Schema.Number,
  ticketKey: Schema.String,
  ticketTitle: Schema.NullOr(Schema.String)
})

/**
 * Hours a signal placed on a ticket Jira says belongs to somebody else.
 *
 * Reported rather than proposed, and reported rather than dropped: a branch cannot tell authoring
 * from reviewing, so this is usually a pull request you read — and occasionally your own work on a
 * colleague's ticket, which is what `assignee` and the override are for.
 */
export const NotMineRow = Schema.Struct({
  /** Who Jira says owns it, or null when it is unassigned. */
  assignee: Schema.NullOr(Schema.String),
  day: Day,
  seconds: Schema.Number,
  signal: AttributionSignal,
  ticketKey: Schema.String,
  ticketTitle: Schema.NullOr(Schema.String)
})

/** A day withheld from proposals, with the reason, so it never reads as "nothing to log". */
export const ExcludedDay = Schema.Struct({
  day: Day,
  reason: Schema.String
})

export const WeekPlan = Schema.Struct({
  /**
   * True when a Coding Agent was needed and could not be reached. The deterministic rows are still
   * complete; what is missing is only the placement of sessions no branch or path could place.
   */
  attributorAvailable: Schema.Boolean,
  attributorCalls: Schema.Number,
  days: Schema.Array(Day),
  excludedDays: Schema.Array(ExcludedDay),
  monday: Day,
  /** Names the server-held evidence a confirmation refers to. */
  planId: Schema.String,
  rows: Schema.Array(WeekRow),
  /** Closed Clockify entries without a ticket, excluded from ticket reconciliation. */
  unlinkedClockify: Schema.Array(Schema.Struct({
    entry: Schema.optionalKey(SavedEntry),
    day: Day,
    seconds: Schema.Number,
    description: Schema.NullOr(Schema.String),
    startMs: Schema.Number,
    endMs: Schema.Number
  })),
  sessionCount: Schema.Number,
  /** False for recorded-only weeks. Omitted by older servers means a session scan is available. */
  sessionScanAvailable: Schema.optional(Schema.Boolean),
  /** Which systems this week was read from. A side that is out reports zero because nobody asked. */
  scope: WeekScope,
  /** Zero means nothing is opted in, which is the usual reason for an empty week. */
  sessionRootCount: Schema.Number,
  /** Hours on tickets assigned to somebody else. Empty when ownership is not being enforced. */
  notMine: Schema.Array(NotMineRow),
  /**
   * True when Jira actually answered about who owns these tickets.
   *
   * False means nothing was filtered on ownership, whatever the setting says — a week that quietly
   * hid rows because Jira was unreachable would be a week missing hours with nothing to explain it.
   */
  ownershipChecked: Schema.Boolean,
  /** Whether this week withheld tickets assigned to other people. */
  ownership: Schema.Literals(["assigned", "any"]),
  unattributed: Schema.Array(UnattributedDay),
  withheld: Schema.Array(WithheldRow)
})

/** Authenticated cached view. Missing evidence allows provider-only reads; suggestions require an explicit scan. */
export const SavedWeek = Schema.Struct({ monday: Day, scope: WeekScope, plan: Schema.NullOr(WeekPlan) })

/** What one side of a write did. Mirrors `SideOutcome` in the engine. */
export const SideOutcome = Schema.Union([
  Schema.TaggedStruct("Written", {
    seconds: Schema.Number,
    segments: Schema.optional(Schema.Array(Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })))
  }),
  Schema.TaggedStruct("PartiallyWritten", {
    seconds: Schema.Number,
    segments: Schema.optional(Schema.Array(Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number }))),
    failure: Schema.Union([
      Schema.TaggedStruct("Refused", { message: Schema.String }),
      Schema.TaggedStruct("NotLoggedIn", {})
    ])
  }),
  Schema.TaggedStruct("NothingOwed", {}),
  Schema.TaggedStruct("Skipped", {}),
  Schema.TaggedStruct("Refused", { message: Schema.String }),
  Schema.TaggedStruct("NotLoggedIn", {})
])

/**
 * What a write actually did, in the engine's own words.
 *
 * `lines` is rendered by the engine rather than the browser so a terminal and a page cannot describe
 * the same write differently. `description` is what landed in both systems, returned because it is
 * the text other people will read.
 */
export const WriteResult = Schema.Struct({
  clockify: SideOutcome,
  description: Schema.String,
  jira: SideOutcome,
  lines: Schema.Array(Schema.String)
})

/**
 * Accept one proposed row, optionally with the amount or the Issue Key overruled.
 *
 * No spans, no credited seconds, no deltas: the server holds the evidence this row was built from
 * and re-reads both systems before writing, so the only numbers a browser can influence are the ones
 * a person is allowed to choose.
 */
export const ConfirmPayload = Schema.Struct({
  /**
   * Which of the row's blocks to write, by position. Absent means all of them.
   *
   * Positions rather than times or durations, so the server still owns every number: naming block
   * two of a row it built is not the same kind of claim as sending "40 minutes at 20:52".
   */
  blocks: Schema.optional(Schema.Array(Schema.Number.pipe(Schema.check(Schema.isInt())))),
  note: Schema.optional(Note),
  planId: Schema.String,
  rowId: Schema.String,
  /** Absent means the systems the week was read under. Neither is a usage error, not a write. */
  targets: Schema.optional(WriteTargets),
  /** Absent means "as proposed". Present must not exceed the row's `maxSeconds`. */
  seconds: Schema.optional(WorkSeconds),
  /** Absent means the Issue Key the evidence placed it on. */
  ticketKey: Schema.optional(TicketKey)
})

/**
 * Log time no session evidences — a meeting, a whiteboard, a review away from the keyboard.
 *
 * Deliberately an *addition* rather than a top-up: a person typing 30 minutes means add 30 minutes,
 * which is what `jcf timer log` has always done. Nothing is subtracted, so running it twice logs
 * twice, exactly as typing it twice would.
 */
export const ManualPayload = Schema.Struct({
  day: Day,
  note: Schema.optional(Note),
  seconds: WorkSeconds,
  targets: Schema.optional(WriteTargets),
  /** Local `HH:MM` the work began. Absent lets the engine place it at local noon. */
  startClock: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)))
  ),
  ticketKey: TicketKey
})

/** Treat one ticket as yours whatever Jira says its assignee is. Sticks, in `~/.jcf/config.json`. */
export const OwnershipPayload = Schema.Struct({
  ticketKey: TicketKey
})

export const OwnershipResult = Schema.Struct({
  ownershipOverrides: Schema.Array(Schema.String)
})

/** Map a directory prefix to an Issue Key, so recurring ticket-less work stops being unplaced. */
export const StandingPayload = Schema.Struct({
  cwd: Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:\/|~|[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/))),
  ticketKey: TicketKey
})

export const StandingResult = Schema.Struct({
  sessionTicketMap: Schema.Record(Schema.String, Schema.String)
})

export type WeekPlanResponse = Schema.Schema.Type<typeof WeekPlan>
export type WeekRowResponse = Schema.Schema.Type<typeof WeekRow>
export type RowProposalResponse = Schema.Schema.Type<typeof RowProposal>
export type UnattributedDayResponse = Schema.Schema.Type<typeof UnattributedDay>
export type WriteResultResponse = Schema.Schema.Type<typeof WriteResult>
export type WeekScopeName = Schema.Schema.Type<typeof WeekScope>
export type WriteTargetsRequest = Schema.Schema.Type<typeof WriteTargets>
export type RecordedIntervalResponse = Schema.Schema.Type<typeof RecordedInterval>
export type ProposalBlockResponse = Schema.Schema.Type<typeof ProposalBlock>
export type NotMineRowResponse = Schema.Schema.Type<typeof NotMineRow>
export type OwnershipMode = "assigned" | "any"

/** Actual server stages. Counts describe completed attribution work, never estimated percentages. */
export const ReadProgress = Schema.Struct({
  activity: Schema.optional(
    Schema.Struct({
      batch: Schema.Number,
      batches: Schema.Number,
      kind: Schema.Literals(["status", "text", "request", "response"]),
      text: Schema.String
    })
  ),
  stage: Schema.Literals(["sessions", "attribution", "recorded", "issues", "calendar"]),
  message: Schema.String,
  completed: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number)
})
export type ReadProgress = typeof ReadProgress.Type

/** One authenticated read stream, ending in exactly one plan or failure. */
export const WeekReadEvent = Schema.Union([
  Schema.TaggedStruct("Progress", { progress: ReadProgress }),
  Schema.TaggedStruct("Complete", { plan: WeekPlan }),
  Schema.TaggedStruct("Failed", { message: Schema.String })
])
export type WeekReadEvent = typeof WeekReadEvent.Type
