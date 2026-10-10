import { PortalProvider } from "@knpkv/rly/foundations"
import { RelayMark } from "@knpkv/rly/patterns"
import { Button, Dialog, StatePanel, Tabs, Text, type RlyTabItem } from "@knpkv/rly/primitives"
import { Cause, Option, Predicate } from "effect"
import { HubRelay, type HubRelayConversation } from "./hub-relay.js"
import type * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react"

export type FleetShellTab = "approvals" | "connect" | "work" | "usage"

export type FleetShortcut =
  | { readonly _tag: "focus_agent_search" }
  | { readonly _tag: "open_shortcuts" }
  | { readonly _tag: "select_tab"; readonly tab: FleetShellTab }

/** A `g` waiting for its second key, and when it was pressed; `null` when none is. */
export type FleetShortcutPrefix = { readonly at: number } | null

/** What one key press does, and the `g` prefix it leaves for the next. */
export interface FleetShortcutStep {
  readonly shortcut: FleetShortcut | null
  readonly prefix: FleetShortcutPrefix
}

/** How long a `g` waits for the key that completes it. */
export const FLEET_SEQUENCE_MS = 1500

export type FleetWorkState =
  | { readonly _tag: "Failure"; readonly content: ReactNode | null; readonly detail: string }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly content: ReactNode }
  | { readonly _tag: "Unavailable" }

export type FleetWorkRequestState =
  | { readonly _tag: "Failure"; readonly content: ReactNode | null; readonly detail: string; readonly waiting: boolean }
  | { readonly _tag: "Initial"; readonly content: ReactNode | null }
  | { readonly _tag: "Success"; readonly content: ReactNode | null; readonly waiting: boolean }
  | { readonly _tag: "Unavailable" }

type FleetWorkRequestError = { readonly _tag: string; readonly status?: number }

/** Classify the typed Work request result without losing a known 404 during revalidation. */
export const fleetWorkRequestStateFromResult = <A, E extends FleetWorkRequestError>({
  content,
  result
}: {
  readonly content: ReactNode | null
  readonly result: AsyncResult.AsyncResult<A, E>
}): FleetWorkRequestState => {
  switch (result._tag) {
    case "Initial":
      return { _tag: "Initial", content }
    case "Failure": {
      const failure = Cause.findErrorOption(result.cause)
      return Option.isSome(failure) && failure.value._tag === "ConnectStatusError" && failure.value.status === 404
        ? { _tag: "Unavailable" }
        : {
            _tag: "Failure",
            content,
            detail: "Work request failed. Refresh to retry.",
            waiting: result.waiting
          }
    }
    case "Success":
      return { _tag: "Success", content, waiting: result.waiting }
  }
}

/** Preserve Work request failure, loading, and absence as separate presentation states. */
export const fleetWorkStateFromRequest = (request: FleetWorkRequestState): FleetWorkState => {
  switch (request._tag) {
    case "Failure":
      return request.waiting
        ? request.content === null
          ? { _tag: "Loading" }
          : { _tag: "Ready", content: request.content }
        : { _tag: "Failure", content: request.content, detail: request.detail }
    case "Initial":
      return request.content === null ? { _tag: "Loading" } : { _tag: "Ready", content: request.content }
    case "Success":
      return request.content === null
        ? request.waiting
          ? { _tag: "Loading" }
          : { _tag: "Unavailable" }
        : { _tag: "Ready", content: request.content }
    case "Unavailable":
      return { _tag: "Unavailable" }
  }
}

/** The Work tab's page heading while the board, which has its own, isn't shown. */
const WorkHeading = (): ReactElement => (
  <Text as="h1" variant="card-title">
    Work
  </Text>
)

