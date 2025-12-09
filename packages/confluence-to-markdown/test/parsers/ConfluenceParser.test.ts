import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { parseConfluenceHtml } from "../../src/parsers/ConfluenceParser.js"
import { parseMarkdown } from "../../src/parsers/MarkdownParser.js"
import { serializeToConfluence } from "../../src/serializers/ConfluenceSerializer.js"
import { serializeToMarkdown } from "../../src/serializers/MarkdownSerializer.js"

const PlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const getFixturesDir = Effect.gen(function*() {
  const path = yield* Path.Path
  return path.join(import.meta.dirname, "../fixtures")
})

const readFixture = (filename: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const fixturesDir = yield* getFixturesDir
    return yield* fs.readFileString(path.join(fixturesDir, filename))
  }).pipe(Effect.provide(PlatformLive))

describe("ConfluenceParser", () => {
  describe("parseConfluenceHtml", () => {
    it.effect("parses basic headings", () =>
      Effect.gen(function*() {
        const html = "<h1>Title</h1><h2>Subtitle</h2>"
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(2)
        expect(doc.children[0]?._tag).toBe("Heading")
      }))

    it.effect("parses paragraphs", () =>
      Effect.gen(function*() {
        const html = "<p>Hello world</p>"
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(1)
        expect(doc.children[0]?._tag).toBe("Paragraph")
      }))

    it.effect("parses task lists", () =>
      Effect.gen(function*() {
        const html = `<ac:task-list ac:task-list-id="test">
          <ac:task>
            <ac:task-id>1</ac:task-id>
            <ac:task-uuid>uuid-1</ac:task-uuid>
            <ac:task-status>incomplete</ac:task-status>
            <ac:task-body><span>Task 1</span></ac:task-body>
          </ac:task>
          <ac:task>
            <ac:task-id>2</ac:task-id>
            <ac:task-uuid>uuid-2</ac:task-uuid>
            <ac:task-status>complete</ac:task-status>
            <ac:task-body><span>Task 2</span></ac:task-body>
          </ac:task>
        </ac:task-list>`
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(1)
        const taskList = doc.children[0]
        expect(taskList?._tag).toBe("TaskList")
        if (taskList?._tag === "TaskList") {
          expect(taskList.children.length).toBe(2)
          expect(taskList.children[0]?.status).toBe("incomplete")
          expect(taskList.children[0]?.body[0]?._tag).toBe("Text")
          expect(taskList.children[1]?.status).toBe("complete")
        }
      }))

    it.effect("parses images with attachments", () =>
      Effect.gen(function*() {
        const html = `<ac:image ac:align="center" ac:width="250" ac:alt="logo">
          <ri:attachment ri:filename="logo.svg"/>
        </ac:image>`
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(1)
        const image = doc.children[0]
        expect(image?._tag).toBe("Image")
        if (image?._tag === "Image") {
          expect(image.attachment?.filename).toBe("logo.svg")
          expect(image.align).toBe("center")
          expect(image.width).toBe(250)
          expect(image.alt).toBe("logo")
        }
      }))

    it.effect("parses emoticons", () =>
      Effect.gen(function*() {
        const html =
          `<p><ac:emoticon ac:emoji-shortname=":grinning:" ac:emoji-id="1f600" ac:emoji-fallback="smile"/></p>`
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(1)
        const para = doc.children[0]
        expect(para?._tag).toBe("Paragraph")
        if (para?._tag === "Paragraph") {
          const emoticon = para.children[0]
          expect(emoticon?._tag).toBe("Emoticon")
          if (emoticon?._tag === "Emoticon") {
            expect(emoticon.shortname).toBe(":grinning:")
            expect(emoticon.emojiId).toBe("1f600")
            expect(emoticon.fallback).toBe("smile")
          }
        }
      }))

    it.effect("parses user mentions", () =>
      Effect.gen(function*() {
        const html = `<p><ac:link><ri:user ri:account-id="557058:abc123"/></ac:link></p>`
        const doc = yield* parseConfluenceHtml(html)
        expect(doc.children.length).toBe(1)
        const para = doc.children[0]
        if (para?._tag === "Paragraph") {
          const mention = para.children[0]
          expect(mention?._tag).toBe("UserMention")
          if (mention?._tag === "UserMention") {
            expect(mention.accountId).toBe("557058:abc123")
          }
        }
      }))

    it.effect("parses colored text", () =>
      Effect.gen(function*() {
        const html = `<p><span style="color: rgb(255,0,0);">Red text</span></p>`
        const doc = yield* parseConfluenceHtml(html)
        const para = doc.children[0]
        if (para?._tag === "Paragraph") {
          const colored = para.children[0]
          expect(colored?._tag).toBe("ColoredText")
          if (colored?._tag === "ColoredText") {
            expect(colored.color).toBe("rgb(255,0,0)")
          }
        }
      }))

    it.effect("parses highlighted text", () =>
      Effect.gen(function*() {
        const html = `<p><span style="background-color: rgb(255,255,0);">Highlighted</span></p>`
        const doc = yield* parseConfluenceHtml(html)
        const para = doc.children[0]
        if (para?._tag === "Paragraph") {
          const highlight = para.children[0]
          expect(highlight?._tag).toBe("Highlight")
          if (highlight?._tag === "Highlight") {
            expect(highlight.backgroundColor).toBe("rgb(255,255,0)")
          }
        }
      }))

    it.effect("parses paragraph with alignment", () =>
      Effect.gen(function*() {
        const html = `<p style="text-align: center;">Centered</p>`
        const doc = yield* parseConfluenceHtml(html)
        const para = doc.children[0]
        expect(para?._tag).toBe("Paragraph")
        if (para?._tag === "Paragraph") {
          expect(para.alignment).toBe("center")
        }
      }))

    it.effect("parses paragraph with indent", () =>
      Effect.gen(function*() {
        const html = `<p style="margin-left: 30px;">Indented</p>`
        const doc = yield* parseConfluenceHtml(html)
        const para = doc.children[0]
        expect(para?._tag === "Paragraph").toBe(true)
        if (para?._tag === "Paragraph") {
          expect(para.indent).toBe(30)
        }
      }))

    it.effect("parses underline, subscript, superscript", () =>
      Effect.gen(function*() {
        const html = `<p><u>Underline</u> <sub>Sub</sub> <sup>Sup</sup></p>`
        const doc = yield* parseConfluenceHtml(html)
        const para = doc.children[0]
        if (para?._tag === "Paragraph") {
          const [u, , sub, , sup] = para.children
          expect(u?._tag).toBe("Underline")
          expect(sub?._tag).toBe("Subscript")
          expect(sup?._tag).toBe("Superscript")
        }
      }))

    it.effect("parses tables with proper cell content", () =>
      Effect.gen(function*() {
        const html = `<table>
          <thead><tr><th><p>Header 1</p></th><th><p>Header 2</p></th></tr></thead>
          <tbody><tr><td><p>Cell 1</p></td><td><p>Cell 2</p></td></tr></tbody>
        </table>`
        const doc = yield* parseConfluenceHtml(html)
        const table = doc.children[0]
        expect(table?._tag).toBe("Table")
        if (table?._tag === "Table") {
          // Header should have 2 cells
          expect(table.header?.cells.length).toBe(2)
          // First header cell should have text "Header 1"
          const headerCell = table.header?.cells[0]
          if (headerCell) {
            expect(headerCell.children[0]?._tag).toBe("Text")
            if (headerCell.children[0]?._tag === "Text") {
              expect(headerCell.children[0].value).toBe("Header 1")
            }
          }
          // Body rows
          expect(table.rows.length).toBe(1)
          const bodyCell = table.rows[0]?.cells[0]
          if (bodyCell) {
            expect(bodyCell.children[0]?._tag).toBe("Text")
            if (bodyCell.children[0]?._tag === "Text") {
              expect(bodyCell.children[0].value).toBe("Cell 1")
            }
          }
        }
      }))
  })

  describe("integration test fixture", () => {
    it.effect("parses and serializes integration test fixture", () =>
      Effect.gen(function*() {
        const html = yield* readFixture("integration-test.html.fixture")
        const doc = yield* parseConfluenceHtml(html)

        // Doc should have children - layout markers plus actual content
        expect(doc.children.length).toBeGreaterThan(0)

        // Serialize to markdown - content should be readable (not URL-encoded)
        const markdown = yield* serializeToMarkdown(doc)
        // Layout markers should be present as comments
        expect(markdown).toContain("cf:layout-start")
        expect(markdown).toContain("cf:section:")
        // Content should be readable markdown, not URL-encoded
        expect(markdown).toContain("# Heading 1")
        expect(markdown).toContain("## Heading 2")

        // Serialize to confluence - should reconstruct layout structure
        const confluenceHtml = yield* serializeToConfluence(doc)
        expect(confluenceHtml).toContain("<ac:layout>")
        expect(confluenceHtml).toContain("<ac:layout-section")
        expect(confluenceHtml).toContain("<ac:layout-cell>")
        // Note: ac:task-list may have attributes, so search for the tag name
        expect(confluenceHtml).toContain("ac:task-list")
        expect(confluenceHtml).toContain("<ac:task-status>incomplete</ac:task-status>")
        expect(confluenceHtml).toContain("<ac:task-status>complete</ac:task-status>")
        expect(confluenceHtml).toContain("ac:emoticon")
        expect(confluenceHtml).toContain("ri:account-id")
      }))
  })

  describe("roundtrip HTML -> MD -> HTML", () => {
    it.effect("roundtrips integration-test.html with 1-to-1 preservation", () =>
      Effect.gen(function*() {
        const originalHtml = yield* readFixture("integration-test.html.fixture")
        const doc1 = yield* parseConfluenceHtml(originalHtml)
        const md = yield* serializeToMarkdown(doc1)
        const doc2 = yield* parseMarkdown(md)
        const finalHtml = yield* serializeToConfluence(doc2)

        // 1-to-1 roundtrip: finalHtml should EXACTLY match originalHtml
        expect(finalHtml).toBe(originalHtml)
      }))

    it.effect("roundtrips TOC macro", () =>
      Effect.gen(function*() {
        const html =
          `<ac:structured-macro ac:name="toc"><ac:parameter ac:name="minLevel">2</ac:parameter></ac:structured-macro>`
        const doc1 = yield* parseConfluenceHtml(html)
        expect(doc1.children[0]?._tag).toBe("TocMacro")

        const md = yield* serializeToMarkdown(doc1)
        expect(md).toContain("[[toc]]")

        const doc2 = yield* parseMarkdown(md)
        expect(doc2.children[0]?._tag).toBe("TocMacro")

        const html2 = yield* serializeToConfluence(doc2)
        expect(html2).toContain("<ac:structured-macro ac:name=\"toc\">")
      }))
  })
})
