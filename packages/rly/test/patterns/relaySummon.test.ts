import { describe, expect, it } from "vitest"
import {
  isImeKey,
  matchesShortcutKeys,
  type RelaySummonContext,
  type RelaySummonEffect,
  type RelaySummonKey,
  relaySummonTransition
} from "../../src/internal/relaySummon.js"

const context = (open: boolean, focusInRelay: boolean, fullscreen: boolean): RelaySummonContext => ({
  focusInRelay,
  fullscreen,
  open
})

const press = (
  key: string,
  modifiers: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "repeat", boolean>> & {
    readonly code?: string
    readonly keyCode?: number
  } = {}
) => ({
  altKey: false,
  code: `Key${key.toUpperCase()}`,
  ctrlKey: false,
  isComposing: false,
  key,
  keyCode: 0,
  metaKey: false,
  repeat: false,
  shiftKey: false,
  ...modifiers
})

describe("relaySummonTransition", () => {
  // Every transition the Relay UX decision names, desktop and full screen.
  const cases: ReadonlyArray<readonly [RelaySummonContext, RelaySummonKey, RelaySummonEffect]> = [
    [context(false, false, false), "chord", "Open"],
    [context(false, false, true), "chord", "Open"],
    [context(true, false, false), "chord", "FocusComposer"],
    [context(true, true, false), "chord", "ReturnFocus"],
    [context(true, false, true), "chord", "Close"],
    [context(true, true, true), "chord", "Close"],
    [context(true, true, false), "escape", "Close"],
    [context(true, false, true), "escape", "Close"],
    [context(true, false, false), "escape", "Ignore"],
    [context(false, false, false), "escape", "Ignore"]
  ]
  it.each(cases)("%o + %s → %s", (state, key, effect) => {
    expect(relaySummonTransition(state, key)).toBe(effect)
  })
})

describe("matchesShortcutKeys", () => {
  it("matches exactly the platform chord", () => {
    expect(matchesShortcutKeys("Control+J", press("j", { ctrlKey: true }))).toBe(true)
    expect(matchesShortcutKeys("Control+J", press("J", { ctrlKey: true }))).toBe(true)
    expect(matchesShortcutKeys("Meta+J", press("j", { metaKey: true }))).toBe(true)
    expect(matchesShortcutKeys("Meta+J", press("j", { ctrlKey: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { metaKey: true }))).toBe(false)
  })

  it("leaves other chords, Alt, Shift, IME composition and key repeats alone", () => {
    expect(matchesShortcutKeys("Control+J", press("k", { ctrlKey: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("?", { shiftKey: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("g"))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j"))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { altKey: true, ctrlKey: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { ctrlKey: true, isComposing: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { ctrlKey: true, repeat: true }))).toBe(false)
    expect(matchesShortcutKeys("Control+J", press("j", { ctrlKey: true, keyCode: 229 }))).toBe(false)
  })

  it("matches the physical J on a non-Latin layout and the visible J on a Latin one", () => {
    // Russian: the J key types "о".
    expect(matchesShortcutKeys("Control+J", press("о", { code: "KeyJ", ctrlKey: true }))).toBe(true)
    expect(matchesShortcutKeys("Control+J", press("О", { code: "KeyJ", ctrlKey: true, shiftKey: true }))).toBe(false)
    // Greek: the J key types "ξ".
    expect(matchesShortcutKeys("Meta+J", press("ξ", { code: "KeyJ", metaKey: true }))).toBe(true)
    // Dvorak: "j" sits on the physical C key, and the physical J key types "h".
    expect(matchesShortcutKeys("Control+J", press("j", { code: "KeyC", ctrlKey: true }))).toBe(true)
    expect(matchesShortcutKeys("Control+J", press("h", { code: "KeyJ", ctrlKey: true }))).toBe(false)
  })

  it("treats composition and keyCode 229 as IME keys", () => {
    expect(isImeKey(press("Escape", { isComposing: true }))).toBe(true)
    expect(isImeKey(press("Process", { keyCode: 229 }))).toBe(true)
    expect(isImeKey(press("Escape"))).toBe(false)
  })
})
