import { describe, expect, it } from "@effect/vitest"
import {
  applyTerminalModifierToInput,
  dispatchTerminalKey,
  serializeTerminalKey,
  type TerminalModifiers,
  type TerminalRailKey,
  toggleTerminalModifier
} from "../src/terminal-keyboard.js"

const none: TerminalModifiers = { base: null, shift: false }
const shift: TerminalModifiers = { base: null, shift: true }
const ctrlShift: TerminalModifiers = { base: "ctrl", shift: true }
const altShift: TerminalModifiers = { base: "alt", shift: true }

describe("one-shot terminal Shift", () => {
  it("sends back-tab and releases Shift after one use", () => {
    expect(dispatchTerminalKey("tab", shift)).toEqual({
      _tag: "sent",
      command: { type: "terminal.input", text: "\u001b[Z" },
      nextModifier: none
    })
    expect(applyTerminalModifierToInput(shift, "\t")).toEqual({
      _tag: "supported",
      text: "\u001b[Z",
      nextModifier: none
    })
  })

  const arrows: ReadonlyArray<readonly [TerminalRailKey, string]> = [
    ["arrowUp", "A"],
    ["arrowDown", "B"],
    ["arrowRight", "C"],
    ["arrowLeft", "D"]
  ]
  const combinations: ReadonlyArray<readonly [string, TerminalModifiers, number]> = [
    ["Shift", shift, 2],
    ["Ctrl+Shift", ctrlShift, 6],
    ["Alt+Shift", altShift, 4]
  ]
  for (const [label, modifiers, parameter] of combinations) {
    for (const [key, code] of arrows) {
      it(`sends ${label}+${key} with xterm parameter ${parameter}`, () => {
        const text = `\u001b[1;${parameter}${code}`
        expect(serializeTerminalKey(key, modifiers, "application")).toEqual({ _tag: "supported", text })
        for (const input of [`\u001b[${code}`, `\u001bO${code}`, text]) {
          expect(applyTerminalModifierToInput(modifiers, input)).toEqual({
            _tag: "supported",
            text,
            nextModifier: none
          })
        }
      })
    }
  }

  it("sends Shift+Enter as CSI-u newline and releases the modifier", () => {
    for (const input of ["\r", "\u001b[13;2u"]) {
      expect(applyTerminalModifierToInput(shift, input)).toEqual({
        _tag: "supported",
        text: "\u001b[13;2u",
        nextModifier: none
      })
    }
  })

  it("uppercases one typed letter and releases Shift", () => {
    for (const input of ["a", "z", "A"]) {
      expect(applyTerminalModifierToInput(shift, input)).toEqual({
        _tag: "supported",
        text: input.toUpperCase(),
        nextModifier: none
      })
    }
  })

  it("keeps supported Ctrl control letters byte-identical with Shift", () => {
    expect(applyTerminalModifierToInput(ctrlShift, "c")).toEqual({
      _tag: "supported",
      text: "\u0003",
      nextModifier: none
    })
  })

  it("uppercases supported Alt letters without doubling Escape", () => {
    for (const input of ["d", "\u001bd", "\u001bD"]) {
      expect(applyTerminalModifierToInput(altShift, input)).toEqual({
        _tag: "supported",
        text: "\u001bD",
        nextModifier: none
      })
    }
  })

  it("toggles Shift independently while Ctrl and Alt remain exclusive", () => {
    expect(toggleTerminalModifier(none, "shift")).toEqual(shift)
    expect(toggleTerminalModifier(shift, "shift")).toEqual(none)
    expect(toggleTerminalModifier(shift, "ctrl")).toEqual(ctrlShift)
    expect(toggleTerminalModifier(ctrlShift, "alt")).toEqual(altShift)
    expect(toggleTerminalModifier(ctrlShift, "shift")).toEqual({ base: "ctrl", shift: false })
    expect(toggleTerminalModifier(ctrlShift, "ctrl")).toEqual(shift)
    expect(none).toEqual({ base: null, shift: false })
  })

  it("retains unsupported input and modifier combinations without consuming Shift", () => {
    const inputs: ReadonlyArray<readonly [TerminalModifiers, string]> = [
      [shift, "hello"],
      [shift, "1"],
      [ctrlShift, "x"],
      [altShift, "x"],
      [ctrlShift, "\r"],
      [altShift, "\r"],
      [altShift, "\t"]
    ]
    for (const [modifiers, input] of inputs) {
      expect(applyTerminalModifierToInput(modifiers, input)).toEqual({
        _tag: "unsupported",
        reason: "modifier_combination_not_supported",
        nextModifier: modifiers
      })
    }
    expect(serializeTerminalKey("escape", shift)._tag).toBe("unsupported")
    expect(serializeTerminalKey("tab", ctrlShift)._tag).toBe("unsupported")
    expect(serializeTerminalKey("tab", altShift)._tag).toBe("unsupported")
  })
})
