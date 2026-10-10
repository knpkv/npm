import { Schema } from "effect"
import type { TerminalClientCommand } from "./model.js"

export const TerminalModifier = Schema.Literals(["ctrl", "alt", "shift"])
export type TerminalModifier = typeof TerminalModifier.Type

export type TerminalModifiers = {
  readonly base: "ctrl" | "alt" | null
  readonly shift: boolean
}

export const noTerminalModifiers: TerminalModifiers = { base: null, shift: false }

export const terminalModifierIsActive = (modifiers: TerminalModifiers, key: TerminalModifier): boolean =>
  key === "shift" ? modifiers.shift : modifiers.base === key

export const TerminalCursorMode = Schema.Literals(["normal", "application"])
export type TerminalCursorMode = typeof TerminalCursorMode.Type

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
}

export const terminalModifiers: ReadonlyArray<TerminalModifier> = ["ctrl", "alt", "shift"]

export const terminalKeyDescriptors: ReadonlyArray<TerminalKeyDescriptor> = [
  { key: "escape", label: "Esc", ariaLabel: "Escape" },
  { key: "tab", label: "Tab", ariaLabel: "Tab" },
  { key: "arrowLeft", label: "←", ariaLabel: "Arrow left" },
  { key: "arrowUp", label: "↑", ariaLabel: "Arrow up" },
  { key: "arrowDown", label: "↓", ariaLabel: "Arrow down" },
  { key: "arrowRight", label: "→", ariaLabel: "Arrow right" }
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
): "A" | "B" | "C" | "D" => {
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

const arrowSequence = (code: "A" | "B" | "C" | "D", cursorMode: TerminalCursorMode): string =>
  cursorMode === "application" ? `\u001bO${code}` : `\u001b[${code}`

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
  modifier: TerminalModifiers,
  cursorMode: TerminalCursorMode = "normal"
): TerminalKeySerialization => {
  switch (key) {
    case "escape":
      return modifier.base === null && !modifier.shift ? supported("\u001b") : unsupported()
    case "tab":
      if (modifier.base === "ctrl") return unsupported()
      if (modifier.shift) return modifier.base === null ? supported("\u001b[Z") : unsupported()
      return supported(modifier.base === "alt" ? "\u001b\t" : "\t")
    case "arrowLeft":
    case "arrowUp":
    case "arrowDown":
    case "arrowRight": {
      const code = arrowCode(key)
      return supported(
        modifier.base === null && !modifier.shift
          ? arrowSequence(code, cursorMode)
          : modifiedArrowSequence(code, modifier)
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
    readonly nextModifier: TerminalModifiers
  }
  | {
    readonly _tag: "unsupported"
    readonly reason: "modifier_combination_not_supported"
    readonly nextModifier: TerminalModifiers
  }

/** Apply a rail key and clear a successful one-shot modifier. */
export const dispatchTerminalKey = (
  key: TerminalRailKey,
  modifier: TerminalModifiers,
  cursorMode: TerminalCursorMode = "normal"
): TerminalKeyDispatch => {
  const serialization = serializeTerminalKey(key, modifier, cursorMode)
  return serialization._tag === "supported"
    ? {
      _tag: "sent",
      command: { type: "terminal.input", text: serialization.text },
      nextModifier: noTerminalModifiers
    }
    : {
      _tag: "unsupported",
      reason: serialization.reason,
      nextModifier: modifier
    }
}

export const toggleTerminalModifier = (
  current: TerminalModifiers,
  next: TerminalModifier
): TerminalModifiers =>
  next === "shift"
    ? { ...current, shift: !current.shift }
    : { ...current, base: current.base === next ? null : next }

export type TerminalInputApplication =
  | { readonly _tag: "supported"; readonly text: string; readonly nextModifier: TerminalModifiers }
  | {
    readonly _tag: "unsupported"
    readonly reason: "modifier_combination_not_supported"
    readonly nextModifier: TerminalModifiers
  }

const modifiedArrowSequence = (code: "A" | "B" | "C" | "D", modifiers: TerminalModifiers): string => {
  const parameter = 1 + (modifiers.shift ? 1 : 0) + (modifiers.base === "ctrl" ? 4 : modifiers.base === "alt" ? 2 : 0)
  return `\u001b[1;${parameter}${code}`
}

const arrowInputs: ReadonlyArray<{
  readonly plain: string
  readonly application: string
  readonly ctrl: string
  readonly alt: string
  readonly code: "A" | "B" | "C" | "D"
}> = arrowDefinitions.map(({ code }) => ({
  code,
  plain: `\u001b[${code}`,
  application: `\u001bO${code}`,
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
  modifier: TerminalModifiers,
  text: string
): TerminalInputApplication => {
  const arrow = arrowInputs.find(
    (candidate) =>
      candidate.plain === text || candidate.application === text ||
      (modifier.base !== null && candidate[modifier.base] === text) ||
      modifiedArrowSequence(candidate.code, modifier) === text
  )
  if (arrow !== undefined) {
    return { _tag: "supported", text: modifiedArrowSequence(arrow.code, modifier), nextModifier: noTerminalModifiers }
  }
  if (modifier.shift && modifier.base === null) {
    if (text === "\t" || text === "\u001b[Z") {
      return { _tag: "supported", text: "\u001b[Z", nextModifier: noTerminalModifiers }
    }
    // CSI-u preserves Shift+Enter through the PTY and is Claude Code's newline key.
    if (text === "\r" || text === "\u001b[13;2u") {
      return { _tag: "supported", text: "\u001b[13;2u", nextModifier: noTerminalModifiers }
    }
    if (/^[a-z]$/i.test(text)) {
      return { _tag: "supported", text: text.toUpperCase(), nextModifier: noTerminalModifiers }
    }
  }
  if (modifier.base === "ctrl") {
    if (text === "\u0003" || text === "\u0004" || text === "\u000c" || text === "\u001a") {
      return { _tag: "supported", text, nextModifier: noTerminalModifiers }
    }
    const controlKey = text.length === 1 ? text.toLowerCase() : text
    if (controlKey === "c" || controlKey === "d" || controlKey === "l" || controlKey === "z") {
      return { _tag: "supported", text: controlCharacter(controlKey), nextModifier: noTerminalModifiers }
    }
  }
  if (modifier.base === "alt") {
    const normalized = text.length === 1
      ? text.toLowerCase()
      : text.length === 2 && text.startsWith("\u001b")
      ? `\u001b${text.slice(1).toLowerCase()}`
      : text
    const character = modifierCharacterInputs.find((candidate) =>
      candidate.plain === normalized || candidate.encoded === normalized
    )
    if (character !== undefined) {
      return {
        _tag: "supported",
        text: modifier.shift
          ? `\u001b${text.slice(text.startsWith("\u001b") ? 1 : 0).toUpperCase()}`
          : text.length === 1
          ? `\u001b${text}`
          : text,
        nextModifier: noTerminalModifiers
      }
    }
    if (!modifier.shift && (text === "\t" || text === "\u001b\t")) {
      return { _tag: "supported", text: "\u001b\t", nextModifier: noTerminalModifiers }
    }
  }
  return { _tag: "unsupported", reason: "modifier_combination_not_supported", nextModifier: modifier }
}

/** Apply a latched modifier to one Ghostty input chunk using only known encodings. */
export const applyTerminalModifierToInput = (
  modifier: TerminalModifiers,
  text: string
): TerminalInputApplication =>
  modifier.base === null && !modifier.shift
    ? { _tag: "supported", text, nextModifier: noTerminalModifiers }
    : terminalInputWithModifier(modifier, text)
