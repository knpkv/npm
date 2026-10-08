// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import {
  applyTerminalInputIdentity,
  focusTerminalInput,
  trackTerminalInputFocus
} from "../src/terminal-input-identity.js"

describe("terminal input identity", () => {
  it("gives the Ghostty terminal input stable form identity", () => {
    const input = { id: "", name: "" }

    applyTerminalInputIdentity(input)

    expect(input).toEqual({ id: "connect-terminal-input", name: "terminal-input" })
  })
})

describe("terminal input focus", () => {
  it("focuses the text input itself, synchronously, so iOS opens the keyboard within the tap", () => {
    const container = document.createElement("div")
    container.setAttribute("contenteditable", "true")
    const textarea = document.createElement("textarea")
    container.append(textarea)
    document.body.append(container)

    focusTerminalInput(textarea)

    // No await or timer between the call and the check: the focus happened inside the gesture.
    expect(document.activeElement).toBe(textarea)
    container.remove()
  })

  it("keeps the page where it is", () => {
    const calls: Array<FocusOptions | undefined> = []
    focusTerminalInput({ focus: (options) => calls.push(options) })
    expect(calls).toEqual([{ preventScroll: true }])
  })
})

describe("terminal input focus tracking", () => {
  it("reports focus and blur as they happen, and nothing after release", () => {
    const textarea = document.createElement("textarea")
    const other = document.createElement("button")
    document.body.append(textarea, other)
    const seen: Array<boolean> = []
    const release = trackTerminalInputFocus(textarea, (focused) => seen.push(focused))

    textarea.focus()
    other.focus()
    release()
    textarea.focus()

    expect(seen).toEqual([true, false])
    textarea.remove()
    other.remove()
  })
})
