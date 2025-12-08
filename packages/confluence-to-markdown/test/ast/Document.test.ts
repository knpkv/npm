import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { Heading } from "../../src/ast/BlockNode.js"
import { Document, isDocument, makeDocument } from "../../src/ast/Document.js"
import { Text } from "../../src/ast/InlineNode.js"

describe("Document", () => {
  describe("Document schema", () => {
    it("decodes valid document", () => {
      const result = Schema.decodeUnknownEither(Document)({
        children: [
          {
            _tag: "Heading",
            level: 1,
            children: [{ _tag: "Text", value: "Title" }]
          },
          {
            _tag: "Paragraph",
            children: [{ _tag: "Text", value: "Content" }]
          }
        ]
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.version).toBe(1)
        expect(result.right.children).toHaveLength(2)
      }
    })

    it("decodes document with explicit version", () => {
      const result = Schema.decodeUnknownEither(Document)({
        version: 2,
        children: []
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.version).toBe(2)
      }
    })

    it("decodes document with macro nodes", () => {
      const result = Schema.decodeUnknownEither(Document)({
        children: [
          {
            _tag: "InfoPanel",
            panelType: "warning",
            children: [
              {
                _tag: "Paragraph",
                children: [{ _tag: "Text", value: "Warning!" }]
              }
            ]
          }
        ]
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("encodes document to plain object", () => {
      const doc: Schema.Schema.Type<typeof Document> = {
        version: 1,
        children: [
          new Heading({
            level: 1,
            children: [new Text({ value: "Hello" })]
          })
        ]
      }
      const result = Schema.encodeUnknownEither(Document)(doc)
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects invalid children", () => {
      const result = Schema.decodeUnknownEither(Document)({
        children: [{ invalid: true }]
      })
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("makeDocument", () => {
    it("creates document with default version", () => {
      const doc = makeDocument([
        new Heading({
          level: 1,
          children: [new Text({ value: "Title" })]
        })
      ])
      expect(doc.version).toBe(1)
      expect(doc.children).toHaveLength(1)
    })

    it("creates empty document", () => {
      const doc = makeDocument([])
      expect(doc.children).toHaveLength(0)
    })
  })

  describe("isDocument", () => {
    it("returns true for valid document", () => {
      const doc = makeDocument([])
      expect(isDocument(doc)).toBe(true)
    })

    it("returns true for document-like object", () => {
      expect(isDocument({ children: [] })).toBe(true)
    })

    it("returns false for null", () => {
      expect(isDocument(null)).toBe(false)
    })

    it("returns false for non-object", () => {
      expect(isDocument("string")).toBe(false)
    })

    it("returns false for object without children", () => {
      expect(isDocument({ version: 1 })).toBe(false)
    })

    it("returns false for object with non-array children", () => {
      expect(isDocument({ children: "not array" })).toBe(false)
    })
  })
})
