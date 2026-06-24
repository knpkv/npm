import { describe, expect, it } from "vitest"
import { revertPlaceholders } from "../src/AdfPlaceholders.js"

const docOf = (content: ReadonlyArray<unknown>) => ({ version: 1, type: "doc", content })
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64")

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

  it("rewrites native TOC syntax into a Confluence core extension node", () => {
    const out = revertPlaceholders(docOf([para("[[toc]]")])) as {
      content: Array<{ type: string; attrs?: Record<string, unknown> }>
    }

    expect(out.content[0]).toEqual({
      type: "extension",
      attrs: {
        extensionKey: "toc",
        extensionType: "com.atlassian.confluence.macro.core"
      }
    })
  })

  it("rewrites native TOC syntax with levels into macro parameters", () => {
    const out = revertPlaceholders(docOf([para("[[toc:min=2,max=4]]")])) as {
      content: Array<{ type: string; attrs?: Record<string, unknown> }>
    }

    expect(out.content[0]).toEqual({
      type: "extension",
      attrs: {
        extensionKey: "toc",
        extensionType: "com.atlassian.confluence.macro.core",
        parameters: {
          macroParams: {
            minLevel: { value: "2" },
            maxLevel: { value: "4" }
          }
        }
      }
    })
  })

  it("leaves invalid or code-marked native TOC syntax as text", () => {
    const invalid = revertPlaceholders(docOf([para("[[toc:min=0]]")])) as {
      content: Array<{ type: string; content?: ReadonlyArray<unknown> }>
    }
    const quoted = revertPlaceholders(docOf([{
      type: "paragraph",
      content: [{ type: "text", text: "[[toc]]", marks: [{ type: "code" }] }]
    }])) as { content: Array<{ type: string; content?: ReadonlyArray<unknown> }> }

    expect(invalid.content[0]!.type).toBe("paragraph")
    expect(quoted.content[0]!.type).toBe("paragraph")
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

  it("rewrites fallback inline formatting HTML into native marks", () => {
    const out = revertPlaceholders(
      docOf([para(
        `Plain <u>underline</u>, H<sub>2</sub>O, x<sup>2</sup>, ` +
          `<span style="color:#ff5630">Colored text</span>, ` +
          `<span style="background-color:#f8e6a0">highlighted text</span>.`
      )])
    ) as {
      content: Array<{
        content: Array<{ type: string; text?: string; marks?: ReadonlyArray<{ type: string; attrs?: unknown }> }>
      }>
    }

    const inlineContent = out.content[0]!.content
    expect(inlineContent).toContainEqual({
      type: "text",
      text: "underline",
      marks: [{ type: "underline" }]
    })
    expect(inlineContent).toContainEqual({
      type: "text",
      text: "2",
      marks: [{ type: "subsup", attrs: { type: "sub" } }]
    })
    expect(inlineContent).toContainEqual({
      type: "text",
      text: "2",
      marks: [{ type: "subsup", attrs: { type: "sup" } }]
    })
    expect(inlineContent).toContainEqual({
      type: "text",
      text: "Colored text",
      marks: [{ type: "textColor", attrs: { color: "#ff5630" } }]
    })
    expect(inlineContent).toContainEqual({
      type: "text",
      text: "highlighted text",
      marks: [{ type: "backgroundColor", attrs: { color: "#f8e6a0" } }]
    })
  })

  it("rewrites inlineCard placeholders into native smart-link nodes", () => {
    const attrs = { url: "https://www.atlassian.com" }
    const out = revertPlaceholders(
      docOf([para(`Inline smart link: <!-- adf:inlineCard attrs=${b64(attrs)} -->.`)])
    ) as { content: Array<{ content: Array<{ type: string; attrs?: Record<string, unknown> }> }> }

    expect(out.content[0]!.content[1]).toEqual({ type: "inlineCard", attrs })
  })

  it("rewrites encoded date and emoji placeholders into native inline nodes", () => {
    const date = { type: "date", attrs: { timestamp: "1782259200000" } }
    const emoji = { type: "emoji", attrs: { shortName: ":white_check_mark:", text: "✅" } }
    const out = revertPlaceholders(
      docOf([para(`Example <!-- adf:date node=${b64(date)} --> <!-- adf:emoji node=${b64(emoji)} -->`)])
    ) as { content: Array<{ content: Array<unknown> }> }

    expect(out.content[0]!.content).toContainEqual(date)
    expect(out.content[0]!.content).toContainEqual(emoji)
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

  it("re-attaches the blocks between panel markers as a panel body", () => {
    const attrs = { panelType: "warning" }
    const blob = Buffer.from(JSON.stringify(attrs)).toString("base64")
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:panel type=warning attrs=${blob} -->`),
        para("panel body"),
        para(`<!-- adf:/panel -->`),
        para("after")
      ])
    ) as { content: Array<{ type: string; attrs?: Record<string, unknown>; content?: ReadonlyArray<unknown> }> }

    expect(out.content).toHaveLength(2)
    expect(out.content[0]).toEqual({
      type: "panel",
      attrs,
      content: [para("panel body")]
    })
    expect(out.content[1]).toEqual(para("after"))
  })

  it("re-attaches paragraph-level marks from paragraph markers", () => {
    const marks = [{ type: "alignment", attrs: { align: "center" } }]
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:paragraph marks=${b64(marks)} -->`),
        para("Centered paragraph for alignment validation."),
        para(`<!-- adf:/paragraph -->`)
      ])
    ) as { content: Array<{ type: string; marks?: unknown; content?: ReadonlyArray<unknown> }> }

    expect(out.content).toEqual([{
      type: "paragraph",
      marks,
      content: [{ type: "text", text: "Centered paragraph for alignment validation." }]
    }])
  })

  it("restores encoded native block nodes", () => {
    const taskList = {
      type: "taskList",
      attrs: { localId: "tasks-1" },
      content: [{
        type: "taskItem",
        attrs: { localId: "task-1", state: "DONE" },
        content: [{ type: "text", text: "Existing primitive coverage reviewed" }]
      }]
    }
    const decisionList = {
      type: "decisionList",
      attrs: { localId: "decisions-1" },
      content: [{
        type: "decisionItem",
        attrs: { localId: "decision-1", state: "DECIDED" },
        content: [{ type: "text", text: "Decide whether to maintain a separate asset for advanced macros." }]
      }]
    }
    const expand = {
      type: "expand",
      attrs: { title: "Expandable supplementary content" },
      content: [para("This section can be expanded.")]
    }
    const table = {
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [para("Date")] }] }]
    }
    const layoutSection = {
      type: "layoutSection",
      content: [{ type: "layoutColumn", attrs: { width: 50 }, content: [para("Left column")] }]
    }
    const blockCard = { type: "blockCard", attrs: { url: "https://www.atlassian.com/software/confluence" } }
    const embedCard = {
      type: "embedCard",
      attrs: { url: "https://www.atlassian.com/software/confluence", layout: "center" }
    }
    const out = revertPlaceholders(
      docOf([
        para(`<!-- adf:taskList node=${b64(taskList)} -->`),
        para("[x] Existing primitive coverage reviewed"),
        para("<!-- adf:/taskList -->"),
        para(`<!-- adf:decisionList node=${b64(decisionList)} -->`),
        para("This page will act as the baseline integration test asset for editor primitive coverage."),
        para("<!-- adf:/decisionList -->"),
        para(`<!-- adf:expand node=${b64(expand)} -->`),
        para("This section can be expanded."),
        para("<!-- adf:/expand -->"),
        para(`<!-- adf:table node=${b64(table)} -->`),
        para("| Date |"),
        para("<!-- adf:/table -->"),
        para(`<!-- adf:layoutSection node=${b64(layoutSection)} -->`),
        para("Left column"),
        para("<!-- adf:/layoutSection -->"),
        para(`<!-- adf:blockCard node=${b64(blockCard)} -->`),
        para("https://www.atlassian.com/software/confluence"),
        para("<!-- adf:/blockCard -->"),
        para(`<!-- adf:embedCard node=${b64(embedCard)} -->`),
        para("https://www.atlassian.com/software/confluence"),
        para("<!-- adf:/embedCard -->")
      ])
    ) as { content: Array<unknown> }

    expect(out.content).toEqual([taskList, decisionList, expand, table, layoutSection, blockCard, embedCard])
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

  it("leaves code-marked text that quotes placeholder syntax untouched", () => {
    const codeText = (text: string) => ({
      type: "paragraph",
      content: [{ type: "text", text, marks: [{ type: "code" }] }]
    })
    const input = docOf([
      codeText(`<span class="adf-status" data-color="green">DONE</span>`),
      codeText(`<!-- adf:extension key=k type=t -->`),
      codeText(`<!-- adf:/bodiedExtension -->`)
    ])
    expect(revertPlaceholders(input)).toEqual(input)
  })

  it("leaves placeholder-looking text inside a codeBlock untouched", () => {
    // A code sample *quoting* the placeholder syntax must not get structured
    // nodes injected — codeBlock only permits text children, so the document
    // would fail outgoing schema validation and the push would error out.
    const code = `<span class="adf-status" data-color="blue">X</span>\n<!-- adf:inlineExtension key=k type=t -->`
    const input = docOf([{
      type: "codeBlock",
      attrs: { language: "html" },
      content: [{ type: "text", text: code }]
    }])
    expect(revertPlaceholders(input)).toEqual(input)
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
