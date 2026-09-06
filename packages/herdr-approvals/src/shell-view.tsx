import { StateLabel, StatePanel, Tabs, Text, type RlyTabItem } from "@knpkv/rly/primitives"
import { Predicate } from "effect"
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react"

export type FleetShellTab = "approvals" | "connect" | "work"

export type FleetShortcut =
  { readonly _tag: "focus_agent_search" } | { readonly _tag: "select_tab"; readonly tab: FleetShellTab }

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

/** Render the separate Work request without conflating loading, failure, and absence. */
export const FleetWorkPanel = ({ state }: { readonly state: FleetWorkState }): ReactElement => {
  switch (state._tag) {
    case "Loading":
      return (
        <StatePanel
          announce="polite"
          description="Loading the latest durable goal projection."
          title="Loading Work"
          tone="progress"
        />
      )
    case "Unavailable":
      return (
        <StatePanel
          description="No durable goal projection is configured on this host. Live agent and job activity remain available below."
          title="Goals unavailable"
          tone="neutral"
        />
      )
    case "Failure":
      return (
        <>
          {state.content}
          <StatePanel description={state.detail} title="Work unavailable" tone="critical" />
        </>
      )
    case "Ready":
      return <>{state.content}</>
  }
}

export const fleetShortcutFor = ({
  editable,
  key,
  modified
}: {
  readonly editable: boolean
  readonly key: string
  readonly modified: boolean
}): FleetShortcut | null => {
  if (editable || modified) return null
  switch (key) {
    case "1":
      return { _tag: "select_tab", tab: "approvals" }
    case "2":
      return { _tag: "select_tab", tab: "connect" }
    case "3":
      return { _tag: "select_tab", tab: "work" }
    case "/":
      return { _tag: "focus_agent_search" }
    default:
      return null
  }
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!Predicate.hasProperty(target, "nodeName") || !Predicate.isString(target.nodeName)) return false
  if (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.nodeName === "SELECT") return true
  if (Predicate.hasProperty(target, "isContentEditable") && target.isContentEditable === true) return true
  return Predicate.hasProperty(target, "role") && target.role === "textbox"
}

const isShellTab = (value: string): value is FleetShellTab =>
  value === "approvals" || value === "connect" || value === "work"

const FleetKeyRail = (): ReactElement => (
  <nav className="fleet-key-rail" aria-label="Keyboard shortcuts">
    <span>
      <kbd>1</kbd> Approvals
    </span>
    <span>
      <kbd>2</kbd> Connect
    </span>
    <span>
      <kbd>3</kbd> Work
    </span>
    <span>
      <kbd>/</kbd> Agent search
    </span>
  </nav>
)

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
      const shortcut = fleetShortcutFor({
        editable: isEditableTarget(event.target),
        key: event.key,
        modified: event.altKey || event.ctrlKey || event.metaKey
      })
      if (shortcut === null) return
      event.preventDefault()
      if (shortcut._tag === "select_tab") {
        selectTab(shortcut.tab)
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
      content: (
        <>
          <FleetKeyRail />
          {approvals}
        </>
      ),
      label: "Approvals",
      value: "approvals"
    },
    {
      content: (
        <>
          <FleetKeyRail />
          {connect}
        </>
      ),
      label: "Connect",
      value: "connect"
    },
    {
      content: (
        <>
          <FleetKeyRail />
          {work}
        </>
      ),
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
          <span>
            <Text as="strong" variant="label">
              Herdr
            </Text>
            <Text tone="secondary" variant="meta">
              Fleet control
            </Text>
          </span>
        </div>
        <StateLabel label={`${String(hostCount)} configured hosts`} size="compact" tone="positive" />
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
    </div>
  )
}
