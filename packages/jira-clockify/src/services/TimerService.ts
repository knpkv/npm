/**
 * Core timer lifecycle — start, stop, detect running — bridging Clockify and Jira worklog.
 *
 * **Mental model**
 *
 * - **Dual write**: Starting a timer creates a Clockify time entry AND updates the local
 *   state file (for Neovim/statusline). Stopping updates the Clockify entry AND posts
 *   a Jira worklog via raw HTTP (generated client swallows 4xx as void).
 * - **Auto-resolution**: Project ID, billable flag, and tags are resolved from config defaults,
 *   Clockify project name matching, and Jira issue type/labels.
 * - **External detection**: {@link TimerServiceShape.detectRunning} polls Clockify for a
 *   running timer not started by jcf and syncs local state.
 *
 * **Gotchas**
 *
 * - Jira worklog uses raw HTTP because the generated client returns void for 4xx — check
 *   `response.status` manually.
 * - `timeSpentSeconds` is floored to 60s minimum (Jira rejects <60s worklogs).
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { ClockifyAuth } from "./ClockifyAuth.js"
import { ConfigService } from "./ConfigService.js"
import { StateWriter, type TimerStateFile } from "./StateWriter.js"
import type { JiraTicket } from "./TicketService.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface TimerState {
  readonly active: boolean
  readonly ticketKey: string | null
  readonly summary: string | null
  readonly project: string | null
  readonly startedAt: Date | null
  readonly clockifyEntryId: string | null
  readonly projectId: string | null
  readonly projectName: string | null
  /** null = user hasn't explicitly set it (prompt on stop) */
  readonly billable: boolean | null
  /** true if timer was started via jcf (not just detected from Clockify) */
  readonly startedViaJcf: boolean
}

export interface StopResult {
  readonly duration: Duration.Duration
  readonly clockifyLogged: boolean
  readonly jiraWorklogLogged: boolean
  readonly needsProjectId: boolean
  readonly needsBillable: boolean
}

