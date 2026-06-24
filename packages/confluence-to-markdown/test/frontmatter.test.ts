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