/** Render the separate Work request without conflating loading, failure, and absence. */
export const FleetWorkPanel = ({ state }: { readonly state: FleetWorkState }): ReactElement => {
  switch (state._tag) {
    case "Loading":
      // Holds a screen of space, like the board that replaces it, so agents and history below
      // stay out of view instead of being pushed down (CLS 0.48 at 1440 before).
      return (
        <div className="fleet-work-reserved">
          <WorkHeading />
          <StatePanel
            announce="polite"
            description="Loading the latest durable goal projection."
            title="Loading Work"
            tone="progress"
          />
        </div>
      )
    case "Unavailable":
      return (
        <>
          <WorkHeading />
          <StatePanel
            description="No durable goal projection is configured on this host. Live agent and job activity remain available below."
            title="Goals unavailable"
            tone="neutral"
          />
        </>
      )
    case "Failure":
      // A failure before any board arrived keeps the loading reservation: the retry that follows
      // usually lands a full board, and collapsing now would pull the panels below up, then push
      // them back down. Unavailable and an empty board are settled answers and release it.
      return state.content === null ? (
        <div className="fleet-work-reserved">
          <WorkHeading />
          <StatePanel description={state.detail} title="Work unavailable" tone="critical" />
        </div>
      ) : (
        <>
          {state.content}
          <StatePanel description={state.detail} title="Work unavailable" tone="critical" />
        </>
      )
    case "Ready":
      return <>{state.content}</>
  }
}

const sequenceTabs: ReadonlyMap<string, FleetShellTab> = new Map([
  ["a", "approvals"],
  ["c", "connect"],
  ["w", "work"],
  ["u", "usage"]
])

/**
 * The shortcut for one key press, and the `g` prefix it leaves. No single bare key acts on its own:
 * a tiling window manager may own Alt, so tabs are `g` then `a` / `c` / `w` / `u` within
 * {@link FLEET_SEQUENCE_MS}, agent search is Ctrl+K (Cmd+K), and `?` lists the shortcuts. Only
 * Ctrl+K works inside a field; nothing else takes a key while one has focus.
 */
export const fleetShortcutFor = ({
  alt,
  control,
  editable,
  key,
  now,
  prefix
}: {
  readonly alt: boolean
  /** Ctrl or Cmd. */
  readonly control: boolean
  readonly editable: boolean
  readonly key: string
  readonly now: number
  readonly prefix: FleetShortcutPrefix
}): FleetShortcutStep => {
  if (control && !alt && key.toLowerCase() === "k") return { prefix: null, shortcut: { _tag: "focus_agent_search" } }
  if (control || alt || editable) return { prefix: null, shortcut: null }
  if (key === "?") return { prefix: null, shortcut: { _tag: "open_shortcuts" } }
  const tab = sequenceTabs.get(key)
  if (prefix !== null && now - prefix.at <= FLEET_SEQUENCE_MS && tab !== undefined) {
    return { prefix: null, shortcut: { _tag: "select_tab", tab } }
  }
  if (key === "g") return { prefix: { at: now }, shortcut: null }
  return { prefix: null, shortcut: null }
}

/** Every shortcut, as the `?` overlay lists them. */
const shortcutList: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly action: string }> = [
  { action: "Go to Approvals", keys: ["g", "a"] },
  { action: "Go to Connect", keys: ["g", "c"] },
  { action: "Go to Work", keys: ["g", "w"] },
  { action: "Go to Usage", keys: ["g", "u"] },
  { action: "Search agents", keys: ["Ctrl", "K"] },
  { action: "Show these shortcuts", keys: ["?"] }
]

