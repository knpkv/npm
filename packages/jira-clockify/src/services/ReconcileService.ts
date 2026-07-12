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
import { ClockifyAuth } from "./ClockifyAuth.js"
import { ConfigService } from "./ConfigService.js"
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

export interface ReconcileServiceShape {
  /** Compare Clockify entries and Jira worklogs over the period, bucketed by ticket+day. */
  readonly compare: (period: ReconcilePeriod) => Effect.Effect<ReadonlyArray<ReconcileRow>, ReconcileError>
  /** Post `seconds` of work to Jira for `(ticketKey, day)`, with an optional worklog comment. */
  readonly applyToJira: (
    ticketKey: string,
    day: string,
    seconds: number,
    comment?: string
  ) => Effect.Effect<JiraWorklogOutcome>
  /** Create a closed Clockify entry of `seconds` for `(ticketKey, day)`. Resolves true on success. */
  readonly applyToClockify: (
    ticketKey: string,
    day: string,
    seconds: number
  ) => Effect.Effect<boolean, ReconcileError>
}

export class ReconcileService extends Context.Service<ReconcileService, ReconcileServiceShape>()(
  "jcf/ReconcileService"
) {}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Parse a ticket key from a Clockify description (`[KEY] summary` or `KEY: summary`). */
export const parseTicketKey = (description: string | null | undefined): string | null => {
  const desc = description ?? ""
  const bracket = desc.match(/^\[([^\]]+)\]/)
  if (bracket?.[1]) return bracket[1].trim()
  const colon = desc.match(/^([A-Za-z][A-Za-z0-9]*-\d+):/)
  if (colon?.[1]) return colon[1].trim()
  return null
}

/** Local calendar day (`YYYY-MM-DD`) of an instant — matches how a timesheet reads. */
export const localDay = (date: Date): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

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
    if (text && !seen.has(text)) {
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

const issueKey = (issue: unknown): string | null => {
  if (!Predicate.isObject(issue)) return null
  const key = issue.key
  return typeof key === "string" ? key : null
}

const toRawWorklog = (value: unknown): RawWorklog | null => {
  if (!Predicate.isObject(value)) return null
  const author = Predicate.isObject(value.author) ? value.author : undefined
  const accountId = author?.accountId
  return {
    ...(typeof accountId === "string" ? { author: { accountId } } : {}),
    ...(typeof value.started === "string" ? { started: value.started } : {}),
    ...(typeof value.timeSpentSeconds === "number" ? { timeSpentSeconds: value.timeSpentSeconds } : {})
  }
}

const toRawWorklogs = (response: unknown): ReadonlyArray<RawWorklog> => {
  if (!Predicate.isObject(response) || !Array.isArray(response.worklogs)) return []
  return response.worklogs.flatMap((worklog) => {
    const parsed = toRawWorklog(worklog)
    return parsed ? [parsed] : []
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
    const timer = yield* TimerService

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
          if (!ticketKey || !start || !end) continue // skip running / unparseable entries
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
          return key ? [key] : []
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
            Effect.catch(() => Effect.succeed<ReadonlyArray<RawWorklog>>([]))
          )

          for (const wl of worklogs) {
            if (!wl.started || typeof wl.timeSpentSeconds !== "number") continue
            // Only this user's worklogs (the JQL narrows issues, not individual worklog authors).
            if (accountId && wl.author?.accountId && wl.author.accountId !== accountId) continue
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

    // Noon-local on the bucket's day — keeps the worklog/entry firmly on that calendar day.
    const dayStart = (day: string): Date => new Date(`${day}T12:00:00`)

    const applyToJira = (ticketKey: string, day: string, seconds: number, comment?: string) =>
      timer.logWorklog({
        ticketKey,
        startedAt: dayStart(day),
        durationSeconds: seconds,
        // Carry the Clockify description across; only fall back to a generic note when blank.
        comment: comment && comment.trim() ? comment.trim() : "Reconciled from Clockify"
      })

    const applyToClockify = (ticketKey: string, day: string, seconds: number) =>
      Effect.gen(function*() {
        const auth = yield* getAuth
        const cfg = yield* config.get
        const start = dayStart(day)
        const end = new Date(start.getTime() + seconds * 1000)
        yield* clockify.createTimeEntry(auth.workspaceId, {
          description: `[${ticketKey}] Reconciled from Jira`,
          start: start.toISOString(),
          end: end.toISOString(),
          ...(cfg.defaultProjectId ? { projectId: cfg.defaultProjectId } : {})
        }).pipe(
          Effect.mapError((e) => new ReconcileError({ message: `Clockify create failed: ${e.message}`, cause: e }))
        )
        return true
      })

    return { compare, applyToJira, applyToClockify }
  })
)
