import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { OAuthConfigSchema, OAuthTokenSchema } from "../src/Schemas.js"

/**
 * Tests for OAuth schema validation used by tokenStorage.
 * Full integration tests for file operations would require mocking the filesystem.
 */
describe("tokenStorage schemas", () => {
  describe("OAuthTokenSchema", () => {
    it("validates complete token", () => {
      const token = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
        scope: "read:confluence-content.all",
        cloud_id: "test_cloud_id",
        site_url: "https://test.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isRight(result)).toBe(true)
    })

    it("validates token with user info", () => {
      const token = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
        scope: "read:confluence-content.all",
        cloud_id: "test_cloud_id",
        site_url: "https://test.atlassian.net",
        user: {
          account_id: "user123",
          name: "Test User",
          email: "test@example.com"
        }
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.user?.name).toBe("Test User")
      }
    })

    it("rejects token missing required field", () => {
      const token = {
        access_token: "test",
        // missing refresh_token
        expires_at: Date.now(),
        scope: "test",
        cloud_id: "test",
        site_url: "https://test.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("rejects token with invalid expires_at type", () => {
      const token = {
        access_token: "test",
        refresh_token: "test",
        expires_at: "not a number",
        scope: "test",
        cloud_id: "test",
        site_url: "https://test.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OAuthConfigSchema", () => {
    it("validates complete config", () => {
      const config = {
        clientId: "test_client_id",
        clientSecret: "test_client_secret"
      }
      const result = Schema.decodeUnknownEither(OAuthConfigSchema)(config)
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects config missing clientSecret", () => {
      const config = {
        clientId: "test_client_id"
      }
      const result = Schema.decodeUnknownEither(OAuthConfigSchema)(config)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("rejects config missing clientId", () => {
      const config = {
        clientSecret: "test_client_secret"
      }
      const result = Schema.decodeUnknownEither(OAuthConfigSchema)(config)
      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
