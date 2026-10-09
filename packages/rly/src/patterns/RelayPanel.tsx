import { Dialog as RadixDialog } from "radix-ui"
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, Ref, RefObject } from "react"
import { useCallback, useId, useRef, useSyncExternalStore } from "react"
import { PortalBoundary } from "../foundations/PortalProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import * as Predicate from "../internal/predicates.js"
import {
  restoreModalFocusAfterCleanup,
  useModalContentRegistration,
  useModalIsolation,
  useModalScrollLock
} from "../internal/modal.js"
import { hasNestedLayer, isImeKey } from "../internal/relaySummon.js"
import { IconButton } from "../primitives/IconButton.js"
import { Tabs } from "../primitives/Tabs.js"
import styles from "./RelayPanel.module.css"
import { RelayMark } from "./RelayMark.js"
import type { RlyRelayMarkActivity } from "./RelayMark.js"

const style = (name: string): string => cssClass(styles, name)

/** How Relay is laid out: over the page, pinned beside it, or full screen. */
export const RLY_RELAY_PANEL_PRESENTATIONS: readonly ["overlay", "pinned", "fullscreen"] = [
  "overlay",
  "pinned",
  "fullscreen"
]
/** One Relay presentation. */
export type RlyRelayPanelPresentation = (typeof RLY_RELAY_PANEL_PRESENTATIONS)[number]

/** The overlay's width, and the column a pinned Relay takes, in CSS pixels. */
export const RLY_RELAY_PANEL_WIDTH = 440

/** What Relay is looking at: a label and, when it has one, the exact revision (shown in mono). */
export interface RlyRelayScope {
  readonly label: string
  readonly revision?: string
}

/** One of Relay's views; a count is part of its name ("Findings 3"), never announced on change. */
export interface RlyRelayPanelTab {
  readonly content: ReactNode
  readonly count?: number
  readonly label: string
  readonly value: string
}

/** The pin toggle, passed only when the host can pin Relay beside its page at this width. */
export interface RlyRelayPanelPin {
  readonly onPinnedChange: (pinned: boolean) => void
  readonly pinned: boolean
}

interface RelayPanelBaseProps {
  /** What Relay is doing, shown on the header mark; `idle` (still) unless given. Say it in words too. */
  readonly activity?: RlyRelayMarkActivity
  /** Status line under the header (freshness of what Relay read); not a live region. */
  readonly freshness?: ReactNode
  /** Kept on screen under the body: the composer. */
  readonly footer?: ReactNode
  /** Where focus returns when the panel closes itself (close button, Escape, full-screen dismissal). */
  readonly launcher: RefObject<HTMLElement | null>
  /**
   * Called by the close button and Escape. Closing hides Relay in every presentation; whether it was
   * pinned is the host's remembered preference, restored when Relay opens again.
   */
  readonly onClose: () => void
  /** Thread options, usually one menu trigger. */
  readonly options?: ReactNode
  readonly pin?: RlyRelayPanelPin | undefined
  readonly presentation: RlyRelayPanelPresentation
  /** The panel's region, for useRelaySummon. */
  readonly ref?: Ref<HTMLElement>
  readonly scope: RlyRelayScope
  /** The panel's name, "Relay" unless the host names it more specifically. */
  readonly title?: string
}

interface RelayPanelTabsProps extends RelayPanelBaseProps {
  readonly children?: never
  readonly onTabChange: (value: string) => void
  readonly selectedTab: string
  readonly tabs: ReadonlyArray<RlyRelayPanelTab>
}

interface RelayPanelBodyProps extends RelayPanelBaseProps {
  /** A single view (setup, for example), shown without tabs. */
  readonly children: ReactNode
  readonly onTabChange?: never
  readonly selectedTab?: never
  readonly tabs?: never
}

/** Inputs for the panel: tabbed views, or one body. */
export type RelayPanelProps = RelayPanelTabsProps | RelayPanelBodyProps

