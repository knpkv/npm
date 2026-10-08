/**
 * Reconcile time logged in Clockify against Jira worklogs over a period.
 *
 * **Mental model**
 *
 * - **Per ticket per day**: both sides are bucketed by `(ticketKey, localDay)` and their durations
 *   summed, so splitting one day's work into several entries on either side doesn't create false
 *   discrepancies. A {@link ReconcileRow} is one such bucket with the seconds logged on each side.
 * - **Direction = source of truth**: `clockify-to-jira` treats Clockify as authoritative and fills
 *   the gap *into Jira*; `jira-to-clockify` does the reverse. Only the under-logged side is ever
 *   written to — reconciling never deletes.
 * - **Apply is per-row and additive**: fixing a row posts the *delta* (source − target) to the target,
 *   so re-running after a partial fix converges instead of double-counting.
 *
 * **Gotchas**
 *
 * - Jira worklogs carry no Clockify id, so matching is heuristic (ticket + day), never entry-to-entry.
 * - Clockify entries must encode the ticket as `[KEY] …` or `KEY: …` in the description; entries
 *   without a parseable key remain outside reconciliation proposals. Running entries are excluded from totals.
 * - Days are local calendar days so the buckets line up with how a person reads their timesheet.
 *
 * @module
 */
import { ClockifyApi } from "@knpkv/clockify-api-client"
import type { make as makeJiraApi } from "@knpkv/jira-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import {
  activeWindows,
  type AgentChoice,
  attributeSession,
  bothSides,
  buildSessionProposals,
  deterministicAttribution,
  expandHomePath,
  mergeSpansWithinDays,
  type ReconcileSides,
  type SessionProposal,
  splitCredits,
  splitSessionAttribution,
  type TicketDayCredit,
  type UnattributedDayCredit
} from "../agent/sessions.js"
import * as SourceConsumption from "../agent/sourceConsumption.js"
import * as WriterGuard from "../cli/writerGuard.js"
import { CONNECT_JIRA_COMMAND, NOT_LOGGED_IN_HINT } from "../utils/hints.js"
import { localDay, nextLocalMidnight, splitIntervalByLocalDay } from "../utils/time.js"
import { AgentSessionReader } from "./AgentSessionReader.js"
import { ConfigService } from "./ConfigService.js"
import { HomeDirectory } from "./HomeDirectory.js"
import { postJiraWorklog } from "./internal/JiraWorklogPost.js"
import { retryTransport } from "./internal/retryTransport.js"
import { JiraAccess } from "./JiraAccess.js"
import { readJiraDeletionEvidence } from "./ProviderDeletion.js"
import {
  type ClockifyWriteSnapshot,
  type JiraWriteSnapshot,
  type JiraWriteState,
  make as makeProviderSnapshots
} from "./ProviderSnapshots.js"
import { jiraWorklogDescription, type RecordedEntry } from "./SavedEntries.js"
import {
  type AttributionChoice,
  type CandidateFact,
  SessionAttributor,
  type SessionDescribeAnswer
} from "./SessionAttributor.js"
import { type SourceBinding, type SourceIdentity, SourceLedger } from "./SourceLedger.js"
import { candidateFact, type RankingFacts, readRankingFacts, ticketPriority } from "./TicketRanking.js"
import { type JiraWorklogOutcome, TimerService } from "./TimerService.js"

export type { RecordedEntry } from "./SavedEntries.js"

/** Concurrent Jira worklog reads per tally. Bounded so a large week does not trip rate limits. */
const JIRA_WORKLOG_READ_CONCURRENCY = 8

/** Server-private source evidence supplied only by the confirmed agent planner. */
export interface SourceSegment {
  readonly rowId: string
  readonly sourceStartMs: number
  readonly startMs: number
  readonly endMs: number
  readonly seconds: number
  /** Server-held identity expected by a retained confirmation, never a browser field. */
  readonly expectedScope?: string | undefined
  /** Provider identity that supplied this source evidence, checked again before the target write. */
  readonly expectedSource?: {
    readonly provider: "clockify" | "jira"
    readonly scope: string
  } | undefined
}

/** Private provider/account identity for a retained read. Never serialize it to the week DTO. */
export interface ProviderScopes {
  readonly clockify: string | null
  readonly jira: string | null
}

/** Server-private reason Jira cannot currently authorize source-backed writes. */
export type JiraAvailability = "verified" | "not-logged-in" | "unverified"

/** A durable source write can be refused before Jira is called when its account cannot be verified. */
export type JiraWriteOutcome = JiraWorklogOutcome | { readonly _tag: "VerificationUnavailable" }

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Which side is the source of truth when filling a gap. */
export type ReconcileDirection = "clockify-to-jira" | "jira-to-clockify"

/** Re-exported so a caller of {@link ReconcileServiceContract} needs one import, not two. */
export type { ReconcileSides } from "../agent/sessions.js"
export { bothSides } from "../agent/sessions.js"

/** A half-open period [from, to). */
export interface ReconcilePeriod {
  readonly from: Date
  readonly to: Date
}

/** When one recorded entry says the work happened, and which system says so. */
export interface RecordedInterval {
  readonly entry?: RecordedEntry
  readonly startMs: number
  readonly endMs: number
  readonly source: "clockify" | "jira"
}

/** One `(ticket, day)` bucket with the time logged on each side. */
export interface ReconcileRow {
  readonly ticketKey: string
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  /**
   * When the recorded time happened, ascending — the entries behind the totals rather than a
   * replacement for them. The totals stay authoritative on *how much*: a Jira worklog states a
   * duration from its start, so its interval is derived rather than observed, and an entry crossing
   * local midnight contributes one interval to each day it touches.
   *
   * Carried because a week drawn as a calendar needs to know *when*, and the tally that answers
   * "how much" reads these anyway before summing them away.
   */
  readonly intervals: ReadonlyArray<RecordedInterval>
  /**
   * The Clockify entry description(s) for this bucket, ticket-prefix stripped and combined.
   * Used as the Jira worklog comment when filling clockify→jira. null when nothing meaningful.
   */
  readonly clockifyDescription: string | null
}

/** Private write provenance for one direction row. Never serialized to an HTTP client. */
export type DirectionSourceDecision =
  | { readonly _tag: "Ordinary" }
  | { readonly _tag: "Bound"; readonly source: SourceSegment; readonly startedAt: Date }
  | { readonly _tag: "Refused"; readonly message: string }

/** One complete direction read whose private provider evidence remains attached to its resolver. */
export interface DirectionComparison {
  readonly rows: ReadonlyArray<ReconcileRow>
  readonly resolveSource: (
    row: ReconcileRow,
    direction: ReconcileDirection,
    seconds: number
  ) => Effect.Effect<DirectionSourceDecision, ReconcileError>
}

interface VerifiedInterval {
  readonly startMs: number
  readonly endMs: number
}

const mergeIntervals = (intervals: ReadonlyArray<VerifiedInterval>): ReadonlyArray<VerifiedInterval> => {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  const merged: Array<VerifiedInterval> = []
  for (const interval of sorted) {
    const previous = merged.at(-1)
    if (previous === undefined || interval.startMs > previous.endMs) {
      merged.push(interval)
    } else if (interval.endMs > previous.endMs) {
      merged[merged.length - 1] = { startMs: previous.startMs, endMs: interval.endMs }
    }
  }
  return merged
}

const subtractIntervals = (
  source: VerifiedInterval,
  consumed: ReadonlyArray<VerifiedInterval>
): ReadonlyArray<VerifiedInterval> => {
  let remaining: ReadonlyArray<VerifiedInterval> = [source]
  for (const interval of mergeIntervals(consumed)) {
    remaining = remaining.flatMap((candidate) => {
      if (interval.endMs <= candidate.startMs || interval.startMs >= candidate.endMs) return [candidate]
      return [
        ...(interval.startMs > candidate.startMs
          ? [{ startMs: candidate.startMs, endMs: Math.min(interval.startMs, candidate.endMs) }]
          : []),
        ...(interval.endMs < candidate.endMs
          ? [{ startMs: Math.max(interval.endMs, candidate.startMs), endMs: candidate.endMs }]
          : [])
      ]
    })
  }
  return remaining.filter((interval) => interval.endMs > interval.startMs)
}

