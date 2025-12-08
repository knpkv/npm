import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  getTextContent,
  HastFromHtml,
  HastNodeSchema,
  HastRootSchema,
  isHastElement,
  isHastText,
  makeHastElement,
  makeHastRoot,
  makeHastText
} from "../../src/schemas/hast/index.js"

describe("HastSchema", () => {
  describe("constructors", () => {
    it("creates text node", () => {
      const node = makeHastText("hello")
      expect(node._tag).toBe("text")
      expect(node.value).toBe("hello")
    })

    it("creates element node", () => {
      const node = makeHastElement("div", { class: "test" }, [makeHastText("child")])
      expect(node._tag).toBe("element")
      expect(node.tagName).toBe("div")
      expect(node.properties.class).toBe("test")
      expect(node.children).toHaveLength(1)
    })

    it("creates root node", () => {
      const root = makeHastRoot([makeHastElement("p", {}, [makeHastText("text")])])
      expect(root._tag).toBe("root")
      expect(root.children).toHaveLength(1)
    })
  })

  describe("type guards", () => {
    it("isHastText returns true for text node", () => {
      expect(isHastText(makeHastText("hello"))).toBe(true)
      expect(isHastText(makeHastElement("div"))).toBe(false)
    })

    it("isHastElement returns true for element node", () => {
      expect(isHastElement(makeHastElement("div"))).toBe(true)
      expect(isHastElement(makeHastText("hello"))).toBe(false)
    })
  })

  describe("getTextContent", () => {
    it("extracts text from text node", () => {
      expect(getTextContent(makeHastText("hello"))).toBe("hello")
    })

    it("extracts text from nested elements", () => {
      const el = makeHastElement("div", {}, [
        makeHastText("hello "),
        makeHastElement("strong", {}, [makeHastText("world")])
      ])
      expect(getTextContent(el)).toBe("hello world")
    })
  })

  describe("HastNodeSchema", () => {
    it("validates text node", () => {
      const result = Schema.decodeUnknownEither(HastNodeSchema)(makeHastText("test"))
      expect(Either.isRight(result)).toBe(true)
    })

    it("validates element node", () => {
      const result = Schema.decodeUnknownEither(HastNodeSchema)(makeHastElement("p"))
      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("HastRootSchema", () => {
    it("validates root node", () => {
      const root = makeHastRoot([makeHastElement("p", {}, [makeHastText("text")])])
      const result = Schema.decodeUnknownEither(HastRootSchema)(root)
      expect(Either.isRight(result)).toBe(true)
    })
  })
})

describe("HastFromHtml", () => {
  describe("decode (HTML -> HAST)", () => {
    it.effect("parses simple HTML", () =>
      Effect.gen(function*() {
        const hast = yield* Schema.decode(HastFromHtml)("<p>Hello</p>")
        expect(hast._tag).toBe("root")
        expect(hast.children).toHaveLength(1)
        const p = hast.children[0]
        expect(isHastElement(p) && p.tagName).toBe("p")
      }))

    it.effect("parses nested HTML", () =>
      Effect.gen(function*() {
        const hast = yield* Schema.decode(HastFromHtml)("<div><p>Text</p></div>")
        expect(hast.children).toHaveLength(1)
        const div = hast.children[0]
        if (isHastElement(div)) {
          expect(div.tagName).toBe("div")
          expect(div.children).toHaveLength(1)
        }
      }))

    it.effect("parses HTML with attributes", () =>
      Effect.gen(function*() {
        const hast = yield* Schema.decode(HastFromHtml)("<a href=\"https://example.com\">Link</a>")
        const a = hast.children[0]
        if (isHastElement(a)) {
          expect(a.properties.href).toBe("https://example.com")
        }
      }))
  })

  describe("encode (HAST -> HTML)", () => {
    it.effect("stringifies HAST to HTML", () =>
      Effect.gen(function*() {
        const hast = makeHastRoot([
          makeHastElement("p", {}, [makeHastText("Hello")])
        ])
        const html = yield* Schema.encode(HastFromHtml)(hast)
        expect(html).toContain("<p>")
        expect(html).toContain("Hello")
      }))

    it.effect("roundtrips HTML", () =>
      Effect.gen(function*() {
        const original = "<p>Test paragraph</p>"
        const hast = yield* Schema.decode(HastFromHtml)(original)
        const html = yield* Schema.encode(HastFromHtml)(hast)
        expect(html.replace(/\s/g, "")).toBe(original.replace(/\s/g, ""))
      }))
  })
})
