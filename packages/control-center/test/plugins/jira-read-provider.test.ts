import { assert, describe, it } from "@effect/vitest"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { makeJiraReadProvider, mapJiraReadProviderFailure } from "../../src/server/plugins/jira/JiraReadProvider.js"

const jiraClientLayer = (
  body: unknown,
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  JiraApiClient.layer.pipe(
    Layer.provide(Layer.succeed(JiraApiConfig, {
      baseUrl: "https://acme.atlassian.net",
      auth: {
        type: "basic",
        email: "owner@example.com",
        apiToken: Redacted.make("test-token")
      }
    })),
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

const rateLimitError = (retryAfter: string): HttpClientError.HttpClientError => {
  const request = HttpClientRequest.get("https://acme.atlassian.net/rest/api/3/issue/PAY-42")
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
  )
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response })
  })
}

const mapRateLimit = Effect.fn("JiraReadProviderTest.mapRateLimit")(function*(retryAfter: string) {
  const outcome = yield* mapJiraReadProviderFailure("jira-get-issue", rateLimitError(retryAfter)).pipe(
    Effect.result
  )
  if (Result.isSuccess(outcome)) return yield* Effect.die("expected the provider failure mapper to fail")
  assert.strictEqual(outcome.failure._tag, "PluginRateLimitFailure")
  if (outcome.failure._tag !== "PluginRateLimitFailure") {
    return yield* Effect.die("expected a rate-limit failure")
  }
  return outcome.failure.retryAt
})

describe("JiraReadProvider", () => {
  it.effect("pins project JQL and formats ISO watermarks as Jira minute timestamps", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)
      const page = yield* provider.searchProjectIssues({
        projectId: "10\" OR project = 20",
        watermark: { updatedAt: "2026-07-17T09:30:00.000Z", issueId: "10042" },
        nextPageToken: "provider-page-2",
        maxResults: 25,
        timeZone: "UTC"
      })

      assert.lengthOf(page.issues, 1)
      const requestParameters = new Map(requests[0]?.urlParams ?? [])
      const jql = requestParameters.get("jql")
      if (jql === undefined) return yield* Effect.die("expected generated JQL")
      assert.strictEqual(
        jql,
        "project = \"10\\\" OR project = 20\" AND updated >= \"2026-07-17 09:30\" ORDER BY updated ASC, id ASC"
      )
      assert.notInclude(jql, "T09:30")
      assert.notInclude(jql, ":00.000Z")
      assert.strictEqual(requestParameters.get("nextPageToken"), "provider-page-2")
      assert.strictEqual(requestParameters.get("maxResults"), "25")

      yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: null,
        nextPageToken: null,
        maxResults: 25,
        timeZone: "UTC"
      })
      assert.strictEqual(
        new Map(requests[1]?.urlParams ?? []).get("jql"),
        "project = \"10\" ORDER BY updated ASC, id ASC"
      )

      yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: { updatedAt: "2026-07-17T09:30:00.000Z", issueId: "10042" },
        nextPageToken: null,
        maxResults: 25,
        timeZone: "America/Los_Angeles"
      })
      assert.strictEqual(
        new Map(requests[2]?.urlParams ?? []).get("jql"),
        "project = \"10\" AND updated >= \"2026-07-17 02:30\" ORDER BY updated ASC, id ASC"
      )
    }).pipe(Effect.provide(jiraClientLayer({
      issues: [{
        id: "10043",
        key: "PAY-43",
        fields: {
          summary: "Bound retries",
          updated: "2026-07-17T09:31:00.000Z",
          project: { id: "10", key: "PAY", name: "Payments" }
        }
      }],
      isLast: true,
      nextPageToken: null
    }, requests)))
  })

  it.effect("maps a malformed successful project-search response to the closed plugin taxonomy", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)
      const outcome = yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: null,
        nextPageToken: null,
        maxResults: 25,
        timeZone: "UTC"
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
      }
    }).pipe(Effect.provide(jiraClientLayer({ issues: [], isLast: false }, []))))

  it.effect("maps a numeric Retry-After delta from the current Effect clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-17T12:00:00.000Z")))
      const retryAt = yield* mapRateLimit("5")
      assert.strictEqual(DateTime.formatIso(retryAt), "2026-07-17T12:00:05.000Z")
    }))

  it.effect("maps an HTTP-date Retry-After value from the current Effect clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-17T12:00:00.000Z")))
      const retryAt = yield* mapRateLimit("Fri, 17 Jul 2026 12:00:05 GMT")
      assert.strictEqual(DateTime.formatIso(retryAt), "2026-07-17T12:00:05.000Z")
    }))
})
