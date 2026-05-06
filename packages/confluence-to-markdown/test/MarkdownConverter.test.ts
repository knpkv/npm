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

const minimalDoc = (content: ReadonlyArray<unknown>): string => JSON.stringify({ version: 1, type: "doc", content })

describe("MarkdownConverter", () => {
  describe("adfToMarkdown", () => {
    it.effect("converts a heading", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md = yield* converter.adfToMarkdown(
          minimalDoc([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hello" }] }])
        )
        expect(md).toContain("# Hello")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("converts a paragraph with marks", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md = yield* converter.adfToMarkdown(
          minimalDoc([{
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", text: "world", marks: [{ type: "strong" }] }
            ]
          }])
        )
        expect(md).toContain("Hello")
        expect(md).toContain("**world**")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("converts a bullet list", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md = yield* converter.adfToMarkdown(
          minimalDoc([{
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }]
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }]
              }
            ]
          }])
        )
        expect(md).toContain("- one")
        expect(md).toContain("- two")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("converts a code block with language", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md = yield* converter.adfToMarkdown(
          minimalDoc([{
            type: "codeBlock",
            attrs: { language: "ts" },
            content: [{ type: "text", text: "const x = 1" }]
          }])
        )
        expect(md).toContain("```ts")
        expect(md).toContain("const x = 1")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("converts a panel to a GitHub admonition", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md = yield* converter.adfToMarkdown(
          minimalDoc([{
            type: "panel",
            attrs: { panelType: "info" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "heads up" }] }]
          }])
        )
        expect(md).toContain("[!NOTE]")
        expect(md).toContain("heads up")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("fails with ConversionError on invalid JSON", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const result = yield* Effect.either(converter.adfToMarkdown("not json"))
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("ConversionError")
          expect(result.left.direction).toBe("adfToMarkdown")
        }
      }).pipe(Effect.provide(TestLayer)))

    it.effect("fails with ConversionError on schema-invalid input", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const result = yield* Effect.either(
          converter.adfToMarkdown(JSON.stringify({ version: 1, type: "doc", content: "not an array" }))
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("ConversionError")
        }
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("markdownToAdf", () => {
    it.effect("produces a valid ADF doc for a heading", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const adf = yield* converter.markdownToAdf("# Title\n\nBody")
        const parsed = JSON.parse(adf) as { type: string; version: number; content: ReadonlyArray<{ type: string }> }
        expect(parsed.type).toBe("doc")
        expect(parsed.version).toBe(1)
        expect(parsed.content[0]?.type).toBe("heading")
      }).pipe(Effect.provide(TestLayer)))

    it.effect("round-trips a heading + paragraph through both directions", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const md1 = "# Title\n\nHello **world**"
        const adf = yield* converter.markdownToAdf(md1)
        const md2 = yield* converter.adfToMarkdown(adf)
        expect(md2).toContain("# Title")
        expect(md2).toContain("**world**")
      }).pipe(Effect.provide(TestLayer)))
  })
})
