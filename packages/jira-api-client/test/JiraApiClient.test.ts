import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { JiraApiClient, JiraApiConfig, type JiraApiConfigShape } from "../src/index.js"

const clientLayer = (
  config: JiraApiConfigShape,
  response: { readonly status: number; readonly body?: unknown },
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  JiraApiClient.layer.pipe(
    Layer.provide(Layer.succeed(JiraApiConfig, config)),
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(response.body === undefined ? null : JSON.stringify(response.body), {
              status: response.status,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

const basicConfig: JiraApiConfigShape = {
  baseUrl: "https://jira.test",
  auth: {
    type: "basic",
    email: "user@example.com",
    apiToken: Redacted.make("test-token")
  }
}

describe("JiraApiClient", () => {
  it.effect("applies basic auth and decodes dynamic issue fields", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const issue = yield* client.getIssue("PROJ-1", undefined)
      expect(issue.key).toBe("PROJ-1")
      expect(issue.fields?.customfield_10001).toBe("dynamic")
      expect(requests[0]?.url).toBe("https://jira.test/rest/api/3/issue/PROJ-1")
      expect(requests[0]?.headers.authorization).toMatch(/^Basic /)
    }).pipe(Effect.provide(clientLayer(basicConfig, {
      status: 200,
      body: { id: "10001", key: "PROJ-1", fields: { customfield_10001: "dynamic" } }
    }, requests)))
  })

  it.effect("routes OAuth2 through the Atlassian cloud gateway", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      yield* client.getIssue("PROJ-1", undefined)
      expect(requests[0]?.url).toBe("https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/PROJ-1")
      expect(requests[0]?.headers.authorization).toBe("Bearer oauth-token")
    }).pipe(Effect.provide(clientLayer(
      {
        baseUrl: "",
        auth: { type: "oauth2", accessToken: Redacted.make("oauth-token"), cloudId: "cloud-123" }
      },
      { status: 200, body: { id: "10001", key: "PROJ-1", fields: {} } },
      requests
    )))
  })

  it.effect("keeps bodyless-spec 404 responses in the typed error channel", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* Effect.result(client.getIssue("NOPE-999", undefined))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("GetIssue404")
    }).pipe(Effect.provide(clientLayer(basicConfig, {
      status: 404,
      body: { errorMessages: ["Issue does not exist"] }
    }, []))))

  it.effect("never treats a genuinely empty 404 as success", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* Effect.result(client.getIssue("NOPE-EMPTY", undefined))
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(clientLayer(basicConfig, { status: 404 }, []))))

  it.effect("decodes a terminal JQL page whose nextPageToken is null", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* client.searchIssuesUsingJql({ params: { jql: "project = PROJ" } })
      expect(result.nextPageToken).toBeNull()
      expect(result.isLast).toBe(true)
    }).pipe(Effect.provide(clientLayer(basicConfig, {
      status: 200,
      body: { issues: [], isLast: true, nextPageToken: null }
    }, []))))

  it.effect("preserves Jira Premium contributors on decoded versions", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const version = yield* client.getVersion("10000", undefined)
      expect(version.contributors).toEqual([
        "account-1",
        { accountId: "account-2", displayName: "Ada" }
      ])
    }).pipe(Effect.provide(clientLayer(basicConfig, {
      status: 200,
      body: {
        id: "10000",
        name: "1.0.0",
        contributors: ["account-1", { accountId: "account-2", displayName: "Ada" }]
      }
    }, []))))

  it.effect("rejects malformed successful responses", () =>
    Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* Effect.result(client.getFields(undefined))
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(clientLayer(basicConfig, { status: 200, body: {} }, []))))

  it.effect("uploads multipart data with the Atlassian CSRF bypass header", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const attachments = yield* client.uploadAttachment("PROJ-1", {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "example.bin",
        mediaType: "application/octet-stream"
      })
      expect(attachments[0]?.filename).toBe("example.bin")
      expect(requests[0]?.headers["x-atlassian-token"]).toBe("no-check")
      expect(requests[0]?.body._tag).toBe("FormData")
    }).pipe(Effect.provide(clientLayer(basicConfig, {
      status: 200,
      body: [{ id: "1", filename: "example.bin", size: 3 }]
    }, requests)))
  })
})
