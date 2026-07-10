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
import { externalizeAdfMetadata, hydrateAdfMetadata } from "../src/internal/adfMetadata.js"
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const contentOf = (value: unknown): ReadonlyArray<unknown> => {
  if (!isRecord(value) || !Array.isArray(value["content"])) {
    throw new Error("Expected ADF node with content array")
  }
  return value["content"]
}

const parsedContent = (json: string): ReadonlyArray<unknown> => contentOf(JSON.parse(json))

const nodeType = (value: unknown): string | null => {
  if (!isRecord(value)) return null
  const type = value["type"]
  return typeof type === "string" ? type : null
}

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

  it.effect("round-trips code-block custom width and attrs as native ADF", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "codeBlock",
          attrs: { language: "ts", uniqueId: "code-1", wrap: true, hideLineNumbers: true },
          marks: [{ type: "breakout", attrs: { mode: "wide", width: 760 } }],
          content: [{ type: "text", text: "const x: number = 1" }]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      expect(md).toContain("```ts")
      expect(md).toContain("const x: number = 1")

      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips metadata-bearing code blocks containing bracket text", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "codeBlock",
          attrs: { language: "json", localId: "14686791bf5e" },
          marks: [{ type: "breakout", attrs: { mode: "wide", width: 1011 } }],
          content: [{
            type: "text",
            text: "{\n  \"mentions\": [\"[Add Engineer]\", \"[Add Reviewer]\"],\n  \"supportsADF\": true\n}"
          }]
        }]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("pushes legacy escaped raw code-block metadata markers as native ADF", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const codeBlock = {
        type: "codeBlock",
        attrs: { language: "json", localId: "14686791bf5e" },
        marks: [{ type: "breakout", attrs: { mode: "wide", width: 1011 } }],
        content: [{
          type: "text",
          text: "{\n  \"mentions\": [\"[Add Engineer]\", \"[Add Reviewer]\"],\n  \"supportsADF\": true\n}"
        }]
      }
      const codeText = codeBlock.content[0]?.text ?? ""
      const legacyMarkdown = [
        `\\<!-- adf:codeBlock node=${JSON.stringify(codeBlock)} -->`,
        "",
        "```json",
        codeText,
        "```",
        "",
        "\\<!-- adf:/codeBlock -->"
      ].join("\n")
      const content = parsedContent(yield* converter.markdownToAdf(legacyMarkdown))
      expect(content[0]).toEqual(codeBlock)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("hydrated table whose cell text contains `<` pushes to a single table (no junk paragraph)", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      // A cell whose text contains `<` (here the real idp `<!DOCTYPE` symptom):
      // when the sidecar blob is hydrated as raw JSON, the @atlaskit markdown
      // parser reads the `<` as an HTML tag and splits the placeholder comment
      // across inline nodes, so the reverter can't match it — the marker used to
      // survive as a literal junk paragraph *alongside* the real table.
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Alert" }] }]
            }]
          },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` }]
              }]
            }]
          }
        ]
      }
      // Emulate the sync path: pull → externalize to sidecar+ref, push → hydrate.
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const hydrated = hydrateAdfMetadata(markdown, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      // no leftover placeholder text survives as a literal paragraph
      expect(JSON.stringify(content)).not.toContain("adf:table node=")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: the sidecar table node used to be authoritative on push, so any
  // edit the user made to a Markdown table cell was silently discarded. The GFM
  // table's content must now win, while the sidecar's attrs are preserved.
  it.effect("honors an edited table cell on push while preserving sidecar attrs", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "wide", localId: "tbl-1" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colwidth: [200] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Head" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#eeeeee" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "OldCell" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          }
        ]
      }
      // Sync path: pull → externalize (node → sidecar+ref) → edit md → hydrate → push.
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("OldCell", "NewCell")
      expect(edited).toContain("NewCell")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const pushed = content[0]
      // The user's new cell text reaches the pushed ADF; the stale sidecar text does not.
      expect(JSON.stringify(pushed)).toContain("NewCell")
      expect(JSON.stringify(pushed)).not.toContain("OldCell")
      // Attrs the human can't express in GFM survive from the sidecar node.
      if (!isRecord(pushed)) throw new Error("expected table node")
      expect(pushed["attrs"]).toEqual({ layout: "wide", localId: "tbl-1" })
      const rows = contentOf(pushed)
      const headerCell = contentOf(rows[0])[0]
      if (!isRecord(headerCell)) throw new Error("expected header cell")
      expect(headerCell["attrs"]).toEqual({ colwidth: [200] })
      const editedCell = contentOf(rows[1])[0]
      if (!isRecord(editedCell)) throw new Error("expected edited cell")
      expect(editedCell["attrs"]).toEqual({ background: "#eeeeee" })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("honors a row added to a table via GFM on push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              },
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Append a new row line right after the existing body row.
      const edited = markdown.replace("| 1 | 2 |", "| 1 | 2 |\n| 3 | 4 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      expect(JSON.stringify(rows[2])).toContain("3")
      expect(JSON.stringify(rows[2])).toContain("4")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("honors a row removed from a table via GFM on push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "keep1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "keep2" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "drop1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "drop2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Drop the last body row (and the newline that precedes it).
      const edited = markdown.replace("\n| drop1 | drop2 |", "")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(2)
      expect(JSON.stringify(content)).not.toContain("drop1")
      expect(JSON.stringify(content)).not.toContain("drop2")
    }).pipe(Effect.provide(TestLayer)))

  // Safety: a merged-cell table can't be aligned to the flat GFM grid, so the
  // merge must bail and leave the sidecar node untouched — no crash, no
  // corruption, and the GFM edit is documented-lossy for such tables.
  it.effect("falls back to the sidecar node for a merged-cell table", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colspan: 2 },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Spanning" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              },
              { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Attempt to edit a cell; the merged-cell table must ignore it.
      const edited = markdown.replace("| a |", "| EDITED |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      // The edit is discarded; the authoritative sidecar node wins unchanged.
      expect(JSON.stringify(content)).not.toContain("EDITED")
      expect(JSON.stringify(content)).toContain("Spanning")
      const rows = contentOf(content[0])
      const spanningCell = contentOf(rows[0])[0]
      if (!isRecord(spanningCell)) throw new Error("expected spanning cell")
      expect(spanningCell["attrs"]).toEqual({ colspan: 2 })
    }).pipe(Effect.provide(TestLayer)))

  // A row inserted mid-table shifts every subsequent index, so a naive
  // positional merge would move row/cell attrs (backgrounds, localIds, …)
  // onto the wrong content. Fingerprint alignment must keep the attrs with
  // their original rows and slot the new row in without a sidecar counterpart.
  it.effect("honors a row inserted mid-table and keeps attrs with their rows", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "styled" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Insert a new row *before* the styled row.
      const edited = markdown.replace("| styled |", "| inserted |\n| styled |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      expect(JSON.stringify(rows[1])).toContain("inserted")
      // The styled background stays with the "styled" row, now shifted down.
      const styledCell = contentOf(rows[2])[0]
      if (!isRecord(styledCell)) throw new Error("expected styled cell")
      expect(styledCell["attrs"]).toEqual({ background: "#ffcccc" })
      expect(JSON.stringify(styledCell)).toContain("styled")
      const insertedCell = contentOf(rows[1])[0]
      if (!isRecord(insertedCell)) throw new Error("expected inserted cell")
      expect(insertedCell["attrs"] ?? {}).toEqual({})
    }).pipe(Effect.provide(TestLayer)))

  // A column inserted before the end shifts cell attrs and header-vs-cell
  // identity, so a naive positional merge would move them onto the wrong
  // Markdown content. Fingerprint alignment must keep each column's attrs
  // with its original content.
  it.effect("honors a column inserted mid-table and keeps attrs with their columns", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              },
              {
                type: "tableCell",
                attrs: { background: "#ccffcc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Insert a new first column on every line of the table.
      const edited = markdown
        .replace("| A | B |", "| New | A | B |")
        .replace("| --- | --- |", "| --- | --- | --- |")
        .replace("| 1 | 2 |", "| n | 1 | 2 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      const headerCells = contentOf(rows[0])
      expect(headerCells).toHaveLength(3)
      expect(JSON.stringify(headerCells[0])).toContain("New")
      const cells = contentOf(rows[1])
      expect(cells).toHaveLength(3)
      // The highlight stays with the "2" column, now shifted right.
      const highlighted = cells[2]
      if (!isRecord(highlighted)) throw new Error("expected highlighted cell")
      expect(highlighted["attrs"]).toEqual({ background: "#ccffcc" })
      expect(JSON.stringify(highlighted)).toContain("2")
      const insertedCell = cells[0]
      if (!isRecord(insertedCell)) throw new Error("expected inserted cell")
      expect(JSON.stringify(insertedCell)).toContain("n")
      expect(insertedCell["attrs"] ?? {}).toEqual({})
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a cell edit combined with a tail row append used to make the
  // fingerprint check bail and drop both otherwise-supported changes. The
  // overlap pairs by index (edits allowed) and the surplus row appends.
  it.effect("honors a cell edit combined with a tail row append in one push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#eeeeee" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("| old | 2 |", "| new | 2 |\n| 3 | 4 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const editedCell = contentOf(rows[1])[0]
      if (!isRecord(editedCell)) throw new Error("expected edited cell")
      expect(JSON.stringify(editedCell)).toContain("new")
      expect(editedCell["attrs"]).toEqual({ background: "#eeeeee" })
      expect(JSON.stringify(rows[2])).toContain("3")
      expect(JSON.stringify(content)).not.toContain("old")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: same for columns — an edit plus a trailing column append
  // must merge instead of dropping both changes.
  it.effect("honors a cell edit combined with a tail column append in one push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colwidth: [150] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown
        .replace("| A | B |", "| A | B | C |")
        .replace("| --- | --- |", "| --- | --- | --- |")
        .replace("| 1 | 2 |", "| 1x | 2 | 3 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const headerCells = contentOf(rows[0])
      expect(headerCells).toHaveLength(3)
      const firstHeader = headerCells[0]
      if (!isRecord(firstHeader)) throw new Error("expected header cell")
      expect(firstHeader["attrs"]).toEqual({ colwidth: [150] })
      const bodyCells = contentOf(rows[1])
      expect(JSON.stringify(bodyCells[0])).toContain("1x")
      expect(JSON.stringify(bodyCells[2])).toContain("3")
    }).pipe(Effect.provide(TestLayer)))

  // Safety: rows whose text is identical can't be told apart, so an insert
  // into the run has several equally plausible alignments — each assigning
  // backgrounds/localIds differently. The merge must refuse to guess.
  it.effect("falls back to the sidecar when a row is inserted into duplicate-text rows", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "dup" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "dup" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Insert another identical-looking row before the duplicates.
      const edited = markdown.replace("| dup |\n| dup |", "| dup |\n| dup |\n| dup |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      // Ambiguous alignment — the sidecar node wins unchanged.
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const first = contentOf(rows[1])[0]
      const second = contentOf(rows[2])[0]
      if (!isRecord(first) || !isRecord(second)) throw new Error("expected cells")
      expect(first["attrs"]).toEqual({ background: "#ffcccc" })
      expect(second["attrs"]).toEqual({ background: "#ccccff" })
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a same-size reorder used to be merged positionally, pushing
  // the moved content under the original positions' attrs. Fingerprint
  // alignment must let attrs travel with the moved rows.
  it.effect("keeps row attrs with their content when rows are reordered", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("| first |\n| second |", "| second |\n| first |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const nowFirst = contentOf(rows[1])[0]
      const nowSecond = contentOf(rows[2])[0]
      if (!isRecord(nowFirst) || !isRecord(nowSecond)) throw new Error("expected cells")
      // Each background moved together with its text.
      expect(JSON.stringify(nowFirst)).toContain("second")
      expect(nowFirst["attrs"]).toEqual({ background: "#ccccff" })
      expect(JSON.stringify(nowSecond)).toContain("first")
      expect(nowSecond["attrs"]).toEqual({ background: "#ffcccc" })
    }).pipe(Effect.provide(TestLayer)))

  // Safety: a reorder combined with an edit is ambiguous (an edited row is
  // indistinguishable from a moved-and-edited row) — the merge must bail.
  it.effect("falls back to the sidecar when a reorder is combined with an edit", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Move "second" up and edit the other row in the same push.
      const edited = markdown.replace("| first |\n| second |", "| second |\n| first-edited |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      // Ambiguous — the sidecar wins unchanged.
      expect(JSON.stringify(content)).not.toContain("first-edited")
      const rows = contentOf(content[0])
      expect(JSON.stringify(contentOf(rows[1])[0])).toContain("first")
    }).pipe(Effect.provide(TestLayer)))

  // Safety: reordering both axes at once is invisible to per-axis
  // fingerprints (each row fp embeds the old column order and vice versa), so
  // a positional merge would leave every per-cell attr at its old coordinate.
  // The merge must detect the moved-but-unedited grid and bail.
  it.effect("falls back to the sidecar when rows and columns are reordered together", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }]
              },
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap both rows and both columns: a→d position, d→a position.
      const edited = markdown.replace("| a | b |\n| c | d |", "| d | c |\n| b | a |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      // Ambiguous — the sidecar wins unchanged, backgrounds stay with a and d.
      const rows = contentOf(content[0])
      const cellA = contentOf(rows[0])[0]
      const cellD = contentOf(rows[1])[1]
      if (!isRecord(cellA) || !isRecord(cellD)) throw new Error("expected cells")
      expect(JSON.stringify(cellA)).toContain("a")
      expect(cellA["attrs"]).toEqual({ background: "#ffcccc" })
      expect(JSON.stringify(cellD)).toContain("d")
      expect(cellD["attrs"]).toEqual({ background: "#ccccff" })
    }).pipe(Effect.provide(TestLayer)))

  // Safety: distinct status lozenges carry their visible content in attrs,
  // not text nodes — the fingerprint must not collapse them to the same empty
  // string, or a reorder of status-only rows would look like "unchanged" and
  // keep each row's attrs at its old position.
  it.effect("keeps row attrs with their content when status-only rows are reordered", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "State" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccffcc" },
                content: [{
                  type: "paragraph",
                  content: [{ type: "status", attrs: { text: "DONE", color: "green" } }]
                }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{
                  type: "paragraph",
                  content: [{ type: "status", attrs: { text: "BLOCKED", color: "red" } }]
                }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const doneRow = markdown.split("\n").find((line) => line.includes("DONE"))
      const blockedRow = markdown.split("\n").find((line) => line.includes("BLOCKED"))
      if (!doneRow || !blockedRow) throw new Error("expected status rows in markdown")
      const edited = markdown.replace(`${doneRow}\n${blockedRow}`, `${blockedRow}\n${doneRow}`)
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const nowFirst = contentOf(rows[1])[0]
      const nowSecond = contentOf(rows[2])[0]
      if (!isRecord(nowFirst) || !isRecord(nowSecond)) throw new Error("expected cells")
      // Whatever the merge decided, the red background must stay with BLOCKED
      // and the green one with DONE — never crossed.
      const first = JSON.stringify(nowFirst)
      const second = JSON.stringify(nowSecond)
      if (first.includes("BLOCKED")) {
        expect(nowFirst["attrs"]).toEqual({ background: "#ffcccc" })
        expect(second).toContain("DONE")
        expect(nowSecond["attrs"]).toEqual({ background: "#ccffcc" })
      } else {
        expect(first).toContain("DONE")
        expect(nowFirst["attrs"]).toEqual({ background: "#ccffcc" })
        expect(second).toContain("BLOCKED")
        expect(nowSecond["attrs"]).toEqual({ background: "#ffcccc" })
      }
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: with a row appended, the extra row used to be folded into
  // the column fingerprints, so a simultaneous column swap looked like
  // in-place edits and kept column attrs at their old positions. Column
  // identity must be judged on the rows both tables share.
  it.effect("honors a column swap combined with a row append in one push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colwidth: [111] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: { colwidth: [222] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap the columns and append a row in the same push.
      const edited = markdown
        .replace("| A | B |", "| B | A |")
        .replace("| 1 | 2 |", "| 2 | 1 |\n| y | x |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const headerCells = contentOf(rows[0])
      const nowFirstHeader = headerCells[0]
      const nowSecondHeader = headerCells[1]
      if (!isRecord(nowFirstHeader) || !isRecord(nowSecondHeader)) throw new Error("expected header cells")
      // Each colwidth travelled with its column content.
      expect(JSON.stringify(nowFirstHeader)).toContain("B")
      expect(nowFirstHeader["attrs"]).toEqual({ colwidth: [222] })
      expect(JSON.stringify(nowSecondHeader)).toContain("A")
      expect(nowSecondHeader["attrs"]).toEqual({ colwidth: [111] })
      expect(JSON.stringify(rows[2])).toContain("y")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: with a column appended, the extra column used to be folded
  // into the row fingerprints, so a simultaneous row swap looked like
  // in-place edits and kept row attrs at their old positions. Row identity
  // must be judged on the columns both tables share.
  it.effect("honors a row swap combined with a column append in one push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap the two data rows and append a new column in the same push.
      const edited = markdown
        .replace("| H |", "| H | N |")
        .replace("| --- |", "| --- | --- |")
        .replace("| first |\n| second |", "| second | s2 |\n| first | s1 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const nowFirst = contentOf(rows[1])[0]
      const nowSecond = contentOf(rows[2])[0]
      if (!isRecord(nowFirst) || !isRecord(nowSecond)) throw new Error("expected cells")
      // Each background travelled with its row; the new column is present.
      expect(JSON.stringify(nowFirst)).toContain("second")
      expect(nowFirst["attrs"]).toEqual({ background: "#ccccff" })
      expect(JSON.stringify(nowSecond)).toContain("first")
      expect(nowSecond["attrs"]).toEqual({ background: "#ffcccc" })
      expect(contentOf(rows[1])).toHaveLength(2)
      expect(JSON.stringify(contentOf(rows[1])[1])).toContain("s2")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a two-axis reorder that also edits a moved cell used to
  // slip past the pure-reorder guard (the multiset is no longer identical).
  // Mismatched cells whose text is conserved elsewhere in the grid mark a
  // move, not an edit — when they dominate, the merge must refuse to guess.
  it.effect("falls back to the sidecar when a two-axis reorder includes an edit", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }]
              },
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap both axes AND edit the moved d cell.
      const edited = markdown.replace("| a | b |\n| c | d |", "| dX | c |\n| b | a |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      // Ambiguous — the sidecar wins unchanged.
      expect(JSON.stringify(content)).not.toContain("dX")
      const rows = contentOf(content[0])
      const cellA = contentOf(rows[0])[0]
      if (!isRecord(cellA)) throw new Error("expected cell")
      expect(JSON.stringify(cellA)).toContain("a")
      expect(cellA["attrs"]).toEqual({ background: "#ffcccc" })
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: editing cells to values that already exist elsewhere in
  // the table (copying) must not be mistaken for a reorder — the copied
  // value's source cell still matches at its own position, so nothing was
  // vacated and the edits merge normally.
  it.effect("honors edits that duplicate existing cell values", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "D" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Overwrite A with B's value and C with D's value — plain edits.
      const edited = markdown.replace("| A | B |\n| C | D |", "| B | B |\n| D | D |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const firstCell = contentOf(rows[0])[0]
      if (!isRecord(firstCell)) throw new Error("expected cell")
      // The edits landed and the cell kept its own attrs.
      expect(JSON.stringify(firstCell)).toContain("B")
      expect(firstCell["attrs"]).toEqual({ background: "#ffcccc" })
      expect(JSON.stringify(content)).not.toContain("\"text\":\"A\"")
      expect(JSON.stringify(contentOf(rows[1])[0])).toContain("D")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a two-axis reorder where the moved cells are also edited
  // (novel texts tie the moved ones) must still bail — the surviving moved
  // cells' sources are vacated, which copy-edits never produce.
  it.effect("falls back when a two-axis reorder edits enough cells to tie the counts", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }]
              },
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap both axes and edit both top cells: b and a survive as moved.
      const edited = markdown.replace("| a | b |\n| c | d |", "| dX | cX |\n| b | a |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      // Ambiguous — the sidecar wins unchanged.
      expect(JSON.stringify(content)).not.toContain("dX")
      const rows = contentOf(content[0])
      const cellA = contentOf(rows[0])[0]
      if (!isRecord(cellA)) throw new Error("expected cell")
      expect(JSON.stringify(cellA)).toContain("a")
      expect(cellA["attrs"]).toEqual({ background: "#ffcccc" })
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: `foo` and `**foo**` used to share a fingerprint, so
  // reordering them looked like "unchanged" and each row's attrs stuck to its
  // old position. Marks are part of the fingerprint now, making the reorder
  // visible so attrs travel with the moved rows.
  it.effect("keeps row attrs with their content when formatting-only twins are reordered", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "foo" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{
                  type: "paragraph",
                  content: [{ type: "text", text: "foo", marks: [{ type: "strong" }] }]
                }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("| foo |\n| **foo** |", "| **foo** |\n| foo |")
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const nowFirst = contentOf(rows[1])[0]
      const nowSecond = contentOf(rows[2])[0]
      if (!isRecord(nowFirst) || !isRecord(nowSecond)) throw new Error("expected cells")
      // The bold row moved up and brought its background along.
      expect(JSON.stringify(nowFirst)).toContain("strong")
      expect(nowFirst["attrs"]).toEqual({ background: "#ccccff" })
      expect(JSON.stringify(nowSecond)).not.toContain("strong")
      expect(nowSecond["attrs"]).toEqual({ background: "#ffcccc" })
    }).pipe(Effect.provide(TestLayer)))

  // Safety: when one copy of a duplicate row stays anchored and another
  // moves, either copy could be the moved one — each choice assigns the
  // duplicates' attrs differently. The merge must refuse to guess.
  it.effect("falls back to the sidecar when a duplicate row moves past an anchored twin", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "dup" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "dup" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccffcc" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // dup, dup, x → dup, x, dup: either dup could be the one that moved.
      const edited = markdown.replace("| dup |\n| dup |\n| x |", "| dup |\n| x |\n| dup |")
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      // Ambiguous — the sidecar wins unchanged.
      expect(rows).toHaveLength(3)
      const middle = contentOf(rows[1])[0]
      if (!isRecord(middle)) throw new Error("expected cell")
      expect(JSON.stringify(middle)).toContain("dup")
      expect(middle["attrs"]).toEqual({ background: "#ccccff" })
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: GFM can't express a header *column*, so a row appended in
  // Markdown parses its first cell as a plain tableCell. When every sidecar
  // row carries a tableHeader in that column, the inserted row must regain it.
  it.effect("restores header-column identity on a row appended via GFM", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "r1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "r2" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("| r2 | b |", "| r2 | b |\n| r3 | c |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      const newFirstCell = contentOf(rows[2])[0]
      const newSecondCell = contentOf(rows[2])[1]
      if (!isRecord(newFirstCell) || !isRecord(newSecondCell)) throw new Error("expected cells")
      expect(JSON.stringify(newFirstCell)).toContain("r3")
      // The header column keeps its identity; the body column stays a cell.
      expect(newFirstCell["type"]).toBe("tableHeader")
      expect(newSecondCell["type"]).toBe("tableCell")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: hardBreaks are emitted as literal `<br>` and come back as
  // plain text — such cells must stay sidecar-authoritative or a no-op push
  // rewrites the cell body.
  it.effect("round-trips a hardBreak cell unchanged on a no-op push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const breakCell = {
        type: "tableCell",
        attrs: {},
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" }
          ]
        }]
      }
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              attrs: {},
              content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }]
            }]
          },
          { type: "tableRow", content: [breakCell] }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const hydrated = hydrateAdfMetadata(markdown, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      // The hardBreak structure survives; no literal "<br>" text appears.
      expect(contentOf(rows[1])[0]).toEqual(breakCell)
      expect(JSON.stringify(content)).not.toContain("<br>")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a lossy (multi-block) cell can never fingerprint-match its
  // flattened GFM copy, so a row inserted before it used to be mapped onto
  // the lossy row — swallowing the inserted content into the sidecar body.
  // Structural changes on tables with lossy cells must fall back.
  it.effect("falls back when a row is inserted into a table with a multi-block cell", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const complexCell = {
        type: "tableCell",
        attrs: {},
        content: [
          { type: "paragraph", content: [{ type: "text", text: "para one" }] },
          { type: "paragraph", content: [{ type: "text", text: "para two" }] }
        ]
      }
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              attrs: {},
              content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }]
            }]
          },
          { type: "tableRow", content: [complexCell] }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Insert a row before the complex row.
      const edited = markdown.replace("| para one<br>para two |", "| inserted |\n| para one<br>para two |")
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      // Ambiguous — the sidecar wins unchanged; nothing is swallowed.
      expect(rows).toHaveLength(2)
      expect(JSON.stringify(content)).not.toContain("inserted")
      expect(contentOf(rows[1])[0]).toEqual(complexCell)
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a column swap plus a mid-table row insert used to pass the
  // row aligner positionally (the swapped columns make every row fingerprint
  // look edited), gluing old attrs onto the wrong rows. The moved-cells guard
  // over the mapped overlap must catch it.
  it.effect("falls back when a column swap is combined with a mid-table row insert", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colwidth: [111] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: { colwidth: [222] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Swap the columns and insert a row before the data row.
      const edited = markdown
        .replace("| A | B |", "| B | A |")
        .replace("| 1 | 2 |", "| ins1 | ins2 |\n| 2 | 1 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      // Ambiguous — the sidecar wins unchanged, colwidths stay put.
      expect(rows).toHaveLength(2)
      expect(JSON.stringify(content)).not.toContain("ins1")
      const firstHeader = contentOf(rows[0])[0]
      if (!isRecord(firstHeader)) throw new Error("expected header cell")
      expect(JSON.stringify(firstHeader)).toContain("A")
      expect(firstHeader["attrs"]).toEqual({ colwidth: [111] })
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: swapping rows that carry lossy (multi-block) cells must not
  // produce hybrid rows (old lossy body + moved simple text). The moved-cells
  // guard sees the swapped simple cells land in vacated positions and bails.
  it.effect("falls back when rows containing lossy cells are swapped", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ffcccc" },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "one-a" }] },
                  { type: "paragraph", content: [{ type: "text", text: "one-b" }] }
                ]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "simple1" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { background: "#ccccff" },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "two-a" }] },
                  { type: "paragraph", content: [{ type: "text", text: "two-b" }] }
                ]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "simple2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const rowOne = markdown.split("\n").find((line) => line.includes("simple1"))
      const rowTwo = markdown.split("\n").find((line) => line.includes("simple2"))
      if (!rowOne || !rowTwo) throw new Error("expected both data rows in markdown")
      const edited = markdown.replace(`${rowOne}\n${rowTwo}`, `${rowTwo}\n${rowOne}`)
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      // Ambiguous — the sidecar wins unchanged; no hybrid rows.
      const firstData = contentOf(rows[1])[0]
      if (!isRecord(firstData)) throw new Error("expected cell")
      expect(JSON.stringify(firstData)).toContain("one-a")
      expect(firstData["attrs"]).toEqual({ background: "#ffcccc" })
      expect(JSON.stringify(contentOf(rows[1])[1])).toContain("simple1")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a header-only table has no body rows to testify to a
  // header *column*, so the first data row added via Markdown must keep its
  // plain tableCell identity instead of being rewritten into headers.
  it.effect("keeps body-cell identity for the first row added to a header-only table", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("| --- | --- |", "| --- | --- |\n| 1 | 2 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(2)
      const newCells = contentOf(rows[1])
      const firstNew = newCells[0]
      const secondNew = newCells[1]
      if (!isRecord(firstNew) || !isRecord(secondNew)) throw new Error("expected cells")
      expect(firstNew["type"]).toBe("tableCell")
      expect(secondNew["type"]).toBe("tableCell")
      expect(JSON.stringify(rows[1])).toContain("1")
    }).pipe(Effect.provide(TestLayer)))

  // Codex review: a blank line inside the table marker splits the GFM table
  // into two fragments. Merging only the first fragment would silently drop
  // every row after the blank line — the merge must fall back instead.
  it.effect("falls back when a blank line splits the table inside its marker", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              attrs: {},
              content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }]
            }]
          },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              attrs: {},
              content: [{ type: "paragraph", content: [{ type: "text", text: "keepA" }] }]
            }]
          },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              attrs: {},
              content: [{ type: "paragraph", content: [{ type: "text", text: "keepB" }] }]
            }]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Accidentally split the table with a blank line before the last row.
      const edited = markdown.replace("\n| keepB |", "\n\n| keepB |")
      expect(edited).not.toBe(markdown)
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      // Nothing after the blank line is lost — the sidecar wins unchanged.
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(3)
      expect(JSON.stringify(content)).toContain("keepA")
      expect(JSON.stringify(content)).toContain("keepB")
    }).pipe(Effect.provide(TestLayer)))

  // Safety: the walker pads a ragged (non-rectangular) table with empty cells
  // so it can be shown as GFM. Merging that padded grid back would add cells
  // the sidecar never had, mutating the table on a no-op push — the merge
  // must fall back to the authoritative sidecar node instead.
  it.effect("round-trips a ragged table unchanged on a no-op push", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "Wide" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const hydrated = hydrateAdfMetadata(markdown, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      // No padded empty cell sneaks into the one-cell first row.
      expect(content[0]).toEqual(table)
    }).pipe(Effect.provide(TestLayer)))

  // A column appended at the tail leaves every existing index intact, so it
  // merges cleanly: existing cells keep their attrs, the new cells are used
  // verbatim.
  it.effect("honors a column appended at the tail of a table", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colwidth: [120] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown
        .replace("| A |", "| A | B |")
        .replace("| --- |", "| --- | --- |")
        .replace("| 1 |", "| 1 | 2 |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const headerCells = contentOf(rows[0])
      expect(headerCells).toHaveLength(2)
      const firstHeader = headerCells[0]
      if (!isRecord(firstHeader)) throw new Error("expected header cell")
      expect(firstHeader["attrs"]).toEqual({ colwidth: [120] })
      expect(JSON.stringify(headerCells[1])).toContain("B")
      expect(JSON.stringify(contentOf(rows[1])[1])).toContain("2")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: a headerless table is emitted with a synthetic empty GFM
  // header row (Markdown tables require one). The merge used to align that
  // synthetic row with the sidecar's first *data* row, blanking it and
  // shifting every row down by one on an unchanged push.
  it.effect("round-trips a headerless table without blanking or shifting rows", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "first1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "first2" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "second1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "second2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // Edit a cell in the second row; the synthetic header must not consume a row.
      const edited = markdown.replace("second1", "EDITED")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(2)
      const firstCell = contentOf(rows[0])[0]
      if (!isRecord(firstCell)) throw new Error("expected first cell")
      // The first data row keeps its identity and text — not blanked into a header.
      expect(firstCell["type"]).toBe("tableCell")
      expect(JSON.stringify(rows[0])).toContain("first1")
      expect(JSON.stringify(rows[1])).toContain("EDITED")
      expect(JSON.stringify(content)).not.toContain("second1")
    }).pipe(Effect.provide(TestLayer)))

  // Safety: text typed into the synthetic header row of a headerless table has
  // no sidecar row to merge with — the merge must bail to the sidecar node
  // rather than shift every row's attrs off by one.
  it.effect("falls back to the sidecar when text is typed into a synthetic header row", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "only1" }] }]
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "only2" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      // The emitted table starts with an all-empty header row; type into it.
      expect(markdown).toContain("|  |")
      const edited = markdown.replace("|  |", "| NewHeader |")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      expect(JSON.stringify(content)).not.toContain("NewHeader")
      const rows = contentOf(content[0])
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows[0])).toContain("only1")
    }).pipe(Effect.provide(TestLayer)))

  // Regression: a cell body richer than one paragraph is flattened to
  // <br>-joined Markdown on pull, so the GFM-parsed cell is a degraded copy.
  // The merge used to adopt that degraded copy even on an unchanged push,
  // collapsing the block structure. The sidecar body must stay authoritative
  // for such cells while simple cells in the same table remain editable.
  it.effect("keeps the sidecar body for a multi-block cell while honoring simple-cell edits", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const complexCell = {
        type: "tableCell",
        attrs: {},
        content: [
          { type: "paragraph", content: [{ type: "text", text: "para one" }] },
          { type: "paragraph", content: [{ type: "text", text: "para two" }] }
        ]
      }
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              complexCell,
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "simple" }] }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("simple", "EDITED")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      expect(content.filter((n) => nodeType(n) === "table")).toHaveLength(1)
      const rows = contentOf(content[0])
      const pushedComplex = contentOf(rows[1])[0]
      // The two-paragraph body survives untouched — no <br>/hardBreak collapse.
      expect(pushedComplex).toEqual(complexCell)
      expect(JSON.stringify(rows[1])).toContain("EDITED")
    }).pipe(Effect.provide(TestLayer)))

  // Paragraph-level attrs/marks can't be expressed in a GFM cell; when the
  // cell still parses back as a single paragraph they must be grafted onto
  // the edited content rather than dropped.
  it.effect("keeps paragraph attrs on an edited single-paragraph cell", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const table = {
        type: "table",
        attrs: { layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }]
              }
            ]
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [{
                  type: "paragraph",
                  attrs: { localId: "para-1" },
                  content: [{ type: "text", text: "OldText" }]
                }]
              }
            ]
          }
        ]
      }
      const md = yield* converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: [table] }))
      const { markdown, sidecar } = externalizeAdfMetadata(md, "./page.adf.json")
      const edited = markdown.replace("OldText", "NewText")
      const hydrated = hydrateAdfMetadata(edited, new Map([["./page.adf.json", sidecar!]]))

      const content = parsedContent(yield* converter.markdownToAdf(hydrated))
      const rows = contentOf(content[0])
      const cell = contentOf(rows[1])[0]
      const para = contentOf(cell)[0]
      if (!isRecord(para)) throw new Error("expected paragraph")
      expect(para["attrs"]).toEqual({ localId: "para-1" })
      expect(JSON.stringify(para)).toContain("NewText")
      expect(JSON.stringify(content)).not.toContain("OldText")
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

  it.effect("upgrades a legacy generic block extension placeholder to the attrs form, then stays fixed", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(
        `<!-- adf:extension key=anchor type=com.atlassian.confluence.macro.core -->\n`
      )
      expect(md).toContain("<!-- adf:extension key=anchor type=com.atlassian.confluence.macro.core attrs=")
      const again = yield* roundTrip(md)
      expect(again).toBe(md)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips native TOC syntax as a fixed point", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip("[[toc:min=2,max=4]]\n")
      expect(md).toContain("[[toc:min=2,max=4]]")
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual({ type: "extension", attrs })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips Confluence TOC macroMetadata through the placeholder attrs blob", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const attrs = {
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
      const md = yield* converter.adfToMarkdown(JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "extension", attrs }]
      }))
      expect(md).toContain("<!-- adf:extension key=toc type=com.atlassian.confluence.macro.core attrs=")
      expect(md).not.toContain("[[toc")
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual({ type: "extension", attrs })
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content).toHaveLength(1)
      expect(content[0]).toMatchObject({ type: "bodiedExtension", attrs })
      expect(contentOf(content[0])).toEqual([
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual({
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content).toEqual(source.content)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("round-trips media identity behind visible Markdown image previews", () =>
    Effect.gen(function*() {
      const converter = yield* MarkdownConverter
      const source = {
        version: 1,
        type: "doc",
        content: [{
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{
            type: "media",
            attrs: {
              id: "file-id-1",
              type: "file",
              collection: "contentId-123",
              alt: "diagram",
              url: "https://example.atlassian.net/wiki/download/attachments/123/diagram.svg"
            }
          }]
        }]
      }
      const expected = {
        ...source,
        content: [{
          ...source.content[0],
          content: [{
            type: "media",
            attrs: {
              id: "file-id-1",
              type: "file",
              collection: "contentId-123",
              alt: "diagram"
            }
          }]
        }]
      }

      const md = yield* converter.adfToMarkdown(JSON.stringify(source))
      expect(md).toContain("![diagram](https://example.atlassian.net/wiki/download/attachments/123/diagram.svg)")
      expect(md).toContain("<!-- adf:mediaSingle node=")
      const adfOutContent = parsedContent(yield* converter.markdownToAdf(md))
      expect(adfOutContent).toEqual(expected.content)
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content[0]).toEqual(source.content[0])
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content).toEqual(source.content)
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
      const adfContent = parsedContent(yield* converter.markdownToAdf(source))
      expect(contentOf(adfContent[0]).some((node) => nodeType(node) === "status")).toBe(false)
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(content.map(nodeType)).toEqual(["paragraph", "paragraph", "paragraph"])
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
      const content = parsedContent(yield* converter.markdownToAdf(md))
      expect(nodeType(content[0])).toBe("bodiedExtension")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("preserves a mention's accountId through round-trip", () =>
    Effect.gen(function*() {
      const md = yield* roundTrip(`[@Andrey Konopkov](confluence-mention://557057%3Aabc-123)\n`)
      expect(md).toContain("[@Andrey Konopkov](confluence-mention://557057%3Aabc-123)")
    }).pipe(Effect.provide(TestLayer)))
})
