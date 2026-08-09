import { describe, expect, it } from "vitest"
import {
  type TextFilterInputKey,
  type TextFilterInputState,
  transitionTextFilterInput
} from "../src/tui/text-filter-input.js"

const applyBatch = (keys: ReadonlyArray<TextFilterInputKey>): TextFilterInputState => {
  let state: TextFilterInputState = { active: false, text: "" }
  for (const key of keys) {
    const transition = transitionTextFilterInput(state, key, true)
    expect(transition.handled).toBe(true)
    state = transition.state
  }
  return state
}

describe("text filter input", () => {
  it("preserves every character when slash, pasted text, and Enter arrive before a render", () => {
    const state = applyBatch([
      { name: "/", char: "/" },
      ...Array.from("fixture", (char) => ({ name: char, char })),
      { name: "return" }
    ])

    expect(state).toEqual({ active: false, text: "fixture" })
  })

  it("keeps settings-filter shortcut letters inside a pasted account search", () => {
    const state = applyBatch([
      { name: "/", char: "/" },
      ...Array.from("dev administrator", (char) => ({ name: char === " " ? "space" : char, char })),
      { name: "return" }
    ])

    expect(state).toEqual({ active: false, text: "dev administrator" })
  })

  it("does not consume ordinary navigation when filtering cannot open", () => {
    const state: TextFilterInputState = { active: false, text: "" }
    expect(transitionTextFilterInput(state, { name: "return" }, false)).toEqual({ handled: false, state })
  })
})
