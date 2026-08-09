import { describe, expect, it } from "vitest"
import { pressExitConfirmation } from "../src/tui/exit-confirmation.js"
import { textFromKeyboardKey } from "../src/tui/keyboard-text.js"

describe("keyboard text normalization", () => {
  it("preserves an OpenTUI space key when pasted input has no char", () => {
    expect(textFromKeyboardKey({ name: "space" })).toBe(" ")
  })

  it("preserves ordinary characters without classifying navigation keys", () => {
    expect(textFromKeyboardKey({ name: "x", char: "x" })).toBe("x")
    expect(textFromKeyboardKey({ name: "return" })).toBeUndefined()
  })

  it("consumes a synchronous second exit press without waiting for a render", () => {
    const confirmation = { current: false }

    expect(pressExitConfirmation(confirmation)).toBe("armed")
    expect(confirmation.current).toBe(true)
    expect(pressExitConfirmation(confirmation)).toBe("quit")
    expect(confirmation.current).toBe(false)

    expect(pressExitConfirmation(confirmation)).toBe("armed")
  })
})
