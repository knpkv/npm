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
  "arrowRight"
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
  { key: "arrowRight", label: "→", ariaLabel: "Arrow right", shortcut: "ArrowRight" }
]

export type TerminalKeySerialization =
  | { readonly _tag: "supported"; readonly text: string }
  | { readonly _tag: "unsupported"; readonly reason: "modifier_combination_not_supported" }

type TerminalInputCommand = Extract<TerminalClientCommand, { readonly type: "terminal.input" }>

const unsupported = (): TerminalKeySerialization => ({
  _tag: "unsupported",
  reason: "modifier_combination_not_supported"
})

const supported = (text: string): TerminalKeySerialization => ({ _tag: "supported", text })

type TerminalControlKey = "c" | "d" | "l" | "z"

const controlCharacter = (key: TerminalControlKey): string => {
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

type ArrowDefinition = {
  readonly key: Extract<TerminalRailKey, "arrowLeft" | "arrowUp" | "arrowDown" | "arrowRight">
  readonly code: "A" | "B" | "C" | "D"
}

const arrowDefinitions: ReadonlyArray<ArrowDefinition> = [
  { key: "arrowUp", code: "A" },
  { key: "arrowDown", code: "B" },
  { key: "arrowRight", code: "C" },
  { key: "arrowLeft", code: "D" }
]

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
    default:
      return unsupported()
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

const arrowInputs: ReadonlyArray<{
  readonly plain: string
  readonly ctrl: string
  readonly alt: string
}> = arrowDefinitions.map(({ code }) => ({
  plain: `\u001b[${code}`,
  ctrl: `\u001b[1;5${code}`,
  alt: `\u001b[1;3${code}`
}))

const modifierCharacterInputs: ReadonlyArray<{
  readonly plain: string
  readonly encoded: string
}> = ["c", "d", "l", "z"].map((key) => ({
  plain: key,
  encoded: `\u001b${key}`
}))

const terminalInputWithModifier = (
  modifier: TerminalModifier,
  text: string
): TerminalInputApplication => {
  const arrow = arrowInputs.find((candidate) => candidate.plain === text || candidate[modifier] === text)
  if (arrow !== undefined) {
    return { _tag: "supported", text: arrow[modifier], nextModifier: null }
  }
  if (modifier === "ctrl") {
    if (text === "\u0003" || text === "\u0004" || text === "\u000c" || text === "\u001a") {
      return { _tag: "supported", text, nextModifier: null }
    }
    if (text === "c" || text === "d" || text === "l" || text === "z") {
      return { _tag: "supported", text: controlCharacter(text), nextModifier: null }
    }
  }
  if (modifier === "alt") {
    const character = modifierCharacterInputs.find((candidate) =>
      candidate.plain === text || candidate.encoded === text
    )
    if (character !== undefined) {
      return { _tag: "supported", text: character.encoded, nextModifier: null }
    }
    if (text === "\t" || text === "\u001b\t") {
      return { _tag: "supported", text: "\u001b\t", nextModifier: null }
    }
  }
  return { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
}

/** Apply a latched modifier to one Ghostty input chunk using only known encodings. */
export const applyTerminalModifierToInput = (
  modifier: TerminalModifier | null,
  text: string
): TerminalInputApplication =>
  modifier === null
    ? { _tag: "supported", text, nextModifier: null }
    : terminalInputWithModifier(modifier, text)
