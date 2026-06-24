import type { DocNode } from "@atlaskit/adf-schema"
import { describe, expect, it } from "vitest"
import { walk } from "../src/AdfWalker.js"

const doc = (content: ReadonlyArray<unknown>): DocNode => ({ version: 1, type: "doc", content } as unknown as DocNode)

const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  if (v !== null && typeof v === "object") {
    return `{${
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, value]) => `${JSON.stringify(k)}:${stableStringify(value)}`)
        .join(",")
    }}`
  }
  return JSON.stringify(v) ?? "null"
}

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

  it("renders a panel as a Confluence-preserving placeholder", () => {
    const r = walk(doc([{
      type: "panel",
      attrs: { panelType: "warning" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "be careful" }] }]
    }]))
    expect(r.markdown).toContain(
      `<!-- adf:panel type=warning attrs=${stableStringify({ panelType: "warning" })} -->`
    )
    expect(r.markdown).toContain("be careful")
    expect(r.markdown).toContain("<!-- adf:/panel -->")
  })

  it("renders task lists with checkbox state", () => {
    const node = {
      type: "taskList",
      attrs: { localId: "tasks-1" },
      content: [
        {
          type: "taskItem",
          attrs: { localId: "task-1", state: "DONE" },
          content: [{ type: "text", text: "done" }]
        },
        {
          type: "taskItem",
          attrs: { localId: "task-2", state: "TODO" },
          content: [{ type: "text", text: "todo" }]
        }
      ]
    }
    const r = walk(doc([node]))
    expect(r.markdown).toContain(`<!-- adf:taskList node=${stableStringify(node)} -->`)
    expect(r.markdown).toContain("- [x] done")
    expect(r.markdown).toContain("- [ ] todo")
    expect(r.markdown).toContain("<!-- adf:/taskList -->")
  })

  it("wraps decision lists so they survive push as native decisions", () => {
    const node = {
      type: "decisionList",
      attrs: { localId: "decisions-1" },
      content: [{
        type: "decisionItem",
        attrs: { localId: "decision-1", state: "DECIDED" },
        content: [{ type: "text", text: "decide" }]
      }]
    }
    const r = walk(doc([node]))
    expect(r.markdown).toContain(`<!-- adf:decisionList node=${stableStringify(node)} -->`)
    expect(r.markdown).toContain("- 🔘 decide")
    expect(r.markdown).toContain("<!-- adf:/decisionList -->")
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

  it("renders a representable TOC extension as readable native syntax", () => {
    const r = walk(doc([{
      type: "extension",
      attrs: {
        extensionKey: "toc",
        extensionType: "com.atlassian.confluence.macro.core"
      }
    }]))
    expect(r.markdown).toContain("[[toc]]")
    expect(r.warnings).not.toContainEqual(
      expect.objectContaining({ _tag: "UnsupportedExtension", extensionKey: "toc" })
    )
  })

  it("renders representable TOC levels in readable native syntax", () => {
    const r = walk(doc([{
      type: "extension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "toc",
        parameters: {
          macroParams: {
            minLevel: { value: "2" },
            maxLevel: { value: "4" }
          }
        }
      }
    }]))
    expect(r.markdown).toContain("[[toc:min=2,max=4]]")
  })

  it("falls back to a generic placeholder when TOC attrs are not fully representable", () => {
    const rawAttrs = {
      extensionKey: "toc",
      extensionType: "com.atlassian.confluence.macro.core",
      layout: "default",
      localId: "abc-123",
      parameters: { macroParams: { maxLevel: { value: "3" } } }
    }
    const r = walk(doc([{ type: "extension", attrs: rawAttrs }]))
    const attrs = stableStringify(rawAttrs)
    expect(r.markdown).toContain(
      `<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=${attrs} -->`
    )
    expect(r.markdown).not.toContain("[[toc")
    expect(
      r.warnings.some((w) =>
        w._tag === "UnsupportedExtension" && w.extensionKey === "toc" && w.nodeType === "extension"
      )
    ).toBe(true)
  })

  it("falls back to a generic placeholder for Confluence TOC macroMetadata", () => {
    const rawAttrs = {
      extensionKey: "toc",
      extensionType: "com.atlassian.confluence.macro.core",
      layout: "default",
      parameters: {
        macroMetadata: {
          schemaVersion: { value: "1" },
          title: "Table of Contents"
        },
        macroParams: {}
      }
    }
    const r = walk(doc([{ type: "extension", attrs: rawAttrs }]))
    const attrs = stableStringify(rawAttrs)
    expect(r.markdown).toContain(
      `<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=${attrs} -->`
    )
    expect(r.markdown).not.toContain("[[toc")
  })

  it("emits the same attrs blob regardless of source key order", () => {
    const a = walk(doc([{ type: "extension", attrs: { extensionKey: "toc", extensionType: "t" } }]))
    const b = walk(doc([{ type: "extension", attrs: { extensionType: "t", extensionKey: "toc" } }]))
    expect(a.markdown).toBe(b.markdown)
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
    const inlineAttrs = stableStringify({ extensionKey: "jira-issue", extensionType: "com.example" })
    const bodiedAttrs = stableStringify({ extensionKey: "details", extensionType: "com.example" })
    expect(r.markdown).toContain(
      `<!-- adf:inlineExtension key=jira-issue type=com.example attrs=${inlineAttrs} -->`
    )
    // The bodied extension renders its body between an open and an end marker
    // so the push side can re-attach it.
    expect(r.markdown).toContain(
      `<!-- adf:bodiedExtension key=details type=com.example attrs=${bodiedAttrs} -->\n\nbody\n\n<!-- adf:/bodiedExtension -->`
    )
    expect(r.warnings.filter((w) => w._tag === "UnsupportedExtension")).toHaveLength(2)
  })

  it("emits the end marker even for an empty bodied extension", () => {
    // Without it the push side cannot tell "bodied macro with empty body"
    // apart from a legacy/corrupted open marker, and would change node type.
    const r = walk(doc([{
      type: "bodiedExtension",
      attrs: { extensionKey: "excerpt", extensionType: "com.example" },
      content: [{ type: "paragraph", content: [] }]
    }]))
    expect(r.markdown).toContain("<!-- adf:/bodiedExtension -->")
  })

  it("emits only the single-line marker for a bodied extension inside a table cell", () => {
    // <br>-flattened multi-block emission cannot be reverted on push; the
    // bare marker at least comes back as a clean extension node.
    const r = walk(doc([{
      type: "table",
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{
            type: "bodiedExtension",
            attrs: { extensionKey: "details", extensionType: "com.example" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }]
          }]
        }]
      }]
    }]))
    expect(r.markdown).not.toContain("adf:/bodiedExtension")
    expect(r.markdown).not.toContain("\n\nbody\n\n")
    expect(r.markdown).toContain("<!-- adf:bodiedExtension key=details type=com.example")
  })

  it("escapes a pipe in a table cell exactly once", () => {
    const cell = (content: ReadonlyArray<unknown>) => ({
      type: "tableCell",
      content: [{ type: "paragraph", content }]
    })
    const r = walk(doc([{
      type: "table",
      content: [{
        type: "tableRow",
        content: [
          cell([{ type: "text", text: "a|b" }]),
          // Code spans skip escapeText, so this pipe is only caught by the
          // table-cell pass — both cells must end up single-escaped.
          cell([{ type: "text", text: "x|y", marks: [{ type: "code" }] }])
        ]
      }]
    }]))
    expect(r.markdown).toContain("a\\|b")
    expect(r.markdown).not.toContain("a\\\\|b")
    expect(r.markdown).toContain("`x\\|y`")
  })

  it("renders a mediaSingle caption as an italic line under the media", () => {
    const r = walk(doc([{
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { id: "m1", alt: "diagram", url: "https://x.test/d.png" } },
        { type: "caption", content: [{ type: "text", text: "Figure 1" }] }
      ]
    }]))
    expect(r.markdown).toContain("![diagram](https://x.test/d.png)\n_Figure 1_")
  })

  it("renders layout sections and columns as visible markdown content", () => {
    const r = walk(doc([{
      type: "layoutSection",
      content: [
        {
          type: "layoutColumn",
          attrs: { width: 50 },
          content: [{ type: "paragraph", content: [{ type: "text", text: "left" }] }]
        },
        {
          type: "layoutColumn",
          attrs: { width: 50 },
          content: [{ type: "paragraph", content: [{ type: "text", text: "right" }] }]
        }
      ]
    }]))
    expect(r.markdown).toContain("left\n\nright")
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "layoutSection")).toBe(false)
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "layoutColumn")).toBe(false)
  })

  it("renders block and embed smart cards from direct and nested urls", () => {
    const blockCard = { type: "blockCard", attrs: { url: "https://x.test/block" } }
    const embedCard = { type: "embedCard", attrs: { data: { url: "https://x.test/embed" } } }
    const r = walk(doc([
      blockCard,
      embedCard
    ]))
    expect(r.markdown).toContain(`<!-- adf:blockCard node=${stableStringify(blockCard)} -->`)
    expect(r.markdown).toContain("<https://x.test/block>")
    expect(r.markdown).toContain(`<!-- adf:embedCard node=${stableStringify(embedCard)} -->`)
    expect(r.markdown).toContain("<https://x.test/embed>")
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "blockCard")).toBe(false)
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "embedCard")).toBe(false)
  })

  it("backslash-escapes nestedExpand titles inside table cells (inline HTML context)", () => {
    const r = walk(doc([{
      type: "table",
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{
            type: "nestedExpand",
            attrs: { title: "v2 *beta*" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }]
          }]
        }]
      }]
    }]))
    expect(r.markdown).toContain("<summary>v2 \\*beta\\*</summary>")
  })

  it("entity-escapes expand titles instead of backslash-escaping them", () => {
    const r = walk(doc([{
      type: "expand",
      attrs: { title: `v2 *beta* <a href="x">` },
      content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }]
    }]))
    expect(r.markdown).toContain(`<!-- adf:expand node=`)
    expect(r.markdown).toContain(`v2 *beta* <a href="x">`)
    expect(r.markdown).not.toContain("\\*beta\\*")
  })

  it("lengthens the code-block fence when the code contains backtick runs", () => {
    const r = walk(doc([{
      type: "codeBlock",
      attrs: { language: "md" },
      content: [{ type: "text", text: "```js\ncode\n```" }]
    }]))
    expect(r.markdown).toContain("````md\n```js\ncode\n```\n````")
  })

  it("sanitizes media alt text and wraps unsafe media urls", () => {
    // Brackets are substituted, not backslash-escaped: @atlaskit's media
    // markdown plugin throws on `\[` in alt, which would make pushes fail.
    const r = walk(doc([{
      type: "mediaSingle",
      content: [{
        type: "media",
        attrs: { id: "m1", alt: "a [b]\nc", url: "https://x.test/a (1).png" }
      }]
    }]))
    expect(r.markdown).toContain("![a (b) c](<https://x.test/a (1).png>)")
  })

  it("percent-encodes wrapper-breaking characters in unsafe urls", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "go",
        marks: [{ type: "link", attrs: { href: "https://x.test/a b<c>d\\e" } }]
      }]
    }]))
    expect(r.markdown).toContain("[go](<https://x.test/a b%3Cc%3Ed%5Ce>)")
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

  it("strips backticks and whitespace from the code-block language", () => {
    const r = walk(doc([{
      type: "codeBlock",
      attrs: { language: "c`x\ninjected" },
      content: [{ type: "text", text: "hello" }]
    }]))
    expect(r.markdown).toContain("```cxinjected\nhello\n```")
  })

  it("warns when an inlineCard has no url to render", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [
        { type: "text", text: "before " },
        { type: "inlineCard", attrs: { data: { title: "hidden" } } },
        { type: "text", text: " after" }
      ]
    }]))
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "inlineCard")).toBe(true)
  })

  it("renders inline cards from nested data urls", () => {
    const r = walk(doc([{
      type: "paragraph",
      content: [
        { type: "text", text: "see " },
        { type: "inlineCard", attrs: { data: { url: "https://x.test/inline" } } }
      ]
    }]))
    expect(r.markdown).toContain(
      `see <!-- adf:inlineCard attrs=${stableStringify({ data: { url: "https://x.test/inline" } })} -->`
    )
    expect(r.warnings.some((w) => w._tag === "UnsupportedNode" && w.nodeType === "inlineCard")).toBe(false)
  })

  it("wraps paragraph-level marks so alignment and indentation survive push", () => {
    const marks = [{ type: "alignment", attrs: { align: "center" } }]
    const r = walk(doc([{
      type: "paragraph",
      marks,
      content: [{ type: "text", text: "centered" }]
    }]))
    expect(r.markdown).toContain(`<!-- adf:paragraph marks=${stableStringify(marks)} -->`)
    expect(r.markdown).toContain("centered")
    expect(r.markdown).toContain("<!-- adf:/paragraph -->")
  })

  it("does not double-wrap an em-marked caption", () => {
    const r = walk(doc([{
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { id: "m1", url: "https://x.test/d.png" } },
        { type: "caption", content: [{ type: "text", text: "a caption", marks: [{ type: "em" }] }] }
      ]
    }]))
    expect(r.markdown).toContain("_a caption_")
    expect(r.markdown).not.toContain("__a caption__")
  })

  it("omits the caption line when the caption is only whitespace", () => {
    const r = walk(doc([{
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { id: "m1", url: "https://x.test/d.png" } },
        { type: "caption", content: [{ type: "text", text: "   " }] }
      ]
    }]))
    expect(r.markdown).toContain("![](https://x.test/d.png)")
    expect(r.markdown).not.toContain("_")
  })

  it("never renders a caption as the media when the media child is missing", () => {
    const r = walk(doc([{
      type: "mediaSingle",
      content: [{ type: "caption", content: [{ type: "text", text: "orphan" }] }]
    }]))
    expect(r.markdown).toContain("<!-- adf:media id= -->")
    expect(r.markdown).toContain("_orphan_")
  })

  it("preserves note and success panel types", () => {
    const r = walk(doc([
      {
        type: "panel",
        attrs: { panelType: "note" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "n" }] }]
      },
      {
        type: "panel",
        attrs: { panelType: "success" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "s" }] }]
      }
    ]))
    expect(r.markdown).toContain(`<!-- adf:panel type=note attrs=${stableStringify({ panelType: "note" })} -->`)
    expect(r.markdown).toContain(
      `<!-- adf:panel type=success attrs=${stableStringify({ panelType: "success" })} -->`
    )
  })

  it("ends output with exactly one newline", () => {
    const r = walk(doc([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]))
    expect(r.markdown.endsWith("\n")).toBe(true)
    expect(r.markdown.endsWith("\n\n")).toBe(false)
  })
})
