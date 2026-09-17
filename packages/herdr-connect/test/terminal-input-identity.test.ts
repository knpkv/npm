import { describe, expect, it } from "@effect/vitest"
import { applyTerminalInputIdentity } from "../src/terminal-input-identity.js"

describe("terminal input identity", () => {
  it("gives the Ghostty terminal input stable form identity", () => {
    const input = { id: "", name: "" }

    applyTerminalInputIdentity(input)

    expect(input).toEqual({ id: "connect-terminal-input", name: "terminal-input" })
  })
})
