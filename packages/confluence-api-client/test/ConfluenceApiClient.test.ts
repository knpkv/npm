import * as HttpClient from "@effect/platform/HttpClient"
import type * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { ConfluenceApiClient, ConfluenceApiConfig } from "../src/index.js"

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

describe("ConfluenceApiClient", () => {
  describe("layer construction", () => {
    it.effect("creates client with basic auth", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { id: "123", title: "Test Page" } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: {
            type: "basic",
            email: "user@example.com",
            apiToken: Redacted.make("test-token")
          }
        })

        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const page = yield* client.v2.getPageById("123")

        expect(page.id).toBe("123")
        expect(page.title).toBe("Test Page")
        expect(capturedRequests).toHaveLength(1)

        const request = capturedRequests[0]!
        expect(request.url).toContain("/wiki/api/v2/pages/123")
        expect(request.headers.authorization).toMatch(/^Basic /)
      }))

    it.effect("creates client with OAuth2 auth", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { id: "456", title: "OAuth Page" } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: {
            type: "oauth2",
            accessToken: Redacted.make("oauth-token"),
            cloudId: "cloud-123"
          }
        })

        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const page = yield* client.v2.getPageById("456")

        expect(page.id).toBe("456")
        expect(capturedRequests).toHaveLength(1)

        const request = capturedRequests[0]!
        expect(request.url).toContain("api.atlassian.com/ex/confluence/cloud-123")
        expect(request.headers.authorization).toBe("Bearer oauth-token")
      }))
  })

  describe("V2 client", () => {
    it.effect("getPageById includes body-format param", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { id: "123", title: "Test", body: { storage: { value: "<p>test</p>" } } } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const page = yield* client.v2.getPageById("123", { bodyFormat: "storage" })

        expect(page.id).toBe("123")
        expect(capturedRequests[0]!.url).toContain("/pages/123")
      }))

    it.effect("getPageChildren with pagination", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { results: [{ id: "1" }, { id: "2" }], _links: {} } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const result = yield* client.v2.getPageChildren("123", { limit: 25 })

        expect(result.results).toHaveLength(2)
        expect(capturedRequests[0]!.url).toContain("/pages/123/children")
      }))

    it.effect("handles API errors", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([
          { status: 404, body: { message: "Page not found" } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const result = yield* client.v2.getPageById("999").pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.status).toBe(404)
        }
      }))
  })

  describe("V1 client", () => {
    it.effect("getUser by accountId", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { accountId: "abc", displayName: "Test User" } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const user = yield* client.v1.getUser({ accountId: "abc" })

        expect(user.accountId).toBe("abc")
        expect(user.displayName).toBe("Test User")
        expect(capturedRequests[0]!.url).toContain("/wiki/rest/api/user")
      }))

    it.effect("getContentProperty", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { key: "prop1", value: { foo: "bar" }, version: { number: 1 } } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        const prop = yield* client.v1.getContentProperty("123", "prop1")

        expect(prop.key).toBe("prop1")
        expect(capturedRequests[0]!.url).toContain("/content/123/property/prop1")
      }))

    it.effect("createContentProperty", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { key: "editor", value: "v2", version: { number: 1 } } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        yield* client.v1.createContentProperty("123", {
          payload: { key: "editor", value: "v2", version: { number: 1 } }
        })

        expect(capturedRequests[0]!.url).toContain("/content/123/property")
        expect(capturedRequests[0]!.method).toBe("POST")
      }))

    it.effect("updateContentProperty", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { key: "editor", value: "v2", version: { number: 2 } } }
        ])

        const configLayer = Layer.succeed(ConfluenceApiConfig, {
          baseUrl: "https://test.atlassian.net",
          auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
        })
        const httpLayer = Layer.succeed(HttpClient.HttpClient, mockClient)

        const client = yield* ConfluenceApiClient.pipe(
          Effect.provide(ConfluenceApiClient.layer),
          Effect.provide(configLayer),
          Effect.provide(httpLayer)
        )

        yield* client.v1.updateContentProperty("123", "editor", {
          payload: { key: "editor", value: "v2", version: { number: 2 } }
        })

        expect(capturedRequests[0]!.url).toContain("/content/123/property/editor")
        expect(capturedRequests[0]!.method).toBe("PUT")
      }))
  })
})
