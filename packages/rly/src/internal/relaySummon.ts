/** A key the summon machine listens for: the bound chord (Ctrl/⌘+J) or Escape. */
export type RelaySummonKey = "chord" | "escape"

/** What the machine needs to know at the moment a key arrives. */
export interface RelaySummonContext {
  readonly open: boolean
  /** Focus is inside the Relay region. */
  readonly focusInRelay: boolean
  /** Relay is a full-screen dialog (phone), where the chord and Escape both close it. */
  readonly fullscreen: boolean
}

/**
 * What a key does (Relay UX decision): closed → Open (focus the composer); open with focus on the page →
 * FocusComposer; open with focus in Relay → ReturnFocus (back to where you were, Relay stays open);
 * full screen, the chord closes. Escape closes when focus is in Relay or Relay is full screen, and is
 * left to the page otherwise. Ignore means the event is not handled and must not be prevented.
 */
export type RelaySummonEffect = "Open" | "FocusComposer" | "ReturnFocus" | "Close" | "Ignore"

export const relaySummonTransition = (context: RelaySummonContext, key: RelaySummonKey): RelaySummonEffect => {
  if (key === "escape") return context.open && (context.fullscreen || context.focusInRelay) ? "Close" : "Ignore"
  if (!context.open) return "Open"
  if (context.fullscreen) return "Close"
  return context.focusInRelay ? "ReturnFocus" : "FocusComposer"
}

/** The parts of a keyboard event the summon reads. */
export interface RelaySummonKeyEvent {
  readonly altKey: boolean
  readonly code: string
  readonly ctrlKey: boolean
  readonly isComposing: boolean
  readonly key: string
  /** Deprecated, but 229 is still how some browsers mark a key that belongs to an IME. */
  readonly keyCode: number
  readonly metaKey: boolean
  readonly repeat: boolean
  readonly shiftKey: boolean
}

/** A key that belongs to an IME composition; Escape there cancels the composition, never Relay. */
export const isImeKey = (event: RelaySummonKeyEvent): boolean => event.isComposing || event.keyCode === 229

const asciiLetter = /^[a-z]$/i

/**
 * Whether an event is exactly the shortcut's ARIA keys ("Control+J", "Meta+J"): the named modifiers and
 * no others, so Ctrl+Shift+J, Alt chords, an IME composition or a held key's repeats never match. A
 * Latin layout matches the letter the user sees (Dvorak, AZERTY); a non-Latin one (Russian, Greek), where
 * the key is no ASCII letter, matches the physical key instead.
 */
export const matchesShortcutKeys = (keys: string, event: RelaySummonKeyEvent): boolean => {
  if (isImeKey(event) || event.repeat) return false
  const parts = keys.split("+")
  const key = parts.at(-1) ?? ""
  const modifiers = new Set(parts.slice(0, -1))
  const sameKey = asciiLetter.test(event.key)
    ? event.key.toLowerCase() === key.toLowerCase()
    : event.code === `Key${key.toUpperCase()}`
  return (
    sameKey &&
    event.ctrlKey === modifiers.has("Control") &&
    event.metaKey === modifiers.has("Meta") &&
    event.altKey === modifiers.has("Alt") &&
    event.shiftKey === modifiers.has("Shift")
  )
}
