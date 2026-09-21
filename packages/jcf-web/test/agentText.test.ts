import { describe, expect, it } from "@effect/vitest"
import { formatAgentText } from "../src/client/agentText.js"

describe("agent text", () => {
  it("indents nested final answers without changing their values", () => {
    const response = "{\"answers\":[{\"ticketKey\":\"PROJ-123\",\"note\":\"First line\\nSecond line\"}]}"
    expect(formatAgentText(response)).toBe(JSON.stringify(JSON.parse(response), null, 2))
    expect(formatAgentText(response)).toContain("\n  \"answers\": [\n    {")
  })

  it("preserves an incomplete response and prompt line breaks while streaming", () => {
    for (const text of ["", "{\"answers\":[{\"ticketKey\":", "User:\nMatch the sessions.\n\nDigest:\nLine two"]) {
      expect(formatAgentText(text)).toBe(text)
    }
  })
})
