import { StateLabel, Tabs, Text, type RlyTabItem } from "@knpkv/rly/primitives"
import { Predicate } from "effect"
import { useEffect, useState, type ReactElement, type ReactNode } from "react"

export type FleetShellTab = "approvals" | "connect" | "work"

export type FleetShortcut =
  { readonly _tag: "focus_agent_search" } | { readonly _tag: "select_tab"; readonly tab: FleetShellTab }

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
  useEffect(() => {
    const candidate = new URLSearchParams(window.location.search).get("tab")
    if (candidate !== null && isShellTab(candidate)) setTab(candidate)
  }, [])
  const selectTab = (value: string): void => {
    if (!isShellTab(value)) return
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
    <div className="fleet-shell">
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
        <Tabs aria-label="Fleet applications" items={items} onValueChange={selectTab} size="large" value={tab} />
      </main>
    </div>
  )
}