export class ReconcileError extends Data.TaggedError("ReconcileError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Jira floors worklogs to the minute. Clockify proposals retain exact positive seconds;
 * each provider's proposal floor matches its own confirmation floor.
 */
const MINIMUM_PROPOSAL_SECONDS = 60

/** A day withheld from proposals, with the reason stated so it never reads as "nothing to log". */
export interface ExcludedDay {
  readonly day: string
  readonly reason: string
}

/**
 * How many Coding Agent calls may be in flight at once.
 *
 * Each call spawns a CLI process that takes tens of seconds, so running them one at a time makes
 * the command look hung. But these processes are heavy and contend for the machine: measured at
 * four, a batch took ~75s and every call in the *second* batch hit the timeout, turning
 * parallelism into lost attributions. Two keeps calls comfortably inside their timeout while still
 * halving the wall clock — faster in practice than four, because nothing is thrown away.
 */
const ATTRIBUTOR_CONCURRENCY = 2

/**
 * Characters of digest a *description* prompt spends on one work item.
 *
 * Smaller than a whole session digest on purpose: what was worked on is stated early, and a bucket
 * that spans four sessions must not spend four times the budget to say one sentence.
 */
const DESCRIBE_DIGEST_CHARS = 3_000

/**
 * How much digest text one Coding Agent call may carry, and how many sessions.
 *
 * Sessions are batched because a call's cost is almost entirely fixed: measured against the real
 * CLI, one session cost $0.080 and 6.3s while seven together cost $0.049 and 10.2s. Chunking rather
 * than one giant call bounds two things — the prompt, and the damage a single timeout does, since a
 * failed chunk costs the attributions of every session in it.
 */
const ATTRIBUTOR_BATCH_CHARS = 24_000
const ATTRIBUTOR_BATCH_SESSIONS = 8

/** Split requests into calls, cut on whichever bound is reached first. */
const batchRequests = <T extends { readonly digest: string }>(
  requests: ReadonlyArray<T>
): ReadonlyArray<ReadonlyArray<T>> => {
  const batches: Array<Array<T>> = []
  let current: Array<T> = []
  let chars = 0
  for (const request of requests) {
    const tooManyChars = current.length > 0 && chars + request.digest.length > ATTRIBUTOR_BATCH_CHARS
    if (tooManyChars || current.length >= ATTRIBUTOR_BATCH_SESSIONS) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(request)
    chars += request.digest.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * How far attribution may go. `"deterministic"` stops at branch, path, and Standing Attribution;
 * `"full"` also wakes a Coding Agent for whatever those leave unplaced.
 */
export type AttributionMode = "full" | "deterministic"

/** What a Coding Agent decided about one session, as reported to a progress listener. */
export type AttributionOutcome =
  | { readonly _tag: "Placed"; readonly ticketKey: string; readonly confidence: number }
  | { readonly _tag: "Declined" }
  | { readonly _tag: "Unavailable"; readonly message: string }

/**
 * Progress a caller can report while a run is working, including live visible agent output.
 * `AgentActivity` carries batch identity while a call is pending; it never advances completion counts.
 *
 * `SessionAttributed` fires per completed call rather than only at the end: the calls take tens of
 * seconds each, so a start-and-finish pair leaves minutes of silence in between — which is
 * indistinguishable from a hang, and was in fact reported as one.
 */
export type SessionProposalProgress =
  | {
    readonly _tag: "AgentActivity"
    readonly batch: number
    readonly batches: number
    readonly kind: "status" | "text" | "request" | "response"
    readonly text: string
  }
  | { readonly _tag: "ReadingRecordedTime"; readonly sides: ReconcileSides }
  | { readonly _tag: "SessionsRead"; readonly count: number }
  | {
    readonly _tag: "AttributingSessions"
    readonly count: number
    /** Calls this will take. Fewer than `count`, because sessions are batched into each call. */
    readonly calls: number
  }
  | {
    readonly _tag: "SessionAttributed"
    readonly done: number
    readonly total: number
    /** Where the session ran, so the line names something recognisable rather than a UUID. */
    readonly gitBranch: string | null
    readonly cwd: string
    readonly outcome: AttributionOutcome
  }
  | {
    readonly _tag: "SessionsAttributed"
    readonly placed: number
    readonly declined: number
    readonly unavailable: number
  }

/**
 * Everything one `--agent` run derived. Deliberately reports more than it proposes: hours that
 * could not be placed, or were placed with too little confidence, stay visible instead of being
 * dropped.
 */
/** Closed Clockify time without a Jira key. Visible, but never a reconciliation candidate. */
export interface UnlinkedClockifyEntry {
  readonly entry?: RecordedEntry
  readonly day: string
  readonly seconds: number
  readonly description: string | null
  readonly startMs: number
  readonly endMs: number
}

export interface SessionProposalReport {
  /** Review holds on the providers in this read, independent of readable source evidence. */
  readonly writeBlocked?: SessionProposal["writeBlocked"]
  /** Original per-session activity windows, before ticket/day merging; retained for saved-entry correlation. */
  readonly sessionEvidence?: ReadonlyArray<{
    readonly sessionId: string
    readonly ticketKey: string | null
    readonly spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
  }>
  /** Credited session evidence before subtracting logged time or excluding running-timer days. */
  readonly attributed: ReadonlyArray<TicketDayCredit>
  /** Proposed Worklogs, ready for row-by-row confirmation. */
  readonly proposals: ReadonlyArray<SessionProposal>
  /**
   * What Clockify and Jira already hold over the period, bucketed by Issue Key and day — the same
   * rows {@link ReconcileServiceContract.compare} returns, including buckets no session evidences.
   *
   * On the report because a run already reads both sides to size its proposals: a surface that shows
   * allocated time beside proposable time would otherwise tally two remote services a second time to
   * learn what this one already knows.
   */
  readonly recorded: ReadonlyArray<ReconcileRow>
  readonly unlinkedClockify: ReadonlyArray<UnlinkedClockifyEntry>
  /** Server-private ID-verified source links, projected without provider/account identifiers. */
  readonly sourceEntries?: ReadonlyArray<SourceConsumption.ResolvedEntry> | undefined
  /** Provider identities used by this read, held only on the server. */
  readonly sourceScopes?: ProviderScopes | undefined
  /** Jira write authority for this read. Compatibility totals never upgrade this value. */
  readonly jiraAvailability?: JiraAvailability | undefined
  /** Which systems this run read. A side that is out reports zero because it was never asked. */
  readonly sides: ReconcileSides
  /** Attributed below the confidence floor — reported, never offered. */
  readonly withheld: ReadonlyArray<TicketDayCredit>
  /** Hours no Attribution Signal could place. */
  readonly unattributed: ReadonlyArray<UnattributedDayCredit>
  /** Raw active windows unioned per ignored ticket/day before sharing. These hours are explanatory, not additive. */
  readonly ignored: ReadonlyArray<{ readonly ticketKey: string; readonly day: string; readonly seconds: number }>
  /** Sorted global ignore policy applied by this read, including tickets with no activity in the period. */
  readonly ignoredTickets: ReadonlyArray<string>
  readonly excludedDays: ReadonlyArray<ExcludedDay>
  /** False when a Coding Agent was needed for at least one session but could not be reached. */
  readonly attributorAvailable: boolean
  /** In-scope Agent Sessions read for this window. */
  readonly sessionCount: number
  /** Configured Session Roots. Zero means nothing is opted in, which is the usual reason for an empty run. */
  readonly sessionRootCount: number
  /**
   * Coding Agent *calls* this run made — not sessions asked. Sessions are batched, so a week that
   * needs seven attributions costs one or two calls. Zero on a day of ticket-branch work.
   */
  readonly attributorCalls: number
  /**
   * Digest by session id, for the sessions behind these rows.
   *
   * Carried on the report because describing a row's work needs its prompts, and by the time a user
   * has confirmed a row the transcripts have long since been read. Reading them twice to answer a
   * question the first pass could already answer would be the only alternative.
   */
  readonly digests: ReadonlyMap<string, string>
}

/** Raw ignored presence, unioned per ticket/day so parallel sessions on one key never duplicate it. */
const ignoredCredits = (
  evidence: NonNullable<SessionProposalReport["sessionEvidence"]>,
  ignoredTickets: ReadonlySet<string>
): SessionProposalReport["ignored"] => {
  const windowsByTicket = new Map<string, Array<{ readonly startMs: number; readonly endMs: number }>>()
  for (const window of evidence) {
    if (window.ticketKey === null || !ignoredTickets.has(window.ticketKey)) continue
    windowsByTicket.set(window.ticketKey, [...(windowsByTicket.get(window.ticketKey) ?? []), ...window.spans])
  }
  return [...windowsByTicket].flatMap(([ticketKey, spans]) => {
    const secondsByDay = new Map<string, number>()
    for (const span of mergeSpansWithinDays(spans)) {
      const day = localDay(new Date(span.startMs))
      secondsByDay.set(day, (secondsByDay.get(day) ?? 0) + (span.endMs - span.startMs) / 1000)
    }
    return [...secondsByDay].map(([day, seconds]) => ({ ticketKey, day, seconds: Math.floor(seconds) }))
  }).sort((a, b) => a.ticketKey.localeCompare(b.ticketKey) || a.day.localeCompare(b.day))
}

/**
 * Provider totals that may size a write. Compatibility Jira rows remain visible, but cannot settle
 * an executable gap until the same credential and account have been verified.
 *
 * @internal
 */
export const recordedForExecution = (
  recorded: ReadonlyArray<ReconcileRow>,
  jiraAvailability: JiraAvailability | undefined
): ReadonlyArray<ReconcileRow> =>
  jiraAvailability === undefined || jiraAvailability === "verified"
    ? recorded
    : recorded.map((row) => ({
      ...row,
      jiraSeconds: 0,
      intervals: row.intervals.filter((interval) => interval.source !== "jira" && interval.entry?.source !== "jira")
    }))

export interface RefreshRecordedOptions {
  /** Jira issues that must be read directly even when its eventually consistent JQL omits them. */
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined
}

export interface ReconcileServiceContract {
  /** Recheck provider totals and running timers using already attributed session evidence. */
  readonly refreshRecordedTime: (
    period: ReconcilePeriod,
    previous: SessionProposalReport,
    options?: RefreshRecordedOptions | undefined
  ) => Effect.Effect<SessionProposalReport, ReconcileError>

  /**
   * Compare Clockify entries and Jira worklogs over the period, bucketed by ticket+day.
   *
   * `sides` narrows which systems are read. A side that is out is never called, and reports zero
   * — which is why every caller that subtracts these totals must know the sides it asked for.
   */
  readonly compare: (
    period: ReconcilePeriod,
    options?: { readonly sides?: ReconcileSides | undefined }
  ) => Effect.Effect<ReadonlyArray<ReconcileRow>, ReconcileError>
  /** Read direction rows and retain their private provider evidence for provenance resolution. */
  readonly compareDirection: (period: ReconcilePeriod) => Effect.Effect<DirectionComparison, ReconcileError>
  /**
   * Post `seconds` of work to Jira for `(ticketKey, day)`, with an optional worklog comment.
   *
   * `startedAt` anchors the worklog to when the work actually began. Without it the entry lands at
   * local noon, which is all a direction-mode row knows — it has a day and a duration and no
   * interval. Agent mode does know, so it says so rather than inventing a midday block.
   */
  readonly applyToJira: (
    ticketKey: string,
    day: string,
    seconds: number,
    comment?: string,
    startedAt?: Date,
    source?: SourceSegment
  ) => Effect.Effect<JiraWriteOutcome>
  /**
   * Create a closed Clockify entry of `seconds` for `(ticketKey, day)`. Resolves true on success.
   *
   * `note` records where the time came from. It is provenance for a human reading the entry months
   * later, never load-bearing: editing it in Clockify's web UI must not re-enable double-logging,
   * because the tally keys on the `[KEY]` prefix and the day, not on this text.
   */
  readonly applyToClockify: (
    ticketKey: string,
    day: string,
    seconds: number,
    note?: string,
    startedAt?: Date,
    source?: SourceSegment
  ) => Effect.Effect<boolean, ReconcileError>
  /**
   * One sentence per proposal saying what was worked on, read off the sessions behind it.
   *
   * Asked *after* rows are confirmed, so nothing is spent describing a row nobody writes. Total: a
   * failure, a timeout or an unreachable Coding Agent yields nulls rather than an error — a missing
   * sentence must never cost a write that is otherwise correct.
   */
  readonly describeProposals: (options: {
    readonly proposals: ReadonlyArray<SessionProposal>
    readonly digests: ReadonlyMap<string, string>
    readonly summaries?: ReadonlyMap<string, string> | undefined
    /** Called when a degraded null came from provider failure rather than a valid empty answer. */
    readonly onUnavailable?: ((message: string) => Effect.Effect<void>) | undefined
  }) => Effect.Effect<ReadonlyArray<string | null>>
  /**
   * Derive Proposed Worklogs from local Agent Sessions over the period. Reads only — writing a
   * confirmed proposal goes back through {@link applyToJira} and {@link applyToClockify}, so no
   * second write path exists.
   */
  readonly proposeFromSessions: (
    period: ReconcilePeriod,
    options?: {
      /** Reported as the run progresses. Consulting a Coding Agent is slow enough to need this. */
      readonly onProgress?: (progress: SessionProposalProgress) => Effect.Effect<void>
      /**
       * Which Attribution Signals may be spent on. `"deterministic"` never wakes a Coding Agent, so
       * a session no branch, path, or Standing Attribution places is reported as unattributed rather
       * than guessed at. Default `"full"`.
       *
       * This is the knob a *repeating* caller needs: a session's Issue Key does not change, so
       * re-asking a model for it on every tick spends a call a minute to be told the same thing.
       */
      readonly attribution?: AttributionMode
      /**
       * Which systems this run is about. Both by default.
       *
       * A side that is out is not read, proposed for, or written to. For someone who tracks in one
       * system that is the difference between a working run and a run that fails on a service they
       * do not use.
       */
      readonly sides?: ReconcileSides | undefined
    }
  ) => Effect.Effect<SessionProposalReport, ReconcileError>
}

export class ReconcileService extends Context.Service<ReconcileService, ReconcileServiceContract>()(
  "jcf/ReconcileService"
) {}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * One digest per proposal: the sessions behind it, joined and bounded.
 *
 * Bounded twice over — each session's digest is already capped when the transcript is read, and a
 * bucket that ran across several sessions is truncated again here, because a prompt that grows with
 * the number of sessions in a day is a prompt that eventually times out.
 */
export const bucketDigest = (
  proposal: Pick<SessionProposal, "sessionIds">,
  digests: ReadonlyMap<string, string>
): string => {
  const parts: Array<string> = []
  let length = 0
  for (const sessionId of proposal.sessionIds) {
    const digest = digests.get(sessionId)?.trim()
    if (digest === undefined || digest === "") continue
    const remaining = DESCRIBE_DIGEST_CHARS - length
    if (remaining <= 0) break
    const clipped = digest.length > remaining ? digest.slice(0, remaining) : digest
    parts.push(clipped)
    length += clipped.length + 1
  }
  return parts.join("\n")
}

/**
 * Standing Attributions with `~` resolved, so the form the config command stores actually matches.
 *
 * `jcf config set session-ticket ~/dev/docs PROJ-42` deliberately keeps the `~` — a config file that
 * reads back the way it was typed is the point — but attribution compares against an absolute
 * working directory, where `~/dev/docs` can never match anything. Session Roots have always been
 * expanded on read for exactly this reason; this is the same treatment for the other prefix.
 */
export const expandedStandingMap = (
  map: Readonly<Record<string, string>>,
  home: string
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map).map(([prefix, ticketKey]) => [expandHomePath(prefix, home), ticketKey])
  )

/** Parse a ticket key from a Clockify description (`[KEY] summary` or `KEY: summary`). */
export const parseTicketKey = (description: string | null | undefined): string | null => {
  const desc = description ?? ""
  const bracket = desc.match(/^\[\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*\]/)
  const bracketKey = bracket?.[1]
  if (bracketKey !== undefined && bracketKey !== "") return bracketKey.trim()
  const colon = desc.match(/^([A-Za-z][A-Za-z0-9]*-\d+):/)
  const colonKey = colon?.[1]
  if (colonKey !== undefined && colonKey !== "") return colonKey.trim()
  return null
}

/**
 * Local calendar day (`YYYY-MM-DD`) of an instant — matches how a timesheet reads.
 * Re-exported from the shared time utilities so every day bucket in jcf (reconcile rows,
 * Attributed Intervals, Proposed Worklogs) is keyed by one definition.
 */
export { localDay }

/** Strip the leading ticket marker (`[KEY] ` or `KEY: `) so the remainder reads as a plain note. */
export const stripTicketPrefix = (description: string): string =>
  description
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^[A-Za-z][A-Za-z0-9]*-\d+:\s*/, "")
    .trim()

/**
 * Combine the Clockify descriptions in a bucket into one Jira worklog comment.
 * Strips the redundant ticket prefix, drops blanks, dedupes, and joins with `; `.
 * Returns null when nothing meaningful remains (so no empty comment is posted).
 */
export const combineDescriptions = (descriptions: ReadonlyArray<string | null | undefined>): string | null => {
  const seen = new Set<string>()
  const parts: Array<string> = []
  for (const raw of descriptions) {
    const text = stripTicketPrefix(raw ?? "")
    if (text !== "" && !seen.has(text)) {
      seen.add(text)
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join("; ") : null
}

/** A `(ticketKey, day) → seconds` tally accumulated from one side's entries. */
export type DayTally = ReadonlyArray<{
  readonly entry?: RecordedEntry
  readonly ticketKey: string
  readonly day: string
  readonly seconds: number
  /** Original entry description (Clockify side) — combined into the worklog comment. */
  readonly description?: string | null
  /** When this slice of the entry ran. Absent when the side reported no usable interval. */
  readonly startMs?: number | undefined
  readonly endMs?: number | undefined
}>

const key = (ticketKey: string, day: string) => `${ticketKey}\u0000${day}`

/**
 * Merge two per-`(ticket, day)` tallies into a sorted row list. Pure — the testable core.
 * Buckets present on either side appear; rows are sorted by day then ticket for stable output.
 */
export const buildReconcileRows = (clockify: DayTally, jira: DayTally): ReadonlyArray<ReconcileRow> => {
  const clockifyByKey = new Map<string, number>()
  const jiraByKey = new Map<string, number>()
  const descByKey = new Map<string, Array<string | null | undefined>>()
  const intervalsByKey = new Map<string, Array<RecordedInterval>>()
  const meta = new Map<string, { ticketKey: string; day: string }>()

  const addInterval = (k: string, entry: DayTally[number], source: RecordedInterval["source"]) => {
    if (entry.startMs === undefined || entry.endMs === undefined) return
    intervalsByKey.set(k, [
      ...(intervalsByKey.get(k) ?? []),
      {
        endMs: entry.endMs,
        source,
        startMs: entry.startMs,
        ...(entry.entry !== undefined && { entry: entry.entry })
      }
    ])
  }

  for (const e of clockify) {
    const k = key(e.ticketKey, e.day)
    clockifyByKey.set(k, (clockifyByKey.get(k) ?? 0) + e.seconds)
    const descs = descByKey.get(k) ?? []
    descs.push(e.description)
    descByKey.set(k, descs)
    addInterval(k, e, "clockify")
    if (!meta.has(k)) meta.set(k, { ticketKey: e.ticketKey, day: e.day })
  }
  for (const e of jira) {
    const k = key(e.ticketKey, e.day)
    jiraByKey.set(k, (jiraByKey.get(k) ?? 0) + e.seconds)
    addInterval(k, e, "jira")
    if (!meta.has(k)) meta.set(k, { ticketKey: e.ticketKey, day: e.day })
  }

  return [...meta.entries()]
    .map(([k, { day, ticketKey }]) => ({
      ticketKey,
      day,
      clockifySeconds: clockifyByKey.get(k) ?? 0,
      jiraSeconds: jiraByKey.get(k) ?? 0,
      clockifyDescription: combineDescriptions(descByKey.get(k) ?? []),
      intervals: (intervalsByKey.get(k) ?? []).sort((a, b) => a.startMs - b.startMs)
    }))
    .sort((a, b) => (a.day === b.day ? a.ticketKey.localeCompare(b.ticketKey) : a.day.localeCompare(b.day)))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface RawWorklog {
  readonly id?: string
  readonly comment?: unknown
  readonly author?: { readonly accountId?: string } | undefined
  readonly started?: string | undefined
  readonly timeSpentSeconds?: number | undefined
}

const ReadableWorklogFields = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/\S/u)),
  author: Schema.Struct({ accountId: Schema.NonEmptyString }),
  started: Schema.NonEmptyString,
  timeSpentSeconds: Schema.Natural
})

