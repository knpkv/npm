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
import type { FetchClientError } from "@knpkv/jira-api-client"
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Effect } from "effect"
import { type JiraTicket, mapIssueToTicket } from "../services/TicketService.js"

/** Shared user hint for the {@link FetchTicketResult} `NotLoggedIn` case. */
export const NOT_LOGGED_IN_HINT = "Not logged in to Jira. Run: jcf auth jira login"

/** Outcome of {@link fetchTicketByKey}. */
export type FetchTicketResult =
  | { readonly _tag: "Found"; readonly ticket: JiraTicket }
  | { readonly _tag: "NotLoggedIn" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "FetchError"; readonly message: string }

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
      Effect.map((loggedIn) => (loggedIn ? null : { _tag: "NotLoggedIn" as const })),
      Effect.catch((e) => Effect.succeed<FetchTicketResult>({ _tag: "FetchError", message: e.message }))
    )
    if (loginCheck) return loginCheck

    const jira = yield* JiraApiClient
    return yield* toEffect(jira.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
      params: {
        path: { issueIdOrKey: key },
        query: { fields: ["summary", "status", "priority", "assignee", "issuetype", "labels", "updated"] }
      }
    })).pipe(
      Effect.map((issue): FetchTicketResult => ({
        _tag: "Found",
        ticket: mapIssueToTicket(issue as Record<string, unknown>, key)
      })),
      Effect.catch((e: FetchClientError) =>
        Effect.succeed<FetchTicketResult>(
          e.status === 404
            ? { _tag: "NotFound" }
            : { _tag: "FetchError", message: e.message }
        )
      )
    )
  })
