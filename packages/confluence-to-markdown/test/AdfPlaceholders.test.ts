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

  it("restores the full attrs (parameters included) from an attrs blob", () => {
    const attrs = {
      extensionKey: "toc",
      extensionType: "com.atlassian.confluence.macro.core",
      layout: "default",
      localId: "abc-123",
      parameters: { macroParams: { maxLevel: { value: "3" } } }
    }
    const blob = Buffer.from(JSON.stringify(attrs)).toString("base64")
    const out = revertPlaceholders(
      docOf([para(`<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=${blob} -->`)])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown> }> }

    expect(out.content[0]).toEqual({ type: "extension", attrs })
  })

  it("falls back to key/type when the attrs blob does not decode to JSON", () => {
    // "aGVsbG8=" is valid base64 but decodes to "hello", which is not JSON.
    const out = revertPlaceholders(
      docOf([para(`<!-- adf:extension key=toc type=t attrs=aGVsbG8= -->`)])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown> }> }

    expect(out.content[0]).toEqual({
      type: "extension",
      attrs: { extensionKey: "toc", extensionType: "t" }
    })
  })

  it("re-attaches the blocks between bodiedExtension markers as its body", () => {
    const attrs = { extensionKey: "details", extensionType: "com.example" }
    const blob = Buffer.from(JSON.stringify(attrs)).toString("base64")
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:bodiedExtension key=details type=com.example attrs=${blob} -->`),
        para("first body paragraph"),
        para("second body paragraph"),
        para(`<!-- adf:/bodiedExtension -->`),
        para("after")
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }> }

    expect(out.content).toHaveLength(2)
    expect(out.content[0]).toEqual({
      type: "bodiedExtension",
      attrs,
      content: [para("first body paragraph"), para("second body paragraph")]
    })
    expect(out.content[1]).toEqual(para("after"))
  })

  it("reverts an extension marker nested inside a bodiedExtension body", () => {
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:bodiedExtension key=outer type=com.example -->`),
        para(`<!-- adf:extension key=inner type=com.example -->`),
        para(`<!-- adf:/bodiedExtension -->`)
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }> }

    expect(out.content[0]).toEqual({
      type: "bodiedExtension",
      attrs: { extensionKey: "outer", extensionType: "com.example" },
      content: [{ type: "extension", attrs: { extensionKey: "inner", extensionType: "com.example" } }]
    })
  })

  it("downgrades a bodiedExtension marker without an end marker to a plain extension", () => {
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:bodiedExtension key=details type=com.example -->`),
        para("just a paragraph, no end marker")
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown> }> }

    expect(out.content[0]).toEqual({
      type: "extension",
      attrs: { extensionKey: "details", extensionType: "com.example" }
    })
    expect(out.content[1]).toEqual(para("just a paragraph, no end marker"))
  })

  it("keeps the bodied kind for an empty-body open/end pair via a stub paragraph", () => {
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:bodiedExtension key=excerpt type=com.example -->`),
        para(`<!-- adf:/bodiedExtension -->`)
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }> }

    expect(out.content[0]).toEqual({
      type: "bodiedExtension",
      attrs: { extensionKey: "excerpt", extensionType: "com.example" },
      content: [{ type: "paragraph", content: [] }]
    })
  })

  it("does not let an unpaired open marker steal a later macro's end marker", () => {
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:bodiedExtension key=legacy type=com.example -->`),
        para("unrelated paragraph"),
        para(`<!-- adf:bodiedExtension key=modern type=com.example -->`),
        para("modern body"),
        para(`<!-- adf:/bodiedExtension -->`)
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }> }

    expect(out.content).toEqual([
      { type: "extension", attrs: { extensionKey: "legacy", extensionType: "com.example" } },
      para("unrelated paragraph"),
      {
        type: "bodiedExtension",
        attrs: { extensionKey: "modern", extensionType: "com.example" },
        content: [para("modern body")]
      }
    ])
  })

  it("downgrades a bodied marker to extension where the schema forbids bodiedExtension", () => {
    // blockquote content allows extension but not bodiedExtension — emitting
    // one would fail outgoing validation and the push would error out.
    const out = revertPlaceholders(
      docOf([{
        type: "blockquote",
        content: [
          para(`<!-- adf:bodiedExtension key=k type=t -->`),
          para("body text"),
          para(`<!-- adf:/bodiedExtension -->`)
        ]
      }])
    ) as { content: Array<{ type: string; content?: ReadonlyArray<unknown> }> }

    expect(out.content[0]!.content).toEqual([
      { type: "extension", attrs: { extensionKey: "k", extensionType: "t" } },
      para("body text")
    ])
  })

  it("drops a stray end marker", () => {
    const out = revertPlaceholders(
      docOf([para("before"), para(`<!-- adf:/bodiedExtension -->`), para("after")])
    ) as { content: Array<unknown> }

    expect(out.content).toEqual([para("before"), para("after")])
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
