import { PortalProvider } from "@knpkv/rly/foundations"
import { RelayMark } from "@knpkv/rly/patterns"
import { Dialog, IconButton, StatePanel } from "@knpkv/rly/primitives"
import { Predicate, Result } from "effect"
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
import { hubModuleLinkTarget } from "./internal/hub-module-links.js"
import { ShellIcon } from "./internal/shell-icon.js"
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
  readonly focus: "deferred" | "page" | "search" | null
}

/** Ordinary document anchors keep their URL and use the landing page behind them. */
const shellLocation = (
  source: URL,
  descriptors: ReadonlyArray<ModuleDescriptor>,
  landing: ModuleDestination,
  anchorFallback: ModuleDestination = landing
): ShellLocation => {
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
  location,
  navigate,
  view
}: {
  readonly view: ModuleViews<ModuleDescriptor>
  readonly location: ShellLocation
  readonly navigate: ModulePageMount["navigate"]
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
      {renderPage(new URLSearchParams(selected.search), { active, navigate })}
    </section>
  )
}

/** The canonical hub owns module history, shared chrome and one Relay conversation. */
export const SuperappShell = <const Views extends ReadonlyArray<ModuleViews<ModuleDescriptor>>>({
  host,
  hostCount,
  landing,
  modules,
  notifications,
  onLocationChange,
  relay
}: {
  readonly modules: Views
  readonly landing: NoInfer<ModuleDestination<Views[number]["descriptor"]>>
  readonly host: string
  readonly hostCount: number
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
  const [visited, setVisited] = useState<Readonly<Record<string, { readonly page: string; readonly search: string }>>>(
    {}
  )
  useLayoutEffect(() => {
    if (location.error !== null) return
    setVisited((previous) => {
      const saved = previous[location.destination.module]
      if (saved?.page === location.destination.page && saved.search === location.url.search) return previous
      return {
        ...previous,
        [location.destination.module]: { page: location.destination.page, search: location.url.search }
      }
    })
  }, [location])
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
  const header = useRef<HTMLElement>(null)
  const bottomBar = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (location.error === null && location.url.href !== window.location.href)
      window.history.replaceState(null, "", location.url)
  }, [location])
  useLayoutEffect(() => {
    onLocationChange?.(location.url.search)
  }, [location.url.search, onLocationChange])
  const navigate = (
    href: string,
    history: "push" | "replace",
    focus: Exclude<ShellLocation["focus"], "deferred"> = "page"
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
    if (history === "push") window.history.pushState(null, "", next.url)
    else window.history.replaceState(null, "", next.url)
    if (panel.open) {
      pendingPanelNavigation.current = { ...next, focus }
      closePanel()
    }
    setLocation({ ...next, focus: panel.open ? "deferred" : focus })
  }
  useLayoutEffect(() => {
    if (location.focus === "search") {
      return focusWhenShown("connect-agent-search")
    }
    if (location.focus === "page") return focusModulePage(location.destination.module, location.destination.page)
  }, [location])
  useEffect(() => {
    const read = (): void =>
      setLocation((previous) =>
        shellLocation(new URL(window.location.href), descriptors, landing, previous.destination)
      )
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
      const samePage =
        (anchor.closest<HTMLElement>("[data-module]")?.dataset.module === location.destination.module ||
          anchor.closest('[aria-label="Module picker"]') !== null) &&
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
      const fleet = descriptors.find((module) => module.id === "fleet")
      if (fleet === undefined) return
      event.preventDefault()
      const page = next.shortcut._tag === "focus_agent_search" ? "connect" : next.shortcut.tab
      navigate(
        moduleHref(fleet, page),
        location.destination.module === "fleet" ? "replace" : "push",
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
  const links = descriptors.map((module) => (
    <a
      aria-label={module.label}
      aria-current={location.error === null && module.id === location.destination.module ? "page" : undefined}
      href={moduleHref(
        module,
        visited[module.id]?.page ?? module.defaultPage,
        new URLSearchParams(visited[module.id]?.search)
      )}
      key={module.id}
    >
      <ShellIcon name={module.id === "fleet" ? "fleet" : "modules"} />
      <span>{module.label}</span>
    </a>
  ))
  return (
    <PortalProvider>
      <div className="superapp-shell">
        <header className="superapp-header" ref={header}>
          {relay === undefined ? (
            <span className="superapp-brand">
              <RelayMark.Tile size={32} />
              Relay
            </span>
          ) : (
            <HubRelay
              relay={relay}
              launcherLabels={{ desktop: "Ask Relay", phone: "Relay" }}
              terminalOwnsKeys={
                location.error === null &&
                location.destination.module === "fleet" &&
                location.destination.page === "connect"
              }
            />
          )}
          <nav aria-label="Breadcrumb" className="superapp-breadcrumb" data-route-found={location.error === null}>
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
                {currentModule === undefined || currentModule.pages.length === 1 ? null : (
                  <span aria-hidden="true">/</span>
                )}
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
        </header>
        <nav aria-label="Modules" className="superapp-sidebar">
          <div className="superapp-sidebar-brand">
            <RelayMark.Tile size={32} />
            <div>
              <strong>Relay</strong>
              <p>Ask anything about your work</p>
            </div>
          </div>
          {links}
          <button type="button" className="superapp-control" onClick={() => openPanel("modules")}>
            <ShellIcon name="modules" /> All modules
          </button>
          <div className="superapp-session" title={`Session on ${host}`}>
            <span>Session on {host}</span>
            <small>Tailscale access</small>
          </div>
        </nav>
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
            <ModuleSlot key={view.descriptor.id} view={view} location={location} navigate={navigate} />
          ))}
        </main>
        <nav aria-label="Mobile modules" className="superapp-bottom" ref={bottomBar}>
          {links}
          <button type="button" className="superapp-control" onClick={() => openPanel("modules")}>
            <ShellIcon name="modules" /> All modules
          </button>
        </nav>
        <Dialog.Root
          open={panel.open}
          onOpenChange={(open) => {
            if (!open) closePanel()
          }}
        >
          <Dialog.Content
            title={panel.page === "modules" ? "Your modules" : panel.page === "hosts" ? "Hosts" : "Notifications"}
            {...(panel.page === "modules" ? { description: "One Relay session. Each tool keeps its own pages." } : {})}
            className="superapp-dialog"
            restoreFocus={restorePanelFocus}
          >
            <span aria-hidden="true" className="superapp-dialog-title-icon">
              <ShellIcon
                name={panel.page === "modules" ? "modules" : panel.page === "hosts" ? "host" : "notifications"}
              />
            </span>
            {panel.page === "modules" ? (
              <nav aria-label="Module picker">
                {descriptors.map((module) => (
                  <a
                    key={module.id}
                    href={moduleHref(
                      module,
                      visited[module.id]?.page ?? module.defaultPage,
                      new URLSearchParams(visited[module.id]?.search)
                    )}
                    aria-current={
                      location.error === null && module.id === location.destination.module ? "page" : undefined
                    }
                  >
                    <ShellIcon name={module.id === "fleet" ? "fleet" : "modules"} />
                    <span>
                      <strong>{module.label}</strong>
                      <small>{module.pages.map((page) => page.label).join(", ")}</small>
                    </span>
                  </a>
                ))}
              </nav>
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
  )
}
