import type { ComponentPropsWithRef, ReactElement, RefCallback, RefObject } from "react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { focusRestoreTarget, isWithinComposedElement } from "../internal/composedFocus.js"
import { hasNestedLayer, isImeKey, matchesShortcutKeys, relaySummonTransition } from "../internal/relaySummon.js"
import styles from "./RelayLauncher.module.css"
import { RelayMark } from "./RelayMark.js"
import type { RlyRelayMarkActivity } from "./RelayMark.js"

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
  /** Relay is the full-screen dialog (phone): the shortcut closes it. */
  readonly fullscreen: boolean
  /** The launcher: where focus returns when the element Relay was summoned from is gone. */
  readonly launcher: RefObject<HTMLElement | null>
  /**
   * The shortcut to listen for, the same value the launcher advertises; `null` while the host's own
   * surface owns the key (a live terminal). Escape inside Relay keeps working either way.
   */
  readonly shortcut: RlyRelayShortcut | null
}

/** Refs a host attaches so the summon knows Relay's region and composer. */
export interface RlyRelaySummon {
  /** Attach to the composer; a pending summon focuses it as soon as it mounts, however late. */
  readonly composerRef: RefCallback<HTMLElement>
  /** Attach to Relay's region (RelayPanel's `ref`); focus inside it counts as being in Relay. */
  readonly regionRef: RefCallback<HTMLElement>
}

/**
 * Relay's keyboard summon (Relay UX decision). The shortcut opens Relay and focuses the composer; open
 * with focus on the page, it moves focus to the composer; open with focus in Relay, it returns focus to
 * where it came from and Relay stays open; full screen, it closes. Escape closes when focus is in Relay
 * or Relay is full screen, and focus returns once Relay has actually closed (after a modal has released
 * the page). Only the exact chord is handled and prevented, so Ctrl+K, `?`, g-sequences and the browser's
 * other keys pass through. It listens on the launcher's document and on Relay's, if Relay is portaled
 * into another (an iframe).
 */
export const useRelaySummon = (options: UseRelaySummonOptions): RlyRelaySummon => {
  const latest = useRef(options)
  // Read by the key listener; updated only once a render commits, never from a discarded one.
  useLayoutEffect(() => {
    latest.current = options
  })
  const [region, setRegion] = useState<HTMLElement | null>(null)
  const regionNode = useRef<HTMLElement | null>(null)
  const composer = useRef<HTMLElement | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const pendingComposerFocus = useRef(false)
  const pendingRestore = useRef(false)
  const escapeOwnedByLayer = useRef<KeyboardEvent | null>(null)

  // The target is kept while Relay stays open, so a later Escape or shortcut returns to the same place.
  const restoreFocus = useCallback((): void => {
    const target = returnTo.current
    if (target?.isConnected === true) target.focus()
    else latest.current.launcher.current?.focus()
  }, [])
  const regionRef = useCallback((element: HTMLElement | null) => {
    regionNode.current = element
    setRegion(element)
  }, [])
  const composerRef = useCallback((element: HTMLElement | null) => {
    composer.current = element
    if (element === null || !pendingComposerFocus.current) return
    pendingComposerFocus.current = false
    element.focus()
  }, [])

  // Opened any way (the shortcut or the launcher), Relay remembers where focus was so the shortcut can
  // take you back. Closed by the summon, focus goes back only now, after the close has committed.
  useEffect(() => {
    if (!options.open) {
      pendingComposerFocus.current = false
      if (pendingRestore.current) {
        pendingRestore.current = false
        restoreFocus()
      }
      returnTo.current = null
      return
    }
    pendingRestore.current = false
    if (returnTo.current === null) {
      returnTo.current = focusOutside(regionNode.current, latest.current.launcher.current?.ownerDocument ?? document)
    }
    // A composer that was already mounted gets no ref callback, so a pending summon focuses it here.
    if (pendingComposerFocus.current && composer.current !== null) {
      pendingComposerFocus.current = false
      composer.current.focus()
    }
  }, [options.open, restoreFocus])

  const keys = options.shortcut?.keys ?? null
  useEffect(() => {
    const documents = new Set([options.launcher.current?.ownerDocument ?? document, region?.ownerDocument])
    const listeners = [...documents].flatMap((owner) => {
      if (owner === undefined) return []
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || isImeKey(event)) return
        const key =
          event.key === "Escape" ? "escape" : keys !== null && matchesShortcutKeys(keys, event) ? "chord" : undefined
        if (key === undefined) return
        const { fullscreen, onOpenChange, open } = latest.current
        const surface = regionNode.current
        // Escape belongs to a dialog, listbox or menu open inside (or opened from) Relay.
        if (key === "escape" && escapeOwnedByLayer.current === event) return
        const active = focusRestoreTarget(owner)
        const focusInRelay = surface !== null && active !== null && isWithinComposedElement(surface, active)
        const effect = relaySummonTransition({ focusInRelay, fullscreen, open }, key)
        if (effect === "Ignore") return
        event.preventDefault()
        switch (effect) {
          case "Open":
            returnTo.current = focusOutside(surface, owner)
            pendingComposerFocus.current = true
            onOpenChange(true)
            return
          case "FocusComposer":
            returnTo.current = focusOutside(surface, owner)
            if (composer.current === null) pendingComposerFocus.current = true
            else composer.current.focus()
            return
          case "ReturnFocus":
            pendingComposerFocus.current = false
            restoreFocus()
            return
          case "Close":
            pendingComposerFocus.current = false
            pendingRestore.current = true
            onOpenChange(false)
            return
        }
      }
      // A popup's own handler may close it before the event reaches the document, so whether Escape belongs
      // to a nested layer is decided in the capture phase, while the layer is still open.
      const onKeyDownCapture = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && hasNestedLayer(regionNode.current, event.composedPath())) {
          escapeOwnedByLayer.current = event
        }
      }
      owner.addEventListener("keydown", onKeyDownCapture, true)
      owner.addEventListener("keydown", onKeyDown)
      return [
        () => owner.removeEventListener("keydown", onKeyDownCapture, true),
        () => owner.removeEventListener("keydown", onKeyDown)
      ]
    })
    return () => {
      for (const remove of listeners) remove()
    }
  }, [keys, options.launcher, region, restoreFocus])

  return { composerRef, regionRef }
}

/**
 * The element focused in `owner` (the document that received the key, or the launcher's) when it is on
 * the page rather than in Relay, shadow roots included; otherwise null.
 */
const focusOutside = (region: HTMLElement | null, owner: Document): HTMLElement | null => {
  const active = focusRestoreTarget(owner)
  return active !== null && region !== null && isWithinComposedElement(region, active) ? null : active
}

/** Inputs for the launcher. */
export type RelayLauncherProps = Omit<ComponentPropsWithRef<"button">, "children" | "type"> & {
  /** What Relay is doing, shown on the mark; `idle` (still) unless given. Say it in words too. */
  readonly activity?: RlyRelayMarkActivity
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
  activity,
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
      <RelayMark activity={activity} className={style("mark")} size={20} />
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
