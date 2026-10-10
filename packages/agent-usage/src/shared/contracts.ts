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

export const SessionsQuery = Schema.Struct({
  ...RangeQuery.fields,
  /** A Booking id as `UsageReport.bookings[].id` gives it, for example `ticket:RLY-142`. */
  booking: Schema.NonEmptyString,
  agent: AgentFilter
})
export type SessionsQuery = typeof SessionsQuery.Type

/** One agent session's usage on one Booking within a range. Never a share of a limit: limits are the account's. */
export const SessionSummary = Schema.Struct({
  agent: Agent,
  sessionId: Schema.String,
  /** First and last request inside the range. */
  firstAt: Millis,
  lastAt: Millis,
  requests: Count,
  tokens: Tokens,
  /** API-Equivalent Cost of the priced tokens only. */
  costUsd: Schema.Finite,
  unpricedTokens: Count,
  models: Schema.Array(Schema.String),
  unpricedModels: Schema.Array(Schema.String),
  branches: Schema.Array(Schema.String)
})
export type SessionSummary = typeof SessionSummary.Type

export const SessionsReport = Schema.Struct({
  booking: Schema.String,
  /** Most API-Equivalent Cost first, then the most recent. */
  sessions: Schema.Array(SessionSummary),
  /** Sessions past the list's cap, left out. */
  omitted: Count
})
export type SessionsReport = typeof SessionsReport.Type

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

/**
 * This Machine's limits as of `observedAt`, on the server's clock: what `agent-usage limits` prints.
 * Every time in it is on that same clock, so a reader elsewhere measures ages against `observedAt`
 * rather than its own clock. Limits only: balances and spend stay on the authenticated page and
 * never leave the Machine this way.
 */
export const LimitsNow = Schema.Struct({
  /**
   * The format's version. A reader pinned to another agent-usage checks it first: a newer `v` means
   * the line is not one it can read, rather than a malformed one. New snapshot sources or reasons
   * within v1 are additive; readers decode `latest` one snapshot at a time and skip what they don't know.
   */
  v: Schema.Literal(1),
  machine: Schema.NonEmptyString,
  observedAt: Schema.Int,
  latest: Schema.Array(LimitSnapshot)
})
export type LimitsNow = typeof LimitsNow.Type

/** The ranges another program may ask {@link UsageNow} for: the page's presets up to a month. */
export const UsagePreset = Schema.Literals(["24h", "7d", "30d"])
export type UsagePreset = typeof UsagePreset.Type

/** Tokens one agent's model used in one period: `period` indexes {@link UsageNow}'s `periods`. */
export const TokenCell = Schema.Struct({
  period: Count,
  agent: Agent,
  model: Schema.String,
  tokens: Count
})
export type TokenCell = typeof TokenCell.Type

/**
 * This Machine's usage over a range, on the server's clock: what `agent-usage usage` prints, for
 * another program to chart. Tokens per period, agent and model, and the limit series; nothing else.
 * No cost, balance, Booking (ticket or repo), session, path or prompt-key prefix is in it, so it may
 * leave the Machine: the herdr hub carries it across hosts. Versioned like {@link LimitsNow}.
 */
export const UsageNow = Schema.Struct({
  v: Schema.Literal(1),
  machine: Schema.NonEmptyString,
  observedAt: Schema.Int,
  range: Schema.Struct({ preset: UsagePreset, timeZone: Schema.String, from: Millis, to: Millis, bucket: Bucket }),
  periods: Schema.Array(Period),
  tokens: Schema.Array(TokenCell),
  limits: Schema.Array(LimitSeries)
})
export type UsageNow = typeof UsageNow.Type

const SkipCounts = Schema.Struct({ unparseableLine: Count, missingTimestamp: Count, oversizedLine: Count })

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
  codex: SourceStatus,
  claudeLimitSamples: SourceStatus
})

export const ServerStatus = Schema.Struct({
  machine: Schema.String,
  /** The latest finished pass; null until the first one ends. */
  ingest: Schema.NullOr(IngestStatus),
  /** Why the latest pass failed outright, if it did. */
  ingestFailure: Schema.NullOr(Schema.String),
  /** Why the latest Claude limit poll could not be stored, if it could not. */
  limitsFailure: Schema.NullOr(Schema.String),
  ticketLookupFailures: Schema.Array(Schema.String)
})
export type ServerStatus = typeof ServerStatus.Type

/**
 * What the live-updates socket sends: one counter per read, moved after the store has committed
 * whatever changed it. A client refetches each read whose counter moved since it last saw one.
 */
export const LiveVersions = Schema.Struct({
  usage: Count,
  limits: Count,
  status: Count
})
export type LiveVersions = typeof LiveVersions.Type
