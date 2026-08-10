import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ContentHash, PageId } from "../src/Brand.js"
import { parseMarkdown, serializeMarkdown, serializeNewPageMarkdown } from "../src/internal/frontmatter.js"

describe("frontmatter serialization", () => {
  it.effect("serializes existing page frontmatter without gray-matter safeDump", () =>
    Effect.gen(function*() {
      const serialized = serializeMarkdown(
        {
          pageId: PageId("123"),
          version: 7,
          title: "A page",
          updated: new Date("2026-06-24T10:00:00.000Z"),
          parentId: PageId("456"),
          contentHash: ContentHash("a".repeat(64))
        },
        "Body\n"
      )

      expect(serialized).toContain("pageId: '123'")
      expect(serialized).toContain("version: 7")
      expect(serialized).toContain("updated: '2026-06-24T10:00:00.000Z'")

      const parsed = yield* parseMarkdown("page.md", serialized)
      expect(parsed.isNew).toBe(false)
      expect(parsed.content).toBe("Body")
    }))

  // The flag warns the user before they edit, rather than only when the push
  // is refused, so it has to survive the write/read cycle.
  it.effect("round-trips the roundTrip: unsafe flag", () =>
    Effect.gen(function*() {
      const serialized = serializeMarkdown(
        {
          pageId: PageId("123"),
          version: 7,
          title: "A page",
          updated: new Date("2026-06-24T10:00:00.000Z"),
          contentHash: ContentHash("a".repeat(64)),
          roundTrip: "unsafe"
        },
        "Body\n"
      )

      expect(serialized).toContain("roundTrip: unsafe")

      const parsed = yield* parseMarkdown("page.md", serialized)
      expect(parsed.frontMatter?.roundTrip).toBe("unsafe")
    }))

  it.effect("omits the flag for an ordinary page", () =>
    Effect.gen(function*() {
      const serialized = serializeMarkdown(
        {
          pageId: PageId("123"),
          version: 7,
          title: "A page",
          updated: new Date("2026-06-24T10:00:00.000Z"),
          contentHash: ContentHash("a".repeat(64))
        },
        "Body\n"
      )

      expect(serialized).not.toContain("roundTrip")

      const parsed = yield* parseMarkdown("page.md", serialized)
      expect(parsed.frontMatter?.roundTrip).toBeUndefined()
    }))

  it("serializes new page frontmatter", () => {
    const serialized = serializeNewPageMarkdown(
      {
        title: "New page",
        parentId: PageId("456")
      },
      "Draft"
    )

    expect(serialized).toBe("---\ntitle: New page\nparentId: '456'\n---\nDraft\n")
  })
})
