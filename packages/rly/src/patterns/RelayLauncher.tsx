import type { ComponentPropsWithRef, ReactElement, RefObject } from "react"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { focusRestoreTarget, isWithinComposedElement } from "../internal/composedFocus.js"
import { isImeKey, matchesShortcutKeys, relaySummonTransition } from "../internal/relaySummon.js"
import styles from "./RelayLauncher.module.css"
import { RelayMark } from "./RelayMark.js"

const style = (name: string): string => cssClass(styles, name)

/** The keyboard shortcut a launcher advertises: the visible hint and its `aria-keyshortcuts` value. */
export interface RlyRelayShortcut {
  /** Shown beside the label on wider screens, for example "⌘J" or "Ctrl J". */
  readonly hint: string
  /** The ARIA form, for example "Meta+J" or "Control+J". */
  readonly keys: string
}

/** Relay's summon shortcut (Ctrl/⌘+J) as a platform shows it. */
export const relayShortcut = (apple: boolean): RlyRelayShortcut =>
  apple ? { hint: "⌘J", keys: "Meta+J" } : { hint: "Ctrl J", keys: "Control+J" }

/**
 * Whether the browser reports an Apple platform, where the shortcut uses ⌘. Only the browser reads it
 * (useSyncExternalStore's client snapshot); the server renders the non-Apple form.
 */
const isApplePlatform = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
const noSubscription = (): (() => void) => () => undefined

/**
 * Ctrl/⌘+J for the browser's platform, for a host that binds it. The server renders the non-Apple
 * form and an Apple browser switches to ⌘ after hydration without a mismatch. A host that binds the
 * key must also prevent the browser's own Ctrl+J (Downloads in Chrome on Windows and Linux).
 */
export const useRelayShortcut = (): RlyRelayShortcut =>
  relayShortcut(useSyncExternalStore(noSubscription, isApplePlatform, () => false))

/** Inputs for {@link useRelaySummon}. */
export interface UseRelaySummonOptions {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The Relay region; focus inside it counts as being in Relay. */
  readonly region: RefObject<HTMLElement | null>
  /** Where a summon puts focus, the composer. Focused once it renders after opening. */
  readonly composer: RefObject<HTMLElement | null>
  /** The launcher: where focus returns when the element Relay was summoned from is gone. */
  readonly launcher: RefObject<HTMLElement | null>
  /** Relay is the full-screen dialog (phone): the shortcut closes it. */
  readonly fullscreen: boolean
  /**
   * The shortcut to listen for, the same value the launcher advertises; `null` while the host's own
   * surface owns the key (a live terminal), when the launcher button is the only way in.
   */
  readonly shortcut: RlyRelayShortcut | null
}

/**
 * Relay's keyboard summon (Relay UX decision). The shortcut opens Relay and focuses the composer; open
 * with focus on the page, it moves focus to the composer; open with focus in Relay, it returns focus to
 * where it came from and Relay stays open; full screen, it closes. Escape closes when focus is in Relay
 * or Relay is full screen, returning focus. Only the exact chord is handled and prevented, so Ctrl+K,
 * `?`, g-sequences and the browser's other keys pass through.
 */
