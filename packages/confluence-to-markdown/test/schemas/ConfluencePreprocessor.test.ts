import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { PreprocessedHtmlFromConfluence, PreprocessedHtmlSchema } from "../../src/schemas/preprocessing/index.js"

describe("PreprocessedHtmlSchema", () => {
  it("validates branded string", () => {
    const result = Schema.decodeUnknownEither(PreprocessedHtmlSchema)("<p>Hello</p>")
    expect(Either.isRight(result)).toBe(true)
  })
})

describe("PreprocessedHtmlFromConfluence", () => {
  describe("size limit", () => {
    it.effect("rejects HTML exceeding size limit", () =>
      Effect.gen(function*() {
        const largeHtml = "x".repeat(1024 * 1024 + 1)
        const result = yield* Effect.either(Schema.decode(PreprocessedHtmlFromConfluence)(largeHtml))
        expect(Either.isLeft(result)).toBe(true)
      }))

    it.effect("accepts HTML within size limit", () =>
      Effect.gen(function*() {
        const html = "<p>Hello</p>"
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("Hello")
      }))
  })

  describe("structured macro expansion", () => {
    it.effect("expands code macro", () =>
      Effect.gen(function*() {
        // Single line format that matches the regex pattern
        const html =
          `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[const x = 1]]></ac:plain-text-body></ac:structured-macro>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-macro=\"code\"")
        expect(result).toContain("data-language=\"typescript\"")
        expect(result).toContain("const x = 1")
      }))

    it.effect("expands info panel macro", () =>
      Effect.gen(function*() {
        const html = `<ac:structured-macro ac:name="info">
          <ac:parameter ac:name="title">Note</ac:parameter>
          <ac:rich-text-body><p>Content here</p></ac:rich-text-body>
        </ac:structured-macro>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-macro=\"info\"")
        expect(result).toContain("data-title=\"Note\"")
        expect(result).toContain("<p>Content here</p>")
      }))

    it.effect("expands expand macro", () =>
      Effect.gen(function*() {
        const html = `<ac:structured-macro ac:name="expand">
          <ac:parameter ac:name="title">Click to expand</ac:parameter>
          <ac:rich-text-body><p>Hidden content</p></ac:rich-text-body>
        </ac:structured-macro>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("<details")
        expect(result).toContain("<summary>Click to expand</summary>")
        expect(result).toContain("<p>Hidden content</p>")
      }))

    it.effect("expands TOC macro", () =>
      Effect.gen(function*() {
        const html = `<ac:structured-macro ac:name="toc">
          <ac:parameter ac:name="minLevel">2</ac:parameter>
          <ac:parameter ac:name="maxLevel">4</ac:parameter>
        </ac:structured-macro>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-macro=\"toc\"")
        expect(result).toContain("data-min=\"2\"")
        expect(result).toContain("data-max=\"4\"")
      }))

    it.effect("expands status macro", () =>
      Effect.gen(function*() {
        const html = `<ac:structured-macro ac:name="status">
          <ac:parameter ac:name="colour">Green</ac:parameter>
          <ac:parameter ac:name="title">Done</ac:parameter>
        </ac:structured-macro>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-macro=\"status\"")
        expect(result).toContain("data-color=\"Green\"")
        expect(result).toContain("Done")
      }))
  })

  describe("task list preprocessing", () => {
    it.effect("converts task list to ul", () =>
      Effect.gen(function*() {
        const html = `<ac:task-list>
          <ac:task>
            <ac:task-id>1</ac:task-id>
            <ac:task-status>incomplete</ac:task-status>
            <ac:task-body>Task one</ac:task-body>
          </ac:task>
        </ac:task-list>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("<ul data-macro=\"task-list\">")
        expect(result).toContain("data-task-id=\"1\"")
        expect(result).toContain("data-task-status=\"incomplete\"")
        expect(result).toContain("Task one")
      }))
  })

  describe("image preprocessing", () => {
    it.effect("converts attachment images", () =>
      Effect.gen(function*() {
        const html = `<ac:image ac:align="center" ac:width="250">
          <ri:attachment ri:filename="test.png"/>
        </ac:image>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-attachment=\"test.png\"")
        expect(result).toContain("data-align=\"center\"")
        expect(result).toContain("data-width=\"250\"")
      }))
  })

  describe("emoticon preprocessing", () => {
    it.effect("converts emoticons", () =>
      Effect.gen(function*() {
        const html = `<ac:emoticon ac:emoji-shortname=":grinning:" ac:emoji-id="1f600" ac:emoji-fallback="😀"/>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-emoji=\":grinning:\"")
        expect(result).toContain("data-emoji-id=\"1f600\"")
        expect(result).toContain("😀")
      }))
  })

  describe("user mention preprocessing", () => {
    it.effect("converts user mentions", () =>
      Effect.gen(function*() {
        const html = `<ac:link><ri:user ri:account-id="557058:abc123"/></ac:link>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("data-user-mention=\"557058:abc123\"")
      }))
  })

  describe("namespace stripping", () => {
    it.effect("removes ac: and ri: tags", () =>
      Effect.gen(function*() {
        const html = `<p>Text<ac:parameter ac:name="foo">bar</ac:parameter></p>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).not.toContain("ac:parameter")
        expect(result).toContain("<p>Text</p>")
      }))
  })

  describe("layout preprocessing", () => {
    it.effect("adds layout markers", () =>
      Effect.gen(function*() {
        const html = `<ac:layout>
          <ac:layout-section ac:type="two_equal">
            <ac:layout-cell><p>Cell 1</p></ac:layout-cell>
            <ac:layout-cell><p>Cell 2</p></ac:layout-cell>
          </ac:layout-section>
        </ac:layout>`
        const result = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        expect(result).toContain("<!--cf:layout-start-->")
        expect(result).toContain("<!--cf:layout-end-->")
        expect(result).toContain("<!--cf:section:0;")
        expect(result).toContain("<p>Cell 1</p>")
        expect(result).toContain("<p>Cell 2</p>")
      }))
  })

  describe("encode (identity)", () => {
    it.effect("encode returns same string", () =>
      Effect.gen(function*() {
        const html = "<p>Hello</p>"
        const preprocessed = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        const encoded = yield* Schema.encode(PreprocessedHtmlFromConfluence)(preprocessed)
        expect(encoded).toBe(preprocessed)
      }))
  })
})
