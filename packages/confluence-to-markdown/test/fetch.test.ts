import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PageId } from "../src/Brand.js"
import { fetchPageAdf, fetchPageMarkdown } from "../src/commands/fetch.js"
import { ConfluenceClient } from "../src/ConfluenceClient.js"
import { MarkdownConverter } from "../src/MarkdownConverter.js"
import type { PageResponse } from "../src/Schemas.js"

const page: PageResponse = {
  id: "2333334354",
  title: "Fetched Page",
  version: { number: 7 },
  body: {
    atlas_doc_format: {
      representation: "atlas_doc_format",
      value: JSON.stringify({ type: "doc", version: 1, content: [] })
    }
  }
}

const TestLayer = Layer.mergeAll(
  Layer.succeed(
    ConfluenceClient,
    ConfluenceClient.of({
      getPage: () => Effect.succeed(page),
      getChildren: () => Effect.die("unused"),
      getAllChildren: () => Effect.die("unused"),
      createPage: () => Effect.die("unused"),
      updatePage: () => Effect.die("unused"),
      deletePage: () => Effect.die("unused"),
      getPageVersions: () => Effect.die("unused"),
      getPageAttachments: () => Effect.die("unused"),
      uploadAttachmentToPage: () => Effect.die("unused"),
      getUser: () => Effect.die("unused"),
      getSpaceId: () => Effect.die("unused"),
      setEditorVersion: () => Effect.die("unused")
    })
  ),
  Layer.succeed(
    MarkdownConverter,
    MarkdownConverter.of({
      adfToMarkdown: () => Effect.succeed("# Fetched Page\n\n<!-- adf:panel attrs={} -->\n\nBody\n"),
      markdownToAdf: () => Effect.die("unused")
    })
  )
)

describe("fetchPageMarkdown", () => {
  it.effect("returns preserving markdown by default", () =>
    Effect.gen(function*() {
      const markdown = yield* fetchPageMarkdown(PageId("2333334354"), { cleanMarkdown: false })

      expect(markdown).toContain("<!-- adf:panel attrs={} -->")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("can return clean markdown", () =>
    Effect.gen(function*() {
      const markdown = yield* fetchPageMarkdown(PageId("2333334354"), { cleanMarkdown: true })

      expect(markdown).toBe("# Fetched Page\n\nBody\n")
    }).pipe(Effect.provide(TestLayer)))
})

describe("fetchPageAdf", () => {
  // `page put --if-version <n>` is the documented way to make the
  // read-modify-write safe, and this read is where `<n>` has to come from —
  // the recommended workflow could not be performed without it.
  it.effect("reports the version the body was read at", () =>
    Effect.gen(function*() {
      const result = yield* fetchPageAdf(PageId("2333334354"))

      expect(result.version).toBe(7)
      expect(JSON.parse(result.adfJson)).toEqual({ type: "doc", version: 1, content: [] })
    }).pipe(Effect.provide(TestLayer)))
})
