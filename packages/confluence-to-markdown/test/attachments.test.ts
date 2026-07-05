import type * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import {
  isConfluenceReadRetryError,
  isConfluenceWriteRetryError,
  layer as ConfluenceClientLayer,
  makeConfluenceAttachmentUrl
} from "../src/ConfluenceClient.js"
import type { ConfluenceClient } from "../src/ConfluenceClient.js"
import { ApiError, RateLimitError } from "../src/ConfluenceError.js"
import {
  renderConfluenceAttachmentReference,
  resolveMediaAttachmentReferences,
  resolveMediaAttachmentUrls
} from "../src/internal/attachments.js"

describe("Confluence attachment helpers", () => {
  it("keeps the client layer self-contained for read-only consumers", () => {
    const clientLayer: Layer.Layer<ConfluenceClient> = ConfluenceClientLayer({
      baseUrl: "https://example.atlassian.net",
      auth: { type: "token", email: "test@example.com", token: "token" }
    })

    expect(clientLayer).toBeDefined()
  })

  it("adds attachment download URLs to matching media nodes by fileId", () => {
    const resolved = resolveMediaAttachmentUrls(
      JSON.stringify({
        type: "doc",
        version: 1,
        content: [{
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "file-1", type: "file", collection: "page-1" } }]
        }]
      }),
      [{
        id: "attachment-1",
        fileId: "file-1",
        filename: "diagram.svg",
        url: "https://example.atlassian.net/wiki/download/attachments/page-1/diagram.svg",
        mediaType: "image/svg+xml",
        size: 42,
        collectionName: "contentId-page-1"
      }]
    )

    expect(JSON.parse(resolved)).toMatchObject({
      content: [{
        content: [{
          attrs: {
            id: "file-1",
            url: "https://example.atlassian.net/wiki/download/attachments/page-1/diagram.svg",
            filename: "diagram.svg",
            mediaType: "image/svg+xml"
          }
        }]
      }]
    })
  })

  it("preserves existing media alt text instead of replacing it with the filename", () => {
    const resolved = resolveMediaAttachmentUrls(
      JSON.stringify({
        type: "doc",
        version: 1,
        content: [{
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "file-1", type: "file", alt: "Existing alt" } }]
        }]
      }),
      [{
        id: "attachment-1",
        fileId: "file-1",
        filename: "diagram.svg",
        url: "https://example.atlassian.net/wiki/download/attachments/page-1/diagram.svg",
        mediaType: "image/svg+xml",
        size: 42
      }]
    )

    expect(JSON.parse(resolved)).toMatchObject({
      content: [{
        content: [{
          attrs: {
            alt: "Existing alt",
            filename: "diagram.svg"
          }
        }]
      }]
    })
  })

  it("reports unresolved media ids from ADF instead of rendered markdown text", () => {
    const resolved = resolveMediaAttachmentReferences(
      JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "codeBlock",
            content: [{ type: "text", text: "<!-- adf:media id=quoted -->" }]
          },
          {
            type: "mediaSingle",
            content: [{ type: "media", attrs: { id: "file-1", type: "file" } }]
          }
        ]
      }),
      []
    )

    expect(resolved.unresolvedMediaIds).toEqual(["file-1"])
  })

  it("renders media nodes with fileId and collectionName identities", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      fileId: "10452f6e-9b0c-4c11-9311-89f31273f338",
      collectionName: "contentId-7110731",
      filename: "inline-attachment.svg",
      url: "https://example.atlassian.net/wiki/download/inline-attachment.svg",
      mediaType: "image/svg+xml",
      size: 448
    })

    expect(markdown).toContain("\"id\":\"10452f6e-9b0c-4c11-9311-89f31273f338\"")
    expect(markdown).toContain("\"collection\":\"contentId-7110731\"")
    expect(markdown).toContain("![inline-attachment.svg]")
  })

  it("preserves placeholder labels as markdown alt text and native media alt", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      fileId: "10452f6e-9b0c-4c11-9311-89f31273f338",
      collectionName: "contentId-7110731",
      filename: "inline-attachment.svg",
      url: "https://example.atlassian.net/wiki/download/inline-attachment.svg",
      mediaType: "image/svg+xml",
      size: 448
    }, { label: "Architecture diagram" })

    expect(markdown).toContain("\"alt\":\"Architecture diagram\"")
    expect(markdown).toContain("![Architecture diagram]")
  })

  it("uses Confluence-safe media alt text for bracketed upload labels", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      fileId: "10452f6e-9b0c-4c11-9311-89f31273f338",
      collectionName: "contentId-7110731",
      filename: "inline-[draft].svg",
      url: "https://example.atlassian.net/wiki/download/inline-%5Bdraft%5D.svg",
      mediaType: "image/svg+xml",
      size: 448
    }, { label: "Architecture [draft]" })

    expect(markdown).toContain("\"alt\":\"Architecture (draft)\"")
    expect(markdown).toContain("![Architecture (draft)]")
    expect(markdown).not.toContain("\\[draft\\]")
  })

  it("uses Confluence-safe media alt text for bracketed image filenames", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      fileId: "10452f6e-9b0c-4c11-9311-89f31273f338",
      collectionName: "contentId-7110731",
      filename: "inline-[draft].svg",
      url: "https://example.atlassian.net/wiki/download/inline-%5Bdraft%5D.svg",
      mediaType: "image/svg+xml",
      size: 448
    })

    expect(markdown).toContain("![inline-(draft).svg]")
    expect(markdown).not.toContain("\\[draft\\]")
  })

  it("prints copyable native Confluence references when fileId is available", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      fileId: "10452f6e-9b0c-4c11-9311-89f31273f338",
      filename: "inline-attachment.svg",
      url: "https://example.atlassian.net/wiki/download/inline-attachment.svg",
      mediaType: "image/svg+xml",
      size: 448
    })

    expect(markdown).toContain("<!-- adf:mediaSingle")
    expect(markdown).toContain("<!-- adf:/mediaSingle -->")
  })

  it("renders uploads without fileId as plain attachment markdown", () => {
    const markdown = renderConfluenceAttachmentReference("7110731", {
      id: "att7012497",
      filename: "inline-attachment.svg",
      url: "https://example.atlassian.net/wiki/download/inline-attachment.svg",
      mediaType: "image/svg+xml",
      size: 448
    })

    expect(markdown).toBe("![inline-attachment.svg](https://example.atlassian.net/wiki/download/inline-attachment.svg)")
    expect(markdown).not.toContain("adf:mediaSingle")
  })

  it("preserves the Confluence /wiki context for v1 attachment download links", () => {
    const url = makeConfluenceAttachmentUrl(
      "https://example.atlassian.net",
      "/download/attachments/7110731/diagram.svg",
      {
        base: "https://example.atlassian.net/wiki",
        context: "/wiki"
      }
    )

    expect(url).toBe("https://example.atlassian.net/wiki/download/attachments/7110731/diagram.svg")
  })

  it("does not duplicate an existing Confluence link context", () => {
    const url = makeConfluenceAttachmentUrl(
      "https://example.atlassian.net",
      "/wiki/download/attachments/7110731/diagram.svg",
      {
        base: "https://example.atlassian.net/wiki",
        context: "/wiki"
      }
    )

    expect(url).toBe("https://example.atlassian.net/wiki/download/attachments/7110731/diagram.svg")
  })

  it("keeps broad transient retries on reads but restricts writes to rate limits", () => {
    const serverError = new ApiError({ status: 503, message: "unavailable", endpoint: "/pages" })
    const rateLimitApiError = new ApiError({ status: 429, message: "rate limited", endpoint: "/pages" })
    const rateLimitError = new RateLimitError({ retryAfter: 30 })

    expect(isConfluenceReadRetryError(serverError)).toBe(true)
    expect(isConfluenceWriteRetryError(serverError)).toBe(false)
    expect(isConfluenceWriteRetryError(rateLimitApiError)).toBe(true)
    expect(isConfluenceWriteRetryError(rateLimitError)).toBe(true)
  })
})
