import * as HttpClient from "@effect/platform/HttpClient"
import type * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { JiraApiClient, JiraApiConfig } from "../src/index.js"

/**
 * Mock HTTP client that captures requests.
 */
const createMockHttpClient = (
  responses: Array<{ status: number; body: unknown }>
) => {
  let requestIndex = 0
  const capturedRequests: Array<HttpClientRequest.HttpClientRequest> = []

  const mockClient: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.gen(function*() {
      capturedRequests.push(request)
      const response = responses[requestIndex] ?? { status: 200, body: {} }
      requestIndex++
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(response.body),
          { status: response.status, headers: { "content-type": "application/json" } }
        )
      )
    })
  )

  return { mockClient, capturedRequests }
}

describe("JiraApiClient", () => {
  describe("layer construction", () => {
    it.effect("creates client with basic auth", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { id: "10001", key: "PROJ-1", fields: { summary: "Test" } } }
        ])

        const configLayer = Layer.succeed(JiraApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: {
            type: "basic",
            email: "user@example.com",
            apiToken: Redacted.make("test-token")
          }
        })

        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* JiraApiClient.pipe(
          Effect.provide(JiraApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        // Just verify we can get the client - the actual API will vary
        expect(client.v3).toBeDefined()
        expect(capturedRequests).toHaveLength(0) // No requests made yet
      }))

    it.effect("creates client with OAuth2 auth", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([])

        const configLayer = Layer.succeed(JiraApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: {
            type: "oauth2",
            accessToken: Redacted.make("oauth-token"),
            cloudId: "cloud-123"
          }
        })

        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* JiraApiClient.pipe(
          Effect.provide(JiraApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        expect(client.v3).toBeDefined()
        expect(capturedRequests).toHaveLength(0)
      }))
  })
})
