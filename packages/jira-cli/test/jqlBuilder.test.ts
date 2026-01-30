import { describe, expect, it } from "@effect/vitest"
import { buildByVersionJql, escapeJqlValue } from "../src/internal/jqlBuilder.js"

describe("jqlBuilder", () => {
  describe("buildByVersionJql", () => {
    it("builds JQL for version only", () => {
      const result = buildByVersionJql("1.0.0")
      expect(result).toBe("fixVersion = \"1.0.0\" ORDER BY key ASC")
    })

    it("builds JQL with project filter", () => {
      const result = buildByVersionJql("1.0.0", "PROJ")
      expect(result).toBe("project = \"PROJ\" AND fixVersion = \"1.0.0\" ORDER BY key ASC")
    })

    it("handles version with special characters", () => {
      const result = buildByVersionJql("1.0.0-beta.1")
      expect(result).toBe("fixVersion = \"1.0.0-beta.1\" ORDER BY key ASC")
    })

    it("escapes quotes in version name", () => {
      const result = buildByVersionJql("OOB 42 \"Nimble Needlefish\"")
      expect(result).toBe("fixVersion = \"OOB 42 \\\"Nimble Needlefish\\\"\" ORDER BY key ASC")
    })
  })

  describe("escapeJqlValue", () => {
    it("escapes backslashes", () => {
      expect(escapeJqlValue("path\\to\\file")).toBe("path\\\\to\\\\file")
    })

    it("escapes double quotes", () => {
      expect(escapeJqlValue("say \"hello\"")).toBe("say \\\"hello\\\"")
    })

    it("leaves normal strings unchanged", () => {
      expect(escapeJqlValue("normal string")).toBe("normal string")
    })

    it("escapes newlines and carriage returns", () => {
      expect(escapeJqlValue("line1\nline2")).toBe("line1\\nline2")
      expect(escapeJqlValue("line1\r\nline2")).toBe("line1\\r\\nline2")
    })
  })
})
