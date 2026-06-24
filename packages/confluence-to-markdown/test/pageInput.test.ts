import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parseConfluencePageUrl, resolvePageInput } from "../src/commands/pageInput.js"

describe("page input", () => {
  it.effect("parses shorthand Atlassian URLs", () =>
    Effect.gen(function*() {
      const result = yield* parseConfluencePageUrl("https://example.atlassian.com/2333334354")

      expect(result).toEqual({
        baseUrl: "https://example.atlassian.com",
        pageId: "2333334354"
      })
    }))

  it.effect("parses space page URLs", () =>
    Effect.gen(function*() {
      const result = yield* parseConfluencePageUrl(
        "https://example.atlassian.net/wiki/spaces/DEV/pages/2333334354/Page+Title"
      )

      expect(result).toEqual({
        baseUrl: "https://example.atlassian.net",
        pageId: "2333334354"
      })
    }))

  it.effect("parses wiki page URLs", () =>
    Effect.gen(function*() {
      const result = yield* parseConfluencePageUrl("https://example.atlassian.net/wiki/pages/2333334354")

      expect(result).toEqual({
        baseUrl: "https://example.atlassian.net",
        pageId: "2333334354"
      })
    }))

  it.effect("rejects unsupported hosts", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(parseConfluencePageUrl("https://example.com/wiki/pages/2333334354"))

      expect(result._tag).toBe("Failure")
    }))

  it.effect("rejects URLs without a page ID", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(parseConfluencePageUrl("https://example.atlassian.net/wiki/spaces/DEV"))

      expect(result._tag).toBe("Failure")
    }))

  it.effect("rejects page URLs when the segment after pages is not numeric", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(
        parseConfluencePageUrl("https://example.atlassian.net/wiki/spaces/DEV/pages/not-a-page-id/2333334354")
      )

      expect(result._tag).toBe("Failure")
    }))

  it.effect("resolves separate page ID and base URL", () =>
    Effect.gen(function*() {
      const result = yield* resolvePageInput({
        pageId: "2333334354",
        baseUrl: "https://example.atlassian.net"
      })

      expect(result).toEqual({
        baseUrl: "https://example.atlassian.net",
        pageId: "2333334354"
      })
    }))

  it.effect("rejects mixed URL and separate flags", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(resolvePageInput({
        url: "https://example.atlassian.net/wiki/pages/2333334354",
        pageId: "2333334354"
      }))

      expect(result._tag).toBe("Failure")
    }))
})
