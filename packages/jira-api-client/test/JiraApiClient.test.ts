import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { JiraApiClient, JiraApiConfig, type JiraApiConfigContract } from "../src/index.js"

// A test case is its own entry point: it composes exactly the client and response that case needs
// and provides them there. The diagnostic is about production wiring, where a Layer provided
// mid-graph can cut a scope short.
// @effect-diagnostics strictEffectProvide:off

const clientLayer = (
  config: JiraApiConfigContract,
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

const basicConfig: JiraApiConfigContract = {
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

  // A client is built once and can outlive its credential: `jcf watch` runs all day on an access
  // token good for about an hour. Before this, the token was read at layer construction and baked
  // into a header, so every request after the first expiry 401ed for the life of the process.
  it.effect("re-reads a refreshing credential on every request", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    let issued = 0
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      yield* client.getIssue("PROJ-1", undefined)
      yield* client.getIssue("PROJ-1", undefined)
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer token-1",
        "Bearer token-2"
      ])
    }).pipe(Effect.provide(clientLayer(
      {
        baseUrl: "",
        auth: { type: "oauth2", accessToken: Redacted.make("stale"), cloudId: "cloud-123" },
        resolveAuth: Effect.sync(() => {
          issued += 1
          return { type: "oauth2", accessToken: Redacted.make(`token-${issued}`), cloudId: "cloud-123" }
        })
      },
      { status: 200, body: { id: "10001", key: "PROJ-1", fields: {} } },
      requests
    )))
  })

  // The host comes from the same value as the header, so a resolver cannot address one site while
  // authenticating against another.
  it.effect("routes a refreshed credential at its own cloud id", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      yield* client.getIssue("PROJ-1", undefined)
      expect(requests[0]?.url).toBe("https://api.atlassian.com/ex/jira/cloud-999/rest/api/3/issue/PROJ-1")
    }).pipe(Effect.provide(clientLayer(
      {
        baseUrl: "",
        auth: { type: "oauth2", accessToken: Redacted.make("stale"), cloudId: "cloud-123" },
        resolveAuth: Effect.succeed({
          type: "oauth2",
          accessToken: Redacted.make("fresh"),
          cloudId: "cloud-999"
        })
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

  it.effect("returns void for Jira 204 responses that advertise an empty JSON schema", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* client.setBanner({
        payload: { isEnabled: true, message: "Maintenance" }
      })

      expect(result).toBeUndefined()
      expect(requests).toHaveLength(1)
    }).pipe(Effect.provide(clientLayer(basicConfig, { status: 204 }, requests)))
  })

  it.effect("keeps naturally bodyless delete operations void", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* JiraApiClient
      const result = yield* client.deleteIssue("PROJ-1", undefined)

      expect(result).toBeUndefined()
      expect(requests).toHaveLength(1)
    }).pipe(Effect.provide(clientLayer(basicConfig, { status: 204 }, requests)))
  })

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
