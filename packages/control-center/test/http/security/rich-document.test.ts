import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { sanitizeRichDocumentV1, validateRichDocumentV1 } from "../../../src/server/http/security/index.js"
import type { RichTextNode } from "../../../src/server/http/security/index.js"

const text = (value: string): RichTextNode => ({ _tag: "text", text: value, marks: [] })

describe("RichDocumentV1", () => {
  it.effect("preserves canonical text, HTTPS links, mentions, emoji, and opaque media", () =>
    Effect.gen(function*() {
      const document = yield* sanitizeRichDocumentV1({
        _tag: "rich-document",
        version: 1,
        children: [{
          _tag: "paragraph",
          children: [
            text("Release ready "),
            { _tag: "link", href: "https://jira.example/browse/RPS-6307", children: [text("RPS-6307")] },
            { _tag: "mention", reference: "person:42", label: "Ava" },
            { _tag: "emoji", text: "🚀" },
            { _tag: "media", mediaRef: `media_${"a".repeat(64)}`, alt: "Ava" }
          ]
        }]
      })
      assert.strictEqual(document.children.length, 1)
      const paragraph = document.children[0]
      assert.strictEqual(paragraph?._tag, "paragraph")
      if (paragraph?._tag === "paragraph") {
        assert.deepStrictEqual(paragraph.children.map((node) => node._tag), [
          "text",
          "link",
          "mention",
          "emoji",
          "media"
        ])
      }
    }))

  it.effect("drops active provider nodes and unwraps unsafe link text", () =>
    Effect.gen(function*() {
      const document = yield* sanitizeRichDocumentV1({
        _tag: "rich-document",
        version: 1,
        children: [{
          _tag: "paragraph",
          children: [
            { _tag: "raw-html", html: "<img src=x onerror=alert(1)>" },
            { _tag: "script", children: [text("must not execute")] },
            { _tag: "link", href: "javascript:alert(1)", children: [text("visible label")] },
            { _tag: "media", mediaRef: "https://evil.example/tracker.svg", alt: "tracker" }
          ]
        }]
      })
      const paragraph = document.children[0]
      assert.strictEqual(paragraph?._tag, "paragraph")
      if (paragraph?._tag === "paragraph") {
        assert.deepStrictEqual(paragraph.children, [text("visible label")])
      }
    }))

  it.effect("rejects excessive depth before recursive schema decoding", () =>
    Effect.gen(function*() {
      let nested: unknown = { _tag: "paragraph", children: [text("bottom")] }
      for (let depth = 0; depth < 25; depth += 1) nested = { _tag: "blockquote", children: [nested] }
      const result = yield* validateRichDocumentV1({
        _tag: "rich-document",
        version: 1,
        children: [nested]
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "bounds-exceeded")
    }))

  it.effect("enforces per-text and exact encoded document byte budgets", () =>
    Effect.gen(function*() {
      const oversizedText = yield* validateRichDocumentV1({
        _tag: "rich-document",
        version: 1,
        children: [{ _tag: "paragraph", children: [text("x".repeat(16 * 1024 + 1))] }]
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(oversizedText))
      if (Result.isFailure(oversizedText)) assert.strictEqual(oversizedText.failure.reason, "bounds-exceeded")

      const encodedOversize = yield* validateRichDocumentV1({
        _tag: "rich-document",
        version: 1,
        children: Array.from({ length: 20 }, () => ({
          _tag: "paragraph",
          children: [text("x".repeat(14 * 1024))]
        }))
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(encodedOversize))
      if (Result.isFailure(encodedOversize)) assert.strictEqual(encodedOversize.failure.reason, "encoded-size-exceeded")
    }))
})
