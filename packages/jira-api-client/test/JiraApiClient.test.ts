import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import { FetchClientError, JiraApiClient, JiraApiConfig, toEffect } from "../src/index.js"

const isRequest = (input: RequestInfo | URL): input is Request =>
  Predicate.hasProperty(input, "url") &&
  Predicate.hasProperty(input, "headers") &&
  Predicate.hasProperty(input.headers, "entries") &&
  typeof input.headers.entries === "function"

const headersRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (headers === undefined) return {}
  if (
    Predicate.hasProperty(headers, "entries") &&
    typeof headers.entries === "function"
  ) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return Object.fromEntries(Object.entries(headers))
}

const authorizationHeader = (headers: HeadersInit | undefined): string | undefined => {
  const record = headersRecord(headers)
  return record.Authorization ?? record.authorization
}

/**
 * Mock global fetch to capture requests and return canned responses.
 */
const withMockFetch = <A, E>(
  responses: Array<{ status: number; body: unknown }>,
  fn: (capturedRequests: Array<{ url: string; init: RequestInit }>) => Effect.Effect<A, E>
): Effect.Effect<A, E> => {
  const capturedRequests: Array<{ url: string; init: RequestInit }> = []
  let requestIndex = 0
  const originalFetch = fetch

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : isRequest(input) ? input.url : input.toString()
    const headers = isRequest(input)
      ? Object.fromEntries(input.headers.entries())
      : headersRecord(init?.headers)
    capturedRequests.push({ url, init: { ...init, headers } })
    const response = responses[requestIndex] ?? { status: 200, body: {} }
    requestIndex++
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" }
    })
  })

  return Effect.ensuring(
    fn(capturedRequests),
    Effect.sync(() => {
      vi.stubGlobal("fetch", originalFetch)
    })
  )
}

describe("JiraApiClient", () => {
  describe("layer construction", () => {
    // Verifies basic auth applies Base64-encoded email:token as Authorization header and routes to baseUrl
    it.effect("creates client with basic auth", () =>
      withMockFetch(
        [{ status: 200, body: { id: "10001", key: "PROJ-1", fields: { summary: "Test" } } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(JiraApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: {
                type: "basic",
                email: "user@example.com",
                apiToken: Redacted.make("test-token")
              }
            })

            const client = yield* JiraApiClient.pipe(
              Effect.provide(JiraApiClient.layer),
              Effect.provide(configLayer)
            )

            const issue = yield* toEffect(client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
              params: { path: { issueIdOrKey: "PROJ-1" } }
            }))

            expect(issue.id).toBe("10001")
            expect(issue.key).toBe("PROJ-1")
            expect(capturedRequests).toHaveLength(1)

            const request = capturedRequests[0]!
            expect(request.url).toContain("test.atlassian.net")
            expect(request.url).toContain("/rest/api/3/issue/PROJ-1")
            const authHeader = authorizationHeader(request.init.headers)
            expect(authHeader).toMatch(/^Basic /)
          })
      ))

    // Verifies OAuth2 applies Bearer token and routes through Atlassian cloud proxy
    it.effect("creates client with OAuth2 auth and applies Bearer token", () =>
      withMockFetch(
        [{ status: 200, body: { id: "10001", key: "PROJ-1", fields: { summary: "Test" } } }],
        (capturedRequests) =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(JiraApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: {
                type: "oauth2",
                accessToken: Redacted.make("oauth-token"),
                cloudId: "cloud-123"
              }
            })

            const client = yield* JiraApiClient.pipe(
              Effect.provide(JiraApiClient.layer),
              Effect.provide(configLayer)
            )

            const issue = yield* toEffect(client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
              params: { path: { issueIdOrKey: "PROJ-1" } }
            }))

            expect(issue.id).toBe("10001")
            expect(capturedRequests).toHaveLength(1)

            const request = capturedRequests[0]!
            expect(request.url).toContain("api.atlassian.com/ex/jira/cloud-123")
            const authHeader = authorizationHeader(request.init.headers)
            expect(authHeader).toBe("Bearer oauth-token")
          })
      ))
  })

  describe("V3 client", () => {
    // API errors must propagate as FetchClientError
    it.effect("handles API errors", () =>
      withMockFetch(
        [{ status: 404, body: { errorMessages: ["Issue does not exist"] } }],
        () =>
          Effect.gen(function*() {
            const configLayer = Layer.succeed(JiraApiConfig, {
              baseUrl: "https://test.atlassian.net",
              auth: { type: "basic", email: "u@e.com", apiToken: Redacted.make("t") }
            })

            const client = yield* JiraApiClient.pipe(
              Effect.provide(JiraApiClient.layer),
              Effect.provide(configLayer)
            )

            const result = yield* toEffect(client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
              params: { path: { issueIdOrKey: "NOPE-999" } }
            }))
              .pipe(Effect.result)

            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") {
              expect(result.failure).toBeInstanceOf(FetchClientError)
              if (Predicate.hasProperty(result.failure, "status")) {
                expect(result.failure.status).toBe(404)
              }
            }
          })
      ))
  })
})
