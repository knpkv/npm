import { describe, expect, it } from "@effect/vitest"
import { formatAgentText } from "../src/client/agentText.js"

describe("agent text", () => {
  it("indents nested final answers without changing their values, and marks them as code", () => {
    const response = "{\"answers\":[{\"ticketKey\":\"PROJ-123\",\"note\":\"First line\\nSecond line\"}]}"
    const formatted = formatAgentText(response)
    expect(formatted.kind).toBe("json")
    expect(formatted.text).toBe(JSON.stringify(JSON.parse(response), null, 2))
    expect(formatted.text).toContain("\n  \"answers\": [\n    {")
  })

  // Prose stays in the reading font; only a complete JSON value is set as code.
  it("preserves an incomplete response and prompt line breaks while streaming, as prose", () => {
    for (const text of ["", "{\"answers\":[{\"ticketKey\":", "User:\nMatch the sessions.\n\nDigest:\nLine two"]) {
      expect(formatAgentText(text)).toEqual({ kind: "prose", text })
    }
  })
})
