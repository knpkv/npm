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

/** Inputs for the launcher. */
export type RelayLauncherProps = Omit<ComponentPropsWithRef<"button">, "children" | "type"> & {
  /** Whether Relay is open; announced as the button's expanded state. */
  readonly expanded: boolean
  /** The visible name, "Relay" unless the host names its Relay more specifically. */
  readonly label?: string
  /**
   * The shortcut to advertise. Defaults to Ctrl/⌘+J for the browser's platform; pass `null` where
   * the host does not bind it (a live terminal that keeps its own chords).
   */
  readonly shortcut?: RlyRelayShortcut | null
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
  // The server renders the non-Apple hint; the browser corrects it after hydration without a mismatch.
  const apple = useSyncExternalStore(noSubscription, isApplePlatform, () => false)
  const advertised = shortcut === undefined ? relayShortcut(apple) : shortcut
  return (
    <button
      {...props}
      aria-expanded={expanded}
      aria-keyshortcuts={advertised === null ? undefined : advertised.keys}
      className={classNames(style("root"), className)}
      data-rly-relay-launcher=""
      type="button"
    >
      <RelayMark className={style("mark")} size={20} />
      <span className={style("label")}>{requireText(label, "RelayLauncher label")}</span>
      {advertised === null ? null : (
        // The hint repeats aria-keyshortcuts for sighted users, so assistive technology hears it once.
        <kbd aria-hidden="true" className={style("hint")}>
          {requireText(advertised.hint, "RelayLauncher shortcut hint")}
        </kbd>
      )}
    </button>
  )
}
