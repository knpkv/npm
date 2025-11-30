import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { ContentHash, PageId, PageIdSchema, SpaceKey, SpaceKeySchema } from "../src/Brand.js"

describe("Brand", () => {
  describe("PageId", () => {
    it("accepts valid page IDs", () => {
      expect(PageId("123456")).toBe("123456")
      expect(PageId("abc-def")).toBe("abc-def")
    })

    it("rejects empty strings", () => {
      expect(() => PageId("")).toThrow()
    })
  })

  describe("PageIdSchema", () => {
    it("decodes valid page IDs", () => {
      const result = Schema.decodeEither(PageIdSchema)("123456")
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects empty strings", () => {
      const result = Schema.decodeEither(PageIdSchema)("")
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("SpaceKey", () => {
    it("accepts valid space keys", () => {
      expect(SpaceKey("MYSPACE")).toBe("MYSPACE")
      expect(SpaceKey("DEV")).toBe("DEV")
    })

    it("rejects empty strings", () => {
      expect(() => SpaceKey("")).toThrow()
    })
  })

  describe("SpaceKeySchema", () => {
    it("decodes uppercase alphanumeric keys", () => {
      const result = Schema.decodeEither(SpaceKeySchema)("MYSPACE123")
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects lowercase keys", () => {
      const result = Schema.decodeEither(SpaceKeySchema)("myspace")
      expect(Either.isLeft(result)).toBe(true)
    })

    it("rejects keys with special characters", () => {
      const result = Schema.decodeEither(SpaceKeySchema)("MY-SPACE")
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("ContentHash", () => {
    it("accepts valid 64-char hex hashes", () => {
      const validHash = "a".repeat(64)
      expect(ContentHash(validHash)).toBe(validHash)
    })

    it("rejects short hashes", () => {
      expect(() => ContentHash("abc123")).toThrow()
    })

    it("rejects empty strings", () => {
      expect(() => ContentHash("")).toThrow()
    })
  })
})
