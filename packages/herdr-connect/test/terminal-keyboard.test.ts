import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { TerminalClientCommand } from "../src/model.js"
import {
  applyTerminalModifierToInput,
  dispatchTerminalKey,
  serializeTerminalKey,
  type TerminalModifier,
  type TerminalRailKey,
  toggleTerminalModifier
} from "../src/terminal-keyboard.js"

describe("terminal keyboard rail", () => {
  it("serializes fixed special keys through the existing terminal input command", () => {
    const cases: ReadonlyArray<readonly [TerminalRailKey, TerminalModifier | null, string]> = [
      ["escape", null, "\u001b"],
      ["tab", null, "\t"],
      ["tab", "alt", "\u001b\t"],
      ["arrowUp", null, "\u001b[A"],
      ["arrowLeft", "ctrl", "\u001b[1;5D"],
      ["arrowRight", "alt", "\u001b[1;3C"]
    ]

    for (const [key, modifier, text] of cases) {
      const dispatch = dispatchTerminalKey(key, modifier)
      expect(dispatch).toEqual({
        _tag: "sent",
        command: { type: "terminal.input", text },
        nextModifier: null
      })
      if (dispatch._tag === "sent") {
        expect(Schema.decodeUnknownSync(TerminalClientCommand)(dispatch.command)).toEqual(dispatch.command)
      }
    }
  })

  it("uses application-cursor SS3 sequences only when the live mode is enabled", () => {
    expect(serializeTerminalKey("arrowUp", null, "normal")).toEqual({
      _tag: "supported",
      text: "\u001b[A"
    })
    expect(serializeTerminalKey("arrowUp", null, "application")).toEqual({
      _tag: "supported",
      text: "\u001bOA"
    })
    expect(dispatchTerminalKey("arrowLeft", null, "application")).toEqual({
      _tag: "sent",
      command: { type: "terminal.input", text: "\u001bOD" },
      nextModifier: null
    })
  })

  it("keeps unsupported combinations rejected and modifiers deterministic", () => {
    expect(toggleTerminalModifier(null, "ctrl")).toBe("ctrl")
    expect(toggleTerminalModifier("ctrl", "ctrl")).toBeNull()
    expect(toggleTerminalModifier("ctrl", "alt")).toBe("alt")

    expect(dispatchTerminalKey("tab", "ctrl")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: "ctrl"
    })
    expect(serializeTerminalKey("escape", "alt")._tag).toBe("unsupported")
  })

  it("applies a latched modifier to one compatible terminal input and then resets", () => {
    expect(applyTerminalModifierToInput(null, "echo hello\n")).toEqual({
      _tag: "supported",
      text: "echo hello\n",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("ctrl", "c")).toEqual({
      _tag: "supported",
      text: "\u0003",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("ctrl", "\u001b[1;5A")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("ctrl", "\u001bOA")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("ctrl", "\u001b[A")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("alt", "d")).toEqual({
      _tag: "supported",
      text: "\u001bd",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("alt", "\u001bd")).toEqual({
      _tag: "supported",
      text: "\u001bd",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("alt", "\t")).toEqual({
      _tag: "supported",
      text: "\u001b\t",
      nextModifier: null
    })
    expect(applyTerminalModifierToInput("alt", "\u001b\t")).toEqual({
      _tag: "supported",
      text: "\u001b\t",
      nextModifier: null
    })
  })

  it("does not rewrite or send an unsupported latched input", () => {
    expect(applyTerminalModifierToInput("ctrl", "x")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: "ctrl"
    })
    expect(applyTerminalModifierToInput("alt", "echo\n")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: "alt"
    })
    expect(applyTerminalModifierToInput("ctrl", "\u001b[1;3A")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: "ctrl"
    })
  })
})