const isReadableWorklog = Schema.is(ReadableWorklogFields)
type ReadableWorklog = RawWorklog & typeof ReadableWorklogFields.Type

const issueKey = <UnparsedInput>(issue: UnparsedInput): string | null => {
  if (!Predicate.isObject(issue)) return null
  const key = issue.key
  return Predicate.isString(key) ? key : null
}

const toRawWorklog = <UnparsedInput>(value: UnparsedInput): RawWorklog | null => {
  if (!Predicate.isObject(value)) return null
  const author = Predicate.isObject(value.author) ? value.author : undefined
  const accountId = author?.accountId
  return {
    ...((Predicate.isString(value.id)) && { id: value.id }),
    comment: value.comment,
    ...((Predicate.isString(accountId)) && { author: { accountId } }),
    ...((Predicate.isString(value.started)) && { started: value.started }),
    ...((Predicate.isNumber(value.timeSpentSeconds)) && { timeSpentSeconds: value.timeSpentSeconds })
  }
}

export const layer = Layer.effect(
  ReconcileService,
  Effect.gen(function*() {
    const jira = yield* JiraApiClient
    const jiraAccess = yield* JiraAccess
    const config = yield* ConfigService
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const timer = yield* TimerService
    const sessionReader = yield* AgentSessionReader
    const attributor = yield* SessionAttributor
    const sourceLedger = yield* SourceLedger

    const provideGuard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ConfigService, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path)
      )

    const providerSnapshots = yield* makeProviderSnapshots
    const clockifyWriteSnapshot = providerSnapshots.clockify.pipe(
      Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
    )
    const jiraWriteState = providerSnapshots.jira
    const jiraWriteSnapshot: Effect.Effect<JiraWriteSnapshot | null> = jiraWriteState.pipe(
      Effect.map((state) => state.snapshot)
    )

    /**
     * How many entries to ask Clockify for at a time, and how many pages to accept.
     *
     * The page size is explicit because Clockify's own default is 50 — small enough that an ordinary
     * week silently arrives truncated, and a truncated *recorded* side is the dangerous direction:
     * every caller subtracts this tally from something and writes the difference, so an entry that
     * fell off the page reads as time Clockify never had.
     */
    const CLOCKIFY_PAGE_SIZE = 200
    const CLOCKIFY_MAX_PAGES = 50

    // Tally Clockify entries in the period by (ticket, day).
    const clockifyTally = (period: ReconcilePeriod, pinned?: ClockifyWriteSnapshot) =>
      Effect.gen(function*() {
        const { auth, client } = pinned ?? (yield* clockifyWriteSnapshot)

        const getPage = (page: number) =>
          client.getTimeEntries(auth.workspaceId, auth.userId, {
            params: {
              start: period.from.toISOString(),
              end: period.to.toISOString(),
              page,
              "page-size": CLOCKIFY_PAGE_SIZE
            }
          }).pipe(
            Effect.mapError((e) => new ReconcileError({ message: `Clockify fetch failed: ${e.message}`, cause: e }))
          )

        const entries = []
        let pages = 0
        // Stops on an *empty* page rather than a short one. Clockify is free to serve fewer entries
        // than the page size asked for, and treating a short page as the last one would truncate
        // exactly as reading a single page did — just less often, and so less visibly.
        for (; pages < CLOCKIFY_MAX_PAGES; pages++) {
          const batch = yield* getPage(pages + 1)
          if (batch.length === 0) break
          for (const entry of batch) entries.push(entry)
        }
        if (pages === CLOCKIFY_MAX_PAGES) {
          // Failing costs a run. Proceeding on a partial tally costs someone a duplicated day.
          return yield* new ReconcileError({
            message: "Clockify returned more entries than this run will read; narrow the window."
          })
        }

        const tally: Array<{
          ticketKey: string
          day: string
          seconds: number
          description: string | null
          entry: RecordedEntry
          startMs: number
          endMs: number
        }> = []
        const unlinked: Array<UnlinkedClockifyEntry> = []
        const fromMs = period.from.getTime()
        const toMs = period.to.getTime()
        for (const entry of entries) {
          const ticketKey = parseTicketKey(entry.description)
          const start = entry.timeInterval?.start
          const end = entry.timeInterval?.end
          // A missing end is a running timer. A completed entry with missing or malformed bounds
          // cannot be treated as absent: doing so makes its time look available for another write.
          if (end === undefined || end === null) continue
          if (start === undefined || start === null) {
            return yield* new ReconcileError({ message: "Clockify returned an incomplete entry" })
          }
          const startMs = new Date(start).getTime()
          const endMs = new Date(end).getTime()
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return yield* new ReconcileError({ message: "Clockify returned an incomplete entry" })
          }
          if (endMs <= fromMs || startMs >= toMs) continue
          for (
            const bucket of splitIntervalByLocalDay(
              Math.max(startMs, fromMs),
              Math.min(Math.max(startMs, endMs), toMs)
            )
          ) {
            const slice = {
              ...bucket,
              description: entry.description ?? null,
              entry: {
                id: entry.id,
                source: "clockify",
                ticketKey,
                startMs,
                endMs,
                description: entry.description ?? null
              } satisfies RecordedEntry
            }
            if (ticketKey === null) unlinked.push(slice)
            else tally.push({ ...slice, ticketKey })
          }
        }
        return { tally, unlinked }
      })

    /** Read every Jira page before treating an absent provider ID as deletion evidence. */
    const readJiraWorklogs = Effect.fn("ReconcileService.readJiraWorklogs")(function*(
      client: ReturnType<typeof makeJiraApi>,
      issueKey: string,
      startedAfter: number,
      startedBefore: number
    ) {
      const worklogs: Array<ReadableWorklog> = []
      const seenIds = new Set<string>()
      let nextStartAt = 0
      let expectedTotal: number | undefined
      for (;;) {
        const page = yield* retryTransport(client.getIssueWorklog(issueKey, {
          params: { startAt: nextStartAt, startedAfter, startedBefore }
        })).pipe(
          Effect.mapError((cause) =>
            new ReconcileError({ message: `Jira worklog fetch failed for ${issueKey}: ${String(cause)}`, cause })
          )
        )
        const { maxResults, startAt, total, worklogs: entries } = page
        if (
          startAt !== nextStartAt ||
          maxResults === undefined || !Number.isSafeInteger(maxResults) || maxResults < 0 ||
          total === undefined || !Number.isSafeInteger(total) || total < 0 ||
          entries === undefined || entries.length > maxResults ||
          (expectedTotal !== undefined && total !== expectedTotal) ||
          startAt + entries.length > total ||
          (entries.length === 0 && startAt < total)
        ) {
          return yield* new ReconcileError({ message: `Jira returned an incomplete worklog page for ${issueKey}` })
        }
        expectedTotal = total
        for (const entry of entries) {
          const parsed = toRawWorklog(entry)
          if (parsed?.id === undefined) {
            return yield* new ReconcileError({
              message: `Jira returned a worklog without an ID for ${issueKey}; session consumption needs manual review`
            })
          }
          if (
            !isReadableWorklog(parsed) ||
            !Number.isFinite(new Date(parsed.started).getTime()) ||
            seenIds.has(parsed.id)
          ) {
            return yield* new ReconcileError({ message: `Jira returned inconsistent worklogs for ${issueKey}` })
          }
          seenIds.add(parsed.id)
          worklogs.push(parsed)
        }
        nextStartAt += entries.length
        if (nextStartAt === total) return worklogs
      }
    })

    // Tally the current user's Jira worklogs in the period by (ticket, day).
    const jiraTally = (
      period: ReconcilePeriod,
      requiredIssueKeys: ReadonlyArray<string> = [],
      pinned: JiraWriteSnapshot | null | undefined = undefined,
      /**
       * `window` searches every issue I logged in the period and adds the required keys;
       * `required-only` reads just the required keys, to top up a tally that already searched.
       */
      scope: "window" | "required-only" = "window"
    ) =>
      Effect.gen(function*() {
        // A verified snapshot pins the account, site and credential-backed client for every page.
        // Falling back is only for a side without a usable write credential; that side cannot be
        // written because its source scope remains null, but independent providers may still proceed.
        const snapshot = pinned === undefined ? yield* jiraWriteSnapshot : pinned
        const client = snapshot?.client ?? jira
        const connection = yield* jiraAccess.connection.pipe(
          Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
        )
        const cachedAccountId = Option.isSome(connection) && connection.value.accountId !== ""
          ? connection.value.accountId
          : undefined
        if (snapshot !== null && snapshot !== undefined && cachedAccountId !== snapshot.accountId) {
          return yield* new ReconcileError({
            message: "The cached Jira account does not match the verified credential"
          })
        }
        const accountId = snapshot?.accountId ?? cachedAccountId
        if (accountId === undefined || accountId === "") {
          return yield* new ReconcileError({
            message: Option.isNone(connection)
              ? NOT_LOGGED_IN_HINT
              : `Jira did not say which account is connected. Run ${CONNECT_JIRA_COMMAND} again.`
          })
        }

        const fromMs = period.from.getTime()
        const from = period.from
        // Jira indexes a worklog by its start day. Include the prior local day so an overnight
        // worklog can contribute the slice that overlaps this period's first day.
        const lookupFromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1).getTime()
        const fromDay = localDay(new Date(lookupFromMs))
        // `period.to` is exclusive and `worklogDate <=` is not, so the last *included* instant is
        // what names the day. Taking the endpoint's own day asked Jira for the next day's issues as
        // well — harmless in the tally, which filters by instant, but every extra issue is another
        // worklog request, and one failure there fails the whole run by design.
        const toDay = localDay(new Date(Math.max(period.from.getTime(), period.to.getTime() - 1)))
        // Find issues the user logged work on in the window.
        // Every page, not just the first. A ticket that fell off page one tallies as zero Jira time,
        // and since every caller subtracts this from what a session accounts for, that reads as
        // "Jira is short by the whole day" — which `watch` would then post on top of hours Jira
        // already holds. A window of more than a hundred distinct issues is an ordinary week.
        const jql = `worklogAuthor = currentUser() AND worklogDate >= "${fromDay}" AND worklogDate <= "${toDay}"`
        const searchPage = (pageToken: string | undefined) =>
          retryTransport(client.searchIssuesUsingJql({
            params: {
              jql,
              maxResults: 100,
              fields: ["key"],
              ...((pageToken !== undefined) && { nextPageToken: pageToken })
            }
          })).pipe(
            Effect.mapError((e) => new ReconcileError({ message: `Jira search failed: ${String(e)}`, cause: e }))
          )

        const searched: Array<unknown> = []
        let pageToken: string | undefined = undefined
        // Bounded so a server that keeps handing back a token cannot spin here for ever; hitting the
        // bound fails the run rather than proceeding on a partial tally.
        for (let page = 0; scope === "window" && page < 50; page++) {
          const result: unknown = yield* searchPage(pageToken)
          const issues: unknown = Predicate.isObject(result) ? result["issues"] : undefined
          // A page with no `issues` at all is not an empty page. The generated success schema makes
          // the field optional, so a response Jira truncated or a shape that changed under us would
          // otherwise read as "this user logged no work" — and every caller subtracts that from what
          // a session accounts for before writing the difference.
          if (!Array.isArray(issues)) {
            return yield* new ReconcileError({
              message: "Jira returned a worklog search page with no issues field; not tallying a partial result."
            })
          }
          for (const issue of issues) searched.push(issue)
          const next: string | undefined = Predicate.isObject(result) && Predicate.isString(result["nextPageToken"])
            ? result["nextPageToken"]
            : undefined
          if (Predicate.isObject(result) && result["isLast"] === false && (next === undefined || next.trim() === "")) {
            return yield* new ReconcileError({ message: "Jira returned an incomplete Jira search page" })
          }
          pageToken = next
          if (next === undefined) break
        }
        if (pageToken !== undefined) {
          return yield* new ReconcileError({
            message: "Jira returned more worklog pages than this run will read; narrow the window."
          })
        }
        // An issue whose key cannot be read is an issue whose worklogs go unread, which is the same
        // under-count as a dropped page — so it fails rather than being skipped.
        const issueKeys: Array<string> = []
        for (const issue of searched) {
          const key = issueKey(issue)
          if (key === null) {
            return yield* new ReconcileError({
              message: "Jira returned a worklog search result with no issue key; not tallying a partial result."
            })
          }
          issueKeys.push(key)
        }
        for (const key of requiredIssueKeys) {
          if (!issueKeys.includes(key)) issueKeys.push(key)
        }

        const toMs = period.to.getTime()
        const tally: Array<{
          ticketKey: string
          day: string
          seconds: number
          entry?: RecordedEntry
          startMs: number
          endMs: number
        }> = []

        // Every issue's worklogs are read before any is tallied, a few at a time: a week of forty
        // tickets read one after another made every confirmation wait on forty round trips. Tallying
        // stays in issue order, so the result is the same as a sequential read.
        const worklogsByIssue = yield* Effect.forEach(
          issueKeys,
          (issueKey) => readJiraWorklogs(client, issueKey, lookupFromMs - 1, toMs),
          { concurrency: JIRA_WORKLOG_READ_CONCURRENCY }
        )
        for (const [issueIndex, issueKey] of issueKeys.entries()) {
          const worklogs = worklogsByIssue[issueIndex] ?? []

          for (const wl of worklogs) {
            // Only this user's worklogs (the JQL narrows issues, not individual worklog authors).
            const author = wl.author?.accountId
            if (author !== accountId) continue
            const startedMs = new Date(wl.started).getTime()
            const endedMs = startedMs + wl.timeSpentSeconds * 1000
            if (endedMs <= fromMs || startedMs >= toMs) continue
            const entry: RecordedEntry | undefined = wl.id === undefined
              ? undefined
              : {
                id: wl.id,
                source: "jira",
                ticketKey: issueKey,
                startMs: startedMs,
                endMs: endedMs,
                description: yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Json))(wl.comment).pipe(
                  Effect.flatMap(jiraWorklogDescription),
                  Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
                )
              }
            // Clockify and session evidence use local calendar slices. Apply the same accounting
            // policy to Jira's duration even though Jira stores it as one start-day worklog, or a
            // matching overnight pair becomes two opposite discrepancies.
            for (
              const bucket of splitIntervalByLocalDay(
                Math.max(startedMs, fromMs),
                Math.min(endedMs, toMs)
              )
            ) {
              tally.push({
                ticketKey: issueKey,
                ...(entry !== undefined && { entry }),
                ...bucket
              })
            }
          }
        }
        return tally
      })
    type JiraTallyRows = Effect.Success<ReturnType<typeof jiraTally>>

    const readRecorded = (
      period: ReconcilePeriod,
      options?: {
        readonly sides?: ReconcileSides | undefined
        readonly jiraIssueKeys?: ReadonlyArray<string> | undefined
        /** A Jira tally this read already took under the same snapshot, so Jira is read once. */
        readonly jiraPreRead?: JiraTallyRows | undefined
        readonly clockifySnapshot?: ClockifyWriteSnapshot | undefined
        readonly jiraSnapshot?: JiraWriteSnapshot | null | undefined
        /** Keep an unavailable Jira side read-only while independently verified providers proceed. */
        readonly tolerateUnavailableJira?: boolean | undefined
      }
    ) =>
      Effect.gen(function*() {
        const sides = options?.sides ?? bothSides
        // A side that is out is not called at all. That is the point of the option for someone who
        // tracks in one system: no Clockify workspace to configure, no Jira login to keep alive, and
        // no request whose failure could stop a run that never needed it.
        const jiraSideRead = !sides.jira
          ? Effect.succeed([])
          : options?.jiraPreRead !== undefined
          ? Effect.succeed(options.jiraPreRead)
          : jiraTally(period, options?.jiraIssueKeys, options?.jiraSnapshot)
        const [clockifySide, jiraSide] = yield* Effect.all(
          [
            sides.clockify
              ? clockifyTally(period, options?.clockifySnapshot)
              : Effect.succeed({ tally: [], unlinked: [] }),
            options?.tolerateUnavailableJira === true
              ? jiraSideRead.pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Jira could not be read; reconciling Clockify alone", error).pipe(Effect.as([]))
                )
              )
              : jiraSideRead
          ],
          { concurrency: 2 }
        )
        return { recorded: buildReconcileRows(clockifySide.tally, jiraSide), unlinkedClockify: clockifySide.unlinked }
      })

    const compare = (period: ReconcilePeriod, options?: { readonly sides?: ReconcileSides | undefined }) =>
      readRecorded(period, options).pipe(Effect.map((result) => result.recorded))

    type BindingEvidence = { readonly _tag: "Present"; readonly entry: RecordedEntry }

    /**
     * Read one bound Clockify entry without the generated client's lossy unexpected-status fallback.
     *
     * Clockify's pinned OpenAPI contract declares no typed not-found response for this operation.
     * A non-2xx response therefore remains uncertain even when its numeric status is 404.
     */
    const readClockifyBinding = (
      binding: SourceBinding,
      snapshot: ClockifyWriteSnapshot
    ): Effect.Effect<typeof ClockifyApi.GetTimeEntry200.Type, ReconcileError> =>
      snapshot.client.httpClient.execute(
        HttpClientRequest.get(`/v1/workspaces/${snapshot.auth.workspaceId}/time-entries/${binding.entryId}`).pipe(
          HttpClientRequest.setUrlParam("hydrated", "false")
        )
      ).pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? HttpClientResponse.schemaBodyJson(ClockifyApi.GetTimeEntry200)(response).pipe(
              Effect.mapError((cause) =>
                new ReconcileError({ message: "Clockify returned incomplete bound-entry evidence", cause })
              )
            )
            : Effect.fail(
              new ReconcileError({ message: "Clockify did not provide a verifiable bound-entry response" })
            )
        ),
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "ReconcileError")
            ? cause
            : new ReconcileError({ message: "Could not verify the current Clockify bound entry", cause })
        )
      )

    /** A targeted read can verify presence; ambiguous misses keep the bound credit held. */
    const readBindingEvidence = (
      binding: SourceBinding,
      currentEntries: ReadonlyArray<RecordedEntry>,
      clockifySnapshot: ClockifyWriteSnapshot,
      jiraSnapshot: JiraWriteSnapshot
    ): Effect.Effect<BindingEvidence, ReconcileError> => {
      const current = currentEntries.find((entry) => entry.source === binding.provider && entry.id === binding.entryId)
      if (current !== undefined) return Effect.succeed({ _tag: "Present", entry: current })
      const read = binding.provider === "clockify"
        ? readClockifyBinding(binding, clockifySnapshot).pipe(
          Effect.flatMap((entry) => {
            const start = entry.timeInterval.start
            const end = entry.timeInterval.end
            const startMs = new Date(start ?? "").getTime()
            const endMs = new Date(end ?? "").getTime()
            if (
              entry.id !== binding.entryId || entry.userId !== clockifySnapshot.auth.userId ||
              entry.workspaceId !== clockifySnapshot.auth.workspaceId || end === undefined ||
              !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
            ) {
              return Effect.fail(
                new ReconcileError({
                  message: "Clockify returned incomplete bound-entry evidence"
                })
              )
            }
            return Effect.succeed<BindingEvidence>({
              _tag: "Present",
              entry: {
                id: entry.id,
                source: "clockify",
                ticketKey: parseTicketKey(entry.description),
                startMs,
                endMs,
                description: entry.description
              }
            })
          })
        )
        : jiraSnapshot.client.getWorklog(binding.ticketKey, binding.entryId, undefined).pipe(
          Effect.flatMap((value) => {
            const worklog = toRawWorklog(value)
            if (
              worklog === null || !isReadableWorklog(worklog) || worklog.id !== binding.entryId ||
              worklog.author.accountId !== jiraSnapshot.accountId
            ) {
              return Effect.fail(new ReconcileError({ message: "Jira returned incomplete bound-worklog evidence" }))
            }
            const startMs = new Date(worklog.started).getTime()
            const endMs = startMs + worklog.timeSpentSeconds * 1000
            if (!Number.isFinite(startMs) || endMs <= startMs) {
              return Effect.fail(new ReconcileError({ message: "Jira returned incomplete bound-worklog evidence" }))
            }
            return Effect.succeed<BindingEvidence>({
              _tag: "Present",
              entry: {
                id: worklog.id,
                source: "jira",
                ticketKey: binding.ticketKey,
                startMs,
                endMs,
                description: null
              }
            })
          }),
          Effect.catchTag("GetWorklog404", () =>
            Effect.gen(function*() {
              if (binding.jiraCreatedAtMs === undefined) {
                return yield* new ReconcileError({
                  message: "Jira bound entry has no provider-created checkpoint; deletion remains unproved"
                })
              }
              const evidence = yield* readJiraDeletionEvidence(
                jiraSnapshot.client,
                binding.entryId,
                binding.jiraCreatedAtMs
              ).pipe(
                Effect.mapError((cause) => new ReconcileError({ message: cause.message }))
              )
              if (evidence._tag === "Unproved") {
                return yield* new ReconcileError({ message: "Jira bound entry has no verified deletion event" })
              }
              const current = yield* jiraWriteState
              if (current.snapshot === null || current.snapshot.heldScope !== jiraSnapshot.heldScope) {
                return yield* new ReconcileError({ message: "Jira account changed during deletion verification" })
              }
              // A deletion event is historical. Jira's targeted 404 also covers lost visibility,
              // so neither fact proves the entry is still absent after an out-of-band restore.
              return yield* new ReconcileError({
                message: "Jira deleted-worklog event is verified, but current absence is not"
              })
            }))
        )
      return read.pipe(
        Effect.mapError((cause) =>
          new ReconcileError({ message: `Could not verify the current ${binding.provider} bound entry`, cause })
        )
      )
    }

    const directionSource = (
      recorded: ReadonlyArray<ReconcileRow>,
      unlinkedClockify: ReadonlyArray<UnlinkedClockifyEntry>,
      clockifySnapshot: ClockifyWriteSnapshot,
      jiraSnapshot: JiraWriteSnapshot | null
    ) =>
    (
      row: ReconcileRow,
      direction: ReconcileDirection,
      seconds: number
    ): Effect.Effect<DirectionSourceDecision, ReconcileError> =>
      Effect.gen(function*() {
        const sourceProvider = direction === "clockify-to-jira" ? "clockify" : "jira"
        const targetProvider = sourceProvider === "clockify" ? "jira" : "clockify"
        const sourceEntries = row.intervals
          .flatMap(({ entry }) => entry?.source === sourceProvider ? [entry] : [])
          .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index)
        const stored = yield* sourceLedger.read.pipe(
          Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
        )
        const hasMarker = sourceEntries.some((entry) =>
          entry.description !== null && SourceConsumption.markers(entry.description).length > 0
        )
        const mayBeBound = sourceEntries.some((entry) =>
          stored.bindings.some((binding) => binding.provider === sourceProvider && binding.entryId === entry.id)
        )
        if (!hasMarker && !mayBeBound) return { _tag: "Ordinary" }

        if (jiraSnapshot === null) {
          return {
            _tag: "Refused",
            message: "Direction provenance could not be verified for the current provider accounts"
          }
        }
        const sourceScope = sourceProvider === "clockify" ? clockifySnapshot.scope : jiraSnapshot.ledgerScope
        const targetScope = targetProvider === "clockify" ? clockifySnapshot.scope : jiraSnapshot.ledgerScope
        const expectedTargetScope = targetProvider === "clockify" ? clockifySnapshot.scope : jiraSnapshot.heldScope
        const expectedSourceScope = sourceProvider === "clockify" ? clockifySnapshot.scope : jiraSnapshot.heldScope
        const sourceIds = new Set(sourceEntries.map((entry) => entry.id))
        const verifiedSource = stored.bindings.filter((binding) =>
          binding.provider === sourceProvider && binding.scope === sourceScope && sourceIds.has(binding.entryId)
        )
        if (
          verifiedSource.length === 0 ||
          sourceEntries.some((entry) =>
            entry.description !== null && SourceConsumption.markers(entry.description).length > 0 &&
            !verifiedSource.some((binding) => binding.entryId === entry.id)
          )
        ) {
          return { _tag: "Refused", message: "Direction source marker is not verified by the private ledger" }
        }
        const sourceKeys = new Map(
          verifiedSource.map((binding) => [
            SourceConsumption.blockKey(binding.rowId, binding.sourceStartMs),
            { rowId: binding.rowId, sourceStartMs: binding.sourceStartMs }
          ])
        )
        if (sourceKeys.size !== 1) {
          return {
            _tag: "Refused",
            message: "Direction row combines more than one verified source block; split it manually before writing"
          }
        }
        const sourceKey = sourceKeys.values().next().value
        if (sourceKey === undefined) {
          return { _tag: "Refused", message: "Direction source binding is unavailable" }
        }
        const currentEntries = [
          ...recorded.flatMap((candidate) =>
            candidate.intervals.flatMap(({ entry }) => entry === undefined ? [] : [entry])
          ),
          ...unlinkedClockify.flatMap(({ entry }) => entry === undefined ? [] : [entry])
        ].filter((entry, index, entries) =>
          entries.findIndex((candidate) => candidate.source === entry.source && candidate.id === entry.id) === index
        )
        const sourceEvidence = yield* Effect.forEach(
          verifiedSource,
          (binding) => readBindingEvidence(binding, currentEntries, clockifySnapshot, jiraSnapshot),
          { concurrency: 2 }
        )
        const sourceIntervals = verifiedSource.flatMap((binding, index) => {
          const evidence = sourceEvidence[index]
          if (evidence?._tag !== "Present") return []
          const startMs = Math.max(binding.startMs, evidence.entry.startMs)
          const endMs = Math.min(binding.endMs, evidence.entry.endMs)
          return endMs > startMs ? [{ startMs, endMs }] : []
        })
        const sourceAuthority = mergeIntervals(sourceIntervals)
        if (sourceAuthority.length !== 1 || sourceIntervals.length !== verifiedSource.length) {
          return {
            _tag: "Refused",
            message: "Direction source intervals are no longer one contiguous verified block"
          }
        }
        const sourceInterval = sourceAuthority[0]
        if (sourceInterval === undefined) {
          return { _tag: "Refused", message: "Direction source interval is unavailable" }
        }
        const targetBindings = stored.bindings.filter((binding) =>
          binding.provider === targetProvider && binding.scope === targetScope &&
          binding.rowId === sourceKey.rowId && binding.sourceStartMs === sourceKey.sourceStartMs
        )
        const targetEvidence = yield* Effect.forEach(
          targetBindings,
          (binding) => readBindingEvidence(binding, currentEntries, clockifySnapshot, jiraSnapshot),
          { concurrency: 2 }
        )
        const consumedIntervals = targetBindings.flatMap((_binding, index) => {
          const evidence = targetEvidence[index]
          return evidence?._tag === "Present"
            ? [{ startMs: evidence.entry.startMs, endMs: evidence.entry.endMs }]
            : []
        })
        if (
          consumedIntervals.some((interval) =>
            interval.startMs < sourceInterval.startMs || interval.endMs > sourceInterval.endMs
          )
        ) {
          return {
            _tag: "Refused",
            message: "A bound target moved outside its verified source interval"
          }
        }
        const remaining = subtractIntervals(sourceInterval, consumedIntervals)
        if (remaining.length === 0 || seconds <= 0) {
          return { _tag: "Refused", message: "Direction delta exceeds the remaining verified source time" }
        }
        if (remaining.length !== 1) {
          return {
            _tag: "Refused",
            message: "Verified target time leaves disconnected source intervals; split it manually before writing"
          }
        }
        const remainingInterval = remaining[0]
        if (remainingInterval === undefined) {
          return { _tag: "Refused", message: "Direction source interval is unavailable" }
        }
        const remainingSeconds = (remainingInterval.endMs - remainingInterval.startMs) / 1000
        const writableSeconds = Math.min(seconds, remainingSeconds)
        if (!Number.isSafeInteger(writableSeconds) || writableSeconds <= 0) {
          return { _tag: "Refused", message: "Direction remainder is not representable as whole seconds" }
        }
        if (targetProvider === "jira" && writableSeconds < MINIMUM_PROPOSAL_SECONDS) {
          return { _tag: "Refused", message: "Direction remainder is less than Jira's one-minute minimum" }
        }
        const startedAtMs = remainingInterval.startMs
        return {
          _tag: "Bound",
          startedAt: new Date(startedAtMs),
          source: {
            rowId: sourceKey.rowId,
            sourceStartMs: sourceKey.sourceStartMs,
            startMs: startedAtMs,
            endMs: startedAtMs + writableSeconds * 1000,
            seconds: writableSeconds,
            expectedScope: expectedTargetScope,
            expectedSource: { provider: sourceProvider, scope: expectedSourceScope }
          }
        }
      })

    const compareDirection = (period: ReconcilePeriod): Effect.Effect<DirectionComparison, ReconcileError> =>
      Effect.gen(function*() {
        const clockifySnapshot = yield* clockifyWriteSnapshot
        const jiraSnapshot = (yield* jiraWriteState).snapshot
        const result = yield* readRecorded(period, { clockifySnapshot, jiraSnapshot })
        return {
          rows: result.recorded,
          resolveSource: directionSource(result.recorded, result.unlinkedClockify, clockifySnapshot, jiraSnapshot)
        }
      })

    // Noon-local on the bucket's day — the fallback when a caller knows only the day. It keeps the
    // worklog or entry firmly on the right calendar day whatever the reader's timezone.
    const dayStart = (day: string): Date => new Date(`${day}T12:00:00`)

    /**
     * When the work began: the caller's instant if it belongs to this day, else local noon.
     *
     * The day check matters because the bucket's day is authoritative — a caller must not be able to
     * push an entry onto a neighbouring day by passing an instant from it.
     */
    const startOf = (day: string, startedAt: Date | undefined): Date =>
      startedAt !== undefined && localDay(startedAt) === day ? startedAt : dayStart(day)

    const sourceScopeIsCurrent = (source: SourceSegment | undefined): Effect.Effect<boolean> => {
      if (source?.expectedSource === undefined) return Effect.succeed(true)
      if (source.expectedSource.provider === "clockify") {
        return Effect.result(clockifyWriteSnapshot).pipe(
          Effect.map((result) => result._tag === "Success" && result.success.scope === source.expectedSource?.scope)
        )
      }
      return jiraWriteState.pipe(
        Effect.map((state) => state.snapshot?.heldScope === source.expectedSource?.scope)
      )
    }

    const applyToJiraUnGuarded = (
      ticketKey: string,
      day: string,
      seconds: number,
      comment?: string,
      startedAt?: Date,
      source?: SourceSegment
    ): Effect.Effect<JiraWriteOutcome> =>
      Effect.gen(function*() {
        if (
          source !== undefined &&
          (seconds !== source.seconds || startedAt?.getTime() !== source.startMs)
        ) {
          return { _tag: "Failed", message: "The approved Jira interval changed before confirmation" }
        }
        if (!(yield* sourceScopeIsCurrent(source))) {
          return { _tag: "Failed", message: "The source provider account changed since this direction was read" }
        }
        const state = source === undefined ? undefined : yield* jiraWriteState
        const snapshot = state?.snapshot ?? null
        const identity: SourceIdentity | undefined = source === undefined || snapshot === null ? undefined : {
          rowId: source.rowId,
          sourceStartMs: source.sourceStartMs,
          startMs: source.startMs,
          endMs: source.endMs,
          seconds: source.seconds,
          ticketKey,
          provider: "jira",
          scope: snapshot.ledgerScope
        }
        if (source !== undefined && identity === undefined) {
          return state?.availability === "not-logged-in"
            ? { _tag: "NotLoggedIn" }
            : { _tag: "VerificationUnavailable" }
        }
        if (source?.expectedScope !== undefined && snapshot?.heldScope !== source.expectedScope) {
          return { _tag: "Failed", message: "The Jira account changed since this plan was read" }
        }
        if (identity !== undefined) {
          const reserved = yield* Effect.result(sourceLedger.reserve(identity))
          if (reserved._tag === "Failure") return { _tag: "Failed", message: reserved.failure.message }
        }
        let writeSnapshot = snapshot
        if (identity !== undefined) {
          const sourceIsCurrent = yield* sourceScopeIsCurrent(source)
          const currentState = yield* jiraWriteState
          const current = currentState.snapshot
          if (
            !sourceIsCurrent || current === null || current.ledgerScope !== identity.scope ||
            source?.expectedScope !== undefined && current.heldScope !== source.expectedScope
          ) {
            const released = yield* Effect.result(sourceLedger.release(identity))
            if (released._tag === "Failure") {
              return {
                _tag: "Failed",
                message: "Provider identity changed and the private write intent needs manual review"
              }
            }
            if (!sourceIsCurrent) {
              return { _tag: "Failed", message: "The source provider account changed before the Jira worklog write" }
            }
            if (currentState.availability === "not-logged-in") return { _tag: "NotLoggedIn" }
            if (currentState.availability === "unverified") return { _tag: "VerificationUnavailable" }
            return { _tag: "Failed", message: "The Jira account changed before the worklog write" }
          }
          writeSnapshot = current
        }
        const params = {
          ticketKey,
          startedAt: startOf(day, startedAt),
          durationSeconds: seconds,
          comment: comment !== undefined && comment.trim() !== "" ? comment.trim() : "Reconciled from Clockify"
        }
        const posted = writeSnapshot === null
          ? yield* timer.logWorklog(params)
          : yield* postJiraWorklog(writeSnapshot.client, params)
        if (identity === undefined) return posted
        if (posted._tag === "NotLoggedIn") {
          const released = yield* Effect.result(sourceLedger.release(identity))
          return released._tag === "Failure"
            ? { _tag: "Failed", message: "Jira was not called but the private write intent could not be released" }
            : posted
        }
        if (posted._tag !== "Posted") return posted
        if (posted.entryId === undefined || posted.entryId === "") {
          return {
            _tag: "Failed",
            message: "Jira may have written time without returning an entry ID; manual recovery required"
          }
        }
        // An exact provider read may add a Jira-clock checkpoint; its failure cannot undo a confirmed POST.
        const createdAtMs = writeSnapshot === null
          ? undefined
          : yield* writeSnapshot.client.getWorklog(ticketKey, posted.entryId, undefined).pipe(
            Effect.flatMap((worklog) => {
              const value = worklog.created === undefined ? NaN : new Date(worklog.created).getTime()
              const valid = worklog.id === posted.entryId &&
                worklog.author?.accountId === writeSnapshot.accountId &&
                Number.isSafeInteger(value) && value >= 0
              return valid
                ? Effect.succeed(value)
                : Effect.logWarning("Jira creation checkpoint is incomplete; deletion reconciliation stays held")
                  .pipe(Effect.as(undefined))
            }),
            Effect.catch(() =>
              Effect.logWarning("Jira creation checkpoint is unavailable; deletion reconciliation stays held")
                .pipe(Effect.as(undefined))
            )
          )
        const bound = yield* Effect.result(sourceLedger.bind(identity, posted.entryId, createdAtMs))
        return bound._tag === "Failure"
          ? { _tag: "Failed", message: "Jira wrote time but its private binding failed; manual recovery required" }
          : posted
      })

    const applyToJira = (
      ticketKey: string,
      day: string,
      seconds: number,
      comment?: string,
      startedAt?: Date,
      source?: SourceSegment
    ): Effect.Effect<JiraWriteOutcome> =>
      provideGuard(WriterGuard.mutate(
        applyToJiraUnGuarded(ticketKey, day, seconds, comment, startedAt, source)
      )).pipe(
        Effect.catchTag("WriterGuardError", (error) =>
          Effect.succeed<JiraWriteOutcome>({ _tag: "Failed", message: error.message }))
      )

    const applyToClockifyUnGuarded = (
      ticketKey: string,
      day: string,
      seconds: number,
      note?: string,
      startedAt?: Date,
      source?: SourceSegment
    ) =>
      Effect.gen(function*() {
        if (
          source !== undefined &&
          (seconds !== source.seconds || startedAt?.getTime() !== source.startMs)
        ) {
          return yield* new ReconcileError({ message: "The approved Clockify interval changed before confirmation" })
        }
        if (!(yield* sourceScopeIsCurrent(source))) {
          return yield* new ReconcileError({
            message: "The source provider account changed since this direction was read"
          })
        }
        const snapshot = yield* clockifyWriteSnapshot
        const cfg = yield* config.get
        const start = startOf(day, startedAt)
        const end = new Date(start.getTime() + seconds * 1000)
        const identity: SourceIdentity | undefined = source === undefined ? undefined : {
          rowId: source.rowId,
          sourceStartMs: source.sourceStartMs,
          startMs: source.startMs,
          endMs: source.endMs,
          seconds: source.seconds,
          provider: "clockify",
          scope: snapshot.scope,
          ticketKey
        }
        if (source?.expectedScope !== undefined && identity?.scope !== source.expectedScope) {
          return yield* new ReconcileError({ message: "The Clockify account changed since this plan was read" })
        }
        if (identity !== undefined) {
          yield* sourceLedger.reserve(identity, snapshot.legacyScope).pipe(
            Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
          )
        }
        const sourceIsCurrent = yield* sourceScopeIsCurrent(source)
        const verified = yield* Effect.result(clockifyWriteSnapshot)
        if (!sourceIsCurrent || verified._tag === "Failure") {
          if (identity !== undefined) {
            const released = yield* Effect.result(sourceLedger.release(identity))
            if (released._tag === "Failure") {
              return yield* new ReconcileError({
                message: "Clockify was not called but its private write intent needs manual recovery",
                cause: released.failure
              })
            }
          }
          return yield* verified._tag === "Failure"
            ? verified.failure
            : new ReconcileError({ message: "The source provider account changed before the Clockify write" })
        }
        const current = verified.success
        if (
          current.scope !== snapshot.scope ||
          (source?.expectedScope !== undefined && current.scope !== source.expectedScope)
        ) {
          if (identity !== undefined) {
            yield* sourceLedger.release(identity).pipe(
              Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
            )
          }
          return yield* new ReconcileError({ message: "The Clockify account changed before the write" })
        }
        const created = yield* current.client.createTimeEntry(current.auth.workspaceId, {
          payload: {
            description: `[${ticketKey}] ${
              note !== undefined && note.trim() !== "" ? note.trim() : "Reconciled from Jira"
            }`,
            start: start.toISOString(),
            end: end.toISOString(),
            // Stated, not left to Clockify's own default. `jcf timer start` already sends it, so
            // omitting it here made a reconciled entry's billable flag differ from a timed one's for
            // the same ticket — visible only later, on an invoice.
            billable: cfg.defaultBillable,
            ...((cfg.defaultProjectId) && { projectId: cfg.defaultProjectId })
          }
        }).pipe(
          Effect.mapError((e) => new ReconcileError({ message: `Clockify create failed: ${e.message}`, cause: e }))
        )
        if (identity !== undefined) {
          yield* sourceLedger.bind(identity, created.id).pipe(
            Effect.mapError((cause) =>
              new ReconcileError({
                message: "Clockify wrote time but its private binding failed; manual recovery required",
                cause
              })
            )
          )
        }
        return true
      })

    const applyToClockify = (
      ticketKey: string,
      day: string,
      seconds: number,
      note?: string,
      startedAt?: Date,
      source?: SourceSegment
    ) =>
      provideGuard(WriterGuard.mutate(
        applyToClockifyUnGuarded(ticketKey, day, seconds, note, startedAt, source)
      )).pipe(
        Effect.mapError((error) =>
          error._tag === "WriterGuardError"
            ? new ReconcileError({ message: error.message, cause: error })
            : error
        )
      )

    /**
     * Days that must not be proposed because a Timer is still running across them.
     *
     * Load-bearing, not politeness: a running Clockify entry has no end time, and the Clockify
     * tally skips entries without one. Its time is therefore invisible to the subtraction, so
     * proposing such a day would log hours a second time the moment the Timer is stopped.
     *
     * Every day the Timer spans is excluded, not just the one it started on. A Timer left running
     * overnight hides time on each day it crosses, and the day it happened to start is no safer than
     * the others — it is simply the one a shorter rule noticed.
     */
    const runningTimerExclusions = (period: ReconcilePeriod, snapshot: ClockifyWriteSnapshot) =>
      Effect.gen(function*() {
        // Fails the run rather than logging and carrying on. An unknown running-timer state is not
        // an absent one, and every caller of this subtracts before writing the difference.
        const running = yield* snapshot.client.getTimeEntries(snapshot.auth.workspaceId, snapshot.auth.userId, {
          params: { "in-progress": "true", "page-size": 1 }
        }).pipe(
          Effect.mapError((cause) => new ReconcileError({ message: "Could not rule out a running timer", cause }))
        )
        if (running.length === 0) return []
        const started = running[0]?.timeInterval.start
        const startedMs = started === undefined ? Number.NaN : new Date(started).getTime()
        if (!Number.isFinite(startedMs)) {
          return yield* new ReconcileError({ message: "Running Clockify timer has no valid start" })
        }
        // Clamped to the window on both sides: a Timer running since last week makes nothing outside
        // this period any less proposable, and the period's own end is as far as the run can look.
        const fromMs = Math.max(startedMs, period.from.getTime())
        const toMs = period.to.getTime() - 1
        if (fromMs > toMs) return []

        const excluded: Array<ExcludedDay> = []
        for (let cursor = fromMs; cursor <= toMs; cursor = nextLocalMidnight(cursor)) {
          excluded.push({
            day: localDay(new Date(cursor)),
            reason: "a Clockify timer is still running on this day — stop it and re-run"
          })
        }
        return excluded
      })

    /**
     * Attribute every session, spending a Coding Agent call only where the deterministic signals
     * came up empty.
     *
     * The calls run concurrently. They are the slowest thing this command does — a CLI process
     * each, tens of seconds apiece — and doing them one after another is what makes a week's run
     * look like it has hung. A failure marks the Coding Agent unavailable so the remaining
     * sessions are honestly reported as Unattributed Sessions rather than retried.
     */
    const attributeSessions = (
      sessions: ReadonlyArray<{
        readonly sessionId: string
        readonly cwd: string
        readonly gitBranch: string | null
        readonly candidateKeys: ReadonlyArray<string>
        readonly digest: string
      }>,
      options: {
        readonly standingMap: Record<string, string>
        readonly ignoredTickets: ReadonlySet<string>
        readonly confidenceFloor: number
        readonly mode: AttributionMode
        readonly onProgress: (progress: SessionProposalProgress) => Effect.Effect<void>
        /** Ranking facts shown beside each candidate; absent when Jira could not answer. */
        readonly candidateFact?: ((ticketKey: string) => CandidateFact | undefined) | undefined
      }
    ) =>
      Effect.gen(function*() {
        // `deterministicAttribution` is asked here purely to decide whether a call is warranted;
        // `attributeSession` remains the single place the precedence is actually applied.
        const needsAgent = options.mode === "deterministic" ?
          [] :
          sessions.filter((session) =>
            deterministicAttribution(session, options) === null &&
            session.candidateKeys.length > 0
          )

        const batches = batchRequests(needsAgent)
        if (needsAgent.length > 0) {
          yield* options.onProgress({
            _tag: "AttributingSessions",
            count: needsAgent.length,
            calls: batches.length
          })
        }

        // Counted as batches finish rather than in list order, so the reported number always
        // reflects work actually completed. Safe as a plain counter: Effect's scheduler runs these
        // fibers on one thread, so the increment cannot interleave.
        let done = 0
        const batchResults = yield* Effect.all(
          batches.map((batch, batchIndex) =>
            attributor.attribute(
              batch.map((session) => ({
                sessionId: session.sessionId,
                candidateKeys: session.candidateKeys,
                digest: session.digest,
                candidateFacts: new Map(session.candidateKeys.flatMap((key) => {
                  const fact = options.candidateFact?.(key)
                  return fact === undefined ? [] : [[key, fact] satisfies readonly [string, CandidateFact]]
                }))
              })),
              (activity) =>
                options.onProgress({
                  _tag: "AgentActivity",
                  batch: batchIndex + 1,
                  batches: batches.length,
                  ...activity
                })
            ).pipe(
              Effect.map((answers) => {
                const bySession = new Map(answers.map((answer) => [answer.sessionId, answer.choice]))
                return batch.map((session) => {
                  const declined: AttributionChoice = { _tag: "None" }
                  const answer = bySession.get(session.sessionId) ?? declined
                  const choice = answer._tag === "Chosen" && options.ignoredTickets.has(answer.ticketKey)
                    ? declined
                    : answer
                  return {
                    session,
                    choice,
                    outcome: (choice._tag === "Chosen"
                      ? { _tag: "Placed", ticketKey: choice.ticketKey, confidence: choice.confidence }
                      : { _tag: "Declined" }) satisfies AttributionOutcome
                  }
                })
              }),
              // No log here: the failure is reported to the progress listener below, which puts it
              // on stderr with the sessions it belongs to. Logging as well printed it twice.
              //
              // A failed call costs every session in its batch, which is why batches are bounded.
              Effect.catch((error) =>
                Effect.succeed(batch.map((session) => ({
                  session,
                  choice: null,
                  outcome: { _tag: "Unavailable", message: error.message } satisfies AttributionOutcome
                })))
              ),
              Effect.tap((results) =>
                Effect.forEach(results, (result) => {
                  done += 1
                  return options.onProgress({
                    _tag: "SessionAttributed",
                    done,
                    total: needsAgent.length,
                    gitBranch: result.session.gitBranch,
                    cwd: result.session.cwd,
                    outcome: result.outcome
                  })
                }, { discard: true })
              )
            )
          ),
          { concurrency: ATTRIBUTOR_CONCURRENCY }
        )
        const answers = batchResults.flat()

        if (needsAgent.length > 0) {
          yield* options.onProgress({
            _tag: "SessionsAttributed",
            placed: answers.filter((answer) => answer.outcome._tag === "Placed").length,
            declined: answers.filter((answer) => answer.outcome._tag === "Declined").length,
            unavailable: answers.filter((answer) => answer.outcome._tag === "Unavailable").length
          })
        }

        const chosen = new Map<string, AgentChoice>()
        let attributorAvailable = true
        for (const answer of answers) {
          if (answer.choice === null) {
            attributorAvailable = false
            continue
          }
          if (answer.choice._tag === "Chosen") {
            chosen.set(answer.session.sessionId, {
              ticketKey: answer.choice.ticketKey,
              confidence: answer.choice.confidence
            })
          }
        }

        const attributions = sessions.map((session) =>
          attributeSession(session, {
            standingMap: options.standingMap,
            agentChoice: chosen.get(session.sessionId) ?? null,
            confidenceFloor: options.confidenceFloor,
            ignoredTickets: options.ignoredTickets
          })
        )

        return { attributions, attributorAvailable, attributorCalls: batches.length }
      })

    const describeProposals = (options: {
      readonly proposals: ReadonlyArray<SessionProposal>
      readonly digests: ReadonlyMap<string, string>
      readonly summaries?: ReadonlyMap<string, string> | undefined
      readonly onUnavailable?: ((message: string) => Effect.Effect<void>) | undefined
    }) =>
      Effect.gen(function*() {
        if (options.proposals.length === 0) return []
        const requests = options.proposals.map((proposal, index) => ({
          id: String(index),
          ticketKey: proposal.ticketKey,
          summary: options.summaries?.get(proposal.ticketKey) ?? null,
          digest: bucketDigest(proposal, options.digests)
        }))
        // Batched on the same budget as attribution: the prompt carries whole digests, so the bound
        // that matters is characters, not rows.
        const batches = batchRequests(requests)
        const answers = yield* Effect.forEach(
          batches,
          (batch) =>
            attributor.describe(batch).pipe(
              // A batch that fails costs its own notes and nothing else. Reported as a warning
              // rather than a failure: the worklog it belongs to is still correct without a sentence.
              Effect.catch((error) =>
                (options.onUnavailable?.(error.message) ?? Effect.void).pipe(
                  Effect.andThen(Effect.logWarning(`Could not describe ${batch.length} row(s): ${error.message}`)),
                  Effect.as(batch.map((request): SessionDescribeAnswer => ({ id: request.id, note: null })))
                )
              )
            ),
          { concurrency: ATTRIBUTOR_CONCURRENCY }
        )
        const byId = new Map(answers.flat().map((answer) => [answer.id, answer.note]))
        return requests.map((request) => byId.get(request.id) ?? null)
      })

    /** Both first reads and post-write refreshes subtract live totals through the same path. */
    const refreshRecordedTime = Effect.fn("ReconcileService.refreshRecordedTime")(function*(
      period: ReconcilePeriod,
      cached: Omit<SessionProposalReport, "proposals" | "recorded" | "unlinkedClockify" | "excludedDays">,
      options?: RefreshRecordedOptions,
      /** A Jira write state the caller already resolved, so one read never verifies twice. */
      pinnedJiraState?: JiraWriteState,
      /**
       * A Jira tally taken under `pinnedJiraState` earlier in the same read, with the issue keys it
       * was required to cover. Reused only when it covers every key this refresh needs.
       */
      preReadJira?: { readonly tally: JiraTallyRows; readonly requiredKeys: ReadonlyArray<string> }
    ) {
      const ignoredTickets = new Set((yield* config.get).sessionIgnoredTickets)
      const ignored = [...new Map([
        ...ignoredCredits(cached.sessionEvidence ?? [], ignoredTickets),
        ...cached.ignored.filter((entry) => ignoredTickets.has(entry.ticketKey))
      ].map((entry) => [`${entry.ticketKey}:${entry.day}`, entry])).values()]
      const previous = {
        ...cached,
        attributed: cached.attributed.filter((row) => !ignoredTickets.has(row.ticketKey)),
        withheld: cached.withheld.filter((row) => !ignoredTickets.has(row.ticketKey)),
        ignoredTickets: [...ignoredTickets].sort(),
        ignored
      }
      const { sides } = previous
      const writeBlocked: Partial<Record<"clockify" | "jira", string>> = {}
      const stored = yield* sourceLedger.read.pipe(
        Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
      )
      const clockifySnapshot = sides.clockify ? yield* clockifyWriteSnapshot : null
      if (clockifySnapshot !== null) {
        yield* sourceLedger.assertNoLegacyClockify(clockifySnapshot.legacyScope).pipe(
          Effect.catchTag("SourceLedgerError", (cause) => {
            if (cause.reason !== "review-required") return Effect.fail(cause)
            writeBlocked.clockify = cause.message
            return Effect.void
          }),
          Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
        )
      }
      const clockifyScope = clockifySnapshot?.scope ?? null
      const jiraState = sides.jira ? pinnedJiraState ?? (yield* jiraWriteState) : undefined
      const jiraSnapshot = jiraState?.snapshot ?? null
      // Compatibility reads may still render Jira totals, but only one verified snapshot may grant
      // durable source authority. Independent Clockify work remains executable while Jira is held.
      const jiraScope = jiraSnapshot?.ledgerScope ?? null
      const jiraHeldScope = jiraSnapshot?.heldScope ?? null
      const sourceScopes: ProviderScopes = { clockify: clockifyScope, jira: jiraHeldScope }
      if (
        previous.sourceScopes !== undefined &&
        ((sides.clockify && previous.sourceScopes.clockify !== null &&
          clockifyScope !== null &&
          previous.sourceScopes.clockify !== clockifyScope) ||
          (sides.jira && previous.sourceScopes.jira !== null && jiraHeldScope !== null &&
            previous.sourceScopes.jira !== jiraHeldScope))
      ) {
        return yield* new ReconcileError({ message: "The provider account changed since this plan was read" })
      }
      const scoped = stored.bindings.filter((binding) =>
        binding.provider === "clockify" ? binding.scope === clockifyScope : binding.scope === jiraScope
      )
      if (
        previous.attributed.length > 0 &&
        stored.pending.some((pending) =>
          pending.provider === "clockify" ? pending.scope === clockifyScope : pending.scope === jiraScope
        )
      ) {
        return yield* new ReconcileError({ message: "An unresolved source write needs manual reconciliation" })
      }
      const jiraIssueKeys = [
        ...new Set([
          ...previous.attributed.map((row) => row.ticketKey),
          ...scoped.filter((binding) => binding.provider === "jira").map((binding) => binding.ticketKey),
          ...(options?.jiraIssueKeys ?? [])
        ])
      ]
      // Covered means read directly or found holding my time; anything else is read fresh, so reuse
      // is an optimization the result never depends on.
      const covered = new Set([
        ...(preReadJira?.requiredKeys ?? []),
        ...(preReadJira?.tally ?? []).map((row) => row.ticketKey)
      ])
      // Keys the pre-read did not cover — usually tickets the agent or a split chose — are read on
      // their own and merged. They held none of my time in the pre-read's search, so their rows
      // cannot duplicate it. If the top-up fails, the refresh falls back to a full read.
      const missingKeys = jiraIssueKeys.filter((key) => !covered.has(key))
      const topUp = preReadJira === undefined || pinnedJiraState === undefined || missingKeys.length === 0
        ? undefined
        : yield* Effect.result(jiraTally(period, missingKeys, jiraSnapshot, "required-only"))
      const jiraPreRead = preReadJira === undefined || pinnedJiraState === undefined
        ? undefined
        : missingKeys.length === 0
        ? preReadJira.tally
        : topUp?._tag === "Success"
        ? [...preReadJira.tally, ...topUp.success]
        : undefined
      const [{ recorded, unlinkedClockify }, excludedDays] = yield* Effect.all([
        readRecorded(period, {
          sides,
          jiraIssueKeys,
          jiraPreRead,
          clockifySnapshot: clockifySnapshot ?? undefined,
          jiraSnapshot,
          tolerateUnavailableJira: jiraState?.availability !== "verified"
        }),
        clockifySnapshot === null ? Effect.succeed([]) : runningTimerExclusions(period, clockifySnapshot)
      ], { concurrency: 2 })
      if (
        previous.attributed.length > 0 &&
        recorded.some((row) =>
          row.intervals.some((interval) => interval.source === "jira" && interval.entry === undefined)
        )
      ) {
        return yield* new ReconcileError({
          message: "Jira returned a worklog without an ID; session consumption needs manual review"
        })
      }
      const entries = [
        ...recorded.flatMap((row) =>
          row.intervals.flatMap((interval) => interval.entry === undefined ? [] : [interval.entry])
        ),
        ...unlinkedClockify.flatMap((slice) => slice.entry === undefined ? [] : [slice.entry])
      ]
      const providerScopes: ReadonlyArray<readonly ["clockify" | "jira", string | null]> = [
        ["clockify", clockifyScope],
        ["jira", jiraScope]
      ]
      for (const [provider, scope] of providerScopes) {
        if (previous.attributed.length === 0) break
        if (scope === null) continue
        const known = stored.reviewedWindows.some((window) =>
          window.provider === provider &&
          window.scope === scope && window.fromMs <= period.from.getTime() && window.toMs >= period.to.getTime()
        )
        if (known) continue
        const observed = [...new Map(
          entries.filter((entry) => entry.source === provider)
            .map((entry) => [entry.id, entry])
        ).values()]
        const markerBindings = observed.flatMap(
          (entry): ReadonlyArray<SourceIdentity & { readonly entryId: string }> => {
            const references = entry.description === null ? [] : SourceConsumption.sourceReferences(entry.description)
            if (references.length !== 1 || entry.ticketKey === null) return []
            const reference = references[0]
            if (reference === undefined) return []
            const sourceCredit = previous.attributed.find((credit) =>
              `${credit.day}:${credit.ticketKey}` === reference.rowId
            )
            if (
              sourceCredit === undefined ||
              !sourceCredit.blocks.some((block) =>
                reference.sourceStartMs >= (block.sourceStartMs ?? block.startMs) &&
                reference.sourceStartMs < block.endMs
              )
            ) return []
            return [{
              provider,
              scope,
              entryId: entry.id,
              rowId: reference.rowId,
              sourceStartMs: reference.sourceStartMs,
              startMs: entry.startMs,
              endMs: entry.endMs,
              seconds: (entry.endMs - entry.startMs) / 1000,
              ticketKey: entry.ticketKey
            }]
          }
        )
        const verified = [
          ...stored.bindings.filter((binding) =>
            binding.provider === provider && binding.scope === scope &&
            observed.some((entry) => entry.id === binding.entryId)
          ),
          ...markerBindings.filter((binding) =>
            !stored.bindings.some((knownBinding) =>
              knownBinding.provider === provider && knownBinding.scope === scope &&
              knownBinding.entryId === binding.entryId
            )
          )
        ]
        yield* sourceLedger.ensureWindow(
          {
            provider,
            scope,
            fromMs: period.from.getTime(),
            toMs: period.to.getTime()
          },
          observed.map((entry) => ({ entryId: entry.id, startMs: entry.startMs })),
          verified,
          provider === "clockify" ? clockifySnapshot?.legacyScope : undefined
        ).pipe(
          Effect.catchTag("SourceLedgerError", (cause) => {
            if (cause.reason !== "review-required") return Effect.fail(cause)
            writeBlocked[provider] = cause.message
            return Effect.void
          }),
          Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
        )
      }
      const verifiedLedger = yield* sourceLedger.read.pipe(
        Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
      )
      if (previous.attributed.length > 0) {
        for (const entry of entries) {
          const scope = entry.source === "clockify" ? clockifyScope : jiraScope
          if (
            scope !== null && entry.description !== null &&
            SourceConsumption.markers(entry.description).length > 0 &&
            !verifiedLedger.bindings.some((binding) =>
              binding.provider === entry.source && binding.entryId === entry.id && binding.scope === scope
            )
          ) {
            writeBlocked[entry.source] = "An unlinked source marker needs private manual review before session writes"
          }
        }
      }
      const sourceEntries: ReadonlyArray<SourceConsumption.ResolvedEntry> = verifiedLedger.bindings.filter((binding) =>
        binding.provider === "clockify" ? binding.scope === clockifyScope : binding.scope === jiraScope
      ).flatMap((binding) => {
        const entry = entries.find((candidate) =>
          candidate.source === binding.provider && candidate.id === binding.entryId
        )
        return entry === undefined ? [] : [{
          source: binding.provider,
          id: binding.entryId,
          rowId: binding.rowId,
          sourceStartMs: binding.sourceStartMs,
          startMs: entry.startMs,
          endMs: entry.endMs
        }]
      })
      const executableRecorded = recordedForExecution(recorded, jiraState?.availability)
      return {
        ...previous,
        writeBlocked,
        proposals: buildSessionProposals(previous.attributed, executableRecorded, {
          minimumSeconds: MINIMUM_PROPOSAL_SECONDS,
          excludedDays: excludedDays.map((excluded) => excluded.day),
          sides,
          sourceEntries,
          consumptionRows: unlinkedClockify.map((slice) => ({
            day: slice.day,
            intervals: slice.entry === undefined ? [] : [{ entry: slice.entry }]
          }))
        }).map((proposal) => ({ ...proposal, writeBlocked })),
        recorded,
        unlinkedClockify,
        sourceEntries,
        sourceScopes,
        jiraAvailability: jiraState?.availability,
        excludedDays
      }
    })

    const proposeFromSessions = (
      period: ReconcilePeriod,
      options?: {
        readonly onProgress?: (progress: SessionProposalProgress) => Effect.Effect<void>
        readonly attribution?: AttributionMode
        readonly sides?: ReconcileSides | undefined
      }
    ) =>
      Effect.gen(function*() {
        const onProgress = options?.onProgress ?? (() => Effect.void)
        const cfg = yield* config.get
        const ignoredTickets = new Set(cfg.sessionIgnoredTickets)
        const standingMap = expandedStandingMap(cfg.sessionTicketMap, home)
        const sessions = yield* sessionReader.read(period).pipe(
          Effect.mapError((error) => new ReconcileError({ message: error.message, cause: error }))
        )
        yield* onProgress({ _tag: "SessionsRead", count: sessions.length })

        const sides = options?.sides ?? bothSides
        // Only a run about Jira reads Jira to rank: a Clockify-only week makes no Jira request. The
        // verified profile's client, so a sprint is never read from a different account's site.
        // Resolved once for the whole read: ranking and the first recorded refresh must see the
        // same verified authority, and resolving twice can observe two different answers. The pin
        // never outlives the read: every write path refreshes without it and verifies afresh.
        const jiraState = sides.jira ? yield* jiraWriteState : undefined
        const rankingSnapshot = jiraState?.snapshot ?? undefined
        // The Jira tally is read before attribution, so ranking and the attribution prompt see who
        // logged what, and the first refresh reuses it. Branch, path and standing targets and
        // ledger-bound tickets are required reads; any other candidate the tally lacks is unlogged.
        const preReadJira = rankingSnapshot === undefined ? undefined : yield* Effect.gen(function*() {
          const stored = yield* sourceLedger.read.pipe(
            Effect.mapError((cause) => new ReconcileError({ message: cause.message, cause }))
          )
          const requiredKeys = [
            ...new Set([
              ...sessions.flatMap((session) => {
                const target = deterministicAttribution(session, { standingMap })
                return target === null || ignoredTickets.has(target.ticketKey) ? [] : [target.ticketKey]
              }),
              ...stored.bindings.filter((binding) =>
                binding.provider === "jira" && binding.scope === rankingSnapshot.ledgerScope
              ).map((binding) => binding.ticketKey)
            ])
          ]
          const tally = yield* Effect.result(jiraTally(period, requiredKeys, rankingSnapshot))
          return tally._tag === "Success" ? { tally: tally.success, requiredKeys } : undefined
        })
        const ranking = rankingSnapshot !== undefined
          ? yield* readRankingFacts(
            (jql, nextPageToken) =>
              retryTransport(rankingSnapshot.client.searchIssuesUsingJql({
                params: {
                  jql,
                  maxResults: 100,
                  fields: ["key"],
                  ...((nextPageToken !== undefined) && { nextPageToken })
                }
              })),
            preReadJira?.tally
          )
          : {
            _tag: "Unknown",
            reason: sides.jira ? "Jira account is not verified" : "Jira is out of scope"
          } satisfies RankingFacts

        const ignoredBySession = new Map(sessions.flatMap((session) => {
          const original = deterministicAttribution(session, { standingMap })
          return original === null || !ignoredTickets.has(original.ticketKey)
            ? []
            : [[session.sessionId, original.ticketKey] satisfies readonly [string, string]]
        }))
        const { attributions: primaryAttributions, attributorAvailable, attributorCalls } = yield* attributeSessions(
          sessions.map((session) => ({
            ...session,
            candidateKeys: session.candidateKeys.filter((key) => !ignoredTickets.has(key))
          })),
          {
            standingMap,
            ignoredTickets,
            confidenceFloor: cfg.sessionConfidenceFloor,
            mode: options?.attribution ?? "full",
            onProgress,
            candidateFact: candidateFact(ranking)
          }
        )
        // A split is a guess from mention counts: a deterministic read reports the session unplaced
        // instead, so an unattended watch never downgrades a branch-placed row to `split`.
        const attributions = primaryAttributions.map((attribution, index) => {
          const session = sessions[index]
          return session === undefined || options?.attribution === "deterministic" ?
            attribution :
            splitSessionAttribution(
              session,
              attribution,
              ranking._tag === "Known" && jiraState?.availability === "verified" ? ranking.sprint : undefined,
              ignoredTickets
            )
        })

        // Windows first, then attribution, then sharing — in that order, because time is divided
        // between distinct Issue Keys, not between sessions. Two sessions on one ticket must union
        // their windows rather than halve each other.
        const nowMs = yield* Clock.currentTimeMillis
        const windows = activeWindows(sessions.flatMap((session) => session.activity), {
          idleCapSeconds: cfg.sessionIdleCapSeconds,
          // The end of the window being reconciled — which for a watch is now. Presence is never
          // credited past what this run can see.
          observedAtMs: Math.min(period.to.getTime(), nowMs),
          boundsBySession: new Map(
            sessions.flatMap((session) =>
              session.boundedAtMs === null ? [] : [[session.sessionId, session.boundedAtMs]]
            )
          )
        })
        const attributionBySession = new Map(attributions.map((attribution) => [attribution.sessionId, attribution]))
        const ignored = ignoredCredits(
          windows.map((window) => ({
            ...window,
            ticketKey: ignoredBySession.get(window.sessionId) ?? null
          })),
          ignoredTickets
        )
        const eligibleWindows = windows.filter((window) => {
          const key = attributionBySession.get(window.sessionId)?.ticketKey
          return !ignoredBySession.has(window.sessionId) ||
            (attributionBySession.get(window.sessionId)?.targets?.length ?? 0) > 0 ||
            (key !== null && key !== undefined && !ignoredTickets.has(key))
        })
        const split = splitCredits(eligibleWindows, attributions, {
          cwdBySession: new Map(sessions.map((session) => [session.sessionId, session.cwd])),
          dwellSeconds: cfg.sessionDwellSeconds,
          priority: ticketPriority(ranking),
          ignoredTickets
        })

        yield* onProgress({ _tag: "ReadingRecordedTime", sides })
        return yield* refreshRecordedTime(
          period,
          {
            attributed: split.attributed,
            sessionEvidence: windows.flatMap((window) => {
              const attribution = attributionBySession.get(window.sessionId)
              const keys = attribution?.targets?.map((target) => target.ticketKey) ??
                [attribution?.ticketKey ?? ignoredBySession.get(window.sessionId) ?? null]
              return keys.map((ticketKey) => ({ ...window, ticketKey }))
            }),
            sides,
            withheld: split.withheld,
            unattributed: split.unattributed,
            ignored,
            ignoredTickets: [...ignoredTickets].sort(),
            attributorAvailable,
            sessionCount: sessions.length,
            sessionRootCount: cfg.sessionRoots.length,
            attributorCalls,
            digests: new Map(sessions.map((session) => [session.sessionId, session.digest]))
          },
          undefined,
          jiraState,
          preReadJira
        )
      })

    return {
      compare,
      compareDirection,
      applyToJira,
      applyToClockify,
      describeProposals,
      proposeFromSessions,
      refreshRecordedTime
    }
  })
)