export const useRelaySummon = (options: UseRelaySummonOptions): void => {
  const latest = useRef(options)
  latest.current = options
  const returnTo = useRef<HTMLElement | null>(null)
  const focusComposerOnOpen = useRef(false)

  // Opened any way (the shortcut or the launcher), Relay remembers where focus was so the shortcut can
  // take you back; a summon then focuses the composer once it has rendered.
  useEffect(() => {
    if (!options.open) {
      returnTo.current = null
      return
    }
    if (returnTo.current === null) returnTo.current = focusOutside(options.region.current)
    if (!focusComposerOnOpen.current) return
    focusComposerOnOpen.current = false
    options.composer.current?.focus()
  }, [options.open, options.composer, options.region])

  const keys = options.shortcut?.keys ?? null
  useEffect(() => {
    if (keys === null) return
    const rememberFocus = (): void => {
      returnTo.current = focusOutside(latest.current.region.current)
    }
    const restoreFocus = (): void => {
      const target = returnTo.current
      returnTo.current = null
      if (target?.isConnected === true) target.focus()
      else latest.current.launcher.current?.focus()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isImeKey(event)) return
      const key = event.key === "Escape" ? "escape" : matchesShortcutKeys(keys, event) ? "chord" : undefined
      if (key === undefined) return
      const { composer, fullscreen, onOpenChange, open, region } = latest.current
      // Escape belongs to a dialog, listbox or menu open inside Relay, even one that doesn't prevent it.
      if (key === "escape" && region.current !== null && hasNestedLayer(region.current, event.target)) return
      const active = focusRestoreTarget(document)
      const focusInRelay = region.current !== null && active !== null && isWithinComposedElement(region.current, active)
      const effect = relaySummonTransition({ focusInRelay, fullscreen, open }, key)
      if (effect === "Ignore") return
      event.preventDefault()
      switch (effect) {
        case "Open":
          rememberFocus()
          focusComposerOnOpen.current = true
          onOpenChange(true)
          return
        case "FocusComposer":
          rememberFocus()
          composer.current?.focus()
          return
        case "ReturnFocus":
          restoreFocus()
          return
        case "Close":
          onOpenChange(false)
          restoreFocus()
          return
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [keys])
}

const nestedLayer = "dialog[open], [role='dialog'], [role='alertdialog'], [role='listbox'], [role='menu']"

/** Whether an event comes from a layer nested inside Relay, not from Relay's own region. */
const hasNestedLayer = (region: HTMLElement, target: EventTarget | null): boolean => {
  const layer = isElementTarget(target) ? target.closest(nestedLayer) : null
  return layer !== null && layer !== region && region.contains(layer)
}

const isElementTarget = (target: EventTarget | null): target is Element =>
  target !== null && "closest" in target && "nodeType" in target && target.nodeType === 1

/** The focused element when it is on the page rather than in Relay (shadow roots included), else null. */
const focusOutside = (region: HTMLElement | null): HTMLElement | null => {
  const active = focusRestoreTarget(document)
  return active !== null && region !== null && isWithinComposedElement(region, active) ? null : active
}

/** Inputs for the launcher. */
export type RelayLauncherProps = Omit<ComponentPropsWithRef<"button">, "children" | "type"> & {
  /** Whether Relay is open; announced as the button's expanded state. */
  readonly expanded: boolean
  /** The visible name, "Relay" unless the host names its Relay more specifically. */
  readonly label?: string
  /**
   * The shortcut the host actually binds, usually `useRelayShortcut()`, or `null` when it binds none
   * (a live terminal that keeps its own chords). Required, so a launcher never advertises a key that
   * does nothing.
   */
  readonly shortcut: RlyRelayShortcut | null
}

/**
 * The header button that opens and closes Relay: its mark, a label and the shortcut hint. It sits in
 * the host's header like any other control, never fixed over the page. The hint hides on narrow
 * screens, and the button stays 32px tall (44px for a coarse pointer).
 */
export const RelayLauncher = ({
  className,
  expanded,
  label = "Relay",
  shortcut,
  ...props
}: RelayLauncherProps): ReactElement => {
  return (
    <button
      {...props}
      aria-expanded={expanded}
      aria-keyshortcuts={shortcut === null ? undefined : requireText(shortcut.keys, "RelayLauncher shortcut keys")}
      className={classNames(style("root"), className)}
      data-rly-relay-launcher=""
      type="button"
    >
      <RelayMark className={style("mark")} size={20} />
      <span className={style("label")}>{requireText(label, "RelayLauncher label")}</span>
      {shortcut === null ? null : (
        // The hint repeats aria-keyshortcuts for sighted users, so assistive technology hears it once.
        <kbd aria-hidden="true" className={style("hint")}>
          {requireText(shortcut.hint, "RelayLauncher shortcut hint")}
        </kbd>
      )}
    </button>
  )
}
