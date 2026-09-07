/**
 * The HTTP contract of the week view.
 *
 * **Mental model**
 *
 * - **A read and three writes.** `week` is the whole picture — what each system already holds, what
 *   the sessions say is missing, and what could not be placed. The writes each put time in Jira and
 *   Clockify, and nothing else here changes anything.
 * - **A write never carries its own evidence.** A confirmation names a row of a plan the server
 *   built and still holds, never the spans or the credited seconds behind it. A browser that could
 *   post its own evidence could post any number of hours it liked.
 * - **Amount and Issue Key are the only things a person may overrule**, and both are said out loud
 *   in what gets written. See `WriteProvenance` in `@knpkv/jira-clockify`.
 *
 * @module
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

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

export class OwnerSessionAuth extends HttpApiMiddleware.Service<OwnerSessionAuth>()(
  "@knpkv/jcf-web/OwnerSessionAuth",
  {
    error: [UnauthorizedApiError, ForbiddenApiError],
    security: {
      ownerCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "jcf_owner" })
    }
  }
) {}

/**
 * One stretch of credited work: when it happened, and what it is worth.
 *
 * Epoch milliseconds because the browser draws these on a grid, and `seconds` because a block is
 * what a person accepts on its own — `seconds` is its share of the row, which on time worked in
 * parallel is less than the interval it spans.
 */
export const ProposalBlock = Schema.Struct({
  endMs: Schema.Number,
  seconds: Schema.Number,
  startMs: Schema.Number
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
  sessionCount: Schema.Number,
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

/** What one side of a write did. Mirrors `SideOutcome` in the engine. */
export const SideOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Written"), seconds: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("NothingOwed") }),
  Schema.Struct({ _tag: Schema.Literal("Skipped") }),
  Schema.Struct({ _tag: Schema.Literal("Refused"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("NotLoggedIn") })
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
  startClock: Schema.optional(Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{2}:\d{2}$/)))),
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
  cwd: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  ticketKey: TicketKey
})

export const StandingResult = Schema.Struct({
  sessionTicketMap: Schema.Record(Schema.String, Schema.String)
})

export class WeekGroup extends HttpApiGroup.make("week")
  .add(
    HttpApiEndpoint.get("read", "/", {
      error: ApiError,
      query: Schema.Struct({ monday: Schema.optional(Day), only: Schema.optional(WeekScope) }),
      success: WeekPlan
    })
  )
  .prefix("/api/week")
{}

export class RowsGroup extends HttpApiGroup.make("rows")
  .add(
    HttpApiEndpoint.post("confirm", "/confirm", {
      error: Schema.Union([ApiError, PlanExpiredError, ProposalRejectedError]),
      payload: ConfirmPayload,
      success: WriteResult
    })
  )
  .add(
    HttpApiEndpoint.post("manual", "/manual", {
      error: Schema.Union([ApiError, ProposalRejectedError]),
      payload: ManualPayload,
      success: WriteResult
    })
  )
  .prefix("/api/rows")
{}

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(
    HttpApiEndpoint.post("standing", "/standing", {
      error: Schema.Union([ApiError, ProposalRejectedError]),
      payload: StandingPayload,
      success: StandingResult
    })
  )
  .add(
    HttpApiEndpoint.post("mine", "/mine", {
      error: Schema.Union([ApiError, ProposalRejectedError]),
      payload: OwnershipPayload,
      success: OwnershipResult
    })
  )
  .prefix("/api/config")
{}

export class JcfWebApi extends HttpApi.make("JcfWebApi")
  .add(WeekGroup)
  .add(RowsGroup)
  .add(ConfigGroup)
  .middleware(OwnerSessionAuth)
{}

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
