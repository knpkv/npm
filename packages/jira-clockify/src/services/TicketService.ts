/**
 * Jira ticket fetching with reactive state via SubscriptionRef.
 *
 * **Mental model**
 *
 * - **SubscriptionRef-backed state**: {@link TicketServiceShape.state} is a `SubscriptionRef<TicketState>`
 *   that the TUI subscribes to for live updates. {@link TicketServiceShape.refresh} fetches
 *   tickets from Jira and updates the ref.
 * - **Field extraction helpers**: `extractNested` and `extractString` safely navigate the
 *   loosely-typed Jira API response without runtime crashes.
 * - **In-memory search**: {@link TicketServiceShape.search} filters the cached ticket list
 *   by key or summary substring.
 *
 * @module
 */
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { ConfigService } from "./ConfigService.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface JiraTicket {
  readonly key: string
  readonly summary: string
  readonly status: string
  readonly priority: string | null
  readonly assignee: string | null
  readonly type: string
  readonly labels: ReadonlyArray<string>
  readonly updated: string
}

export interface TicketState {
  readonly tickets: ReadonlyArray<JiraTicket>
  readonly loading: boolean
  readonly error: string | null
  readonly lastRefreshed: Date | null
}

export class TicketError extends Data.TaggedError("TicketError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const emptyState: TicketState = {
  tickets: [],
  loading: false,
  error: null,
  lastRefreshed: null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractField = (fields: Record<string, unknown> | null | undefined, key: string): unknown => fields?.[key] ?? null

const extractString = (fields: Record<string, unknown> | null | undefined, key: string): string | null => {
  const val = extractField(fields, key)
  return typeof val === "string" ? val : null
}

const extractNested = (
  fields: Record<string, unknown> | null | undefined,
  key: string,
  nested: string
): string | null => {
  const val = extractField(fields, key)
  if (val && typeof val === "object" && nested in val) {
    const v = (val as Record<string, unknown>)[nested]
    return typeof v === "string" ? v : null
  }
  return null
}

/**
 * Shape a raw Jira issue (from `/rest/api/3/issue` or `/search/jql`) into a
 * {@link JiraTicket}. Single source of truth for the nested-field extraction —
 * reused by {@link fetchTicketByKey} so the two never drift.
 */
export const mapIssueToTicket = (issue: Record<string, unknown>, fallbackKey?: string): JiraTicket => {
  const fields = issue["fields"] as Record<string, unknown> | null | undefined
  const key = typeof issue["key"] === "string" ? issue["key"] : (fallbackKey ?? "?")
  return {
    key,
    summary: extractString(fields, "summary") ?? (fallbackKey ?? "(no summary)"),
    status: extractNested(fields, "status", "name") ?? "Unknown",
    priority: extractNested(fields, "priority", "name"),
    assignee: extractNested(fields, "assignee", "displayName"),
    type: extractNested(fields, "issuetype", "name") ?? "Task",
    labels: Array.isArray(fields?.["labels"]) ? (fields["labels"] as Array<string>) : [],
    updated: extractString(fields, "updated") ?? new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface TicketServiceShape {
  readonly state: SubscriptionRef.SubscriptionRef<TicketState>
  readonly refresh: Effect.Effect<void, TicketError>
  readonly search: (text: string) => Effect.Effect<ReadonlyArray<JiraTicket>>
}

export class TicketService extends Context.Tag("jcf/TicketService")<TicketService, TicketServiceShape>() {}

export const layer = Layer.effect(
  TicketService,
  Effect.gen(function*() {
    const config = yield* ConfigService
    const jira = yield* JiraApiClient
    const ref = yield* SubscriptionRef.make<TicketState>(emptyState)

    const refresh = Effect.gen(function*() {
      yield* SubscriptionRef.set(ref, { ...emptyState, loading: true })

      const cfg = yield* config.get
      const jql = cfg.defaultJql

      const result = yield* toEffect(jira.v3.client.GET("/rest/api/3/search/jql", {
        params: {
          query: {
            jql,
            maxResults: 50,
            fields: ["summary", "status", "priority", "assignee", "issuetype", "labels", "updated"]
          }
        }
      })).pipe(
        Effect.mapError((e) => new TicketError({ message: `Jira search failed: ${String(e)}`, cause: e }))
      )

      const tickets: Array<JiraTicket> = (result.issues ?? []).map((issue) =>
        mapIssueToTicket(issue as Record<string, unknown>)
      )

      yield* SubscriptionRef.set(ref, {
        tickets,
        loading: false,
        error: null,
        lastRefreshed: new Date()
      })
    }).pipe(
      Effect.catchAll((e: TicketError) => {
        const msg = e._tag === "TicketError"
          ? e.message
          : `Failed to fetch tickets: ${String(e)}`
        return Effect.logDebug(`TicketService refresh error: ${msg}`).pipe(
          Effect.flatMap(() =>
            SubscriptionRef.set(ref, {
              tickets: [],
              loading: false,
              error: msg,
              lastRefreshed: null
            })
          )
        )
      })
    )

    const search = (text: string) =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.get(ref)
        if (!text.trim()) return state.tickets
        const lower = text.toLowerCase()
        return state.tickets.filter(
          (t) =>
            t.key.toLowerCase().includes(lower) ||
            t.summary.toLowerCase().includes(lower)
        )
      })

    return { state: ref, refresh, search }
  })
)
