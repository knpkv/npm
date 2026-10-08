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

/** The parts of a keyboard event the chord match reads. */
export interface RelaySummonKeyEvent {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly isComposing: boolean
  readonly key: string
  readonly metaKey: boolean
  readonly repeat: boolean
  readonly shiftKey: boolean
}

/**
 * Whether an event is exactly the shortcut's ARIA keys ("Control+J", "Meta+J"): the named modifiers and
 * no others, so Ctrl+Shift+J, Alt chords, an IME composition or a held key's repeats never match.
 */
export const matchesShortcutKeys = (keys: string, event: RelaySummonKeyEvent): boolean => {
  if (event.isComposing || event.repeat) return false
  const parts = keys.split("+")
  const key = parts.at(-1) ?? ""
  const modifiers = new Set(parts.slice(0, -1))
  return (
    event.key.toLowerCase() === key.toLowerCase() &&
    event.ctrlKey === modifiers.has("Control") &&
    event.metaKey === modifiers.has("Meta") &&
    event.altKey === modifiers.has("Alt") &&
    event.shiftKey === modifiers.has("Shift")
  )
}
