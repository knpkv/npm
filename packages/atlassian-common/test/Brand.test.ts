import { describe, expect, it } from "vitest"
import { ContentHash, IssueKey, PageId, ProjectKey, SpaceKey } from "../src/Brand.js"

describe("Brand", () => {
  describe("IssueKey", () => {
    it("accepts valid issue keys", () => {
      expect(IssueKey("PROJ-123")).toBe("PROJ-123")
    })

    it("accepts multi-char project keys", () => {
      expect(IssueKey("ABC123-456")).toBe("ABC123-456")
    })

    it("rejects lowercase", () => {
      expect(() => IssueKey("proj-123")).toThrow()
    })

    it("rejects missing number", () => {
      expect(() => IssueKey("PROJ-")).toThrow()
    })
  })

  describe("ProjectKey", () => {
    it("accepts valid project keys", () => {
      expect(ProjectKey("PROJ")).toBe("PROJ")
    })

    it("accepts alphanumeric", () => {
      expect(ProjectKey("PROJ123")).toBe("PROJ123")
    })

    it("rejects lowercase", () => {
      expect(() => ProjectKey("proj")).toThrow()
    })

    it("rejects starting with number", () => {
      expect(() => ProjectKey("123PROJ")).toThrow()
    })
  })

  describe("SpaceKey", () => {
    it("accepts valid space keys", () => {
      expect(SpaceKey("DEV")).toBe("DEV")
    })

    it("rejects lowercase", () => {
      expect(() => SpaceKey("dev")).toThrow()
    })
  })

  describe("PageId", () => {
    it("accepts non-empty strings", () => {
      expect(PageId("12345")).toBe("12345")
    })

    it("rejects empty string", () => {
      expect(() => PageId("")).toThrow()
    })
  })

  describe("ContentHash", () => {
    it("accepts valid SHA256 hash", () => {
      const hash = "a".repeat(64)
      expect(ContentHash(hash)).toBe(hash)
    })

    it("rejects short hash", () => {
      expect(() => ContentHash("abc123")).toThrow()
    })

    it("rejects uppercase", () => {
      expect(() => ContentHash("A".repeat(64))).toThrow()
    })
  })
})
