import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  isMdastHeading,
  isMdastParagraph,
  isMdastText,
  makeMdastHeading,
  makeMdastParagraph,
  makeMdastRoot,
  makeMdastText,
  MdastFromMarkdown,
  MdastRootSchema,
  MdastTextSchema
} from "../../src/schemas/mdast/index.js"

describe("MdastSchema", () => {
  describe("constructors", () => {
    it("creates text node", () => {
      const node = makeMdastText("hello")
      expect(node.type).toBe("text")
      expect(node.value).toBe("hello")
    })

    it("creates heading node", () => {
      const node = makeMdastHeading(2, [makeMdastText("Title")])
      expect(node.type).toBe("heading")
      expect(node.depth).toBe(2)
      expect(node.children).toHaveLength(1)
    })

    it("creates paragraph node", () => {
      const node = makeMdastParagraph([makeMdastText("content")])
      expect(node.type).toBe("paragraph")
      expect(node.children).toHaveLength(1)
    })

    it("creates root node", () => {
      const root = makeMdastRoot([makeMdastParagraph([makeMdastText("text")])])
      expect(root.type).toBe("root")
      expect(root.children).toHaveLength(1)
    })
  })

  describe("type guards", () => {
    it("isMdastText returns true for text node", () => {
      expect(isMdastText(makeMdastText("hello"))).toBe(true)
      expect(isMdastText(makeMdastHeading(1, []))).toBe(false)
    })

    it("isMdastHeading returns true for heading node", () => {
      expect(isMdastHeading(makeMdastHeading(1, []))).toBe(true)
      expect(isMdastHeading(makeMdastText("hello"))).toBe(false)
    })

    it("isMdastParagraph returns true for paragraph node", () => {
      expect(isMdastParagraph(makeMdastParagraph([]))).toBe(true)
      expect(isMdastParagraph(makeMdastText("hello"))).toBe(false)
    })
  })

  describe("MdastTextSchema", () => {
    it("validates text node", () => {
      const result = Schema.decodeUnknownEither(MdastTextSchema)(makeMdastText("test"))
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects invalid type", () => {
      const result = Schema.decodeUnknownEither(MdastTextSchema)({ type: "other", value: "x" })
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("MdastRootSchema", () => {
    it("validates root node", () => {
      const root = makeMdastRoot([makeMdastParagraph([makeMdastText("text")])])
      const result = Schema.decodeUnknownEither(MdastRootSchema)(root)
      expect(Either.isRight(result)).toBe(true)
    })
  })
})

describe("MdastFromMarkdown", () => {
  describe("decode (Markdown -> MDAST)", () => {
    it.effect("parses heading", () =>
      Effect.gen(function*() {
        const mdast = yield* Schema.decode(MdastFromMarkdown)("# Hello")
        expect(mdast.type).toBe("root")
        expect(mdast.children).toHaveLength(1)
        const heading = mdast.children[0]
        expect(heading.type).toBe("heading")
      }))

    it.effect("parses paragraph", () =>
      Effect.gen(function*() {
        const mdast = yield* Schema.decode(MdastFromMarkdown)("Hello world")
        expect(mdast.children).toHaveLength(1)
        expect(mdast.children[0].type).toBe("paragraph")
      }))

    it.effect("parses code block", () =>
      Effect.gen(function*() {
        const mdast = yield* Schema.decode(MdastFromMarkdown)("```ts\nconst x = 1\n```")
        expect(mdast.children).toHaveLength(1)
        const code = mdast.children[0]
        expect(code.type).toBe("code")
      }))

    it.effect("parses list", () =>
      Effect.gen(function*() {
        const mdast = yield* Schema.decode(MdastFromMarkdown)("- item 1\n- item 2")
        expect(mdast.children).toHaveLength(1)
        expect(mdast.children[0].type).toBe("list")
      }))
  })

  describe("encode (MDAST -> Markdown)", () => {
    it.effect("stringifies heading", () =>
      Effect.gen(function*() {
        const mdast = makeMdastRoot([
          makeMdastHeading(1, [makeMdastText("Title")])
        ])
        const md = yield* Schema.encode(MdastFromMarkdown)(mdast)
        expect(md.trim()).toBe("# Title")
      }))

    it.effect("stringifies paragraph", () =>
      Effect.gen(function*() {
        const mdast = makeMdastRoot([
          makeMdastParagraph([makeMdastText("Hello world")])
        ])
        const md = yield* Schema.encode(MdastFromMarkdown)(mdast)
        expect(md.trim()).toBe("Hello world")
      }))

    it.effect("roundtrips markdown", () =>
      Effect.gen(function*() {
        const original = "# Title\n\nParagraph text."
        const mdast = yield* Schema.decode(MdastFromMarkdown)(original)
        const md = yield* Schema.encode(MdastFromMarkdown)(mdast)
        expect(md.trim()).toBe(original)
      }))
  })
})
