import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { fetchTicketByKey } from "../src/cli/fetchTicket.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a JiraApiClient mock whose `v3.client.GET` resolves the openapi-fetch
 * `{ data, error, response }` shape that `toEffect` consumes.
 */
const makeJiraLayer = (
  resolve: () => { data?: unknown; error?: unknown; response: { ok: boolean; status: number } }
) =>
  Layer.succeed(JiraApiClient, {
    v3: {
      client: {
        GET: () => Promise.resolve(resolve())
      }
    }
  } as never)

const issueFixture = {
  key: "PROJ-7",
  fields: {
    summary: "Wire up the thing",
    status: { name: "In Progress" },
    priority: { name: "High" },
    assignee: { displayName: "Dev" },
    issuetype: { name: "Story" },
    labels: ["backend", "api"],
    updated: "2025-06-01T10:00:00.000Z"
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchTicketByKey", () => {
  // Happy path: the issue is shaped through the shared mapper into a JiraTicket
  it.effect("returns Found with a fully-mapped ticket", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-7")
      expect(result._tag).toBe("Found")
      if (result._tag !== "Found") return
      expect(result.ticket.key).toBe("PROJ-7")
      expect(result.ticket.summary).toBe("Wire up the thing")
      expect(result.ticket.status).toBe("In Progress")
      expect(result.ticket.priority).toBe("High")
      expect(result.ticket.assignee).toBe("Dev")
      expect(result.ticket.type).toBe("Story")
      expect(result.ticket.labels).toEqual(["backend", "api"])
    }).pipe(Effect.provide(makeJiraLayer(() => ({ data: issueFixture, response: { ok: true, status: 200 } })))))

  // A 404 must map to NotFound (genuine "no such issue")
  it.effect("returns NotFound on a 404", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-404")
      expect(result._tag).toBe("NotFound")
    }).pipe(Effect.provide(
      makeJiraLayer(() => ({ error: { errorMessages: ["not found"] }, response: { ok: false, status: 404 } }))
    )))

  // A non-404 failure (auth/network) must map to FetchError, NOT NotFound —
  // so a 401 is never reported to the user as "Ticket not found".
  it.effect("returns FetchError on a 401 (distinct from NotFound)", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-1")
      expect(result._tag).toBe("FetchError")
    }).pipe(Effect.provide(
      makeJiraLayer(() => ({ error: { errorMessages: ["unauthorized"] }, response: { ok: false, status: 401 } }))
    )))
})
