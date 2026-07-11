import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient, make } from "@knpkv/jira-api-client"
import { JiraAuth, type JiraAuthService } from "@knpkv/jira-cli/JiraAuth"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { fetchTicketByKey } from "../src/cli/fetchTicket.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a JiraApiClient backed by a deterministic in-memory HTTP transport.
 */
const makeJiraLayer = (
  resolve: () => { data?: unknown; error?: unknown; response: { ok: boolean; status: number } }
) => {
  const httpClient = HttpClient.make((request) => {
    const result = resolve()
    return Effect.succeed(HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(result.data ?? result.error ?? {}), {
        status: result.response.status,
        headers: { "content-type": "application/json" }
      })
    ))
  })
  const api = make(httpClient, {
    baseUrl: "https://jira.test",
    auth: { type: "basic", email: "test@example.com", apiToken: Redacted.make("token") }
  })
  return Layer.succeed(
    JiraApiClient,
    JiraApiClient.of({
      ...api,
      uploadAttachment: () => Effect.die("unused Jira upload mock")
    })
  )
}

const makeAuthService = (isLoggedIn: JiraAuthService["isLoggedIn"]): JiraAuthService => ({
  configure: () => Effect.die("unused JiraAuth mock method"),
  isConfigured: () => Effect.die("unused JiraAuth mock method"),
  login: () => Effect.die("unused JiraAuth mock method"),
  logout: () => Effect.die("unused JiraAuth mock method"),
  getAccessToken: () => Effect.die("unused JiraAuth mock method"),
  getCloudId: () => Effect.die("unused JiraAuth mock method"),
  getSiteUrl: () => Effect.die("unused JiraAuth mock method"),
  getCurrentUser: () => Effect.die("unused JiraAuth mock method"),
  getActiveProfile: () => Effect.die("unused JiraAuth mock method"),
  listProfiles: () => Effect.die("unused JiraAuth mock method"),
  switchProfile: () => Effect.die("unused JiraAuth mock method"),
  removeProfile: () => Effect.die("unused JiraAuth mock method"),
  isLoggedIn
})

// JiraAuth mock — only `isLoggedIn` matters for fetchTicketByKey.
const makeAuthLayer = (loggedIn: boolean) => Layer.succeed(JiraAuth, makeAuthService(() => Effect.succeed(loggedIn)))

// JiraAuth whose isLoggedIn fails with a platform error (e.g. unreadable token file).
const makeAuthFailLayer = (message: string) => Layer.succeed(JiraAuth, makeAuthService(() => Effect.fail({ message })))

const LoggedIn = makeAuthLayer(true)

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
    }).pipe(
      Effect.provide(makeJiraLayer(() => ({ data: issueFixture, response: { ok: true, status: 200 } }))),
      Effect.provide(LoggedIn)
    ))

  // A 404 must map to NotFound (genuine "no such issue")
  it.effect("returns NotFound on a 404", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-404")
      expect(result._tag).toBe("NotFound")
    }).pipe(
      Effect.provide(
        makeJiraLayer(() => ({ error: { errorMessages: ["not found"] }, response: { ok: false, status: 404 } }))
      ),
      Effect.provide(LoggedIn)
    ))

  // A non-404 failure (auth/network) must map to FetchError, NOT NotFound —
  // so a 401 is never reported to the user as "Ticket not found".
  it.effect("returns FetchError on a 401 (distinct from NotFound)", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-1")
      expect(result._tag).toBe("FetchError")
    }).pipe(
      Effect.provide(
        makeJiraLayer(() => ({ error: { errorMessages: ["unauthorized"] }, response: { ok: false, status: 401 } }))
      ),
      Effect.provide(LoggedIn)
    ))

  // Not logged in must short-circuit to NotLoggedIn — an unauthenticated request
  // 404s on a malformed URL and would otherwise masquerade as "ticket not found".
  it.effect("returns NotLoggedIn when not authenticated", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-7")
      expect(result._tag).toBe("NotLoggedIn")
    }).pipe(
      // The Jira client would succeed, but the login check must short-circuit first.
      Effect.provide(makeJiraLayer(() => ({ data: issueFixture, response: { ok: true, status: 200 } }))),
      Effect.provide(makeAuthLayer(false))
    ))

  // A genuine platform error reading the token must NOT masquerade as NotLoggedIn —
  // it is a real failure and should route to FetchError (only a clean absent token is NotLoggedIn).
  it.effect("returns FetchError when the login check fails with a platform error", () =>
    Effect.gen(function*() {
      const result = yield* fetchTicketByKey("PROJ-7")
      expect(result._tag).toBe("FetchError")
      if (result._tag !== "FetchError") return
      expect(result.message).toBe("token file unreadable")
    }).pipe(
      Effect.provide(makeJiraLayer(() => ({ data: issueFixture, response: { ok: true, status: 200 } }))),
      Effect.provide(makeAuthFailLayer("token file unreadable"))
    ))
})
