import { PortalProvider } from "@knpkv/rly/foundations"
import { Dialog, IconButton, StatePanel } from "@knpkv/rly/primitives"
import { Predicate, Result, Schema } from "effect"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react"
import { HubRelay, type HubRelayConversation } from "./hub-relay.js"
import { hubModuleLinkTarget, hubModuleUrl } from "./internal/hub-module-links.js"
import { dashboardRefreshTime } from "./internal/dashboard-refresh.js"
import { ShellIcon } from "./internal/shell-icon.js"
import { RelayChefMark } from "./internal/relay-chef-mark.js"
import { RelayChefMastMark } from "./internal/relay-chef-mast-mark.js"
import { UsageEmptyChef } from "./internal/usage-empty-chef.js"
import { UsageEmptyChromeContext } from "./internal/usage-empty-chrome.js"
import { ShortcutsDialog, focusWhenShown, focusModulePage, isEditableTarget } from "./internal/shell-keys.js"
import {
  canonicalModuleUrl,
  makeModuleViews,
  moduleHref,
  readModuleRoute,
  ModuleRegistrationError,
  type ModuleDescriptor,
  type ModuleDestination,
  type ModuleViews,
  moduleRegistryFingerprint,
  type ModulePageMount
} from "./modules.js"
import { fleetShortcutFor, type FleetShortcutPrefix } from "./shell-view.js"

interface ShellLocation {
  readonly url: URL
  readonly destination: ModuleDestination
  readonly error: string | null
  readonly focus: "deferred" | "history" | "page" | "search" | null
}

const ShellHistoryEntry = Schema.Struct({ openedFrom: Schema.String, document: Schema.String })

/** Preserve other history owners' object keys while validating our own record separately. */
const historyState = () => {
  const state: unknown = window.history.state
  return Predicate.isObject(state) ? state : {}
}

/** Query-key ordering is irrelevant to a parent identity; repeated values retain their order. */
const historyHref = (source: URL, descriptors: ReadonlyArray<ModuleDescriptor>): string => {
  const url = new URL(source)
  const route = readModuleRoute(url, descriptors)
  if (Result.isSuccess(route)) url.hash = `${route.success.module}/${route.success.page}`
  url.searchParams.sort()
  return url.href
}

