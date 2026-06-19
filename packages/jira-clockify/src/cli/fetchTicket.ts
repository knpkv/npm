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
 * genuine "not found" (404) apart from a fetch failure (auth/network), instead
 * of collapsing every error to "not found".
 *
 * @module
 */
import type { FetchClientError } from "@knpkv/jira-api-client"
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import { Effect } from "effect"
import { type JiraTicket, mapIssueToTicket } from "../services/TicketService.js"

/** Outcome of {@link fetchTicketByKey}. */
export type FetchTicketResult =
  | { readonly _tag: "Found"; readonly ticket: JiraTicket }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "FetchError"; readonly message: string }

export const fetchTicketByKey = (
  key: string
): Effect.Effect<FetchTicketResult, never, JiraApiClient> =>
  Effect.gen(function*() {
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
      Effect.catchAll((e: FetchClientError) =>
        Effect.succeed<FetchTicketResult>(
          e.status === 404
            ? { _tag: "NotFound" }
            : { _tag: "FetchError", message: e.message }
        )
      )
    )
  })
