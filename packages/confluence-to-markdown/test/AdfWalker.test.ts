import type { DocNode } from "@atlaskit/adf-schema"
import { describe, expect, it } from "vitest"
import { walk } from "../src/AdfWalker.js"

const doc = (content: ReadonlyArray<unknown>): DocNode => ({ version: 1, type: "doc", content } as unknown as DocNode)

describe("AdfWalker", () => {
  it("emits a heading at the right level", () => {
    const r = walk(doc([{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Hi" }] }]))
    expect(r.markdown).toContain("### Hi")
  })

  it("escapes special characters in text", () => {
    const r = walk(doc([{ type: "paragraph", content: [{ type: "text", text: "use *stars*" }] }]))
    expect(r.markdown).toContain("\\*stars\\*")
  })

  it("does not escape characters that are only special at line-start or in link syntax", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "text", text: "a (b) c+ d! {e} #1 > #2" }]
    }]))
    expect(r.markdown).toContain("a (b) c+ d! {e} #1 > #2")
  })

  it("escapes block markers at line start so text cannot become structure", () => {
    const r = walk(doc([
      { type: "paragraph", content: [{ type: "text", text: "# not a heading" }] },
      { type: "paragraph", content: [{ type: "text", text: "> not a quote" }] },
      { type: "paragraph", content: [{ type: "text", text: "+ not a list" }] },
      { type: "paragraph", content: [{ type: "text", text: "1. not a list" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "hardBreak" },
          { type: "text", text: "# b stays text" }
        ]
      }
    ]))
    expect(r.markdown).toContain("\\# not a heading")
    expect(r.markdown).toContain("\\> not a quote")
    expect(r.markdown).toContain("\\+ not a list")
    expect(r.markdown).toContain("1\\. not a list")
    expect(r.markdown).toContain("\\# b stays text")
  })

  it("does not escape mid-line hashes or list-like text after the first word", () => {
    const r = walk(doc([{ type: "paragraph", content: [{ type: "text", text: "a #1 > #2 + b" }] }]))
    expect(r.markdown).toContain("a #1 > #2 + b")
  })

  it("does not escape code-marked text", () => {
    // Backslashes inside code spans are literal; escaping here made every
    // pull/push round-trip double them (a\_b → a\\\_b → …).
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "text", text: "a_b (c*)", marks: [{ type: "code" }] }]
    }]))
    expect(r.markdown).toContain("`a_b (c*)`")
  })

  it("fences code spans containing backticks with a longer delimiter", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "text", text: "a `b` c", marks: [{ type: "code" }] }]
    }]))
    expect(r.markdown).toContain("``a `b` c``")
  })

  it("space-pads code spans that start or end with a backtick", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "text", text: "`tick", marks: [{ type: "code" }] }]
    }]))
    expect(r.markdown).toContain("`` `tick ``")
  })

  it("renders inline marks", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [
        { type: "text", text: "a", marks: [{ type: "strong" }] },
        { type: "text", text: "b", marks: [{ type: "em" }] },
        { type: "text", text: "c", marks: [{ type: "code" }] },
        { type: "text", text: "d", marks: [{ type: "strike" }] }
      ]
    }]))
    expect(r.markdown).toContain("**a**")
    expect(r.markdown).toContain("_b_")
    expect(r.markdown).toContain("`c`")
    expect(r.markdown).toContain("~~d~~")
  })

  it("renders a link with title", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "go",
        marks: [{ type: "link", attrs: { href: "https://x.test", title: "T" } }]
      }]
    }]))
    expect(r.markdown).toContain(`[go](https://x.test "T")`)
  })

  it("falls back lossy marks to HTML and warns", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "text", text: "U", marks: [{ type: "underline" }] }]
    }]))
    expect(r.markdown).toContain("<u>U</u>")
    expect(r.warnings.some((w) => w._tag === "LossyMark" && w.mark === "underline")).toBe(true)
  })

  it("renders nested bullet lists", () => {
    const r = walk(doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "outer" }] },
          {
            type: "bulletList",
            content: [{
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }]
            }]
          }
        ]
      }]
    }]))
    expect(r.markdown).toContain("- outer")
    expect(r.markdown).toContain("inner")
  })

  it("renders ordered lists with attrs.order", () => {
    const r = walk(doc([{
      type: "orderedList",
      attrs: { order: 5 },
      content: [{
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }]
      }]
    }]))
    expect(r.markdown).toContain("5. first")
  })

  it("renders a code block with language", () => {
    const r = walk(doc([{
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1" }]
    }]))
    expect(r.markdown).toContain("```ts")
    expect(r.markdown).toContain("const x = 1")
    expect(r.markdown).toContain("```")
  })

  it("renders a table with header row", () => {
    const r = walk(doc([{
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] }
          ]
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] }
          ]
        }
      ]
    }]))
    expect(r.markdown).toContain("| A | B |")
    expect(r.markdown).toContain("| --- | --- |")
    expect(r.markdown).toContain("| 1 | 2 |")
  })

  it("renders a panel as a GitHub admonition", () => {
    const r = walk(doc([{
      type: "panel",
      attrs: { panelType: "warning" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "be careful" }] }]
    }]))
    expect(r.markdown).toContain("[!WARNING]")
    expect(r.markdown).toContain("be careful")
  })

  it("renders task lists with checkbox state", () => {
    const r = walk(doc([{
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { state: "DONE" },
          content: [{ type: "text", text: "done" }]
        },
        {
          type: "taskItem",
          attrs: { state: "TODO" },
          content: [{ type: "text", text: "todo" }]
        }
      ]
    }]))
    expect(r.markdown).toContain("- [x] done")
    expect(r.markdown).toContain("- [ ] todo")
  })

  it("renders every child of a mediaGroup", () => {
    const r = walk(doc([{
      type: "mediaGroup",
      content: [
        { type: "media", attrs: { id: "m1", alt: "first", url: "https://x.test/1.png" } },
        { type: "media", attrs: { id: "m2", alt: "second", url: "https://x.test/2.png" } },
        { type: "media", attrs: { id: "m3" } }
      ]
    }]))
    expect(r.markdown).toContain("![first](https://x.test/1.png)")
    expect(r.markdown).toContain("![second](https://x.test/2.png)")
    expect(r.markdown).toContain("<!-- adf:media id=m3 -->")
    expect(r.warnings.some((w) => w._tag === "MediaWithoutUrl" && w.mediaId === "m3")).toBe(true)
  })

  it("emits placeholders + warnings for unknown nodes", () => {
    const r = walk(doc([{ type: "totallyMadeUp" }]))
    expect(r.markdown).toContain("<!-- unsupported ADF node: totallyMadeUp -->")
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode")).toBe(true)
  })

  it("does not double the @ on mentions whose text already starts with @", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "mention", attrs: { id: "557057:abc", text: "@Andrey Konopkov" } }]
    }]))
    expect(r.markdown).toContain("@Andrey Konopkov")
    expect(r.markdown).not.toContain("@@")
  })

  it("encodes the mention accountId in a custom-scheme link", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "mention", attrs: { id: "557057:abc-123", text: "@Andrey Konopkov" } }]
    }]))
    // ":" gets percent-encoded by encodeURIComponent so the URL is unambiguous.
    expect(r.markdown).toContain("[@Andrey Konopkov](confluence-mention://557057%3Aabc-123)")
  })

  it("falls back to plain @text when the mention has no id", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{ type: "mention", attrs: { text: "@Anon" } }]
    }]))
    expect(r.markdown).toContain("@Anon")
    expect(r.markdown).not.toContain("confluence-mention")
  })

  it("preserves extension key in placeholder for Confluence macros", () => {
    const r = walk(doc([{
      type: "extension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "toc"
      }
    }]))
    expect(r.markdown).toContain("<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core -->")
    expect(
      r.warnings.some((w) =>
        w._tag === "UnsupportedExtension" && w.extensionKey === "toc" && w.nodeType === "extension"
      )
    ).toBe(true)
  })

  it("handles inline and bodied extensions", () => {
    const r = walk(doc([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          { type: "inlineExtension", attrs: { extensionKey: "jira-issue", extensionType: "com.example" } },
          { type: "text", text: " after" }
        ]
      },
      {
        type: "bodiedExtension",
        attrs: { extensionKey: "details", extensionType: "com.example" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }]
      }
    ]))
    expect(r.markdown).toContain("<!-- adf:inlineExtension key=jira-issue type=com.example -->")
    expect(r.markdown).toContain("<!-- adf:bodiedExtension key=details type=com.example -->")
    expect(r.warnings.filter((w) => w._tag === "UnsupportedExtension")).toHaveLength(2)
  })

  it("ends output with exactly one newline", () => {
    const r = walk(doc([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]))
    expect(r.markdown.endsWith("\n")).toBe(true)
    expect(r.markdown.endsWith("\n\n")).toBe(false)
  })
})
