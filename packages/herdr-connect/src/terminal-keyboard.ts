import { Schema } from "effect"
import type { TerminalClientCommand } from "./model.js"

export const TerminalModifier = Schema.Literals(["ctrl", "alt"])
export type TerminalModifier = typeof TerminalModifier.Type

export const TerminalRailKey = Schema.Literals([
  "escape",
  "tab",
  "arrowLeft",
  "arrowUp",
  "arrowDown",
  "arrowRight",
  "c",
  "d",
  "l",
  "z"
])
export type TerminalRailKey = typeof TerminalRailKey.Type

export type TerminalKeyDescriptor = {
  readonly key: TerminalRailKey
  readonly label: string
  readonly ariaLabel: string
  readonly shortcut: string
}

export const terminalModifiers: ReadonlyArray<TerminalModifier> = ["ctrl", "alt"]

export const terminalKeyDescriptors: ReadonlyArray<TerminalKeyDescriptor> = [
  { key: "escape", label: "Esc", ariaLabel: "Escape", shortcut: "Escape" },
  { key: "tab", label: "Tab", ariaLabel: "Tab", shortcut: "Tab" },
  { key: "arrowLeft", label: "←", ariaLabel: "Arrow left", shortcut: "ArrowLeft" },
  { key: "arrowUp", label: "↑", ariaLabel: "Arrow up", shortcut: "ArrowUp" },
  { key: "arrowDown", label: "↓", ariaLabel: "Arrow down", shortcut: "ArrowDown" },
  { key: "arrowRight", label: "→", ariaLabel: "Arrow right", shortcut: "ArrowRight" },
  { key: "c", label: "C", ariaLabel: "C", shortcut: "C" },
  { key: "d", label: "D", ariaLabel: "D", shortcut: "D" },
  { key: "l", label: "L", ariaLabel: "L", shortcut: "L" },
  { key: "z", label: "Z", ariaLabel: "Z", shortcut: "Z" }
]

type TerminalKeySerialization =
  | { readonly _tag: "supported"; readonly text: string }
  | { readonly _tag: "unsupported"; readonly reason: "modifier_combination_not_supported" }

type TerminalInputCommand = Extract<TerminalClientCommand, { readonly type: "terminal.input" }>

const unsupported = (): TerminalKeySerialization => ({
  _tag: "unsupported",
  reason: "modifier_combination_not_supported"
})

const supported = (text: string): TerminalKeySerialization => ({ _tag: "supported", text })

const controlCharacter = (key: Extract<TerminalRailKey, "c" | "d" | "l" | "z">): string => {
  switch (key) {
    case "c":
      return "\u0003"
    case "d":
      return "\u0004"
    case "l":
      return "\u000c"
    case "z":
      return "\u001a"
  }
}

const arrowCode = (
  key: Extract<TerminalRailKey, "arrowLeft" | "arrowUp" | "arrowDown" | "arrowRight">
): string => {
  switch (key) {
    case "arrowLeft":
      return "D"
    case "arrowUp":
      return "A"
    case "arrowDown":
      return "B"
    case "arrowRight":
      return "C"
  }
}

/** Serialize one fixed terminal key without accepting arbitrary command text. */
export const serializeTerminalKey = (
  key: TerminalRailKey,
  modifier: TerminalModifier | null
): TerminalKeySerialization => {
  switch (key) {
    case "escape":
      return modifier === null ? supported("\u001b") : unsupported()
    case "tab":
      return modifier === "ctrl" ? unsupported() : supported(modifier === "alt" ? "\u001b\t" : "\t")
    case "arrowLeft":
    case "arrowUp":
    case "arrowDown":
    case "arrowRight": {
      const code = arrowCode(key)
      return supported(
        modifier === null
          ? `\u001b[${code}`
          : `\u001b[1;${modifier === "ctrl" ? "5" : "3"}${code}`
      )
    }
    case "c":
    case "d":
    case "l":
    case "z":
      return modifier === "ctrl"
        ? supported(controlCharacter(key))
        : modifier === "alt"
        ? supported(`\u001b${key}`)
        : unsupported()
  }
}

export type TerminalKeyDispatch =
  | {
    readonly _tag: "sent"
    readonly command: TerminalInputCommand
    readonly nextModifier: null
  }
  | {
    readonly _tag: "unsupported"
    readonly reason: "modifier_combination_not_supported"
    readonly nextModifier: TerminalModifier | null
  }

/** Apply a rail key and clear a successful one-shot modifier. */
export const dispatchTerminalKey = (
  key: TerminalRailKey,
  modifier: TerminalModifier | null
): TerminalKeyDispatch => {
  const serialization = serializeTerminalKey(key, modifier)
  return serialization._tag === "supported"
    ? {
      _tag: "sent",
      command: { type: "terminal.input", text: serialization.text },
      nextModifier: null
    }
    : {
      _tag: "unsupported",
      reason: serialization.reason,
      nextModifier: modifier
    }
}

export const toggleTerminalModifier = (
  current: TerminalModifier | null,
  next: TerminalModifier
): TerminalModifier | null => (current === next ? null : next)

export type TerminalInputApplication =
  | { readonly _tag: "supported"; readonly text: string; readonly nextModifier: null }
  | {
    readonly _tag: "unsupported"
    readonly reason: "modifier_combination_not_supported"
    readonly nextModifier: TerminalModifier
  }

const arrowInputs: ReadonlyArray<readonly [string, string, string]> = [
  ["\u001b[A", "\u001b[1;5A", "\u001b[1;3A"],
  ["\u001b[B", "\u001b[1;5B", "\u001b[1;3B"],
  ["\u001b[C", "\u001b[1;5C", "\u001b[1;3C"],
  ["\u001b[D", "\u001b[1;5D", "\u001b[1;3D"]
]

const terminalInputWithModifier = (
  modifier: TerminalModifier,
  text: string
): TerminalInputApplication => {
  if (text.length !== 1 && text !== "\u001b[A" && text !== "\u001b[B" && text !== "\u001b[C" && text !== "\u001b[D") {
    return { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
  }
  if (text === "\u0003" || text === "\u0004" || text === "\u000c" || text === "\u001a") {
    return modifier === "ctrl"
      ? { _tag: "supported", text, nextModifier: null }
      : { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
  }
  if (text === "\t") {
    return modifier === "alt"
      ? { _tag: "supported", text: "\u001b\t", nextModifier: null }
      : { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
  }
  const arrow = arrowInputs.find(([plain]) => plain === text)
  if (arrow !== undefined) {
    return { _tag: "supported", text: modifier === "ctrl" ? arrow[1] : arrow[2], nextModifier: null }
  }
  switch (text) {
    case "c":
    case "d":
    case "l":
    case "z":
      return {
        _tag: "supported",
        text: modifier === "ctrl" ? controlCharacter(text) : `\u001b${text}`,
        nextModifier: null
      }
    default:
      return { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
  }
}

/** Apply a latched modifier to one Ghostty input chunk using only known encodings. */
export const applyTerminalModifierToInput = (
  modifier: TerminalModifier | null,
  text: string
): TerminalInputApplication =>
  modifier === null
    ? { _tag: "supported", text, nextModifier: null }
    : terminalInputWithModifier(modifier, text)
