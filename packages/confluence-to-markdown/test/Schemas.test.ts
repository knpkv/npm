import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import type { ContentHash, PageId } from "../src/Brand.js"
import {
  ConfluenceConfigFileSchema,
  OAuthConfigSchema,
  OAuthTokenSchema,
  OAuthUserSchema,
  PageFrontMatterSchema
} from "../src/Schemas.js"

describe("Schemas", () => {
  describe("ConfluenceConfigFileSchema", () => {
    it("decodes valid config", () => {
      const config = {
        rootPageId: "123456",
        baseUrl: "https://mysite.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(ConfluenceConfigFileSchema)(config)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.docsPath).toBe(".confluence/docs")
        expect(result.right.excludePatterns).toEqual([])
      }
    })

    it("decodes config with all fields", () => {
      const config = {
        rootPageId: "123456",
        baseUrl: "https://mysite.atlassian.net",
        spaceKey: "DEV",
        docsPath: "docs",
        excludePatterns: ["*.tmp"]
      }
      const result = Schema.decodeUnknownEither(ConfluenceConfigFileSchema)(config)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.spaceKey).toBe("DEV")
        expect(result.right.docsPath).toBe("docs")
      }
    })

    it("rejects invalid base URL", () => {
      const config = {
        rootPageId: "123456",
        baseUrl: "http://invalid.com"
      }
      const result = Schema.decodeUnknownEither(ConfluenceConfigFileSchema)(config)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("rejects missing required fields", () => {
      const config = { baseUrl: "https://mysite.atlassian.net" }
      const result = Schema.decodeUnknownEither(ConfluenceConfigFileSchema)(config)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("PageFrontMatterSchema", () => {
    const validHash = "a".repeat(64) as ContentHash

    it("decodes valid front matter", () => {
      const fm = {
        pageId: "123" as PageId,
        version: 1,
        title: "Test Page",
        updated: new Date().toISOString(),
        contentHash: validHash
      }
      const result = Schema.decodeUnknownEither(PageFrontMatterSchema)(fm)
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes front matter with optional fields", () => {
      const fm = {
        pageId: "123" as PageId,
        version: 2,
        title: "Test Page",
        updated: new Date().toISOString(),
        parentId: "456" as PageId,
        position: 0,
        contentHash: validHash
      }
      const result = Schema.decodeUnknownEither(PageFrontMatterSchema)(fm)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.parentId).toBe("456")
        expect(result.right.position).toBe(0)
      }
    })

    it("rejects negative version", () => {
      const fm = {
        pageId: "123",
        version: -1,
        title: "Test",
        updated: new Date().toISOString(),
        contentHash: validHash
      }
      const result = Schema.decodeUnknownEither(PageFrontMatterSchema)(fm)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OAuthTokenSchema", () => {
    it("decodes valid token", () => {
      const token = {
        access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        refresh_token: "refresh_token_value",
        expires_at: Date.now() + 3600000,
        scope: "read:confluence-content.all",
        cloud_id: "abc123",
        site_url: "https://mysite.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes token with user info", () => {
      const token = {
        access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        refresh_token: "refresh_token_value",
        expires_at: Date.now() + 3600000,
        scope: "read:confluence-content.all",
        cloud_id: "abc123",
        site_url: "https://mysite.atlassian.net",
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

    it("rejects missing required fields", () => {
      const token = {
        access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        // missing refresh_token
        expires_at: Date.now() + 3600000,
        scope: "read:confluence-content.all",
        cloud_id: "abc123",
        site_url: "https://mysite.atlassian.net"
      }
      const result = Schema.decodeUnknownEither(OAuthTokenSchema)(token)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OAuthConfigSchema", () => {
    it("decodes valid config", () => {
      const config = {
        clientId: "client_id_value",
        clientSecret: "client_secret_value"
      }
      const result = Schema.decodeUnknownEither(OAuthConfigSchema)(config)
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects missing clientSecret", () => {
      const config = {
        clientId: "client_id_value"
      }
      const result = Schema.decodeUnknownEither(OAuthConfigSchema)(config)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OAuthUserSchema", () => {
    it("decodes valid user info", () => {
      const user = {
        account_id: "user123",
        name: "Test User",
        email: "test@example.com"
      }
      const result = Schema.decodeUnknownEither(OAuthUserSchema)(user)
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects missing email", () => {
      const user = {
        account_id: "user123",
        name: "Test User"
      }
      const result = Schema.decodeUnknownEither(OAuthUserSchema)(user)
      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
