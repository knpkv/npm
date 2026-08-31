import { describe, expect, it } from "@effect/vitest"
import { terminalBackground } from "../src/terminal-theme.js"

describe("Connect terminal theme", () => {
  it("uses the Rly recessed surface instead of the former near-black canvas", () => {
    expect(terminalBackground).toBe("#17181c")
    expect(terminalBackground).not.toBe("#0b0d10")
  })
})
