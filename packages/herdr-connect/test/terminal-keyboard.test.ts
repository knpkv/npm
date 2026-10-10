import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { TerminalClientCommand } from "../src/model.js"
import {
  applyTerminalModifierToInput,
  dispatchTerminalKey,
  noTerminalModifiers,
  serializeTerminalKey,
  type TerminalModifiers,
  type TerminalRailKey,
  toggleTerminalModifier
} from "../src/terminal-keyboard.js"

const ctrl: TerminalModifiers = { base: "ctrl", shift: false }
const alt: TerminalModifiers = { base: "alt", shift: false }

describe("terminal keyboard rail", () => {
  it("preserves every existing Ctrl and Alt arrow and control-letter byte", () => {
    const arrows: ReadonlyArray<readonly [TerminalRailKey, string]> = [
      ["arrowUp", "A"],
      ["arrowDown", "B"],
      ["arrowRight", "C"],
      ["arrowLeft", "D"]
    ]
    for (const [key, code] of arrows) {
      for (
        const [modifier, parameter] of [[ctrl, 5], [alt, 3]] satisfies ReadonlyArray<
          readonly [TerminalModifiers, number]
        >
      ) {
        const text = `\u001b[1;${parameter}${code}`
        expect(serializeTerminalKey(key, modifier)).toEqual({ _tag: "supported", text })
        for (const input of [`\u001b[${code}`, `\u001bO${code}`, text]) {
          expect(applyTerminalModifierToInput(modifier, input)).toEqual({
            _tag: "supported",
            text,
            nextModifier: noTerminalModifiers
          })
        }
      }
    }
    const controls: ReadonlyArray<readonly [string, string]> = [
      ["c", "\u0003"],
      ["d", "\u0004"],
      ["l", "\u000c"],
      ["z", "\u001a"]
    ]
    for (const [letter, control] of controls) {
      for (const input of [letter, letter.toUpperCase(), control]) {
        expect(applyTerminalModifierToInput(ctrl, input)).toEqual({
          _tag: "supported",
          text: control,
          nextModifier: noTerminalModifiers
        })
      }
      for (const input of [letter, letter.toUpperCase(), `\u001b${letter}`, `\u001b${letter.toUpperCase()}`]) {
        expect(applyTerminalModifierToInput(alt, input)).toEqual({
          _tag: "supported",
          text: input.startsWith("\u001b") ? input : `\u001b${input}`,
          nextModifier: noTerminalModifiers
        })
      }
    }
  })

  it("serializes fixed special keys through the existing terminal input command", () => {
    const cases: ReadonlyArray<readonly [TerminalRailKey, TerminalModifiers, string]> = [
      ["escape", noTerminalModifiers, "\u001b"],
      ["tab", noTerminalModifiers, "\t"],
      ["tab", alt, "\u001b\t"],
      ["arrowUp", noTerminalModifiers, "\u001b[A"],
      ["arrowLeft", ctrl, "\u001b[1;5D"],
      ["arrowRight", alt, "\u001b[1;3C"]
    ]

    for (const [key, modifier, text] of cases) {
      const dispatch = dispatchTerminalKey(key, modifier)
      expect(dispatch).toEqual({
        _tag: "sent",
        command: { type: "terminal.input", text },
        nextModifier: noTerminalModifiers
      })
      if (dispatch._tag === "sent") {
        expect(Schema.decodeUnknownSync(TerminalClientCommand)(dispatch.command)).toEqual(dispatch.command)
      }
    }
  })

  it("uses application-cursor SS3 sequences only when the live mode is enabled", () => {
    expect(serializeTerminalKey("arrowUp", noTerminalModifiers, "normal")).toEqual({
      _tag: "supported",
      text: "\u001b[A"
    })
    expect(serializeTerminalKey("arrowUp", noTerminalModifiers, "application")).toEqual({
      _tag: "supported",
      text: "\u001bOA"
    })
    expect(dispatchTerminalKey("arrowLeft", noTerminalModifiers, "application")).toEqual({
      _tag: "sent",
      command: { type: "terminal.input", text: "\u001bOD" },
      nextModifier: noTerminalModifiers
    })
  })

  it("keeps unsupported combinations rejected and modifiers deterministic", () => {
    expect(toggleTerminalModifier(noTerminalModifiers, "ctrl")).toEqual(ctrl)
    expect(toggleTerminalModifier(ctrl, "ctrl")).toEqual(noTerminalModifiers)
    expect(toggleTerminalModifier(ctrl, "alt")).toEqual(alt)

    expect(dispatchTerminalKey("tab", ctrl)).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: ctrl
    })
    expect(serializeTerminalKey("escape", alt)._tag).toBe("unsupported")
  })

  it("applies a latched modifier to one compatible terminal input and then resets", () => {
    expect(applyTerminalModifierToInput(noTerminalModifiers, "echo hello\n")).toEqual({
      _tag: "supported",
      text: "echo hello\n",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(ctrl, "c")).toEqual({
      _tag: "supported",
      text: "\u0003",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(ctrl, "C")).toEqual({
      _tag: "supported",
      text: "\u0003",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(ctrl, "\u001b[1;5A")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(ctrl, "\u001bOA")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(ctrl, "\u001b[A")).toEqual({
      _tag: "supported",
      text: "\u001b[1;5A",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "d")).toEqual({
      _tag: "supported",
      text: "\u001bd",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "D")).toEqual({
      _tag: "supported",
      text: "\u001bD",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "\u001bd")).toEqual({
      _tag: "supported",
      text: "\u001bd",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "\u001bD")).toEqual({
      _tag: "supported",
      text: "\u001bD",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "\t")).toEqual({
      _tag: "supported",
      text: "\u001b\t",
      nextModifier: noTerminalModifiers
    })
    expect(applyTerminalModifierToInput(alt, "\u001b\t")).toEqual({
      _tag: "supported",
      text: "\u001b\t",
      nextModifier: noTerminalModifiers
    })
  })

  it("does not rewrite or send an unsupported latched input", () => {
    expect(applyTerminalModifierToInput(ctrl, "x")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: ctrl
    })
    expect(applyTerminalModifierToInput(alt, "echo\n")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: alt
    })
    expect(applyTerminalModifierToInput(ctrl, "\u001b[1;3A")).toEqual({
      _tag: "unsupported",
      reason: "modifier_combination_not_supported",
      nextModifier: ctrl
    })
  })
})
