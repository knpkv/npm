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
})