/** Ordinary document anchors keep their URL and use the landing page behind them. */
const shellLocation = (
  incoming: URL,
  descriptors: ReadonlyArray<ModuleDescriptor>,
  landing: ModuleDestination,
  anchorFallback: ModuleDestination = landing
): ShellLocation => {
  const source = hubModuleUrl(incoming, descriptors)
  const legacyWorkAnchor = source.hash === "#work-selected-goal" && source.searchParams.get("tab") === "work"
  if (
    source.hash !== "" &&
    !source.hash.includes("/") &&
    !legacyWorkAnchor &&
    !descriptors.some((module) => source.hash === `#${module.id}`)
  ) {
    return { url: source, destination: anchorFallback, error: null, focus: null }
  }
  const legacy = legacyWorkAnchor
    ? hubModuleLinkTarget(
        source.href,
        source,
        { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
        descriptors
      )
    : null
  const canonical = legacy ?? canonicalModuleUrl(source, descriptors, landing)
  if (Result.isFailure(canonical))
    return { url: source, destination: landing, error: source.hash || source.search, focus: null }
  const route = readModuleRoute(canonical.success, descriptors)
  return Result.isFailure(route)
    ? { url: source, destination: landing, error: source.hash, focus: null }
    : { url: canonical.success, destination: route.success, error: null, focus: "page" }
}

/** Keep a module's component position and last page while another module shows. */
const ModuleSlot = ({
  closeSelection,
  location,
  navigate,
  openHostAccess,
  view
}: {
  readonly view: ModuleViews<ModuleDescriptor>
  readonly location: ShellLocation
  readonly navigate: ModulePageMount["navigate"]
  readonly closeSelection: ModulePageMount["closeSelection"]
  readonly openHostAccess: () => void
}): ReactElement => {
  const active = location.error === null && location.destination.module === view.descriptor.id
  const [saved, setSaved] = useState({ page: view.descriptor.defaultPage, search: "" })
  const selected = active ? { page: location.destination.page, search: location.url.search } : saved
  if (active && (saved.page !== selected.page || saved.search !== selected.search)) setSaved(selected)
  const renderPage = view.pages[selected.page]
  if (renderPage === undefined)
    throw new ModuleRegistrationError({ module: view.descriptor.id, reason: "browser_mismatch" })
  return (
    <section data-module={view.descriptor.id} hidden={!active}>
      {renderPage(new URLSearchParams(selected.search), { active, navigate, closeSelection, openHostAccess })}
    </section>
  )
}

/** Bootstrap/last-success readings stay visible while reconnecting; no reading is unavailable. */
export type SuperappSession =
  | { readonly access: "tailscale" | "loopback"; readonly connection: "connected" | "unavailable" }
  | { readonly access: "tailscale" | "loopback"; readonly connection: "stale"; readonly observedAt: number }

/** The canonical hub owns module history, shared chrome and one Relay conversation. */
export const SuperappShell = <const Views extends ReadonlyArray<ModuleViews<ModuleDescriptor>>>({
  host,
  hostCount,
  landing,
  mobileModules,
  modules,
  notifications,
  onLocationChange,
  primaryModules,
  relay,
  session,
  terminalOwnsKeys = false
}: {
  readonly modules: Views
  readonly landing: NoInfer<ModuleDestination<Views[number]["descriptor"]>>
  /** Installed modules shown directly on the phone bar; defaults to every installed module. */
  readonly mobileModules?: ReadonlyArray<NoInfer<Views[number]["descriptor"]["id"]>>
  /** Installed destinations above the desktop divider; defaults to one flat group. */
  readonly primaryModules?: ReadonlyArray<NoInfer<Views[number]["descriptor"]["id"]>>
  readonly host: string
  readonly hostCount: number
  /** Access and connectivity come from the composition, never inferred from the host label. */
  /** Defaults false. An active connected Connect terminal reserves summon keys and hides/inerts shell chrome until it exits. Home directory itself does neither. */
  readonly terminalOwnsKeys?: boolean
  readonly session: SuperappSession
  readonly notifications: ReactNode
  readonly relay?: HubRelayConversation
  /** Keep existing product selection owners synchronized before the route paints. */
  readonly onLocationChange?: (search: string) => void
}): ReactElement => {
  const metadata = modules.map((view) => view.descriptor)
  const checked = makeModuleViews(metadata, modules)
  if (Result.isFailure(checked)) throw checked.failure
  const fingerprint = moduleRegistryFingerprint(metadata)
  const descriptors = useMemo(() => {
    const descriptors = metadata
    const landingUrl = new URL(`https://example.invalid/#${landing.module}/${landing.page}`)
    if (Result.isFailure(readModuleRoute(landingUrl, descriptors)))
      throw new ModuleRegistrationError({ module: landing.module, reason: "missing_default" })
    return descriptors
  }, [fingerprint, landing.module, landing.page])
  const [location, setLocation] = useState(() => shellLocation(new URL(window.location.href), descriptors, landing))
  const [documentNonce] = useState(() => window.crypto.randomUUID())
  const focusBeforeNavigation = useRef<Element | null>(document.activeElement)
  const pendingSelectionClose = useRef<{
    readonly parent: string
    readonly closing: string
    readonly startedAt: number
  } | null>(null)
  const [panel, setPanel] = useState<{ readonly page: "modules" | "notifications" | "hosts"; readonly open: boolean }>({
    page: "modules",
    open: false
  })
  const closePanel = () => setPanel((current) => ({ ...current, open: false }))
  const pendingPanelNavigation = useRef<ShellLocation | null>(null)
  const clearPanelNavigation = useCallback(() => {
    pendingPanelNavigation.current = null
  }, [])
  const openPanel = (page: "modules" | "notifications" | "hosts"): void => {
    clearPanelNavigation()
    setPanel({ page, open: true })
  }
  const restorePanelFocus = useCallback((): boolean => {
    const next = pendingPanelNavigation.current
    clearPanelNavigation()
    if (next === null) return false
    if (next.focus === "search") {
      focusWhenShown("connect-agent-search")
      return true
    }
    if (next.focus === "page") {
      focusModulePage(next.destination.module, next.destination.page)
      return true
    }
    return false
  }, [clearPanelNavigation])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const restoreShortcutsFocus = useCallback(
    (opener: HTMLElement | null): boolean => {
      if (opener?.isConnected === true) return false
      focusModulePage(location.destination.module, location.destination.page)
      return true
    },
    [location.destination.module, location.destination.page]
  )
  const prefix = useRef<FleetShortcutPrefix>(null)
  const [usageEmpty, setUsageEmpty] = useState(false)
  const [usageGrouped, setUsageGrouped] = useState(false)
  const [announcementOutlet, setAnnouncementOutlet] = useState<HTMLElement | null>(null)
  const [usageHeaderOutlet, setUsageHeaderOutlet] = useState<HTMLElement | null>(null)
  const usageEmptyChrome = useMemo(
    () => ({ host, headerOutlet: usageHeaderOutlet, setEmpty: setUsageEmpty, setGrouped: setUsageGrouped }),
    [host, usageHeaderOutlet]
  )
  const header = useRef<HTMLElement>(null)
  const bottomBar = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (location.error === null && location.url.href !== window.location.href)
      window.history.replaceState(historyState(), "", location.url)
  }, [location])
  useLayoutEffect(() => {
    onLocationChange?.(location.url.search)
  }, [location.url.search, onLocationChange])
  const navigate = (
    href: string,
    history: "push" | "replace",
    focus: Exclude<ShellLocation["focus"], "deferred" | "history"> = "page"
  ): void => {
    const current = new URL(window.location.href)
    const target = hubModuleLinkTarget(
      href,
      current,
      { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      descriptors
    )
    if (target === null || Result.isFailure(target)) {
      setLocation((previous) => ({ ...previous, error: href }))
      return
    }
    const next = shellLocation(target.success, descriptors, landing)
    if (next.error !== null) {
      setLocation((previous) => ({ ...previous, error: href }))
      return
    }
    pendingSelectionClose.current = null
    focusBeforeNavigation.current = document.activeElement
    if (history === "push")
      window.history.pushState(
        {
          ...historyState(),
          relayShell: { openedFrom: historyHref(location.url, descriptors), document: documentNonce }
        },
        "",
        next.url
      )
    else window.history.replaceState(historyState(), "", next.url)
    if (panel.open) {
      pendingPanelNavigation.current = { ...next, focus }
      closePanel()
    }
    setLocation({ ...next, focus: panel.open ? "deferred" : focus })
  }
  const closeSelection = (parentHref: string): void => {
    const current = new URL(window.location.href)
    const pending = pendingSelectionClose.current
    if (pending !== null && pending.closing === current.href) {
      if (window.performance.now() - pending.startedAt < 500) return
      // A cancelled traversal must not leave later Close attempts disabled.
      navigate(parentHref, "replace", null)
      return
    }
    const parent = hubModuleLinkTarget(
      parentHref,
      current,
      { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      descriptors
    )
    const entry = Schema.decodeUnknownResult(ShellHistoryEntry)(historyState().relayShell)
    const parentLocation =
      parent !== null && Result.isSuccess(parent) ? shellLocation(parent.success, descriptors, landing) : null
    const parentKey = parentLocation === null ? null : historyHref(parentLocation.url, descriptors)
    if (parentKey === historyHref(shellLocation(current, descriptors, landing).url, descriptors)) return
    if (
      parentKey !== null &&
      Result.isSuccess(entry) &&
      entry.success.document === documentNonce &&
      entry.success.openedFrom === parentKey
    ) {
      // Separate input tasks may arrive before popstate. Bound the guard so a stalled Back can still close.
      pendingSelectionClose.current = { parent: parentKey, closing: current.href, startedAt: window.performance.now() }
      window.history.back()
      return
    }
    navigate(parentHref, "replace", null)
  }
  const cancelLocationFocus = useRef<(() => void) | null>(null)
  const previousFocusDestination = useRef(location.destination)
  // Compare with the navigation origin, before child activation effects can claim their target.
  useLayoutEffect(() => {
    const previous = previousFocusDestination.current
    previousFocusDestination.current = location.destination
    const arrival = previous.module !== location.destination.module || previous.page !== location.destination.page
    // Query repairs retain the pending arrival focus, but never start another focus request.
    if (location.focus === null) return
    cancelLocationFocus.current?.()
    cancelLocationFocus.current = null
    if (location.focus === "search") {
      cancelLocationFocus.current = focusWhenShown("connect-agent-search")
    }
    if (location.focus === "page" || location.focus === "history")
      cancelLocationFocus.current = focusModulePage(
        location.destination.module,
        location.destination.page,
        arrival || location.focus === "history",
        focusBeforeNavigation.current
      )
  }, [location])
  useLayoutEffect(() => () => cancelLocationFocus.current?.(), [])
  useEffect(() => {
    const read = (event: Event): void => {
      const url = new URL(window.location.href)
      const origin = document.activeElement
      const closing = pendingSelectionClose.current?.parent === historyHref(url, descriptors)
      pendingSelectionClose.current = null
      setLocation((previous) => {
        const next = shellLocation(url, descriptors, landing, previous.destination)
        // Hash traversals also emit hashchange. Do not repeat focus after popstate handled them.
        if (
          historyHref(next.url, descriptors) === historyHref(previous.url, descriptors) &&
          next.error === previous.error
        )
          return next.url.href === previous.url.href && next.url.href === url.href ? previous : { ...next, focus: null }
        if (closing) return { ...next, focus: null }
        focusBeforeNavigation.current = origin
        return event.type === "popstate" && next.focus === "page" ? { ...next, focus: "history" } : next
      })
    }
    window.addEventListener("popstate", read)
    window.addEventListener("hashchange", read)
    return () => {
      window.removeEventListener("popstate", read)
      window.removeEventListener("hashchange", read)
    }
  }, [descriptors, landing.module, landing.page])
  useEffect(() => {
    const click = (event: MouseEvent): void => {
      if (event.defaultPrevented) return
      const anchor = event
        .composedPath()
        .find((node): node is HTMLAnchorElement => Predicate.hasProperty(node, "tagName") && node.tagName === "A")
      const href = anchor?.getAttribute("href")
      if (
        anchor === undefined ||
        href === null ||
        href === undefined ||
        anchor.hasAttribute("target") ||
        anchor.hasAttribute("download")
      )
        return
      const target = hubModuleLinkTarget(href, new URL(window.location.href), event, descriptors)
      if (target === null) return
      event.preventDefault()
      const route = Result.isSuccess(target) ? readModuleRoute(target.success, descriptors) : null
      const owner = anchor.closest<HTMLElement>("[data-module], [data-module-owner]")
      const samePage =
        ((owner?.dataset.module ?? owner?.dataset.moduleOwner) === location.destination.module ||
          anchor.closest('[aria-label="More modules"]') !== null) &&
        route !== null &&
        Result.isSuccess(route) &&
        location.error === null &&
        route.success.module === location.destination.module &&
        route.success.page === location.destination.page
      navigate(href, samePage ? "replace" : "push", samePage ? null : "page")
    }
    document.addEventListener("click", click)
    return () => document.removeEventListener("click", click)
  })
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const next = fleetShortcutFor({
        alt: event.altKey,
        control: event.ctrlKey || event.metaKey,
        editable: isEditableTarget(event.target),
        key: event.key,
        now: event.timeStamp,
        prefix: prefix.current
      })
      prefix.current = next.prefix
      if (next.shortcut === null) return
      if (next.shortcut._tag === "open_shortcuts") {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      const targetModule =
        next.shortcut._tag === "focus_agent_search" || next.shortcut.tab === "connect"
          ? (descriptors.find((module) => module.id === "connect") ??
            descriptors.find((module) => module.id === "fleet"))
          : next.shortcut.tab === "usage"
            ? (descriptors.find((module) => module.id === "usage") ??
              descriptors.find((module) => module.id === "fleet"))
            : descriptors.find((module) => module.id === "fleet")
      if (targetModule === undefined) return
      event.preventDefault()
      const page =
        next.shortcut._tag === "focus_agent_search" || next.shortcut.tab === "connect"
          ? targetModule.id === "connect"
            ? targetModule.defaultPage
            : "connect"
          : next.shortcut.tab === "usage" && targetModule.id === "usage"
            ? targetModule.defaultPage
            : next.shortcut.tab
      navigate(
        moduleHref(targetModule, page),
        location.destination.module === targetModule.id ? "replace" : "push",
        next.shortcut._tag === "focus_agent_search" ? "search" : "page"
      )
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  })
  useLayoutEffect(() => {
    const element = header.current
    if (element === null) return
    const update = (): void => {
      document.documentElement.style.setProperty(
        "--rly-relay-panel-offset",
        `${String(Math.max(0, element.getBoundingClientRect().bottom))}px`
      )
      document.documentElement.style.setProperty(
        "--app-bottom-inset",
        `${String(bottomBar.current?.getBoundingClientRect().height ?? 0)}px`
      )
    }
    update()
    const observer = "ResizeObserver" in window ? new ResizeObserver(update) : null
    observer?.observe(element)
    if (bottomBar.current !== null) observer?.observe(bottomBar.current)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update)
      document.documentElement.style.removeProperty("--rly-relay-panel-offset")
      document.documentElement.style.removeProperty("--app-bottom-inset")
    }
  }, [])
  const currentModule =
    location.error === null ? descriptors.find((module) => module.id === location.destination.module) : undefined
  const currentPage = currentModule?.pages.find((page) => page.id === location.destination.page)
  const hostLabel = hostCount === 1 ? "1 host configured" : `${String(hostCount)} hosts configured`
  const landingModule = descriptors.find((module) => module.id === landing.module)
  if (landingModule === undefined)
    throw new ModuleRegistrationError({ module: landing.module, reason: "missing_default" })
  const moduleLink = (module: ModuleDescriptor) => {
    const view = modules.find((view) => view.descriptor.id === module.id)
    const badge = view?.navigationBadge
    return (
      <a
        aria-label={badge === undefined ? module.label : `${module.label}, ${badge.label}`}
        aria-current={location.error === null && module.id === location.destination.module ? "page" : undefined}
        data-secondary={primaryModules !== undefined && !primaryModules.includes(module.id) ? true : undefined}
        href={moduleHref(module, module.defaultPage)}
        key={module.id}
      >
        {view?.navigationIcon ?? <ShellIcon name={module.id === "fleet" ? "fleet" : "modules"} />}
        <span>{module.label}</span>
        {badge === undefined || badge.text === "" ? null : (
          <span className="superapp-module-badge" aria-hidden="true">
            {badge.text}
          </span>
        )}
      </a>
    )
  }
  const primaryDescriptors = descriptors.filter(
    (module) => primaryModules === undefined || primaryModules.includes(module.id)
  )
  const secondaryDescriptors = descriptors.filter((module) => !primaryDescriptors.includes(module))
  const mobileDescriptors = descriptors.filter(
    (module) => mobileModules === undefined || mobileModules.includes(module.id)
  )
  const offBarModule =
    currentModule !== undefined && !mobileDescriptors.some((module) => module.id === currentModule.id)
  const terminalActive = terminalOwnsKeys && location.error === null && location.destination.module === "connect"
  const limitsActive =
    location.error === null && location.destination.module === "usage" && location.destination.page === "limits"
  const emptyActive = usageEmpty && limitsActive
  // The design's Limits header wraps the shell mast, page title and tabs, so Limits groups them in every state.
  const headerGrouped = (usageGrouped || usageEmpty) && limitsActive
  // Readings can turn empty (or stop being empty) after arrival focus ran. The layout switch, and the empty
  // mast moving into the header outlet once it mounts, unmount the focused page tab, so focus would fall to
  // <body>; hand it to the same page's tab in the new layout.
  // Only focus the switch itself removed is handed over: a poll that flips the layout while the reader rests on
  // <body> must not pull focus to the tabs.
  const emptyLayout = `${emptyActive ? "empty" : "ordinary"}:${
    headerGrouped ? (usageHeaderOutlet === null ? "inline" : "outlet") : "shell"
  }`
  const previousEmptyLayout = useRef(emptyLayout)
  const lastFocused = useRef<Element | null>(null)
  useEffect(() => {
    // focusin fires once the new element holds focus, so the document already names it. Chromium also fires
    // focusout when the focused element is removed, so the record is dropped a microtask later, and only if that
    // element is still in the document and no longer focused: a deliberate blur. The handoff's layout effect runs
    // in the same commit as a removal, before that check.
    const track = (): void => {
      lastFocused.current = document.activeElement
    }
    const release = (): void => {
      queueMicrotask(() => {
        const left = lastFocused.current
        if (left !== null && left.isConnected && document.activeElement !== left) lastFocused.current = null
      })
    }
    document.addEventListener("focusin", track)
    document.addEventListener("focusout", release)
    return () => {
      document.removeEventListener("focusin", track)
      document.removeEventListener("focusout", release)
    }
  }, [])
  useLayoutEffect(() => {
    if (previousEmptyLayout.current === emptyLayout) return
    previousEmptyLayout.current = emptyLayout
    // The record is not cleared here: ordinary -> inline -> outlet can be two commits, and the second run's
    // cleanup cancels the first handoff. Focus landing anywhere replaces the record through focusin.
    const lost = lastFocused.current
    if (location.error !== null || lost === null || lost.isConnected || document.activeElement !== document.body) return
    return focusModulePage(location.destination.module, location.destination.page)
  }, [emptyLayout, location])
  const relayElement =
    relay === undefined ? null : (
      <HubRelay
        key="relay"
        announcementOutlet={announcementOutlet}
        relay={relay}
        launcherLabels={{ desktop: "Ask Relay", phone: "Ask Relay" }}
        launcherMark="chef"
        terminalOwnsKeys={
          location.error === null &&
          ((location.destination.module === "connect" && terminalOwnsKeys) ||
            (location.destination.module === "fleet" && location.destination.page === "connect"))
        }
      />
    )
  const headerElement = (
    <header
      className="superapp-header"
      ref={header}
      hidden={terminalActive}
      inert={terminalActive}
      data-region={headerGrouped ? undefined : "header"}
    >
      <a className="superapp-brand" href={moduleHref(landingModule, landing.page)} aria-label="Relay home" title="Home">
        {headerGrouped ? <UsageEmptyChef /> : <RelayChefMastMark />}
      </a>
      <strong className="superapp-phone-title" aria-hidden="true">
        {location.error === null ? currentModule?.label : "Page not found"}
        {currentPage?.showInPhoneTitle === true ? <span> {currentPage.label}</span> : null}
      </strong>
      {/* The grouped header reads hosts and notifications before Ask Relay, as the design does; the grid places it. */}
      {headerGrouped ? null : relayElement}
      <nav aria-label="Current page" className="superapp-breadcrumb" data-route-found={location.error === null}>
        <span className="superapp-breadcrumb-root">Relay</span>
        <span aria-hidden="true" className="superapp-breadcrumb-root">
          /
        </span>
        {location.error === null ? (
          <>
            {currentModule === undefined || currentModule.pages.length === 1 ? null : (
              <a href={moduleHref(currentModule, currentModule.defaultPage)} title={currentModule.label}>
                <span>{currentModule.label}</span>
              </a>
            )}
            {currentModule === undefined || currentModule.pages.length === 1 ? null : <span aria-hidden="true">/</span>}
            <span aria-current="page" title={currentPage?.label}>
              <bdi dir="ltr">{currentPage?.label}</bdi>
            </span>
          </>
        ) : (
          <span>Page not found</span>
        )}
      </nav>
      <button
        type="button"
        aria-label={`${hostLabel}: ${host}`}
        className="superapp-control superapp-host"
        onClick={() => openPanel("hosts")}
      >
        <ShellIcon name="host" />
        <span>{hostLabel}</span>
      </button>
      <button
        type="button"
        className="superapp-control superapp-notifications"
        onClick={() => openPanel("notifications")}
        aria-label="Notifications"
      >
        <ShellIcon name="notifications" />
      </button>
      {headerGrouped ? relayElement : null}
    </header>
  )
  const sidebarElement = (
    <nav aria-label="Modules" key="sidebar" className="superapp-sidebar" hidden={terminalActive} inert={terminalActive}>
      <a
        className="superapp-sidebar-brand"
        href={moduleHref(landingModule, landing.page)}
        aria-label="Relay home"
        title="Home"
      >
        <RelayChefMark />
        <div>
          <strong>Relay</strong>
        </div>
      </a>
      {/* The design's nav region is this module list in every layout; brand, Settings and session sit outside it. */}
      <div className="superapp-module-nav" data-region="nav">
        {primaryDescriptors.map(moduleLink)}
        {secondaryDescriptors.length === 0 ? null : <span className="superapp-nav-divider" role="separator" />}
        {secondaryDescriptors.map(moduleLink)}
      </div>
      <button
        type="button"
        className="superapp-control superapp-settings"
        aria-haspopup="dialog"
        aria-expanded={panel.open && panel.page === "modules"}
        onClick={() => openPanel("modules")}
      >
        <ShellIcon name="host" /> Settings
      </button>
      <div className="superapp-session" data-state={session.connection}>
        <span className="superapp-session-avatar" aria-hidden="true">
          <ShellIcon name="host" />
        </span>
        <span aria-hidden="true">
          Session on {host}
          <small>
            {session.connection === "connected" ? (
              session.access === "loopback" ? (
                "Local access"
              ) : (
                "Tailscale access"
              )
            ) : session.connection === "stale" ? (
              <>
                Reconnecting, last seen{" "}
                <time dateTime={new Date(session.observedAt).toISOString()}>
                  {dashboardRefreshTime(session.observedAt)}
                </time>
              </>
            ) : (
              "Hub not reachable"
            )}
          </small>
        </span>
        <span className="superapp-session-announcement">
          Session on {host}.{" "}
          {session.connection === "connected"
            ? `${session.access === "loopback" ? "Local access" : "Tailscale access"}, connected.`
            : session.connection === "stale"
              ? `Reconnecting; last seen ${dashboardRefreshTime(session.observedAt)}.`
              : "Hub not reachable."}
        </span>
        {session.connection === "connected" ? (
          <span className="superapp-session-online" data-state="connected" aria-hidden="true" />
        ) : null}
      </div>
    </nav>
  )
  return (
    <UsageEmptyChromeContext.Provider value={usageEmptyChrome}>
      <PortalProvider>
        <div
          className="superapp-shell"
          data-usage-empty={emptyActive ? "true" : undefined}
          data-usage-header={headerGrouped ? "grouped" : undefined}
        >
          {/* One outlet for both layouts, so a layout change never reinserts Relay's populated status region. */}
          <div className="superapp-announcements" ref={setAnnouncementOutlet} />
          {headerGrouped ? sidebarElement : null}
          <div
            key="header"
            className={headerGrouped ? "usage-empty-header-region" : "superapp-header-region"}
            data-region={headerGrouped ? "header" : undefined}
            hidden={terminalActive}
            inert={terminalActive}
          >
            {headerElement}
            {headerGrouped ? (
              <div className="usage-empty-header-outlet" data-module-owner="usage" ref={setUsageHeaderOutlet} />
            ) : null}
          </div>
          {headerGrouped ? null : sidebarElement}
          <main className="superapp-main" id="main" tabIndex={-1}>
            {location.error === null ? null : (
              <StatePanel
                announce="assertive"
                className="superapp-not-found"
                title="This page doesn't exist in Relay."
                description={
                  <>
                    Nothing is registered at <code>{location.error}</code>.
                  </>
                }
                action={<a href={moduleHref(landingModule, landing.page)}>Back to {landingModule.label}</a>}
              />
            )}
            {modules.map((view) => (
              <ModuleSlot
                key={view.descriptor.id}
                view={view}
                location={location}
                navigate={navigate}
                closeSelection={closeSelection}
                openHostAccess={() => openPanel("hosts")}
              />
            ))}
          </main>
          <nav
            aria-label="Mobile modules"
            className="superapp-bottom"
            ref={bottomBar}
            data-region="nav"
            hidden={terminalActive}
            inert={terminalActive}
          >
            {mobileDescriptors.map(moduleLink)}
            <button
              type="button"
              className="superapp-control"
              aria-current={offBarModule ? "page" : undefined}
              aria-expanded={panel.open && panel.page === "modules"}
              aria-label={offBarModule ? `More, current module ${currentModule.label}` : undefined}
              onClick={() => openPanel("modules")}
            >
              <ShellIcon name="modules" /> <span>More</span>
            </button>
          </nav>
          <Dialog.Root
            open={panel.open}
            onOpenChange={(open) => {
              if (!open) closePanel()
            }}
          >
            <Dialog.Content
              title={panel.page === "modules" ? "More" : panel.page === "hosts" ? "Hosts" : "Notifications"}
              className="superapp-dialog"
              restoreFocus={restorePanelFocus}
            >
              <span aria-hidden="true" className="superapp-dialog-title-icon">
                <ShellIcon
                  name={panel.page === "modules" ? "modules" : panel.page === "hosts" ? "host" : "notifications"}
                />
              </span>
              {panel.page === "modules" ? (
                <div className="superapp-more">
                  <nav aria-label="More modules">
                    {descriptors
                      .filter((module) => !mobileDescriptors.includes(module))
                      .map((module) => (
                        <a
                          key={module.id}
                          href={moduleHref(module, module.defaultPage)}
                          aria-current={
                            location.error === null && module.id === location.destination.module ? "page" : undefined
                          }
                        >
                          {modules.find((view) => view.descriptor.id === module.id)?.navigationIcon ?? (
                            <ShellIcon name={module.id === "fleet" ? "fleet" : "modules"} />
                          )}
                          <span>
                            <strong>{module.label}</strong>
                            <small>{module.pages.map((page) => page.label).join(", ")}</small>
                          </span>
                        </a>
                      ))}
                  </nav>
                  <section aria-labelledby="superapp-settings-heading">
                    <h3 id="superapp-settings-heading">Settings</h3>
                    <button type="button" onClick={() => openPanel("hosts")}>
                      <span>Host access</span>
                      <small>{hostLabel}</small>
                    </button>
                    <button type="button" onClick={() => openPanel("notifications")}>
                      <span>Notifications</span>
                      <small>Approvals and blocked agents</small>
                    </button>
                  </section>
                </div>
              ) : panel.page === "hosts" ? (
                <p>
                  {host}. {hostLabel}.
                </p>
              ) : (
                notifications
              )}
              <IconButton
                className="superapp-dialog-close"
                icon="close"
                label="Close"
                onClick={closePanel}
                size="default"
                variant="quiet"
              />
            </Dialog.Content>
          </Dialog.Root>
          <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} restoreFocus={restoreShortcutsFocus} />
        </div>
      </PortalProvider>
    </UsageEmptyChromeContext.Provider>
  )
}
