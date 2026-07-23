import { assert, describe, it } from "@effect/vitest"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { makeJiraReadProvider, mapJiraReadProviderFailure } from "../../src/server/plugins/jira/JiraReadProvider.js"

const jiraClientLayerFromResponse = (
  responseBody: (request: HttpClientRequest.HttpClientRequest) => unknown,
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
            new Response(JSON.stringify(responseBody(request)), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

const jiraClientLayer = (
  body: unknown,
  requests: Array<HttpClientRequest.HttpClientRequest>
) => jiraClientLayerFromResponse(() => body, requests)

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
  it.effect("loads one exact Jira comment for reply validation", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)

      const comment = yield* provider.getComment("10042", "c17")

      assert.isTrue(Option.isSome(comment))
      assert.include(requests[0]?.url ?? "", "/rest/api/3/issue/10042/comment/c17")
      assert.strictEqual(new Map(requests[0]?.urlParams ?? []).get("expand"), "properties")
    }).pipe(Effect.provide(jiraClientLayer({
      id: "c17",
      body: { type: "doc", version: 1, content: [] }
    }, requests)))
  })

  it.effect("loads only the requested Jira project versions by direct ID", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)

      const versions = yield* Effect.forEach(
        ["2026.31", "2026.30"],
        provider.getProjectVersion
      )

      assert.deepStrictEqual(versions, [
        Option.some({ id: "2026.31", name: "August 2026", projectId: "10" }),
        Option.some({ id: "2026.30", name: "July 2026", projectId: "10" })
      ])
      assert.deepStrictEqual(
        requests.map(({ url }) => new URL(url).pathname),
        ["/rest/api/3/version/2026.31", "/rest/api/3/version/2026.30"]
      )
      assert.isFalse(requests.some(({ url }) => url.includes("/project/10/versions")))
    }).pipe(Effect.provide(jiraClientLayerFromResponse(
      (request) =>
        request.url.endsWith("/2026.31")
          ? { id: "2026.31", name: "August 2026", projectId: 10 }
          : { id: "2026.30", name: "July 2026", projectId: 10 },
      requests
    )))
  })

  it.effect("rejects a Jira version response with an unsafe numeric project ID", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)

      const outcome = yield* provider.getProjectVersion("v").pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-openapi-response-invalid")
        }
      }
    }).pipe(Effect.provide(jiraClientLayer({
      id: "v",
      name: "V",
      projectId: Number.MAX_SAFE_INTEGER + 1
    }, requests)))
  })

  it.effect("decodes Jira issue-link types used by governed proposals", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)

      const linkTypes = yield* provider.getIssueLinkTypes

      assert.deepStrictEqual(linkTypes, [{
        id: "10000",
        name: "Relates",
        inward: "relates to",
        outward: "relates to"
      }])
      assert.include(requests[0]?.url ?? "", "/rest/api/3/issueLinkType")
    }).pipe(
      Effect.provide(jiraClientLayer({
        issueLinkTypes: [{
          id: "10000",
          name: "Relates",
          inward: "relates to",
          outward: "relates to"
        }]
      }, requests))
    )
  })

  it.effect("pins project JQL and formats ISO watermarks as Jira minute timestamps", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)
      const page = yield* provider.searchProjectIssues({
        projectId: "10\" OR project = 20",
        watermark: { updatedAt: "2026-07-17T09:30:00.000Z", issueKey: "PAY-42" },
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
        "project = \"10\\\" OR project = 20\" AND updated >= \"2026-07-17 09:30\" ORDER BY updated ASC, key ASC"
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
        "project = \"10\" ORDER BY updated ASC, key ASC"
      )

      yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: { updatedAt: "2026-07-17T09:30:00.000Z", issueKey: "PAY-42" },
        nextPageToken: null,
        maxResults: 25,
        timeZone: "America/Los_Angeles"
      })
      assert.strictEqual(
        new Map(requests[2]?.urlParams ?? []).get("jql"),
        "project = \"10\" AND updated >= \"2026-07-17 02:30\" ORDER BY updated ASC, key ASC"
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
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-project-search-cursor-invalid")
        }
      }
    }).pipe(Effect.provide(jiraClientLayer({ issues: [], isLast: false }, []))))

  it.effect("accepts a terminal project-search response that omits optional isLast", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)
      const page = yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: null,
        nextPageToken: null,
        maxResults: 25,
        timeZone: "UTC"
      })

      assert.deepStrictEqual(page, { issues: [], nextPageToken: null })
    }).pipe(Effect.provide(jiraClientLayer({ issues: [], nextPageToken: null }, requests)))
  })

  it.effect("accepts opaque enhanced-search cursors beyond Jira identifier bounds", () => {
    const nextPageToken = "t".repeat(700)
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const provider = makeJiraReadProvider(client)
      const page = yield* provider.searchProjectIssues({
        projectId: "10",
        watermark: null,
        nextPageToken: null,
        maxResults: 25,
        timeZone: "UTC"
      })

      assert.strictEqual(page.nextPageToken, nextPageToken)
    }).pipe(Effect.provide(jiraClientLayer({ issues: [], isLast: false, nextPageToken }, [])))
  })

  it.effect("keeps Jira issue identifiers within their 512-character bound", () =>
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
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "jira-project-search-response-invalid")
        }
      }
    }).pipe(Effect.provide(jiraClientLayer({
      issues: [{ id: "10043", key: "K".repeat(513), fields: {} }],
      isLast: true,
      nextPageToken: null
    }, []))))

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