export class TimerError extends Data.TaggedError("TimerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const emptyState: TimerState = {
  active: false,
  ticketKey: null,
  summary: null,
  project: null,
  startedAt: null,
  clockifyEntryId: null,
  projectId: null,
  projectName: null,
  billable: null,
  startedViaJcf: false
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface StartOptions {
  readonly projectId?: string | undefined
  readonly billable?: boolean | undefined
  /** Backdate the timer start (e.g. "I forgot to start it 15m ago"). Defaults to now. */
  readonly startedAt?: Date | undefined
}

export interface StopOptions {
  readonly projectId?: string | undefined
  readonly billable?: boolean | undefined
  readonly comment?: string | undefined
}

/** A completed interval logged retroactively when the timer was never started. */
export interface LogManualOptions {
  readonly start: Date
  readonly durationSeconds: number
  readonly projectId?: string | undefined
  readonly billable?: boolean | undefined
  readonly comment?: string | undefined
}

export interface LogManualResult {
  readonly clockifyLogged: boolean
  readonly jiraWorklogLogged: boolean
  readonly projectId: string | null
  readonly billable: boolean | null
}

export interface TimerServiceShape {
  readonly state: SubscriptionRef.SubscriptionRef<TimerState>
  readonly start: (ticket: JiraTicket, options?: StartOptions) => Effect.Effect<void, TimerError>
  readonly stop: (options?: StopOptions) => Effect.Effect<StopResult, TimerError>
  /** Write a completed interval directly (Clockify entry + Jira worklog), no running timer involved. */
  readonly logManual: (ticket: JiraTicket, options: LogManualOptions) => Effect.Effect<LogManualResult, TimerError>
  readonly discard: Effect.Effect<void, TimerError>
  readonly detectRunning: Effect.Effect<void, TimerError>
}

export class TimerService extends Context.Tag("jcf/TimerService")<TimerService, TimerServiceShape>() {}

export const layer = Layer.effect(
  TimerService,
  Effect.gen(function*() {
    const clockify = yield* ClockifyApiClient
    yield* JiraApiClient // ensure dep is in layer
    const httpClient = yield* HttpClient.HttpClient
    const jiraAuth = yield* JiraAuth
    const clockifyAuth = yield* ClockifyAuth
    const config = yield* ConfigService
    const stateWriter = yield* StateWriter
    const ref = yield* SubscriptionRef.make<TimerState>(emptyState)
    const tagCache = new Map<string, string>()

    const writeStateFile = (state: TimerState) => {
      const file: TimerStateFile = {
        active: state.active,
        ticketKey: state.ticketKey,
        summary: state.summary,
        project: state.project,
        startedAt: state.startedAt?.toISOString() ?? null,
        startedAt_unix: state.startedAt ? Math.floor(state.startedAt.getTime() / 1000) : null,
        elapsed: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : 0,
        clockifyEntryId: state.clockifyEntryId
      }
      return stateWriter.write(file)
    }

    const getAuth = clockifyAuth.getConfig.pipe(
      Effect.mapError((e) => new TimerError({ message: e.message }))
    )

    // Resolve projectId: explicit > config default > auto-match by Jira-project name > null
    const resolveProjectId = (ticket: JiraTicket, workspaceId: string, explicit: string | null) =>
      Effect.gen(function*() {
        const cfg = yield* config.get
        let projectId = explicit ?? cfg.defaultProjectId ?? null
        if (!projectId) {
          const jiraProject = ticket.key.split("-")[0] ?? ""
          const clockifyProjectName = cfg.projectMap[jiraProject] ?? jiraProject
          const project = yield* clockify.getProjectByName(workspaceId, clockifyProjectName).pipe(
            Effect.catchAll(() => Effect.succeed(null))
          )
          if (project) projectId = project.id
        }
        return projectId
      })

    // Resolve tags: ticket type + Jira labels → Clockify tag IDs (cached per process)
    const resolveTagIds = (ticket: JiraTicket, workspaceId: string) =>
      Effect.gen(function*() {
        const tagNames = [ticket.type, ...ticket.labels].filter(Boolean)
        const tagIds: Array<string> = []
        for (const tagName of tagNames) {
          const cached = tagCache.get(tagName)
          if (cached) {
            tagIds.push(cached)
            continue
          }
          const tag = yield* clockify.findOrCreateTag(workspaceId, tagName).pipe(
            Effect.catchAll(() => Effect.succeed(null))
          )
          if (tag) {
            tagIds.push(tag.id)
            tagCache.set(tagName, tag.id)
          }
        }
        yield* Effect.logDebug(`Clockify tags: ${tagNames.join(", ")} → ${tagIds.length} tag IDs`)
        return tagIds
      })

    // Post a Jira worklog via raw HTTP (generated client swallows 4xx as void). Returns success.
    const postJiraWorklog = (ticketKey: string, startedAt: Date, durationSeconds: number, comment?: string) =>
      Effect.gen(function*() {
        // Jira rejects worklogs <60s — floor to 60s. Clockify keeps actual elapsed.
        const timeSpent = Math.max(60, Math.floor(durationSeconds))
        const started = startedAt.toISOString().replace("Z", "+0000")
        yield* Effect.logDebug(`Jira worklog: ${ticketKey} ${timeSpent}s`)

        const accessToken = yield* jiraAuth.getAccessToken().pipe(
          Effect.tapError((e) => Effect.logDebug(`Jira getAccessToken failed: ${String(e)}`)),
          Effect.catchAll(() => Effect.succeed(Redacted.make("")))
        )
        const cloudId = yield* jiraAuth.getCloudId().pipe(Effect.catchAll(() => Effect.succeed("")))

        // Short-circuit: without a token or cloudId the request is guaranteed to
        // 401 against a malformed URL — fail fast locally instead.
        if (Redacted.value(accessToken) === "" || cloudId === "") {
          yield* Effect.logDebug("Jira worklog skipped: missing access token or cloudId")
          return false
        }

        const response = yield* httpClient.execute(
          HttpClientRequest.post(
            `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/worklog`
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(accessToken)}`),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyUnsafeJson({
              started,
              timeSpentSeconds: timeSpent,
              ...(comment ?
                {
                  comment: {
                    type: "doc",
                    version: 1,
                    content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }]
                  }
                } :
                {})
            })
          )
        ).pipe(
          Effect.catchAll((e) => Effect.logDebug(`Jira worklog failed: ${String(e)}`).pipe(Effect.map(() => null)))
        )

        if (response && response.status >= 200 && response.status < 300) {
          yield* Effect.logDebug(`Jira worklog created (${response.status})`)
          return true
        }
        if (response) {
          const body = yield* response.text.pipe(Effect.catchAll(() => Effect.succeed("")))
          yield* Effect.logDebug(`Jira worklog failed (${response.status}): ${body.slice(0, 300)}`)
        }
        return false
      })

    const start = (ticket: JiraTicket, options?: StartOptions) =>
      Effect.gen(function*() {
        const auth = yield* getAuth
        const cfg = yield* config.get

        // The new entry's start (possibly backdated to correct a forgotten start).
        const newStartedAt = options?.startedAt ?? new Date()

        // Auto-stop existing timer. When backdating, close the previous entry at
        // the new start time (not now) to avoid overlapping Clockify intervals.
        const current = yield* SubscriptionRef.get(ref)
        if (current.active) {
          yield* internalStop(undefined, newStartedAt).pipe(
            Effect.catchAll((e) => Effect.logWarning(`Auto-stop failed, Clockify entry may be orphaned: ${e.message}`))
          )
        }

        const projectId = yield* resolveProjectId(ticket, auth.workspaceId, options?.projectId ?? null)

        // Resolve project name
        let projectName: string | null = cfg.defaultProjectName ?? null
        if (projectId && !projectName) {
          const projects = yield* clockify.getProjects(auth.workspaceId).pipe(
            Effect.catchAll(() => Effect.succeed([] as const))
          )
          projectName = projects.find((p) => p.id === projectId)?.name ?? null
        }

        // Resolve billable: explicit > config default > null (will prompt on stop)
        const billable = options?.billable ?? cfg.defaultBillable ?? null

        const tagIds = yield* resolveTagIds(ticket, auth.workspaceId)

        // Start timer — `startedAt` may be backdated to correct a forgotten start
        const now = newStartedAt
        const entry = yield* clockify.createTimeEntry(auth.workspaceId, {
          description: `[${ticket.key}] ${ticket.summary}`,
          start: now.toISOString(),
          ...(projectId ? { projectId } : {}),
          ...(billable !== null ? { billable } : {}),
          ...(tagIds.length > 0 ? { tagIds } : {})
        }).pipe(
          Effect.mapError((e) => new TimerError({ message: `Failed to start timer: ${e.message}`, cause: e }))
        )

        const newState: TimerState = {
          active: true,
          ticketKey: ticket.key,
          summary: ticket.summary,
          project: ticket.key.split("-")[0] ?? null,
          startedAt: now,
          clockifyEntryId: entry.id,
          projectId,
          projectName,
          billable,
          startedViaJcf: true
        }

        yield* writeStateFile(newState)
        yield* SubscriptionRef.set(ref, newState)
      })

    const internalStop = (options?: StopOptions, endAt?: Date) =>
      Effect.gen(function*() {
        const auth = yield* getAuth
        const current = yield* SubscriptionRef.get(ref)

        if (!current.active || !current.startedAt) {
          return yield* Effect.fail(new TimerError({ message: "No active timer" }))
        }

        // `endAt` lets `start` close the previous entry at the new (possibly
        // backdated) start time so the two Clockify intervals never overlap.
        // Never end before the entry began.
        const now = endAt && endAt.getTime() >= current.startedAt.getTime() ? endAt : new Date()
        const durationMs = now.getTime() - current.startedAt.getTime()
        const duration = Duration.millis(durationMs)

        // Merge: stop options override current state
        const projectId = options?.projectId ?? current.projectId ?? null
        const billable = options?.billable ?? current.billable ?? null
        const comment = options?.comment

        // Stop via PUT — preserve existing tagIds from the entry
        if (current.clockifyEntryId) {
          const existing = yield* clockify.getTimeEntry(auth.workspaceId, current.clockifyEntryId).pipe(
            Effect.catchAll(() => Effect.succeed(null))
          )
          const tagIds = existing?.tagIds ?? []

          // Append comment to Clockify description if provided
          const description = comment
            ? `${existing?.description ?? ""} | ${comment}`
            : undefined

          yield* clockify.updateTimeEntry(auth.workspaceId, current.clockifyEntryId, {
            start: current.startedAt.toISOString(),
            end: now.toISOString(),
            ...(description !== undefined ? { description } : {}),
            ...(projectId ? { projectId } : {}),
            ...(billable !== null ? { billable } : {}),
            ...(tagIds.length > 0 ? { tagIds: [...tagIds] } : {})
          }).pipe(
            Effect.mapError((e) => new TimerError({ message: `Failed to stop timer: ${e.message}`, cause: e }))
          )
        } else {
          yield* clockify.stopTimer(auth.workspaceId, auth.userId, {
            end: now.toISOString()
          }).pipe(
            Effect.mapError((e) => new TimerError({ message: `Failed to stop timer: ${e.message}`, cause: e }))
          )
        }

        // Log Jira worklog (raw HTTP — generated client swallows 4xx as void)
        let jiraLogged = false
        if (current.ticketKey) {
          jiraLogged = yield* postJiraWorklog(current.ticketKey, current.startedAt, durationMs / 1000, comment)
        }

        yield* SubscriptionRef.set(ref, emptyState)
        yield* stateWriter.clear

        return {
          duration,
          clockifyLogged: true,
          jiraWorklogLogged: jiraLogged,
          needsProjectId: !projectId,
          needsBillable: billable === null
        } satisfies StopResult
      })

    // Log a completed interval after the fact — for when the timer was never started.
    // Writes a closed Clockify entry (start + end) and posts the matching Jira worklog,
    // without ever touching the running-timer state.
    const logManual = (ticket: JiraTicket, options: LogManualOptions) =>
      Effect.gen(function*() {
        // Shared future-time guard for all backdating callers (log + stop-correction).
        // Mirrors `start --since`, which rejects future starts at the command layer.
        if (options.start.getTime() > Date.now()) {
          return yield* Effect.fail(
            new TimerError({ message: "Start time is in the future. Pick a time at or before now." })
          )
        }

        const auth = yield* getAuth
        const cfg = yield* config.get

        const projectId = yield* resolveProjectId(ticket, auth.workspaceId, options.projectId ?? null)
        const billable = options.billable ?? cfg.defaultBillable ?? null
        const tagIds = yield* resolveTagIds(ticket, auth.workspaceId)

        const end = new Date(options.start.getTime() + options.durationSeconds * 1000)

        let clockifyLogged = false
        yield* clockify.createTimeEntry(auth.workspaceId, {
          description: `[${ticket.key}] ${ticket.summary}`,
          start: options.start.toISOString(),
          end: end.toISOString(),
          ...(projectId ? { projectId } : {}),
          ...(billable !== null ? { billable } : {}),
          ...(tagIds.length > 0 ? { tagIds } : {})
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              clockifyLogged = true
            })
          ),
          Effect.catchAll((e) => Effect.logDebug(`Clockify correction entry failed: ${e.message}`))
        )

        const jiraWorklogLogged = yield* postJiraWorklog(
          ticket.key,
          options.start,
          options.durationSeconds,
          options.comment
        )

        return { clockifyLogged, jiraWorklogLogged, projectId, billable } satisfies LogManualResult
      })

    const detectRunning = Effect.gen(function*() {
      const auth = yield* getAuth
      const running = yield* clockify.getRunningTimer(auth.workspaceId, auth.userId).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )

      if (running && running.timeInterval.start) {
        const startedAt = new Date(running.timeInterval.start)
        // Parse "[KEY] summary" or "KEY: summary" format
        const desc = running.description ?? ""
        const bracketMatch = desc.match(/^\[([^\]]+)\]\s*(.*)$/)
        const colonMatch = desc.match(/^([^:]+):\s*(.*)$/)
        const ticketKey = bracketMatch?.[1]?.trim() ?? colonMatch?.[1]?.trim() ?? null
        const summary = bracketMatch?.[2]?.trim() ?? colonMatch?.[2]?.trim() ?? null

        if (!ticketKey) {
          yield* Effect.logWarning(
            `Running Clockify timer has unparseable description: "${desc}"`
          )
        }

        // Resolve project name
        let resolvedProjectName: string | null = null
        if (running.projectId) {
          const projects = yield* clockify.getProjects(auth.workspaceId).pipe(
            Effect.catchAll(() => Effect.succeed([] as const))
          )
          resolvedProjectName = projects.find((p) => p.id === running.projectId)?.name ?? null
        }

        const newState: TimerState = {
          active: true,
          ticketKey,
          summary,
          project: ticketKey?.split("-")[0] ?? null,
          startedAt,
          clockifyEntryId: running.id,
          projectId: running.projectId ?? null,
          projectName: resolvedProjectName,
          billable: running.billable ?? null,
          startedViaJcf: false
        }

        yield* writeStateFile(newState)
        yield* SubscriptionRef.set(ref, newState)
      }
    })

    // Discard: delete the Clockify entry, clear state, no Jira worklog
    const discard = Effect.gen(function*() {
      const current = yield* SubscriptionRef.get(ref)
      if (!current.active) {
        return yield* Effect.fail(new TimerError({ message: "No active timer to discard" }))
      }
      const auth = yield* getAuth
      if (current.clockifyEntryId) {
        yield* clockify
          .deleteTimeEntry(auth.workspaceId, current.clockifyEntryId)
          .pipe(
            Effect.mapError(() => new TimerError({ message: "delete failed" })),
            Effect.catchTag("TimerError", () => Effect.void)
          )
      }
      yield* SubscriptionRef.set(ref, emptyState)
      yield* stateWriter.clear
    })

    return { state: ref, start, stop: internalStop, logManual, discard, detectRunning }
  })
)
