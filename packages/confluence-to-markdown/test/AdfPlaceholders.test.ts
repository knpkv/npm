import { describe, expect, it } from "vitest"
import { revertPlaceholders } from "../src/AdfPlaceholders.js"

const docOf = (content: ReadonlyArray<unknown>) => ({ version: 1, type: "doc", content })
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })

describe("revertPlaceholders", () => {
  it("rewrites a status span placeholder into a status node", () => {
    const out = revertPlaceholders(
      docOf([para(`Some <span class="adf-status" data-color="blue">TESTING</span> here`)])
    ) as { content: Array<{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }> }

    const cellContent = out.content[0]!.content
    expect(cellContent).toHaveLength(3)
    expect(cellContent[0]).toMatchObject({ type: "text", text: "Some " })
    expect(cellContent[1]).toMatchObject({
      type: "status",
      attrs: { text: "TESTING", color: "blue" }
    })
    expect(cellContent[2]).toMatchObject({ type: "text", text: " here" })
  })

  it("replaces a single-comment paragraph with a block extension node", () => {
    const out = revertPlaceholders(
      docOf([para(`<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core -->`)])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown> }> }

    expect(out.content[0]).toMatchObject({
      type: "extension",
      attrs: { extensionKey: "toc", extensionType: "com.atlassian.confluence.macro.core" }
    })
  })

  it("rewrites status and extension placeholders inside table cells", () => {
    const cell = (text: string) => ({
      type: "tableCell",
      attrs: {},
      content: [{ type: "paragraph", content: [{ type: "text", text }] }]
    })
    const out = revertPlaceholders(
      docOf([{
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [{
          type: "tableRow",
          content: [
            cell(`<span class="adf-status" data-color="green">OK</span>`),
            cell(`<!-- adf:extension key=toc type=t -->`)
          ]
        }]
      }])
    ) as {
      content: Array<{
        content: Array<{
          content: Array<{
            content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }>
          }>
        }>
      }>
    }

    const cells = out.content[0]!.content[0]!.content
    // First cell: paragraph wrapping a status node
    expect(cells[0]!.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "status", attrs: { text: "OK", color: "green" } }]
    })
    // Second cell: extension replaces the paragraph entirely
    expect(cells[1]!.content[0]).toMatchObject({
      type: "extension",
      attrs: { extensionKey: "toc", extensionType: "t" }
    })
  })

  it("rewrites inlineExtension placeholders inline", () => {
    const out = revertPlaceholders(
      docOf([para(`before <!-- adf:inlineExtension key=jira type=t --> after`)])
    ) as { content: Array<{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }> }

    const inlineContent = out.content[0]!.content
    expect(inlineContent).toHaveLength(3)
    expect(inlineContent[1]).toMatchObject({
      type: "inlineExtension",
      attrs: { extensionKey: "jira", extensionType: "t" }
    })
  })

  it("leaves text without placeholders untouched", () => {
    const input = docOf([para("plain content")])
    const out = revertPlaceholders(input)
    expect(out).toEqual(input)
  })

  it("rewrites a confluence-mention link into a mention node", () => {
    const out = revertPlaceholders(
      docOf([{
        type: "paragraph",
        content: [{
          type: "text",
          text: "@Andrey Konopkov",
          marks: [{ type: "link", attrs: { href: "confluence-mention://557057%3Aabc-123" } }]
        }]
      }])
    ) as { content: Array<{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }> }

    expect(out.content[0]!.content[0]).toMatchObject({
      type: "mention",
      attrs: { id: "557057:abc-123", text: "@Andrey Konopkov" }
    })
  })

  it("leaves ordinary links alone", () => {
    const input = docOf([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "click",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }]
      }]
    }])
    expect(revertPlaceholders(input)).toEqual(input)
  })
})
