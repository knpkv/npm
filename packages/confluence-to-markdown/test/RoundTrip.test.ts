/**
 * Markdown → ADF → Markdown round-trip fidelity tests for the new pipeline.
 *
 * Replaces the structural fidelity coverage previously held by the deleted
 * `ConfluenceParser`/`MarkdownParser`/`ConversionSchema`/fixture tests. We
 * pin the *substantive* output of the round-trip (heading structure, list
 * markers, code-block fences, table layout, link/title fidelity) rather than
 * exact whitespace, since the @atlaskit transformer normalizes whitespace
 * and we don't want to over-couple to its emission.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { layer as AdfSchemaValidatorLayer } from "../src/AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../src/AtlaskitTransformers.js"
import { layer as MarkdownConverterLayer, MarkdownConverter } from "../src/MarkdownConverter.js"

const TestLayer = MarkdownConverterLayer.pipe(
  Layer.provide(AtlaskitTransformersLayer),
  Layer.provide(AdfSchemaValidatorLayer)
)

const roundTrip = (source: string) =>
  Effect.gen(function*() {
    const converter = yield* MarkdownConverter
    const adf = yield* converter.markdownToAdf(source)
    return yield* converter.adfToMarkdown(adf)
  })

describe("MarkdownConverter round-trip", () => {
  it.effect("preserves nested headings", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("# H1\n\n## H2\n\n### H3\n")
      expect(md).toContain("# H1")
      expect(md).toContain("## H2")
      expect(md).toContain("### H3")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a fenced code block with language", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("```ts\nconst x: number = 1\n```\n")
      expect(md).toContain("```ts")
      expect(md).toContain("const x: number = 1")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a blockquote", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("> a quote\n")
      expect(md).toMatch(/^> a quote/m)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a bullet list", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("- one\n- two\n- three\n")
      expect(md).toContain("- one")
      expect(md).toContain("- two")
      expect(md).toContain("- three")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves an ordered list", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("1. one\n2. two\n3. three\n")
      expect(md).toMatch(/1\. one/)
      expect(md).toMatch(/2\. two/)
      expect(md).toMatch(/3\. three/)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a GFM table with header", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("| A | B |\n| --- | --- |\n| 1 | 2 |\n")
      expect(md).toContain("| A | B |")
      expect(md).toContain("| --- | --- |")
      expect(md).toContain("| 1 | 2 |")
    }).pipe(Effect.provide(TestLayer)))

  // The @atlaskit markdown transformer drops link titles when parsing
  // markdown (its ProseMirror schema for `link` does not capture `title`).
  // So we only assert that text + href survive the round-trip; the title
  // attribute is documented as round-trip-lossy via this test's name.
  it.effect("preserves link text and href (title is lossy via @atlaskit)", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(`[home](https://example.com "Home")\n`)
      expect(md).toContain("[home]")
      expect(md).toContain("https://example.com")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves bold, italic, and inline code combinations", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("a **b** _c_ `d` text\n")
      expect(md).toContain("**b**")
      expect(md).toContain("_c_")
      expect(md).toContain("`d`")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not over-escape ordinary version strings", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("Released v1.0.0 on 2026-05-03\n")
      expect(md).toContain("v1.0.0")
      expect(md).toContain("2026-05-03")
      expect(md).not.toContain("v1\\.0\\.0")
      expect(md).not.toContain("2026\\-05\\-03")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("does not escape parentheses or other line-start-only characters", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("a (b) c+ d!\n")
      expect(md).toContain("a (b) c+ d!")
      expect(md).not.toContain("\\(")
      expect(md).not.toContain("\\+")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: escaping inside code spans put literal backslashes into the
  // ADF text, which the next pull re-escaped — doubling them on every
  // round-trip (`a_b` → `a\_b` → `a\\\_b` → …).
  it.effect("code spans with markdown-special characters are a round-trip fixed point", () =>
    Effect.gen(function*() {
      const source = "x `a_b` y `c()` (z)\n"
      const once = yield* roundTrip(source)
      const twice = yield* roundTrip(once)
      expect(once).toContain("`a_b`")
      expect(once).toContain("`c()`")
      expect(once).not.toContain("\\")
      expect(twice).toBe(once)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves an inline status placeholder through round-trip", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(
        `Status: <span class="adf-status" data-color="blue">TESTING</span>\n`
      )
      expect(md).toContain(`<span class="adf-status" data-color="blue">TESTING</span>`)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("upgrades a legacy block extension placeholder to the attrs form, then stays fixed", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(
        `<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core -->\n`
      )
      expect(md).toContain("<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=")
      const again = yield* roundTrip(md)
      expect(again).toBe(md)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips macro parameters through the placeholder attrs blob", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const attrs = {
        extensionKey: "toc",
        extensionType: "com.atlassian.confluence.macro.core",
        layout: "default",
        localId: "abc-123",
        parameters: { macroParams: { maxLevel: { value: "3" } } }
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "extension", attrs }]
      }))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as {
        content: Array<{ type: string; attrs: Record<string, unknown> }>
      }
      expect(adfOut.content[0]).toEqual({ type: "extension", attrs })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips a bodiedExtension with its body re-attached", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const attrs = { extensionKey: "details", extensionType: "com.atlassian.confluence.macro.core" }
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [{
          type: "bodiedExtension",
          attrs,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "first body paragraph" }] },
            { type: "paragraph", content: [{ type: "text", text: "second body paragraph" }] }
          ]
        }]
      }))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as {
        content: Array<{ type: string; attrs: Record<string, unknown>; content: Array<unknown> }>
      }
      expect(adfOut.content).toHaveLength(1)
      expect(adfOut.content[0]).toMatchObject({ type: "bodiedExtension", attrs })
      expect(adfOut.content[0]!.content).toEqual([
        { type: "paragraph", content: [{ type: "text", text: "first body paragraph" }] },
        { type: "paragraph", content: [{ type: "text", text: "second body paragraph" }] }
      ])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips a Confluence panel as a panel node", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const attrs = { panelType: "warning" }
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [{
          type: "panel",
          attrs,
          content: [{ type: "paragraph", content: [{ type: "text", text: "watch this" }] }]
        }]
      }))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as {
        content: Array<{ type: string; attrs: Record<string, unknown>; content: Array<unknown> }>
      }
      expect(adfOut.content[0]).toEqual({
        type: "panel",
        attrs,
        content: [{ type: "paragraph", content: [{ type: "text", text: "watch this" }] }]
      })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips Confluence-only inline marks as native marks", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "underline", marks: [{ type: "underline" }] },
            { type: "text", text: "2", marks: [{ type: "subsup", attrs: { type: "sub" } }] },
            { type: "text", text: "2", marks: [{ type: "subsup", attrs: { type: "sup" } }] },
            { type: "text", text: "Colored", marks: [{ type: "textColor", attrs: { color: "#ff5630" } }] },
            { type: "text", text: "highlighted", marks: [{ type: "backgroundColor", attrs: { color: "#f8e6a0" } }] }
          ]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips paragraph alignment and indentation marks", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            marks: [{ type: "alignment", attrs: { align: "center" } }],
            content: [{ type: "text", text: "centered" }]
          },
          {
            type: "paragraph",
            marks: [{ type: "alignment", attrs: { align: "end" } }],
            content: [{ type: "text", text: "right" }]
          },
          {
            type: "paragraph",
            marks: [{ type: "indentation", attrs: { level: 2 } }],
            content: [{ type: "text", text: "indented" }]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content).toEqual(source.content)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips inline smart links as native inlineCard nodes", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "Inline smart link: " },
            { type: "inlineCard", attrs: { url: "https://www.atlassian.com" } },
            { type: "text", text: "." }
          ]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips task lists as native task nodes", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "taskList",
          attrs: { localId: "tasks-1" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "task-1", state: "DONE" },
              content: [{ type: "text", text: "Existing primitive coverage reviewed" }]
            },
            {
              type: "taskItem",
              attrs: { localId: "task-2", state: "TODO" },
              content: [{ type: "text", text: "Insert real @mention in editor" }]
            }
          ]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips decision lists as native decision nodes", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "decisionList",
          attrs: { localId: "decisions-1" },
          content: [{
            type: "decisionItem",
            attrs: { localId: "decision-1", state: "DECIDED" },
            content: [{ type: "text", text: "Decide whether to maintain a separate asset for advanced macros." }]
          }]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips expand, table, layout, cards, date, and emoji as native nodes", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [
          {
            type: "expand",
            attrs: { title: "Expandable supplementary content" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "This section can be expanded." }] }]
          },
          {
            type: "table",
            content: [{
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Primitive" }] }]
                },
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Example" }] }]
                }
              ]
            }, {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Date" }] }] },
                {
                  type: "tableCell",
                  content: [{
                    type: "paragraph",
                    content: [{ type: "date", attrs: { timestamp: "1782259200000" } }]
                  }]
                }
              ]
            }, {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Emoji" }] }] },
                {
                  type: "tableCell",
                  content: [{
                    type: "paragraph",
                    content: [{ type: "emoji", attrs: { shortName: ":white_check_mark:", text: "✅" } }]
                  }]
                }
              ]
            }]
          },
          {
            type: "layoutSection",
            content: [
              {
                type: "layoutColumn",
                attrs: { width: 50 },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Left column" }] }]
              },
              {
                type: "layoutColumn",
                attrs: { width: 50 },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Right column" }] }]
              }
            ]
          },
          { type: "blockCard", attrs: { url: "https://www.atlassian.com/software/confluence" } },
          { type: "embedCard", attrs: { url: "https://www.atlassian.com/software/confluence", layout: "center" } }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as typeof source
      expect(adfOut.content).toEqual(source.content)
    }).pipe(Effect.provide(TestLayer)))

  // Regression: `|` in a cell was escaped twice (escapeText + the table-cell
  // pass), emitting `\\|` — GFM reads that as literal backslash + bare pipe,
  // which opens a phantom column and breaks the row.
  it.effect("escapes a pipe inside a table cell exactly once", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("| A |\n| --- |\n| a\\|b |\n")
      expect(md).toContain("a\\|b")
      expect(md).not.toContain("a\\\\|b")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: a code fence *quoting* the placeholder syntax got structured
  // nodes injected into the codeBlock, failing outgoing schema validation.
  it.effect("does not expand placeholder-looking text inside a code fence", () =>
    Effect.gen(function*() {
      const fence = "```html\n" +
        `<span class="adf-status" data-color="blue">X</span>\n` +
        `<!-- adf:inlineExtension key=k type=t -->\n` +
        "```\n"
      const md = yield* roundTrip(fence)
      expect(md).toContain(`<span class="adf-status" data-color="blue">X</span>`)
      expect(md).toContain(`<!-- adf:inlineExtension key=k type=t -->`)
      expect(md).toContain("```html")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: the inline twin of the fence case — a code *span* quoting a
  // placeholder was replaced by a real status node, silently dropping the
  // quoted sample.
  it.effect("does not expand placeholder-looking text inside a code span", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = `Use \`<span class="adf-status" data-color="green">DONE</span>\` in docs\n`
      const adf = JSON.parse(yield* converter.markdownToAdf(source)) as {
        content: Array<{ content: Array<{ type: string }> }>
      }
      expect(adf.content[0]!.content.some((n) => n.type === "status")).toBe(false)
    }).pipe(Effect.provide(TestLayer)))

  // Regression: '# x' / '> x' / '+ x' paragraph text became real headings,
  // quotes, and lists after the ESCAPE_RE narrowing dropped those characters.
  it.effect("keeps line-start block markers in paragraph text as text", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [paragraph("# not a heading"), paragraph("> not a quote"), paragraph("+ not a list")]
      }))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as {
        content: Array<{ type: string }>
      }
      expect(adfOut.content.map((n) => n.type)).toEqual(["paragraph", "paragraph", "paragraph"])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("keeps the bodied kind for an empty-body bodied extension", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const attrs = { extensionKey: "excerpt", extensionType: "com.atlassian.confluence.macro.core" }
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "bodiedExtension", attrs, content: [{ type: "paragraph", content: [] }] }]
      }))
      const adfOut = JSON.parse(yield* converter.markdownToAdf(md)) as {
        content: Array<{ type: string }>
      }
      expect(adfOut.content[0]!.type).toBe("bodiedExtension")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a mention's accountId through round-trip", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(`[@Andrey Konopkov](confluence-mention://557057%3Aabc-123)\n`)
      expect(md).toContain("[@Andrey Konopkov](confluence-mention://557057%3Aabc-123)")
    }).pipe(Effect.provide(TestLayer)))
})
