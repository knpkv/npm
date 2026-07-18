import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { it as effectIt } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  AUTH_URL,
  buildAuthUrl,
  computeCodeChallenge,
  CONFLUENCE_SCOPES,
  generateCodeVerifier
} from "../src/auth/OAuthEndpoints.js"

const withCrypto = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(NodeCrypto.layer))

describe("OAuthEndpoints", () => {
  describe("CONFLUENCE_SCOPES", () => {
    it("includes attachment read and write scopes", () => {
      expect(CONFLUENCE_SCOPES).toContain("read:attachment:confluence")
      expect(CONFLUENCE_SCOPES).toContain("write:attachment:confluence")
    })
  })

  // ---- PKCE ----

  describe("generateCodeVerifier", () => {
    // 32 random bytes base64url-encoded = 43 chars; verifies output shape for RFC 7636 compliance
    effectIt.effect("returns a base64url string of 43 characters (32 random bytes)", () =>
      Effect.gen(function*() {
        const verifier = yield* generateCodeVerifier()
        expect(verifier).toHaveLength(43)
        expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
      }).pipe(withCrypto))

    // PKCE verifiers must be unique per auth request — reuse enables replay attacks
    effectIt.effect("produces unique values", () =>
      Effect.gen(function*() {
        const a = yield* generateCodeVerifier()
        const b = yield* generateCodeVerifier()
        expect(a).not.toBe(b)
      }).pipe(withCrypto))
  })

  describe("computeCodeChallenge", () => {
    // Known test vector from RFC 7636 appendix B — proves SHA-256 + base64url is correct
    effectIt.effect("matches RFC 7636 appendix B test vector", () =>
      Effect.gen(function*() {
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        const challenge = yield* computeCodeChallenge(verifier)
        expect(challenge).toBe(expected)
      }).pipe(withCrypto))

    // Same verifier must always produce same challenge — server verifies this on token exchange
    effectIt.effect("is deterministic", () =>
      Effect.gen(function*() {
        const v = yield* generateCodeVerifier()
        const a = yield* computeCodeChallenge(v)
        const b = yield* computeCodeChallenge(v)
        expect(a).toBe(b)
      }).pipe(withCrypto))

    // base64url must not contain +, /, = — these break URL query params
    effectIt.effect("produces base64url output (no +, /, =)", () =>
      Effect.gen(function*() {
        const challenge = yield* computeCodeChallenge("test-verifier-string")
        expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
      }).pipe(withCrypto))
  })

  // ---- buildAuthUrl ----

  describe("buildAuthUrl", () => {
    // Verifies all required OAuth2 params (audience, client_id, scope, redirect_uri, state, response_type, prompt)
    it("includes required parameters", () => {
      const url = buildAuthUrl({
        clientId: "cid",
        state: "state-123",
        port: 9876,
        scopes: ["read:jira-work", "offline_access"]
      })

      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe(AUTH_URL)
      expect(parsed.searchParams.get("client_id")).toBe("cid")
      expect(parsed.searchParams.get("state")).toBe("state-123")
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:9876/callback")
      expect(parsed.searchParams.get("scope")).toBe("read:jira-work offline_access")
      expect(parsed.searchParams.get("response_type")).toBe("code")
      expect(parsed.searchParams.get("audience")).toBe("api.atlassian.com")
      expect(parsed.searchParams.get("prompt")).toBe("consent")
    })

    it("uses an application callback URL when supplied", () => {
      const url = buildAuthUrl({
        clientId: "cid",
        state: "state-123",
        port: 4173,
        redirectUri: "http://127.0.0.1:4173/services/oauth/atlassian/callback",
        scopes: ["read:me"]
      })

      expect(new URL(url).searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:4173/services/oauth/atlassian/callback"
      )
    })

    // PKCE is optional — omitting codeChallenge must not add params (backwards compat)
    it("omits PKCE params when codeChallenge not provided", () => {
      const url = buildAuthUrl({
        clientId: "cid",
        state: "s",
        port: 3000,
        scopes: ["read:me"]
      })

      const parsed = new URL(url)
      expect(parsed.searchParams.has("code_challenge")).toBe(false)
      expect(parsed.searchParams.has("code_challenge_method")).toBe(false)
    })

    // When PKCE is used, both code_challenge and method=S256 must appear for server to validate
    effectIt.effect(
      "includes code_challenge and code_challenge_method=S256 when provided",
      () =>
        Effect.gen(function*() {
          const challenge = yield* computeCodeChallenge("my-verifier")
          const url = buildAuthUrl({
            clientId: "cid",
            state: "s",
            port: 3000,
            scopes: ["read:me"],
            codeChallenge: challenge
          })

          const parsed = new URL(url)
          expect(parsed.searchParams.get("code_challenge")).toBe(challenge)
          expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
        }).pipe(withCrypto)
    )
  })
})
