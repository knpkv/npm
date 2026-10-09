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

const dialogLayer = "dialog[open], [role='dialog'], [role='alertdialog']"
const popupLayer = "[role='listbox'], [role='menu']"

/**
 * Whether a key event belongs to a layer nested in or opened from Relay: a dialog, a listbox or menu
 * while it is an open popup (Radix's data-state, or the target of an expanded aria-controls), or an
 * expanded popup controller inside Relay that keeps focus while its popup is open (a combobox). It reads
 * the event's composed path up to Relay's region, so layers inside shadow roots and layers portaled out
 * of Relay (whose path never reaches the region) count. Relay's own surface, marked
 * data-rly-relay-surface (the full-screen dialog), and always-rendered lists never count.
 */
export const hasNestedLayer = (region: HTMLElement | null, path: ReadonlyArray<EventTarget>): boolean => {
  const reachesRegion = region !== null && path.includes(region)
  for (const node of path) {
    if (node === region) return false
    if (!isElementTarget(node) || node.hasAttribute("data-rly-relay-surface")) continue
    if (node.matches(dialogLayer)) return true
    if (node.matches(popupLayer) && isOpenPopup(node)) return true
    if (reachesRegion && node.matches(openController)) return true
  }
  return false
}

/** A control whose popup is open and which keeps focus while it is (a combobox, a menu button). */
const openController =
  "[aria-expanded='true'][aria-controls], [aria-expanded='true'][aria-haspopup]:not([aria-haspopup='false'])"

const isOpenPopup = (element: Element): boolean =>
  element.getAttribute("data-state") === "open" ||
  (element.id !== "" &&
    [...controlScope(element).querySelectorAll("[aria-expanded='true'][aria-controls]")].some((control) =>
      (control.getAttribute("aria-controls") ?? "").split(/\s+/).includes(element.id)
    ))

const isElementTarget = (target: EventTarget): target is Element =>
  "matches" in target && "nodeType" in target && target.nodeType === 1

/** Where a popup's controls live: its own shadow root when it has one, else its document. */
const controlScope = (element: Element): ParentNode => {
  const root = element.getRootNode()
  return isShadowRoot(root) ? root : element.ownerDocument
}

const isShadowRoot = (node: Node): node is ShadowRoot => node.nodeType === 11 && "host" in node
