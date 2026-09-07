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

/** When credited work happened. Epoch milliseconds, because the browser draws these on a grid. */
export const Span = Schema.Struct({
  endMs: Schema.Number,
  startMs: Schema.Number
})

/** Which evidence placed a row on its Issue Key. */
export const AttributionSignal = Schema.Literals(["branch", "path", "standing", "agent", "none"])

/**
 * What a row's sessions say, and what accepting it would write.
 *
 * `maxSeconds` is the credited evidence: the ceiling on an edited amount. Editing below it is a
 * person saying the evidence overstates the work; editing above it would be the tool inventing
 * hours, which is the one thing every rule here exists to prevent.
 */
export const RowProposal = Schema.Struct({
  activeSeconds: Schema.Number,
  clockifyDelta: Schema.Number,
  confidence: Schema.NullOr(Schema.Number),
  jiraDelta: Schema.Number,
  maxSeconds: Schema.Number,
  sessionCount: Schema.Number,
  signal: AttributionSignal,
  spans: Schema.Array(Span)
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
  jiraSeconds: Schema.Number,
  proposal: Schema.optional(RowProposal),
  rowId: Schema.String,
  ticketKey: Schema.String
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
  ticketKey: Schema.String
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
  /** Zero means nothing is opted in, which is the usual reason for an empty week. */
  sessionRootCount: Schema.Number,
  unattributed: Schema.Array(UnattributedDay),
  withheld: Schema.Array(WithheldRow)
})

/** What one side of a write did. Mirrors `SideOutcome` in the engine. */
export const SideOutcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Written"), seconds: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("NothingOwed") }),
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
  note: Schema.optional(Note),
  planId: Schema.String,
  rowId: Schema.String,
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
  /** Local `HH:MM` the work began. Absent lets the engine place it at local noon. */
  startClock: Schema.optional(Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{2}:\d{2}$/)))),
  ticketKey: TicketKey
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
      query: Schema.Struct({ monday: Schema.optional(Day) }),
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
