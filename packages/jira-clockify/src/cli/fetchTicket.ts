/**
 * Fetch a single Jira issue by key and shape it into a {@link JiraTicket}.
 *
 * Shared by the `start`, `log`, and `stop` (correction) commands so they all
 * resolve the same fields (summary, type, labels) needed for Clockify tags and
 * worklog descriptions. Field extraction delegates to
 * {@link mapIssueToTicket} (the same mapper `TicketService` uses) so the two
 * never drift.
 *
 * Returns a discriminated {@link FetchTicketResult} so callers can tell a
 * genuine "not found" (404) apart from a fetch failure (auth/network) or a
 * missing Jira login, instead of collapsing every error to "not found".
 *
 * The login check matters because an unauthenticated request resolves an empty
 * cloudId into a malformed URL that Atlassian answers with a 404 — which would
 * otherwise masquerade as "ticket not found".
 *
 * @module
 */
import { JiraApiClient } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Effect } from "effect"
import * as Predicate from "effect/Predicate"
import { type JiraTicket, mapIssueToTicket } from "../services/TicketService.js"

/** Shared user hint for the {@link FetchTicketResult} `NotLoggedIn` case. */
export { NOT_LOGGED_IN_HINT } from "../utils/hints.js"

/** Outcome of {@link fetchTicketByKey}. */
export type FetchTicketResult =
  | { readonly _tag: "Found"; readonly ticket: JiraTicket }
  | { readonly _tag: "NotLoggedIn" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "FetchError"; readonly message: string }

/**
 * A best-effort reader of issue titles, bound to the services it needs.
 *
 * Returns a function rather than taking a key, so a caller resolves the Jira services once and then
 * asks about many issues without carrying their requirements through its own signatures — which is
 * what lets a web handler ask for a title without importing a Jira client.
 *
 * Best-effort by construction: {@link fetchTicketByKey} reports "not found" and "not logged in" as
 * values rather than failures, and both become a null title. A title Clockify cannot be told is a
 * worse entry; a title that costs the write is a worse outcome.
 */
export const ticketSummaryReader: Effect.Effect<
  (ticketKey: string) => Effect.Effect<string | null>,
  never,
  JiraApiClient | JiraAuth
> = Effect.gen(function*() {
  const jira = yield* JiraApiClient
  const auth = yield* JiraAuth
  return (ticketKey: string) =>
    fetchTicketByKey(ticketKey).pipe(
      Effect.map((result) => (result._tag === "Found" ? result.ticket.summary : null)),
      Effect.provideService(JiraApiClient, jira),
      Effect.provideService(JiraAuth, auth)
    )
})

export const fetchTicketByKey = (
  key: string
): Effect.Effect<FetchTicketResult, never, JiraApiClient | JiraAuth> =>
  Effect.gen(function*() {
    // Without a Jira login the request would 404 on a malformed URL; surface
    // the real cause so callers can point the user at `jcf auth jira login`.
    // A *clean* absent token resolves to `false` (→ NotLoggedIn); a genuine
    // platform error (unreadable token file, unresolvable HOME) is a fetch
    // failure, not a benign logged-out state, so it routes to FetchError.
    const auth = yield* JiraAuth
    const loginCheck: FetchTicketResult | null = yield* auth.isLoggedIn().pipe(
      Effect.map((loggedIn): FetchTicketResult | null => (loggedIn ? null : { _tag: "NotLoggedIn" })),
      Effect.catch((e) => Effect.succeed<FetchTicketResult>({ _tag: "FetchError", message: e.message }))
    )
    if (loginCheck) return loginCheck

    const jira = yield* JiraApiClient
    return yield* jira.getIssue(key, {
      params: {
        fields: ["summary", "status", "priority", "assignee", "issuetype", "labels", "updated"]
      }
    }).pipe(
      Effect.map((issue): FetchTicketResult => {
        const record = issue !== null && Predicate.isObjectOrArray(issue) && !Array.isArray(issue)
          ? Object.fromEntries(Object.entries(issue))
          : {}
        return {
          _tag: "Found",
          ticket: mapIssueToTicket(record, key)
        }
      }),
      Effect.catchTag("GetIssue404", () => Effect.succeed<FetchTicketResult>({ _tag: "NotFound" })),
      Effect.catch((e) =>
        Effect.succeed<FetchTicketResult>(
          { _tag: "FetchError", message: String(e) }
        )
      )
    )
  })