const assignRef = <T,>(ref: Ref<T> | undefined, value: T | null): void => {
  if (Predicate.isFunction(ref)) ref(value)
  else if (ref !== undefined && ref !== null) ref.current = value
}

/**
 * Relay's frame (Relay UX decision). `overlay` floats over the right of the page with no backdrop and no
 * focus trap; render it right after the launcher so Tab order follows. `pinned` is a sticky column for
 * the host's grid. `fullscreen` is a modal dialog with the page inert. Only the body scrolls, so the
 * header and the footer's composer stay on screen. Escape and the close button call `onClose` and return
 * focus to the launcher; Escape is left to an IME composition and to dialogs or open popups inside.
 * Changing presentation remounts the views and footer, so state that must survive (a composer draft)
 * lives with the host or the composer, keyed by the object Relay is about.
 */
export const RelayPanel = (props: RelayPanelProps): ReactElement => {
  const { launcher, onClose, presentation, ref } = props
  const titleId = useId()
  const region = useRef<HTMLElement | null>(null)
  const escapeOwnedByLayer = useRef<KeyboardEvent | null>(null)
  const setRegion = useCallback(
    (element: HTMLElement | null) => {
      region.current = element
      assignRef(ref, element)
    },
    [ref]
  )
  const close = useCallback(() => {
    onClose()
    launcher.current?.focus()
  }, [launcher, onClose])

  if (presentation === "fullscreen") {
    return (
      <PortalBoundary>
        {(container) => (
          <RadixDialog.Root
            modal
            onOpenChange={(open) => {
              if (!open) onClose()
            }}
            open
          >
            <RadixDialog.Portal container={container}>
              <FullscreenLayer>
                <RadixDialog.Content
                  aria-describedby={undefined}
                  className={classNames(style("root"), style("fullscreen"))}
                  data-rly-relay-panel="fullscreen"
                  data-rly-relay-surface=""
                  onCloseAutoFocus={(event) => {
                    // The page is inert until the layer's cleanup, so focus returns after it.
                    event.preventDefault()
                    restoreModalFocusAfterCleanup(launcher.current)
                  }}
                  onEscapeKeyDown={(event) => {
                    if (isImeKey(event) || hasNestedLayer(region.current, event.composedPath())) {
                      event.preventDefault()
                    }
                  }}
                  ref={setRegion}
                >
                  <PanelChrome
                    {...props}
                    close={close}
                    heading={
                      <RadixDialog.Title asChild>
                        <p className={style("title")}>{panelTitle(props.title)}</p>
                      </RadixDialog.Title>
                    }
                  />
                </RadixDialog.Content>
              </FullscreenLayer>
            </RadixDialog.Portal>
          </RadixDialog.Root>
        )}
      </PortalBoundary>
    )
  }

  // A popup inside may close itself on Escape before the event bubbles here, so whether Escape belongs
  // to a nested layer is decided on the way down, while the layer is still open.
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && hasNestedLayer(event.currentTarget, event.nativeEvent.composedPath())) {
      escapeOwnedByLayer.current = event.nativeEvent
    }
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event.nativeEvent)) return
    if (escapeOwnedByLayer.current === event.nativeEvent) return
    event.preventDefault()
    close()
  }
  return (
    <aside
      aria-labelledby={titleId}
      className={classNames(style("root"), style(presentation))}
      data-rly-relay-panel={presentation}
      data-rly-relay-surface=""
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
      ref={setRegion}
    >
      <PanelChrome
        {...props}
        close={close}
        heading={
          <p className={style("title")} id={titleId}>
            {panelTitle(props.title)}
          </p>
        }
      />
    </aside>
  )
}

/**
 * Full screen joins rly's shared modal stack: the page behind is inert and cannot scroll, and an rly
 * Dialog or Sheet around Relay treats this layer as its nested modal rather than as background.
 */
const FullscreenLayer = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const layer = useRef<HTMLDivElement>(null)
  useModalContentRegistration()
  useModalIsolation(layer, true)
  useModalScrollLock(layer, true)
  return (
    <div data-rly-modal-layer="" ref={layer}>
      {children}
    </div>
  )
}

