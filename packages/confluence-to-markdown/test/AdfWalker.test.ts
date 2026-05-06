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

  it("emits placeholders + warnings for unknown nodes", () => {
    const r = walk(doc([{ type: "totallyMadeUp" }]))
    expect(r.markdown).toContain("<!-- unsupported ADF node: totallyMadeUp -->")
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode")).toBe(true)
  })

  it("ends output with exactly one newline", () => {
    const r = walk(doc([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]))
    expect(r.markdown.endsWith("\n")).toBe(true)
    expect(r.markdown.endsWith("\n\n")).toBe(false)
  })
})
