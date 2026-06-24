import { describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { HttpClientRequest } from "effect/unstable/http"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { expect } from "vitest"
import { OAuthError } from "../src/auth/OAuthErrors.js"
import {
  buildOAuthToken,
  exchangeCodeForTokens,
  getAccessibleResources,
  getUserInfo,
  refreshToken,
  revokeToken
} from "../src/auth/OAuthOperations.js"
import type { OAuthConfig, OAuthToken } from "../src/config/OAuthSchemas.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const provide = (client: HttpClient.HttpClient) => Effect.provide(Layer.succeed(HttpClient.HttpClient, client))

const validTokenBody = {
  access_token: "access-123",
  refresh_token: "refresh-456",
  expires_in: 3600,
  scope: "read:jira-work",
  token_type: "Bearer"
}

const oauthConfig: OAuthConfig = {
  clientId: "cid",
  clientSecret: "csecret"
}

const oauthToken: OAuthToken = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_at: Date.now() - 1000,
  scope: "read:jira-work",
  cloud_id: "cloud-1",
  site_url: "https://site.atlassian.net"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthOperations", () => {
  // ---- exchangeCodeForTokens ----

  describe("exchangeCodeForTokens", () => {
    // Verifies grant_type, client_id, client_secret, code, redirect_uri are sent — the 5 required fields for token exchange
    // Also confirms code_verifier is absent when PKCE not used
    it.effect("sends correct body without code_verifier", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: validTokenBody }
        ])

        const result = yield* exchangeCodeForTokens("auth-code", oauthConfig, { port: 9876 }).pipe(
          provide(mockClient)
        )

        expect(result.access_token).toBe("access-123")
        expect(capturedRequests).toHaveLength(1)
        const req = capturedRequests[0]!
        expect(req.url).toContain("auth.atlassian.com/oauth/token")

        // body is an Effect — decode from the captured request
        const body = yield* req.body._tag === "Uint8Array"
          ? Effect.succeed(JSON.parse(new TextDecoder().decode(req.body.body)))
          : Effect.succeed({})

        expect(body.grant_type).toBe("authorization_code")
        expect(body.client_id).toBe("cid")
        expect(body.client_secret).toBe("csecret")
        expect(body.code).toBe("auth-code")
        expect(body.redirect_uri).toBe("http://localhost:9876/callback")
        expect(body.code_verifier).toBeUndefined()
      }))

    // PKCE requires code_verifier on token exchange — server checks SHA256(verifier) == challenge from auth URL
    it.effect("includes code_verifier when provided", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: validTokenBody }
        ])

        yield* exchangeCodeForTokens("auth-code", oauthConfig, { port: 9876, codeVerifier: "my-verifier" }).pipe(
          provide(mockClient)
        )

        const req = capturedRequests[0]!
        const body = yield* req.body._tag === "Uint8Array"
          ? Effect.succeed(JSON.parse(new TextDecoder().decode(req.body.body)))
          : Effect.succeed({})

        expect(body.code_verifier).toBe("my-verifier")
      }))

    // Token exchange failures (invalid code, expired code) must surface as OAuthError with step="token"
    it.effect("returns OAuthError with step=token on HTTP 400", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([
          { status: 400, body: { error: "invalid_grant" } }
        ])

        const exit = yield* exchangeCodeForTokens("bad-code", oauthConfig, { port: 9876 }).pipe(
          provide(mockClient),
          Effect.flip
        )

        expect(exit).toBeInstanceOf(OAuthError)
        expect(exit.step).toBe("token")
      }))
  })

  // ---- getAccessibleResources ----

  describe("getAccessibleResources", () => {
    // Verifies Bearer token is applied to Authorization header and response is decoded into typed array
    it.effect("applies Bearer token and decodes response", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          {
            status: 200,
            body: [
              { id: "cloud-1", name: "My Site", url: "https://site.atlassian.net", scopes: ["read:jira-work"] }
            ]
          }
        ])

        const result = yield* getAccessibleResources("tok-abc").pipe(provide(mockClient))

        expect(result).toHaveLength(1)
        expect(result[0]!.id).toBe("cloud-1")

        const req = capturedRequests[0]!
        expect(req.headers.authorization).toBe("Bearer tok-abc")
      }))

    // Resources failures must use step="resources" (not "authorize") so callers can distinguish from other phases
    it.effect("returns OAuthError with step=resources on HTTP 401", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([{ status: 401, body: {} }])

        const exit = yield* getAccessibleResources("bad-tok").pipe(
          provide(mockClient),
          Effect.flip
        )

        expect(exit).toBeInstanceOf(OAuthError)
        expect(exit.step).toBe("resources")
      }))
  })

  // ---- getUserInfo ----

  describe("getUserInfo", () => {
    // Verifies Bearer token and correct decoding of account_id, name, email from /me endpoint
    it.effect("applies Bearer token and decodes response", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { account_id: "uid-1", name: "Alice", email: "a@b.com" } }
        ])

        const result = yield* getUserInfo("tok-xyz").pipe(provide(mockClient))

        expect(result.account_id).toBe("uid-1")
        expect(result.name).toBe("Alice")
        expect(result.email).toBe("a@b.com")

        const req = capturedRequests[0]!
        expect(req.headers.authorization).toBe("Bearer tok-xyz")
      }))

    // User info failures must use step="user-info" (not "authorize") for per-phase error handling
    it.effect("returns OAuthError with step=user-info on HTTP 403", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([{ status: 403, body: {} }])

        const exit = yield* getUserInfo("bad-tok").pipe(
          provide(mockClient),
          Effect.flip
        )

        expect(exit).toBeInstanceOf(OAuthError)
        expect(exit.step).toBe("user-info")
      }))
  })

  // ---- refreshToken ----

  describe("refreshToken", () => {
    // Verifies grant_type=refresh_token is sent and returned token preserves cloud_id/site_url from original
    it.effect("sends refresh_token and returns updated OAuthToken", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: { ...validTokenBody, access_token: "new-access", refresh_token: "new-refresh" } }
        ])

        const result = yield* refreshToken(oauthToken, oauthConfig).pipe(provide(mockClient))

        expect(result.access_token).toBe("new-access")
        expect(result.refresh_token).toBe("new-refresh")
        // preserves existing fields
        expect(result.cloud_id).toBe("cloud-1")
        expect(result.site_url).toBe("https://site.atlassian.net")
        expect(result.expires_at).toBeGreaterThan(Date.now())

        const req = capturedRequests[0]!
        const body = yield* req.body._tag === "Uint8Array"
          ? Effect.succeed(JSON.parse(new TextDecoder().decode(req.body.body)))
          : Effect.succeed({})

        expect(body.grant_type).toBe("refresh_token")
        expect(body.refresh_token).toBe("old-refresh")
      }))

    // Refresh failures (revoked token, expired refresh) must surface as step="refresh"
    it.effect("returns OAuthError with step=refresh on HTTP 400", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([
          { status: 400, body: { error: "invalid_grant" } }
        ])

        const exit = yield* refreshToken(oauthToken, oauthConfig).pipe(
          provide(mockClient),
          Effect.flip
        )

        expect(exit).toBeInstanceOf(OAuthError)
        expect(exit.step).toBe("refresh")
      }))
  })

  // ---- revokeToken ----

  describe("revokeToken", () => {
    // Verifies revoke hits the correct endpoint — logout must invalidate server-side token
    it.effect("sends revoke request", () =>
      Effect.gen(function*() {
        const { capturedRequests, mockClient } = createMockHttpClient([
          { status: 200, body: {} }
        ])

        yield* revokeToken(oauthToken, oauthConfig).pipe(provide(mockClient))

        expect(capturedRequests).toHaveLength(1)
        const req = capturedRequests[0]!
        expect(req.url).toContain("auth.atlassian.com/oauth/revoke")
      }))

    // Revoke failures must surface as step="revoke" for caller error handling
    it.effect("returns OAuthError with step=revoke on HTTP 400", () =>
      Effect.gen(function*() {
        const { mockClient } = createMockHttpClient([{ status: 400, body: {} }])

        const exit = yield* revokeToken(oauthToken, oauthConfig).pipe(
          provide(mockClient),
          Effect.flip
        )

        expect(exit).toBeInstanceOf(OAuthError)
        expect(exit.step).toBe("revoke")
      }))
  })

  // ---- buildOAuthToken ----

  describe("buildOAuthToken", () => {
    // Pure assembly function — verifies token response + site + user are merged correctly with computed expires_at
    it("assembles OAuthToken from response + site + user", () => {
      const token = buildOAuthToken(
        validTokenBody,
        { id: "cloud-1", name: "Site", url: "https://site.atlassian.net", scopes: [] },
        { account_id: "uid-1", name: "Alice", email: "a@b.com" }
      )

      expect(token.access_token).toBe("access-123")
      expect(token.refresh_token).toBe("refresh-456")
      expect(token.cloud_id).toBe("cloud-1")
      expect(token.site_url).toBe("https://site.atlassian.net")
      expect(token.user).toEqual({ account_id: "uid-1", name: "Alice", email: "a@b.com" })
      expect(token.expires_at).toBeGreaterThan(Date.now() - 1000)
    })
  })
})
