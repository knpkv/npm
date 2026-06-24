import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { ConfluenceApiClient, ConfluenceApiConfig, FetchClientError, toEffect } from "../src/index.js"

/**
 * Mock global fetch to capture requests and return canned responses.
 */
const withMockFetch = <A, E>(
  responses: Array<{ status: number; body: unknown }>,
  fn: (capturedRequests: Array<{ url: string; init: RequestInit }>) => Effect.Effect<A, E>
): Effect.Effect<A, E> => {
  const capturedRequests: Array<{ url: string; init: RequestInit }> = []
  let requestIndex = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString()
    const headers = input instanceof Request
      ? Object.fromEntries(input.headers.entries())
      : (init?.headers as Record<string, string> | undefined) ?? {}
    capturedRequests.push({ url, init: { ...init, headers } })
    const response = responses[requestIndex] ?? { status: 200, body: {} }
    requestIndex++
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" }
    })
  }) as typeof globalThis.fetch

  return Effect.ensuring(
    fn(capturedRequests),
    Effect.sync(() => {
      globalThis.fetch = originalFetch
    })
  )
}

describe("ConfluenceApiClient", () => {
  describe("layer construction", () => {
    // Verifies basic auth applies Base64-encoded email:token as Authorization header and routes to baseUrl
    it.effect("creates client with basic auth", () =>
      withMockFetch(
        [{ status: 200, body: { id: "123", title: "Test Page" } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(ConfluenceApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: {
                type: "basic",
                email: "user@example.com",
                apiToken: Redacted.make("test-token")
              }
            })

            const client = yield* ConfluenceApiClient.pipe(
              Effect.provide(ConfluenceApiClient.layer),
              Effect.provide(configLayer)
            )

            const page = yield* toEffect(client.v2.client.GET("/pages/{id}", { params: { path: { id: 123 } } }))

            expect(page.id).toBe("123")
            expect(page.title).toBe("Test Page")
            expect(capturedRequests).toHaveLength(1)

            const request = capturedRequests[0]!
            expect(request.url).toContain("/pages/123")
            const authHeader = (request.init.headers as Record<string, string>)["Authorization"] ??
              (request.init.headers as Record<string, string>)["authorization"]
            expect(authHeader).toMatch(/^Basic /)
          })
      ))

    // Verifies OAuth2 applies Bearer token and routes through Atlassian cloud proxy (api.atlassian.com/ex/confluence/cloudId)
    it.effect("creates client with OAuth2 auth", () =>
      withMockFetch(
        [{ status: 200, body: { id: "456", title: "OAuth Page" } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(ConfluenceApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: {
                type: "oauth2",
                accessToken: Redacted.make("oauth-token"),
                cloudId: "cloud-123"
              }
            })

            const client = yield* ConfluenceApiClient.pipe(
              Effect.provide(ConfluenceApiClient.layer),
              Effect.provide(configLayer)
            )

            const page = yield* toEffect(client.v2.client.GET("/pages/{id}", { params: { path: { id: 456 } } }))

            expect(page.id).toBe("456")
            expect(capturedRequests).toHaveLength(1)

            const request = capturedRequests[0]!
            expect(request.url).toContain("api.atlassian.com/ex/confluence/cloud-123")
            const authHeader = (request.init.headers as Record<string, string>)["Authorization"] ??
              (request.init.headers as Record<string, string>)["authorization"]
            expect(authHeader).toBe("Bearer oauth-token")
          })
      ))
  })

  describe("V2 client", () => {
    // Smoke test: V2 client constructs correct URL path for page retrieval
    it.effect("getPageById makes correct request", () =>
      withMockFetch(
        [{ status: 200, body: { id: "123", title: "Test" } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(ConfluenceApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
            })

            const client = yield* ConfluenceApiClient.pipe(
              Effect.provide(ConfluenceApiClient.layer),
              Effect.provide(configLayer)
            )

            const page = yield* toEffect(client.v2.client.GET("/pages/{id}", { params: { path: { id: 123 } } }))

            expect(page.id).toBe("123")
            expect(capturedRequests[0]!.url).toContain("/pages/123")
          })
      ))

    // API errors (404, 500) must propagate as FetchClientError
    it.effect("handles API errors", () =>
      withMockFetch(
        [{ status: 404, body: { message: "Page not found" } }],
        () =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(ConfluenceApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
            })

            const client = yield* ConfluenceApiClient.pipe(
              Effect.provide(ConfluenceApiClient.layer),
              Effect.provide(configLayer)
            )

            const result = yield* toEffect(client.v2.client.GET("/pages/{id}", { params: { path: { id: 999 } } }))
              .pipe(Effect.result)

            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expect(result.failure).toBeInstanceOf(FetchClientError)
              expect((result.failure as FetchClientError).status).toBe(404)
            }
          })
      ))
  })

  describe("V1 client", () => {
    // V1 API uses different base path (/wiki/rest/api) -- verifies it's wired correctly
    it.effect("getUser makes correct request", () =>
      withMockFetch(
        [{ status: 200, body: { type: "known", accountId: "abc", displayName: "Test User" } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(ConfluenceApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
            })

            const client = yield* ConfluenceApiClient.pipe(
              Effect.provide(ConfluenceApiClient.layer),
              Effect.provide(configLayer)
            )

            const user = yield* toEffect(client.v1.client.GET("/wiki/rest/api/user", {
              params: { query: { accountId: "abc" } }
            }))

            expect(user.accountId).toBe("abc")
            expect(user.displayName).toBe("Test User")
            expect(capturedRequests[0]!.url).toContain("/wiki/rest/api/user")
          })
      ))
  })
})
