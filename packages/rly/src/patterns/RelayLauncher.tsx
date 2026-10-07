import type { ComponentPropsWithRef, ReactElement } from "react"
import { useSyncExternalStore } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
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
      aria-keyshortcuts={shortcut === null ? undefined : shortcut.keys}
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
