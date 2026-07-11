import { describe, expect, it } from "@effect/vitest"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ConfluenceApiClient, ConfluenceApiConfig } from "../src/index.js"

const clientLayer = (
  config: Context.Service.Shape<typeof ConfluenceApiConfig>,
  response: { readonly status: number; readonly body: unknown },
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  ConfluenceApiClient.layer.pipe(
    Layer.provide(Layer.succeed(ConfluenceApiConfig, config)),
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(response.body), {
              status: response.status,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

const basicConfig = {
  baseUrl: "https://example.atlassian.net",
  auth: {
    type: "basic",
    email: "user@example.com",
    apiToken: Redacted.make("token")
  }
} satisfies Context.Service.Shape<typeof ConfluenceApiConfig>

describe("ConfluenceApiClient", () => {
  it.effect("authenticates and decodes V2 requests with basic auth", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceApiClient
      const page = yield* client.v2.getPageById("123", undefined)

      expect(page).toMatchObject({ id: "123", title: "Test Page", position: null })
      expect(requests[0]?.url).toBe("https://example.atlassian.net/wiki/api/v2/pages/123")
      expect(requests[0]?.headers.authorization).toMatch(/^Basic /)
    }).pipe(
      Effect.provide(clientLayer(
        basicConfig,
        { status: 200, body: { id: "123", title: "Test Page", position: null } },
        requests
      ))
    )
  })

  it.effect("routes V1 OAuth requests through Atlassian's cloud gateway", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceApiClient
      const user = yield* client.v1.getUser({ params: { accountId: "account-1" } })

      expect(user.accountId).toBe("account-1")
      expect(requests[0]?.url).toBe(
        "https://api.atlassian.com/ex/confluence/cloud-1/wiki/rest/api/user"
      )
      expect(requests[0]?.urlParams).toContainEqual(["accountId", "account-1"])
      expect(requests[0]?.headers.authorization).toBe("Bearer oauth-token")
    }).pipe(
      Effect.provide(clientLayer(
        {
          baseUrl: "https://ignored.atlassian.net",
          auth: {
            type: "oauth2",
            accessToken: Redacted.make("oauth-token"),
            cloudId: "cloud-1"
          }
        },
        { status: 200, body: { type: "known", accountId: "account-1", displayName: "Ada" } },
        requests
      ))
    )
  })

  it.effect("fails when a successful response violates the generated schema", () =>
    Effect.gen(function*() {
      const client = yield* ConfluenceApiClient
      const result = yield* Effect.result(client.v2.getPageById("123", undefined))
      expect(result._tag).toBe("Failure")
    }).pipe(
      Effect.provide(clientLayer(basicConfig, { status: 200, body: { id: "123", position: "invalid" } }, []))
    ))

  it.effect("preserves status information for non-success responses", () =>
    Effect.gen(function*() {
      const client = yield* ConfluenceApiClient
      const result = yield* Effect.result(client.v2.getPageById("404", undefined))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(HttpClientError.isHttpClientError(result.failure)).toBe(true)
        if (HttpClientError.isHttpClientError(result.failure)) {
          expect(result.failure.response?.status).toBe(404)
        }
      }
    }).pipe(
      Effect.provide(clientLayer(basicConfig, { status: 404, body: { message: "Not found" } }, []))
    ))

  it.effect("sends multipart uploads with Atlassian's required header", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceApiClient
      const response = yield* client.uploadAttachment("123", {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "diagram.png",
        mediaType: "image/png"
      })

      expect(response.size).toBe(1)
      expect(requests[0]?.url).toBe(
        "https://example.atlassian.net/wiki/rest/api/content/123/child/attachment"
      )
      expect(requests[0]?.urlParams).toContainEqual(["status", "current"])
      expect(requests[0]?.headers["x-atlassian-token"]).toBe("nocheck")
      expect(requests[0]?.body._tag).toBe("FormData")
    }).pipe(
      Effect.provide(clientLayer(
        basicConfig,
        { status: 200, body: { results: [{}], size: 1, _links: {} } },
        requests
      ))
    )
  })
})