const panelTitle = (title: string | undefined): string => requireText(title ?? "Relay", "RelayPanel title")

/** Header, views and footer, shared by every presentation; only the title element differs. */
const PanelChrome = (
  props: RelayPanelProps & { readonly close: () => void; readonly heading: ReactElement }
): ReactElement => {
  const { close, footer, freshness, heading, options, pin, scope } = props
  const body = (content: ReactNode): ReactElement => (
    <div className={style("body")}>
      {freshness === undefined ? null : <div className={style("freshness")}>{freshness}</div>}
      {/* Focusable so a keyboard user can scroll a transcript that has no focusable content. */}
      <div className={style("scroll")} data-rly-relay-scroll="" tabIndex={0}>
        {content}
      </div>
    </div>
  )
  return (
    <>
      <header className={style("header")}>
        {/* The header mounts as the panel opens, so its mark plays the entrance once per opening. */}
        <RelayMark.Tile activity={props.activity} entrance size={24} />
        <div className={style("heading")}>
          {heading}
          <p className={style("scope")}>
            {requireText(scope.label, "RelayPanel scope label")}
            {scope.revision === undefined ? null : (
              <>
                {" at "}
                <span className={style("revision")}>{requireText(scope.revision, "RelayPanel scope revision")}</span>
              </>
            )}
          </p>
        </div>
        <div className={style("tools")}>
          {pin === undefined ? null : (
            <IconButton
              aria-pressed={pin.pinned}
              icon="pin"
              label={pin.pinned ? "Unpin" : "Pin beside the page"}
              onClick={() => pin.onPinnedChange(!pin.pinned)}
              variant="quiet"
            />
          )}
          {options}
          <IconButton icon="close" label="Close Relay" onClick={close} variant="quiet" />
        </div>
      </header>
      {props.tabs === undefined ? (
        body(props.children)
      ) : (
        <Tabs
          aria-label="Relay views"
          className={style("tabs")}
          // Two short views: one row on a phone too, never a stacked list above the transcript.
          data-mobile-layout="single-row"
          items={props.tabs.map((tab) => ({
            content: body(tab.content),
            label: tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`,
            value: tab.value
          }))}
          onValueChange={props.onTabChange}
          value={props.selectedTab}
        />
      )}
      {footer === undefined ? null : <div className={style("footer")}>{footer}</div>}
    </>
  )
}

/** Inputs for {@link useRelayPresentation}. */
export interface UseRelayPresentationOptions {
  /** The user's pin preference, remembered by the host per product and viewport class. */
  readonly pinned: boolean
  /** The narrowest width the host's own page stays usable at, beside a pinned Relay. */
  readonly minHostWidth: number
}

/** The presentation to render, and whether to offer the pin toggle. */
export interface RlyRelayPresentation {
  readonly canPin: boolean
  readonly presentation: RlyRelayPanelPresentation
}

/** Full screen at 640 CSS pixels and narrower, so a 250% zoom on a laptop goes full screen too. */
const fullscreenQuery = "(max-width: 640px)"
/** Pinning starts at 1440 and only where the host keeps its minimum beside the column. */
const pinQuery = (minHostWidth: number): string =>
  `(min-width: ${Math.max(1440, minHostWidth + RLY_RELAY_PANEL_WIDTH)}px)`

const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}

/**
 * The presentation for the viewport (Relay UX decision): full screen at phone width; pinned when the user
 * pinned it and the viewport is wide enough (≥1440 and the host's minimum beside the column); otherwise
 * the overlay. The server renders the overlay. A host may still choose its own presentation.
 */
export const useRelayPresentation = ({ minHostWidth, pinned }: UseRelayPresentationOptions): RlyRelayPresentation => {
  const fullscreen = useMediaQuery(fullscreenQuery)
  const wide = useMediaQuery(pinQuery(minHostWidth))
  if (fullscreen) return { canPin: false, presentation: "fullscreen" }
  return { canPin: wide, presentation: pinned && wide ? "pinned" : "overlay" }
}
