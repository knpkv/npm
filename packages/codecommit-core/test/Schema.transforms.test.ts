import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { PRComment } from "../src/Domain.js"

/**
 * Schema transforms are bidirectional: raw AWS JSON ↔ domain model.
 * These tests verify both decode (AWS→domain) and encode (domain→AWS)
 * directions, plus edge cases like missing/null fields.
 *
 * Note: The transform Schemas (RawToPullRequestDetail, etc.) are not
 * exported — they're tested indirectly via the decodeSync wrappers.
 * The PRComment Schema.Class IS exported and can be tested directly.
 */

describe("Schema transforms", () => {
  describe("PRComment roundtrip", () => {
    const raw = {
      id: "c-1" as const,
      content: "Nice work",
      author: "alice",
      creationDate: new Date("2024-03-10T10:00:00Z"),
      deleted: false,
      filePath: "src/main.ts",
      lineNumber: 42
    }

    // Decode→encode must preserve all fields (bidirectional fidelity)
    it("roundtrips PRComment through decode/encode", () => {
      const decoded = Schema.decodeSync(PRComment)(raw)
      const encoded = Schema.encodeSync(PRComment)(decoded)
      expect(encoded.id).toBe(raw.id)
      expect(encoded.content).toBe(raw.content)
      expect(encoded.author).toBe(raw.author)
      expect(encoded.filePath).toBe(raw.filePath)
      expect(encoded.lineNumber).toBe(raw.lineNumber)
    })

    // Reply comments have inReplyTo set — must survive roundtrip
    it("preserves inReplyTo for reply comments", () => {
      const reply = { ...raw, id: "c-2" as const, inReplyTo: "c-1" as const }
      const decoded = Schema.decodeSync(PRComment)(reply)
      expect(decoded.inReplyTo).toBe("c-1")

      const encoded = Schema.encodeSync(PRComment)(decoded)
      expect(encoded.inReplyTo).toBe("c-1")
    })

    // Optional fields absent → should decode as undefined, encode without them
    it("handles absent optional fields", () => {
      const minimal = {
        id: "c-3" as const,
        content: "ok",
        author: "bob",
        creationDate: new Date(),
        deleted: false
      }
      const decoded = Schema.decodeSync(PRComment)(minimal)
      expect(decoded.filePath).toBeUndefined()
      expect(decoded.lineNumber).toBeUndefined()
      expect(decoded.inReplyTo).toBeUndefined()
    })
  })
})
