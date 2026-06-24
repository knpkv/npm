import { describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
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
      const result = Schema.decodeUnknownResult(ConfluenceConfigFileSchema)(config)
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success.docsPath).toBe(".confluence/docs")
        expect(result.success.excludePatterns).toEqual([])
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
      const result = Schema.decodeUnknownResult(ConfluenceConfigFileSchema)(config)
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success.spaceKey).toBe("DEV")
        expect(result.success.docsPath).toBe("docs")
      }
    })

    it("rejects invalid base URL", () => {
      const config = {
        rootPageId: "123456",
        baseUrl: "http://invalid.com"
      }
      const result = Schema.decodeUnknownResult(ConfluenceConfigFileSchema)(config)
      expect(Result.isFailure(result)).toBe(true)
    })

    it("rejects missing required fields", () => {
      const config = { baseUrl: "https://mysite.atlassian.net" }
      const result = Schema.decodeUnknownResult(ConfluenceConfigFileSchema)(config)
      expect(Result.isFailure(result)).toBe(true)
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
      const result = Schema.decodeUnknownResult(PageFrontMatterSchema)(fm)
      expect(Result.isSuccess(result)).toBe(true)
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
      const result = Schema.decodeUnknownResult(PageFrontMatterSchema)(fm)
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success.parentId).toBe("456")
        expect(result.success.position).toBe(0)
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
      const result = Schema.decodeUnknownResult(PageFrontMatterSchema)(fm)
      expect(Result.isFailure(result)).toBe(true)
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
      const result = Schema.decodeUnknownResult(OAuthTokenSchema)(token)
      expect(Result.isSuccess(result)).toBe(true)
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
      const result = Schema.decodeUnknownResult(OAuthTokenSchema)(token)
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success.user?.name).toBe("Test User")
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
      const result = Schema.decodeUnknownResult(OAuthTokenSchema)(token)
      expect(Result.isFailure(result)).toBe(true)
    })
  })

  describe("OAuthConfigSchema", () => {
    it("decodes valid config", () => {
      const config = {
        clientId: "client_id_value",
        clientSecret: "client_secret_value"
      }
      const result = Schema.decodeUnknownResult(OAuthConfigSchema)(config)
      expect(Result.isSuccess(result)).toBe(true)
    })

    it("rejects missing clientSecret", () => {
      const config = {
        clientId: "client_id_value"
      }
      const result = Schema.decodeUnknownResult(OAuthConfigSchema)(config)
      expect(Result.isFailure(result)).toBe(true)
    })
  })

  describe("OAuthUserSchema", () => {
    it("decodes valid user info", () => {
      const user = {
        account_id: "user123",
        name: "Test User",
        email: "test@example.com"
      }
      const result = Schema.decodeUnknownResult(OAuthUserSchema)(user)
      expect(Result.isSuccess(result)).toBe(true)
    })

    it("rejects missing email", () => {
      const user = {
        account_id: "user123",
        name: "Test User"
      }
      const result = Schema.decodeUnknownResult(OAuthUserSchema)(user)
      expect(Result.isFailure(result)).toBe(true)
    })
  })
})
