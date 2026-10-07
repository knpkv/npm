import { Button, Dialog, StatePanel, Tabs, Text, type RlyTabItem } from "@knpkv/rly/primitives"
import { Cause, Option, Predicate } from "effect"
import type * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react"

export type FleetShellTab = "approvals" | "connect" | "work"

export type FleetShortcut =
  | { readonly _tag: "focus_agent_search" }
  | { readonly _tag: "open_shortcuts" }
  | { readonly _tag: "select_tab"; readonly tab: FleetShellTab }

/** A `g` waiting for its second key, and when it was pressed; `null` when none is. */
export type FleetShortcutPrefix = { readonly at: number } | null

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
      return (
        <>
          <WorkHeading />
          <StatePanel
            announce="polite"
            description="Loading the latest durable goal projection."
            title="Loading Work"
            tone="progress"
          />
        </>
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
      return (
        <>
          {state.content === null ? <WorkHeading /> : state.content}
          <StatePanel description={state.detail} title="Work unavailable" tone="critical" />
        </>
      )
    case "Ready":
      return <>{state.content}</>
  }
}

const sequenceTabs: Readonly<Record<string, FleetShellTab>> = { a: "approvals", c: "connect", w: "work" }

/**
 * The shortcut for one key press, and the `g` prefix it leaves. No single bare key acts on its own:
 * Andrey's window manager owns Alt, so tabs are `g` then `a` / `c` / `w` within
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
}): { readonly shortcut: FleetShortcut | null; readonly prefix: FleetShortcutPrefix } => {
  if (control && !alt && key.toLowerCase() === "k") return { prefix: null, shortcut: { _tag: "focus_agent_search" } }
  if (control || alt || editable) return { prefix: null, shortcut: null }
  if (key === "?") return { prefix: null, shortcut: { _tag: "open_shortcuts" } }
  const tab = sequenceTabs[key]
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
    </Dialog.Content>
  </Dialog.Root>
)

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!Predicate.hasProperty(target, "nodeName") || !Predicate.isString(target.nodeName)) return false
  if (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.nodeName === "SELECT") return true
  if (Predicate.hasProperty(target, "isContentEditable") && target.isContentEditable === true) return true
  return Predicate.hasProperty(target, "role") && target.role === "textbox"
}

const isShellTab = (value: string): value is FleetShellTab =>
  value === "approvals" || value === "connect" || value === "work"

export const FleetShell = ({
  approvals,
  connect,
  hostCount,
  work
}: {
  readonly approvals: ReactNode
  readonly connect: ReactNode
  readonly hostCount: number
  readonly work: ReactNode
}): ReactElement => {
  const [tab, setTab] = useState<FleetShellTab>("approvals")
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const prefix = useRef<FleetShortcutPrefix>(null)
  const shellRef = useRef<HTMLDivElement>(null)
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
    const updateTerminalInset = (): void => {
      shell.style.setProperty(
        "--fleet-shell-tab-bottom",
        `${String(Math.max(0, tabList.getBoundingClientRect().bottom))}px`
      )
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
    }
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
      window.requestAnimationFrame(() => document.getElementById("connect-agent-search")?.focus())
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  })
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
    }
  ]
  return (
    <div className="fleet-shell" ref={shellRef}>
      <header className="fleet-shell-masthead">
        <div className="fleet-shell-brand">
          <span aria-hidden="true" className="fleet-shell-mark">
            H
          </span>
          {/* One line: the name, then what it is. */}
          <Text as="strong" variant="label">
            Herdr
          </Text>
          <Text tone="secondary" variant="meta">
            Fleet control
          </Text>
        </div>
        <div className="fleet-shell-meta">
          {/* Configured, not reachable: the shell doesn't know which hosts answer, so it doesn't say. */}
          <Text tone="secondary" variant="meta">
            {hostCount === 1 ? "1 host" : `${String(hostCount)} hosts`}
          </Text>
          <Button onClick={() => setShortcutsOpen(true)} size="compact" title="Or press ?" variant="quiet">
            Keyboard shortcuts
          </Button>
        </div>
      </header>
      <main className="fleet-shell-main">
        <Tabs
          aria-label="Fleet applications"
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
  )
}
