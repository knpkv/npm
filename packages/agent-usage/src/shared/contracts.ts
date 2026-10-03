/**
 * What crosses the HTTP boundary, shared by the server and the browser so both decode with the same
 * schemas. Browser-safe: no Node imports.
 *
 * @module
 */
import { Schema } from "effect"
import {
  Agent,
  BalanceReading,
  Count,
  LimitReading,
  LimitSnapshot,
  TicketTitleValue,
  Tokens,
  WindowMinutes
} from "../core/Model.js"

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String
}, { httpApiStatus: 400 }) {}

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

export const Bucket = Schema.Literals(["hour", "day", "week"])
export type Bucket = typeof Bucket.Type

export const AgentFilter = Schema.Literals(["all", "claude", "codex"])
export type AgentFilter = typeof AgentFilter.Type

const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const RangeQuery = Schema.Struct({
  from: Schema.NumberFromString.pipe(Schema.decodeTo(Millis)),
  to: Schema.NumberFromString.pipe(Schema.decodeTo(Millis))
})

export const UsageQuery = Schema.Struct({
  ...RangeQuery.fields,
  timeZone: Schema.String,
  bucket: Bucket,
  agent: AgentFilter
})
export type UsageQuery = typeof UsageQuery.Type

export const Booking = Schema.Union([
  Schema.TaggedStruct("Ticket", { key: Schema.String }),
  Schema.TaggedStruct("Repo", { name: Schema.String })
])

/** One local hour, day or week: its key (`2026-09-01`, `2026-09-01T10`) and first instant. */
export const Period = Schema.Struct({ key: Schema.String, start: Millis })
export type Period = typeof Period.Type

export const BookingSummary = Schema.Struct({
  id: Schema.String,
  booking: Booking,
  /** Null for a repo; a ticket's title is Known or Unknown with a reason. */
  title: Schema.NullOr(TicketTitleValue),
  agents: Schema.Array(Agent),
  requests: Count,
  tokens: Tokens,
  /** API-Equivalent Cost of the priced tokens only. */
  costUsd: Schema.Finite,
  /** Tokens of models with no price; their cost is unknown, not zero. */
  unpricedTokens: Count,
  unpricedModels: Schema.Array(Schema.String)
})
export type BookingSummary = typeof BookingSummary.Type

export const UsageCell = Schema.Struct({
  /** Index into `periods`. */
  period: Count,
  booking: Schema.String,
  tokens: Count,
  costUsd: Schema.Finite,
  unpricedTokens: Count
})
export type UsageCell = typeof UsageCell.Type

export const UsageReport = Schema.Struct({
  periods: Schema.Array(Period),
  /** Most API-Equivalent Cost first, then most tokens. */
  bookings: Schema.Array(BookingSummary),
  cells: Schema.Array(UsageCell),
  unpriced: Schema.Struct({ tokens: Count, models: Schema.Array(Schema.String) }),
  /** Typed keys whose project is not a Known Project, by prefix, with the requests they did not book. */
  ignoredKeys: Schema.Array(Schema.Struct({ prefix: Schema.String, requests: Count }))
})
export type UsageReport = typeof UsageReport.Type

export const LimitPoint = Schema.Struct({ at: Millis, reading: LimitReading })

export const LimitSeries = Schema.Struct({
  agent: Agent,
  label: Schema.String,
  windowMinutes: WindowMinutes,
  points: Schema.Array(LimitPoint)
})
export type LimitSeries = typeof LimitSeries.Type

export const LimitsReport = Schema.Struct({
  series: Schema.Array(LimitSeries),
  /** The newest snapshot of every series up to the range's end: what the tiles show. */
  latest: Schema.Array(LimitSnapshot),
  balances: Schema.Array(BalanceReading)
})
export type LimitsReport = typeof LimitsReport.Type

const SkipCounts = Schema.Struct({ unparseableLine: Count, missingTimestamp: Count })

export const SourceStatus = Schema.Struct({
  rootMissing: Schema.Boolean,
  filesScanned: Count,
  filesRead: Count,
  eventsAdded: Count,
  skipped: SkipCounts,
  unreadable: Schema.Array(Schema.Struct({ fileKey: Schema.String, reason: Schema.String }))
})

export const IngestStatus = Schema.Struct({
  startedAt: Millis,
  finishedAt: Millis,
  claude: SourceStatus,
  codex: SourceStatus
})

export const ServerStatus = Schema.Struct({
  machine: Schema.String,
  /** The latest finished pass; null until the first one ends. */
  ingest: Schema.NullOr(IngestStatus),
  /** Why the latest pass failed outright, if it did. */
  ingestFailure: Schema.NullOr(Schema.String),
  ticketLookupFailures: Schema.Array(Schema.String)
})
export type ServerStatus = typeof ServerStatus.Type
