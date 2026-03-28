import { describe, expect, it } from "vitest"
import { ContentHash, IssueKey, PageId, ProjectKey, SpaceKey } from "../src/Brand.js"

describe("Brand", () => {
  describe("IssueKey", () => {
    // Happy path: "PROJ-123" is the canonical Jira issue key format
    it("accepts valid issue keys", () => {
      expect(IssueKey("PROJ-123")).toBe("PROJ-123")
    })

    // Jira allows alphanumeric project prefixes like "ABC123-456"
    it("accepts multi-char project keys", () => {
      expect(IssueKey("ABC123-456")).toBe("ABC123-456")
    })

    // Jira keys are always uppercase — lowercase would fail API lookups
    it("rejects lowercase", () => {
      expect(() => IssueKey("proj-123")).toThrow()
    })

    // "PROJ-" without a number is an incomplete key — would break URL construction
    it("rejects missing number", () => {
      expect(() => IssueKey("PROJ-")).toThrow()
    })
  })

  describe("ProjectKey", () => {
    // Jira project keys are uppercase alpha strings
    it("accepts valid project keys", () => {
      expect(ProjectKey("PROJ")).toBe("PROJ")
    })

    // Alphanumeric suffixes allowed (e.g. "PROJ123")
    it("accepts alphanumeric", () => {
      expect(ProjectKey("PROJ123")).toBe("PROJ123")
    })

    // Jira enforces uppercase project keys
    it("rejects lowercase", () => {
      expect(() => ProjectKey("proj")).toThrow()
    })

    // Jira project keys must start with a letter
    it("rejects starting with number", () => {
      expect(() => ProjectKey("123PROJ")).toThrow()
    })
  })

  describe("SpaceKey", () => {
    // Confluence space keys follow same uppercase convention
    it("accepts valid space keys", () => {
      expect(SpaceKey("DEV")).toBe("DEV")
    })

    // Lowercase would fail Confluence API lookups
    it("rejects lowercase", () => {
      expect(() => SpaceKey("dev")).toThrow()
    })
  })

  describe("PageId", () => {
    // Confluence page IDs are numeric strings — must be non-empty
    it("accepts non-empty strings", () => {
      expect(PageId("12345")).toBe("12345")
    })

    // Empty string would produce invalid API URLs
    it("rejects empty string", () => {
      expect(() => PageId("")).toThrow()
    })
  })

  describe("ContentHash", () => {
    // SHA-256 hashes are 64 lowercase hex chars — used for content change detection
    it("accepts valid SHA256 hash", () => {
      const hash = "a".repeat(64)
      expect(ContentHash(hash)).toBe(hash)
    })

    // Short strings aren't valid SHA-256 hashes
    it("rejects short hash", () => {
      expect(() => ContentHash("abc123")).toThrow()
    })

    // SHA-256 hex output is lowercase — uppercase would break comparison
    it("rejects uppercase", () => {
      expect(() => ContentHash("A".repeat(64))).toThrow()
    })
  })
})
