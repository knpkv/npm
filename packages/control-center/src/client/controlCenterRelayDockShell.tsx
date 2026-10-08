import { RelayProductDockProvider, useRelayProductOpen } from "@knpkv/relay-product/registry"
import {
  Component,
  type ComponentType,
  lazy,
  type ReactElement,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef
} from "react"

import styles from "./AppShell.module.css"

const LazyControlCenterRelayPanel = lazy(async () => {
  const module = await import("./controlCenterRelayPanel.js")
  return { default: module.ControlCenterRelayPanel }
})

/**
 * Stands in for Relay's launcher until it loads: the same box (rly's launcher tokens), the same name,
 * and the same behaviour. It is the shared launcher ref, opens Relay on a click or Ctrl/⌘+J, and, if it
 * has focus when the real launcher replaces it, records that so the real one takes focus.
 */
const RelayLauncherStandIn = ({ handoff }: { readonly handoff: RefObject<boolean> }): ReactElement => {
  const { launcher, open, returnTo, setOpen } = useRelayProductOpen()
  useEffect(() => {
    const owner = launcher.current?.ownerDocument ?? document
    const onKeyDown = (event: KeyboardEvent): void => {
      // A loaded panel's summon (capture phase) has already handled it.
      if (event.defaultPrevented) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "KeyJ") return
      event.preventDefault()
      returnTo.current = null
      setOpen((current) => !current)
    }
    owner.addEventListener("keydown", onKeyDown)
    return () => owner.removeEventListener("keydown", onKeyDown)
  }, [launcher, returnTo, setOpen])
  // Runs before the button leaves the document, so focus can still be read.
  useLayoutEffect(
    () => () => {
      const button = launcher.current
      handoff.current = button !== null && button.ownerDocument.activeElement === button
    },
    [handoff, launcher]
  )
  return (
    <button
      aria-expanded={open}
      aria-keyshortcuts="Control+J"
      className={styles.relayLauncherStandIn}
      onClick={() => {
        returnTo.current = null
        setOpen((current) => !current)
      }}
      ref={launcher}
      type="button"
    >
      <span aria-hidden="true" className={styles.relayLauncherStandInMark} />
      <span>Relay</span>
      <span aria-hidden="true" className={styles.relayLauncherStandInHint}>
        Ctrl J
      </span>
    </button>
  )
}

/** Gives the real launcher focus when the stand-in it replaced had it. */
const FocusHandoff = ({ handoff }: { readonly handoff: RefObject<boolean> }): null => {
  const { launcher } = useRelayProductOpen()
  useEffect(() => {
    if (!handoff.current) return
    handoff.current = false
    launcher.current?.focus()
  }, [handoff, launcher])
  return null
}

/**
 * Relay's header launcher from a loader for the real one: the real launcher once loaded, the same-size
 * stand-in before. Tests inject a loader they control.
 */
export const makeRelayLauncherSlot = (load: () => Promise<ComponentType>): (() => ReactElement) => {
  const LazyRelayLauncher = lazy(async () => ({ default: await load() }))
  return () => {
    const handoff = useRef(false)
    return (
      <RelayDockChromeBoundary>
        <Suspense fallback={<RelayLauncherStandIn handoff={handoff} />}>
          <LazyRelayLauncher />
          <FocusHandoff handoff={handoff} />
        </Suspense>
      </RelayDockChromeBoundary>
    )
  }
}

// rly ships its patterns as one chunk, so the launcher loads lazily too, off the initial closure.
export const ControlCenterRelayLauncher = makeRelayLauncherSlot(async () => {
  const module = await import("@knpkv/relay-product")
  return module.RelayProductLauncher
})

/** Keep routed content mounted if Relay's panel fails to load or render. */
export class RelayDockChromeBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state: RelayDockChromeBoundaryState = { failed: false }

  static getDerivedStateFromError(cause: unknown): RelayDockChromeBoundaryState {
    void cause
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

interface RelayDockChromeBoundaryState {
  readonly failed: boolean
}

/** Hold Relay's shared state (the registered PR thread, open and pin) for the whole app. */
export const ControlCenterRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <RelayProductDockProvider>{children}</RelayProductDockProvider>
)

/**
 * Relay's panel slot, right after the header launcher. The panel owns Ctrl/⌘+J and the PR thread, so it
 * loads with the shell (lazily, off the initial closure) and renders nothing while closed.
 */
export const ControlCenterRelayPanelSlot = (): ReactElement => (
  <RelayDockChromeBoundary>
    <Suspense fallback={null}>
      <LazyControlCenterRelayPanel />
    </Suspense>
  </RelayDockChromeBoundary>
)
