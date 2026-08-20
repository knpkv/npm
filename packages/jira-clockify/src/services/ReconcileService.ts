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
 *   without a parseable key (or still running) are ignored.
 * - Days are local calendar days so the buckets line up with how a person reads their timesheet.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as SubscriptionRef from "effect/SubscriptionRef"
import {
  activeWindows,
  type AgentChoice,
  attributeSession,
  buildSessionProposals,
  deterministicAttribution,
  expandHomePath,
  type SessionProposal,
  splitCredits,
  type TicketDayCredit,
  type UnattributedDayCredit
} from "../agent/sessions.js"
import { localDay, nextLocalMidnight } from "../utils/time.js"
import { AgentSessionReader } from "./AgentSessionReader.js"
import { ClockifyAuth } from "./ClockifyAuth.js"
import { ConfigService } from "./ConfigService.js"
import { HomeDirectory } from "./HomeDirectory.js"
import { type AttributionChoice, SessionAttributor, type SessionDescribeAnswer } from "./SessionAttributor.js"
import { type JiraWorklogOutcome, TimerService } from "./TimerService.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Which side is the source of truth when filling a gap. */
export type ReconcileDirection = "clockify-to-jira" | "jira-to-clockify"

/** A half-open period [from, to). */
export interface ReconcilePeriod {
  readonly from: Date
  readonly to: Date
}

/** One `(ticket, day)` bucket with the time logged on each side. */
export interface ReconcileRow {
  readonly ticketKey: string
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  /**
   * The Clockify entry description(s) for this bucket, ticket-prefix stripped and combined.
   * Used as the Jira worklog comment when filling clockify→jira. null when nothing meaningful.
   */
  readonly clockifyDescription: string | null
}

export class ReconcileError extends Data.TaggedError("ReconcileError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Gaps below this are noise, not work: Jira floors worklogs to the minute, so a shorter
 * proposal could not be written faithfully even if it were offered. No other rounding applies —
 * proposals are exact to the minute rather than tidied to a quarter hour.
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
 * Progress a caller can report while a run is working, so a slow step is never silent.
 *
 * `SessionAttributed` fires per completed call rather than only at the end: the calls take tens of
 * seconds each, so a start-and-finish pair leaves minutes of silence in between — which is
 * indistinguishable from a hang, and was in fact reported as one.
 */
export type SessionProposalProgress =
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
export interface SessionProposalReport {
  /** Proposed Worklogs, ready for row-by-row confirmation. */
  readonly proposals: ReadonlyArray<SessionProposal>
  /** Attributed below the confidence floor — reported, never offered. */
  readonly withheld: ReadonlyArray<TicketDayCredit>
  /** Hours no Attribution Signal could place. */
  readonly unattributed: ReadonlyArray<UnattributedDayCredit>
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

export interface ReconcileServiceContract {
  /** Compare Clockify entries and Jira worklogs over the period, bucketed by ticket+day. */
  readonly compare: (period: ReconcilePeriod) => Effect.Effect<ReadonlyArray<ReconcileRow>, ReconcileError>
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
    startedAt?: Date
  ) => Effect.Effect<JiraWorklogOutcome>
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
    startedAt?: Date
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
  const bracket = desc.match(/^\[([^\]]+)\]/)
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
  readonly ticketKey: string
  readonly day: string
  readonly seconds: number
  /** Original entry description (Clockify side) — combined into the worklog comment. */
  readonly description?: string | null
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
  const meta = new Map<string, { ticketKey: string; day: string }>()

  for (const e of clockify) {
    const k = key(e.ticketKey, e.day)
    clockifyByKey.set(k, (clockifyByKey.get(k) ?? 0) + e.seconds)
    const descs = descByKey.get(k) ?? []
    descs.push(e.description)
    descByKey.set(k, descs)
    if (!meta.has(k)) meta.set(k, { ticketKey: e.ticketKey, day: e.day })
  }
  for (const e of jira) {
    const k = key(e.ticketKey, e.day)
    jiraByKey.set(k, (jiraByKey.get(k) ?? 0) + e.seconds)
    if (!meta.has(k)) meta.set(k, { ticketKey: e.ticketKey, day: e.day })
  }

  return [...meta.entries()]
    .map(([k, { day, ticketKey }]) => ({
      ticketKey,
      day,
      clockifySeconds: clockifyByKey.get(k) ?? 0,
      jiraSeconds: jiraByKey.get(k) ?? 0,
      clockifyDescription: combineDescriptions(descByKey.get(k) ?? [])
    }))
    .sort((a, b) => (a.day === b.day ? a.ticketKey.localeCompare(b.ticketKey) : a.day.localeCompare(b.day)))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface RawWorklog {
  readonly author?: { readonly accountId?: string } | undefined
  readonly started?: string | undefined
  readonly timeSpentSeconds?: number | undefined
}

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
    ...((Predicate.isString(accountId)) && { author: { accountId } }),
    ...((Predicate.isString(value.started)) && { started: value.started }),
    ...((Predicate.isNumber(value.timeSpentSeconds)) && { timeSpentSeconds: value.timeSpentSeconds })
  }
}

