import { describe, expect, it } from "vitest"
import { isPreviewableAttachment, renderAttachmentMarkdown, replaceAttachmentPlaceholder } from "../src/attachments.js"

describe("attachment helpers", () => {
  it("treats SVG as previewable even with a generic media type", () => {
    expect(isPreviewableAttachment({
      filename: "diagram.svg",
      mediaType: "application/octet-stream"
    })).toBe(true)
  })

  it("renders image attachments as previews and other attachments as links", () => {
    expect(renderAttachmentMarkdown({
      id: "1",
      filename: "screenshot.png",
      url: "https://example.test/screenshot.png",
      mediaType: "image/png",
      size: 1
    })).toBe("![screenshot.png](https://example.test/screenshot.png)")

    expect(renderAttachmentMarkdown({
      id: "2",
      filename: "debug.log",
      url: "https://example.test/debug.log",
      mediaType: "text/plain",
      size: 1
    })).toBe("[debug.log](https://example.test/debug.log)")
  })

  it("escapes labels and wraps unsafe destinations in rendered markdown", () => {
    expect(renderAttachmentMarkdown({
      id: "1",
      filename: "weird ] name\n.svg",
      url: "https://example.test/a file(1).svg",
      mediaType: "image/svg+xml",
      size: 1
    })).toBe("![weird \\] name .svg](<https://example.test/a file(1).svg>)")
  })

  it("uses an explicit label when rendering attachment markdown", () => {
    expect(renderAttachmentMarkdown({
      id: "1",
      filename: "diagram.svg",
      url: "https://example.test/diagram.svg",
      mediaType: "image/svg+xml",
      size: 1
    }, { label: "Architecture diagram" })).toBe("![Architecture diagram](https://example.test/diagram.svg)")
  })

  it("replaces a named local Markdown placeholder", () => {
    const result = replaceAttachmentPlaceholder(
      "before\n![Diagram](./diagram.svg)\nafter",
      "./diagram.svg",
      "![diagram.svg](https://example.test/diagram.svg)"
    )

    expect(result).toEqual({
      replacements: 1,
      content: "before\n![diagram.svg](https://example.test/diagram.svg)\nafter"
    })
  })

  it("passes the placeholder label to callback replacements", () => {
    const result = replaceAttachmentPlaceholder(
      "before\n![Architecture diagram](./diagram.svg)\nafter",
      "./diagram.svg",
      ({ isImage, label }) => `${isImage ? "!" : ""}[${label}](https://example.test/diagram.svg)`
    )

    expect(result).toEqual({
      replacements: 1,
      content: "before\n![Architecture diagram](https://example.test/diagram.svg)\nafter"
    })
  })
})