const ShortcutsDialog = ({
  onOpenChange,
  open
}: {
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}): ReactElement => (
  <Dialog.Root onOpenChange={onOpenChange} open={open}>
    <Dialog.Content
      className="fleet-shortcuts-dialog"
      description="Type a sequence with no field focused; Ctrl+K works anywhere. The tabs are also reachable with Tab, then the arrow keys."
      title="Keyboard shortcuts"
    >
      <dl className="fleet-shortcuts">
        {shortcutList.map(({ action, keys }) => (
          <div key={action}>
            <dt>
              {keys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? (keys[0] === "Ctrl" ? " + " : " then ") : null}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      {/* Esc closes it too, but a phone has no Esc: the close action is always on screen. */}
      <div className="fleet-shortcuts-actions">
        <Dialog.Close size="compact" variant="secondary">
          Close
        </Dialog.Close>
      </div>
    </Dialog.Content>
  </Dialog.Root>
)

/**
 * How much of the page the on-screen keyboard covers: the layout viewport below the visual one. Zero where
 * the browser resizes the page for the keyboard (`interactive-widget=resizes-content`) and while the page is
 * pinch-zoomed, where the difference is the zoom rather than a keyboard.
 */
export const keyboardHeight = (view: {
  readonly innerHeight: number
  /** Missing where the browser has no Visual Viewport API. */
  readonly visualViewport?: { readonly height: number; readonly offsetTop: number; readonly scale: number } | null
}): number => {
  const visual = view.visualViewport
  if (visual === undefined || visual === null || Math.abs(visual.scale - 1) > 0.01) return 0
  return Math.max(0, Math.round(view.innerHeight - visual.offsetTop - visual.height))
}

/** How long Ctrl+K keeps trying to reach agent search while the Connect tab shows and loads. */
const SEARCH_FOCUS_MS = 3000

/**
 * Focuses the element `id` once it is mounted and shown. Switching to Connect renders its panel a
 * frame or more later, and the search field can mount later still, so one attempt can land before
 * it exists or while it is hidden: keep trying each frame until it has focus, for a bounded time.
 */
const focusWhenShown = (id: string, deadline: number = performance.now() + SEARCH_FOCUS_MS): void => {
  window.requestAnimationFrame((now) => {
    const element = document.getElementById(id)
    element?.focus()
    if (element !== null && document.activeElement === element) return
    if (now < deadline) focusWhenShown(id, deadline)
  })
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!Predicate.hasProperty(target, "nodeName") || !Predicate.isString(target.nodeName)) return false
  if (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.nodeName === "SELECT") return true
  if (Predicate.hasProperty(target, "isContentEditable") && target.isContentEditable === true) return true
  return Predicate.hasProperty(target, "role") && target.role === "textbox"
}

const isAnchor = (node: EventTarget): node is HTMLAnchorElement =>
  Predicate.hasProperty(node, "tagName") && node.tagName === "A"

const isShellTab = (value: string): value is FleetShellTab =>
  value === "approvals" || value === "connect" || value === "work" || value === "usage"

/**
 * The tab a same-page `?tab=` link opens, or null for any other link. Connect's limits line links to
 * `/?tab=usage`; inside the shell that switches tabs rather than reloading the page.
 */
export const shellTabLinkTarget = (
  href: string,
  current: { readonly origin: string; readonly pathname: string }
): FleetShellTab | null => {
  if (!URL.canParse(href, current.origin)) return null
  const url = new URL(href, current.origin)
  if (url.origin !== current.origin || url.pathname !== current.pathname) return null
  const tab = url.searchParams.get("tab")
  return tab !== null && isShellTab(tab) ? tab : null
}

export const FleetShell = ({
  approvals,
  connect,
  hostCount,
  notice = null,
  relay,
  usage,
  work
}: {
  readonly approvals: ReactNode
  readonly connect: ReactNode
  readonly hostCount: number
  /** A page-level notice (such as a failed refresh): under the masthead, in the gutter, above the tabs. */
  readonly notice?: ReactNode
  /** Relay's conversation, on the canonical hub only: the brand becomes Relay's launcher and status. */
  readonly relay?: HubRelayConversation
  /** The Usage tab's content; mounted only while it shows, so its polls stop when it doesn't. */
  readonly usage: ReactNode
  readonly work: ReactNode
}): ReactElement => {
  const [tab, setTab] = useState<FleetShellTab>("approvals")
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const prefix = useRef<FleetShortcutPrefix>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const mastheadRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const candidate = new URLSearchParams(window.location.search).get("tab")
    if (candidate !== null && isShellTab(candidate)) setTab(candidate)
  }, [])
  useLayoutEffect(() => {
    const shell = shellRef.current
    const tabsRoot = tabsRef.current
    if (shell === null || tabsRoot === null) return
    const tabList = tabsRoot.querySelector<HTMLElement>(':scope > [role="tablist"]')
    if (tabList === null) return
    const masthead = mastheadRef.current
    const updateTerminalInset = (): void => {
      shell.style.setProperty(
        "--fleet-shell-tab-bottom",
        `${String(Math.max(0, tabList.getBoundingClientRect().bottom))}px`
      )
      // Relay's overlay starts below the masthead while any of it shows, at the top once it has scrolled away.
      if (masthead !== null) {
        shell.style.setProperty(
          "--rly-relay-panel-offset",
          `${String(Math.max(0, masthead.getBoundingClientRect().bottom))}px`
        )
      }
      // On the root: the full-screen panel is portaled outside the shell.
      document.documentElement.style.setProperty("--fleet-shell-keyboard", `${String(keyboardHeight(window))}px`)
    }
    let animationFrame: number | null = null
    const scheduleTerminalInsetUpdate = (): void => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        updateTerminalInset()
      })
    }
    updateTerminalInset()
    const resizeObserver = "ResizeObserver" in window ? new window.ResizeObserver(scheduleTerminalInsetUpdate) : null
    resizeObserver?.observe(shell)
    resizeObserver?.observe(tabList)
    // Relay's status can wrap and grow the masthead without either of them resizing.
    if (masthead !== null) resizeObserver?.observe(masthead)
    window.addEventListener("resize", scheduleTerminalInsetUpdate)
    window.addEventListener("scroll", scheduleTerminalInsetUpdate, true)
    window.visualViewport?.addEventListener("resize", scheduleTerminalInsetUpdate)
    window.visualViewport?.addEventListener("scroll", scheduleTerminalInsetUpdate)
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      window.removeEventListener("resize", scheduleTerminalInsetUpdate)
      window.removeEventListener("scroll", scheduleTerminalInsetUpdate, true)
      window.visualViewport?.removeEventListener("resize", scheduleTerminalInsetUpdate)
      window.visualViewport?.removeEventListener("scroll", scheduleTerminalInsetUpdate)
      document.documentElement.style.removeProperty("--fleet-shell-keyboard")
    }
  }, [tab])
  // On a phone the tabs scroll as one row; the selected one is always brought into it, so a page
  // opened on `?tab=usage` (the fourth tab) shows which tab it is on.
  useLayoutEffect(() => {
    const tabList = tabsRef.current?.querySelector<HTMLElement>(':scope > [role="tablist"]')
    const selected = tabList?.querySelector<HTMLElement>(`:scope > [role="tab"][data-tab-value="${tab}"]`)
    if (tabList === null || tabList === undefined || selected === null || selected === undefined) return
    const list = tabList.getBoundingClientRect()
    const trigger = selected.getBoundingClientRect()
    if (trigger.left < list.left) tabList.scrollLeft += trigger.left - list.left
    else if (trigger.right > list.right) tabList.scrollLeft += trigger.right - list.right
  }, [tab])
  const focusTab = (nextTab: FleetShellTab): void => {
    const tabList = tabsRef.current?.querySelector<HTMLElement>(':scope > [role="tablist"]')
    const tabs = tabList?.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]') ?? []
    for (const candidate of tabs) {
      if (candidate.dataset.tabValue !== nextTab) continue
      candidate.focus()
      return
    }
  }
  const selectTab = (value: string): void => {
    if (!isShellTab(value)) return
    const activePanel = tabsRef.current?.querySelector<HTMLElement>(':scope > [role="tabpanel"][data-state="active"]')
    if (activePanel?.contains(document.activeElement) === true) focusTab(value)
    setTab(value)
    const url = new URL(window.location.href)
    url.searchParams.set("tab", value)
    window.history.replaceState(null, "", url)
  }
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const next = fleetShortcutFor({
        alt: event.altKey,
        control: event.ctrlKey || event.metaKey,
        editable: isEditableTarget(event.target),
        key: event.key,
        now: event.timeStamp,
        prefix: prefix.current
      })
      prefix.current = next.prefix
      const shortcut = next.shortcut
      if (shortcut === null) return
      event.preventDefault()
      if (shortcut._tag === "select_tab") {
        selectTab(shortcut.tab)
        return
      }
      if (shortcut._tag === "open_shortcuts") {
        setShortcutsOpen(true)
        return
      }
      selectTab("connect")
      focusWhenShown("connect-agent-search")
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  })
  // A plain click on a same-page `?tab=` link switches tabs in place; a modified click (new tab,
  // new window) keeps the browser's own behaviour.
  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      // The link itself, or the link around what was clicked: the first anchor on the event's path.
      const anchor = event.composedPath().find(isAnchor)
      const href = anchor?.getAttribute("href")
      // A link to another window or a download keeps the browser's own behaviour.
      if (
        anchor === undefined ||
        href === null ||
        href === undefined ||
        anchor.getAttribute("target") !== null ||
        anchor.hasAttribute("download")
      )
        return
      const target = shellTabLinkTarget(href, window.location)
      if (target === null) return
      event.preventDefault()
      selectTab(target)
      window.scrollTo({ top: 0 })
    }
    document.addEventListener("click", handleClick)
    return () => document.removeEventListener("click", handleClick)
    // Registered once: selectTab only reads refs and the state setter, both stable across renders.
  }, [])
  const items: ReadonlyArray<RlyTabItem> = [
    {
      content: approvals,
      // Kept mounted while another tab shows: a decision's answer, its pinned request and the
      // countdown's deadline reads must survive a look at Connect or Work.
      forceMount: true,
      label: "Approvals",
      value: "approvals"
    },
    {
      content: connect,
      label: "Connect",
      value: "connect"
    },
    {
      content: work,
      label: "Work",
      value: "work"
    },
    {
      content: usage,
      label: "Usage",
      value: "usage"
    }
  ]
  return (
    // rly overlays (the shortcuts dialog) render into a portal target; without a provider they don't mount.
    <PortalProvider>
      <div className="fleet-shell" ref={shellRef}>
        <header className="fleet-shell-masthead" ref={mastheadRef}>
          <div className="fleet-shell-brand">
            {relay === undefined ? (
              <>
                <RelayMark.Tile className="fleet-shell-mark" size={32} />
                <Text as="strong" variant="label">
                  Relay
                </Text>
              </>
            ) : (
              <HubRelay relay={relay} terminalOwnsKeys={tab === "connect"} />
            )}
          </div>
          <div className="fleet-shell-meta">
            {/* Configured, not reachable: the shell doesn't know which hosts answer, so it doesn't say. */}
            <Text tone="secondary" variant="meta">
              {hostCount === 1 ? "1 host" : `${String(hostCount)} hosts`}
            </Text>
            <Button
              className="fleet-shell-shortcuts-button"
              onClick={() => setShortcutsOpen(true)}
              size="compact"
              title="Or press ?"
              variant="quiet"
            >
              Keyboard shortcuts
            </Button>
          </div>
        </header>
        <main className="fleet-shell-main">
          {notice}
          <Tabs
            aria-label="Relay applications"
            data-mobile-layout="single-row"
            items={items}
            onValueChange={selectTab}
            ref={tabsRef}
            size="large"
            value={tab}
          />
        </main>
        <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
      </div>
    </PortalProvider>
  )
}