const toRawWorklogs = <UnparsedInput>(response: UnparsedInput): ReadonlyArray<RawWorklog> => {
  if (!Predicate.isObject(response) || !Array.isArray(response.worklogs)) return []
  return response.worklogs.flatMap((worklog) => {
    const parsed = toRawWorklog(worklog)
    return parsed === null ? [] : [parsed]
  })
}

export const layer = Layer.effect(
  ReconcileService,
  Effect.gen(function*() {
    const clockify = yield* ClockifyApiClient
    const clockifyAuth = yield* ClockifyAuth
    const jira = yield* JiraApiClient
    const jiraAuth = yield* JiraAuth
    const config = yield* ConfigService
    const home = (yield* HomeDirectory).path
    const timer = yield* TimerService
    const sessionReader = yield* AgentSessionReader
    const attributor = yield* SessionAttributor

    const getAuth = clockifyAuth.getConfig.pipe(
      Effect.mapError((e) => new ReconcileError({ message: e.message }))
    )

    // Tally Clockify entries in the period by (ticket, day).
    const clockifyTally = (period: ReconcilePeriod) =>
      Effect.gen(function*() {
        const auth = yield* getAuth
        const entries = yield* clockify.getTimeEntries(auth.workspaceId, auth.userId, {
          start: period.from.toISOString(),
          end: period.to.toISOString()
        }).pipe(
          Effect.mapError((e) => new ReconcileError({ message: `Clockify fetch failed: ${e.message}`, cause: e }))
        )

        const tally: Array<{ ticketKey: string; day: string; seconds: number; description: string | null }> = []
        for (const entry of entries) {
          const ticketKey = parseTicketKey(entry.description)
          const start = entry.timeInterval?.start
          const end = entry.timeInterval?.end
          // Skip running or unparseable entries: a missing end means the time is not yet real.
          if (ticketKey === null || start === undefined || start === null) continue
          if (end === undefined || end === null) continue
          const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000))
          tally.push({ ticketKey, day: localDay(new Date(start)), seconds, description: entry.description ?? null })
        }
        return tally
      })

    // Tally the current user's Jira worklogs in the period by (ticket, day).
    const jiraTally = (period: ReconcilePeriod) =>
      Effect.gen(function*() {
        const user = yield* jiraAuth.getCurrentUser().pipe(Effect.catch(() => Effect.succeed(null)))
        const accountId = user?.account_id ?? null

        const fromDay = localDay(period.from)
        const toDay = localDay(period.to)
        // Find issues the user logged work on in the window.
        const search = yield* jira.searchIssuesUsingJql({
          params: {
            jql: `worklogAuthor = currentUser() AND worklogDate >= "${fromDay}" AND worklogDate <= "${toDay}"`,
            maxResults: 100,
            fields: ["key"]
          }
        }).pipe(
          Effect.mapError((e) => new ReconcileError({ message: `Jira search failed: ${String(e)}`, cause: e }))
        )

        const issueKeys = (search.issues ?? []).flatMap((issue) => {
          const key = issueKey(issue)
          return key === null ? [] : [key]
        })

        const fromMs = period.from.getTime()
        const toMs = period.to.getTime()
        const tally: Array<{ ticketKey: string; day: string; seconds: number }> = []

        for (const issueKey of issueKeys) {
          const worklogs = yield* jira.getIssueWorklog(issueKey, {
            params: {
              startedAfter: fromMs,
              startedBefore: toMs
            }
          }).pipe(
            Effect.map(toRawWorklogs),
            // Deliberately *not* swallowed into an empty list. An unread worklog is indistinguishable
            // from an absent one, and every caller subtracts this tally from something before
            // writing the difference — so one transient Jira error would silently re-log hours that
            // are already there. Failing costs a run; guessing costs someone else's timesheet.
            Effect.mapError((e) =>
              new ReconcileError({ message: `Jira worklog fetch failed for ${issueKey}: ${String(e)}`, cause: e })
            )
          )

          for (const wl of worklogs) {
            if (wl.started === undefined || !Predicate.isNumber(wl.timeSpentSeconds)) continue
            // Only this user's worklogs (the JQL narrows issues, not individual worklog authors).
            const author = wl.author?.accountId
            if (accountId !== null && author !== undefined && author !== accountId) continue
            const startedMs = new Date(wl.started).getTime()
            if (startedMs < fromMs || startedMs >= toMs) continue
            tally.push({ ticketKey: issueKey, day: localDay(new Date(wl.started)), seconds: wl.timeSpentSeconds })
          }
        }
        return tally
      })

    const compare = (period: ReconcilePeriod) =>
      Effect.gen(function*() {
        const [clockifySide, jiraSide] = yield* Effect.all([clockifyTally(period), jiraTally(period)], {
          concurrency: 2
        })
        return buildReconcileRows(clockifySide, jiraSide)
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

    const applyToJira = (ticketKey: string, day: string, seconds: number, comment?: string, startedAt?: Date) =>
      timer.logWorklog({
        ticketKey,
        startedAt: startOf(day, startedAt),
        durationSeconds: seconds,
        // Carry the Clockify description across; only fall back to a generic note when blank.
        comment: comment !== undefined && comment.trim() !== "" ? comment.trim() : "Reconciled from Clockify"
      })

    const applyToClockify = (
      ticketKey: string,
      day: string,
      seconds: number,
      note?: string,
      startedAt?: Date
    ) =>
      Effect.gen(function*() {
        const auth = yield* getAuth
        const cfg = yield* config.get
        const start = startOf(day, startedAt)
        const end = new Date(start.getTime() + seconds * 1000)
        yield* clockify.createTimeEntry(auth.workspaceId, {
          description: `[${ticketKey}] ${
            note !== undefined && note.trim() !== "" ? note.trim() : "Reconciled from Jira"
          }`,
          start: start.toISOString(),
          end: end.toISOString(),
          ...((cfg.defaultProjectId) && { projectId: cfg.defaultProjectId })
        }).pipe(
          Effect.mapError((e) => new ReconcileError({ message: `Clockify create failed: ${e.message}`, cause: e }))
        )
        return true
      })

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
    const runningTimerExclusions = (period: ReconcilePeriod) =>
      Effect.gen(function*() {
        // Fails the run rather than logging and carrying on. An unknown running-timer state is not
        // an absent one, and every caller of this subtracts before writing the difference.
        yield* timer.detectRunning.pipe(
          Effect.mapError((error) =>
            new ReconcileError({ message: `Could not rule out a running timer: ${error.message}`, cause: error })
          )
        )
        const state = yield* SubscriptionRef.get(timer.state)
        if (!state.active || state.startedAt === null) return []
        const startedMs = state.startedAt.getTime()
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
        readonly confidenceFloor: number
        readonly mode: AttributionMode
        readonly onProgress: (progress: SessionProposalProgress) => Effect.Effect<void>
      }
    ) =>
      Effect.gen(function*() {
        // `deterministicAttribution` is asked here purely to decide whether a call is warranted;
        // `attributeSession` remains the single place the precedence is actually applied.
        const needsAgent = options.mode === "deterministic" ?
          [] :
          sessions.filter((session) =>
            deterministicAttribution(session, { standingMap: options.standingMap }) === null &&
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
          batches.map((batch) =>
            attributor.attribute(
              batch.map((session) => ({
                sessionId: session.sessionId,
                candidateKeys: session.candidateKeys,
                digest: session.digest
              }))
            ).pipe(
              Effect.map((answers) => {
                const bySession = new Map(answers.map((answer) => [answer.sessionId, answer.choice]))
                return batch.map((session) => {
                  const declined: AttributionChoice = { _tag: "None" }
                  const choice = bySession.get(session.sessionId) ?? declined
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
            confidenceFloor: options.confidenceFloor
          })
        )

        return { attributions, attributorAvailable, attributorCalls: batches.length }
      })

    const describeProposals = (options: {
      readonly proposals: ReadonlyArray<SessionProposal>
      readonly digests: ReadonlyMap<string, string>
      readonly summaries?: ReadonlyMap<string, string> | undefined
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
                Effect.logWarning(`Could not describe ${batch.length} row(s): ${error.message}`).pipe(
                  Effect.as(batch.map((request): SessionDescribeAnswer => ({ id: request.id, note: null })))
                )
              )
            ),
          { concurrency: ATTRIBUTOR_CONCURRENCY }
        )
        const byId = new Map(answers.flat().map((answer) => [answer.id, answer.note]))
        return requests.map((request) => byId.get(request.id) ?? null)
      })

    const proposeFromSessions = (
      period: ReconcilePeriod,
      options?: {
        readonly onProgress?: (progress: SessionProposalProgress) => Effect.Effect<void>
        readonly attribution?: AttributionMode
      }
    ) =>
      Effect.gen(function*() {
        const onProgress = options?.onProgress ?? (() => Effect.void)
        const cfg = yield* config.get
        const sessions = yield* sessionReader.read(period).pipe(
          Effect.mapError((error) => new ReconcileError({ message: error.message, cause: error }))
        )
        yield* onProgress({ _tag: "SessionsRead", count: sessions.length })

        const { attributions, attributorAvailable, attributorCalls } = yield* attributeSessions(sessions, {
          standingMap: expandedStandingMap(cfg.sessionTicketMap, home),
          confidenceFloor: cfg.sessionConfidenceFloor,
          mode: options?.attribution ?? "full",
          onProgress
        })

        // Windows first, then attribution, then sharing — in that order, because time is divided
        // between distinct Issue Keys, not between sessions. Two sessions on one ticket must union
        // their windows rather than halve each other.
        const windows = activeWindows(sessions.flatMap((session) => session.activity), {
          idleCapSeconds: cfg.sessionIdleCapSeconds,
          // The end of the window being reconciled — which for a watch is now. Presence is never
          // credited past what this run can see.
          observedAtMs: period.to.getTime(),
          boundsBySession: new Map(
            sessions.flatMap((session) =>
              session.boundedAtMs === null ? [] : [[session.sessionId, session.boundedAtMs]]
            )
          )
        })
        const split = splitCredits(windows, attributions)

        const [recorded, excludedDays] = yield* Effect.all([compare(period), runningTimerExclusions(period)])

        return {
          proposals: buildSessionProposals(split.attributed, recorded, {
            minimumSeconds: MINIMUM_PROPOSAL_SECONDS,
            excludedDays: excludedDays.map((excluded) => excluded.day)
          }),
          withheld: split.withheld,
          unattributed: split.unattributed,
          excludedDays,
          attributorAvailable,
          sessionCount: sessions.length,
          sessionRootCount: cfg.sessionRoots.length,
          attributorCalls,
          digests: new Map(sessions.map((session) => [session.sessionId, session.digest]))
        }
      })

    return { compare, applyToJira, applyToClockify, describeProposals, proposeFromSessions }
  })
)
