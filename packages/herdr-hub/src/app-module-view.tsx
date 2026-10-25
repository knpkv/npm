/**
 * Installed hub apps as superapp modules. Each app the registry lists becomes a {@link ModuleViews} like a core
 * module's, so the shell's history, focus and navigation treat it the same.
 *
 * **Mental model**
 *
 * - A `Ready` app's pages mount its client: the shell imports `/apps/<id>/app/assets/<entry>` (same origin), links
 *   its CSS, and calls `mount` on an element carrying `data-app="<id>"`. Navigating inside the app, or switching
 *   modules, calls `update`; the instance lives as long as the shell does.
 * - An `Unavailable` app keeps its nav item, with its last manifest's label, and shows the registry's reason.
 *   Turning Unavailable unmounts the client. A new client entry (an update) unmounts the old one, drops its CSS and
 *   mounts the new; the same entry only updates.
 * - A client that fails to import, mount or update shows `client_failed`; the rest of the shell is unaffected.
 * - An app whose id a core module holds (`duplicate`) gets no nav item: the core module owns that id.
 *
 * @module
 */
import {
  AppClientModule,
  type AppManifest,
  type AppState,
  type ModuleDescriptor,
  type MountedApp,
  type ShellBadge,
  type ShellContext
} from "@knpkv/hub-app"
import { StatePanel } from "@knpkv/rly/primitives"
import { Effect, Schema } from "effect"
import {
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { unavailableDetail } from "./apps/unavailable-detail.js"
import { ShellHeaderContext } from "./internal/app-header.js"
import { moduleHref, type ModulePageMount, type ModuleViews } from "./modules.js"

/** Client contracts this shell mounts; the registry already lists an app on any other as incompatible. */
const mountedContracts: ReadonlyArray<number> = [1]

export interface AppModuleOptions {
  /** The machine the hub runs on. */
  readonly host: string
  /** The login the hub authenticated for this page. */
  readonly viewer: string
  /**
   * Nav glyphs the shell draws for apps it knows, by app id. A manifest carries no icon yet, so this is how Usage keeps
   * the chart it had as a hub module; any other app gets the generic module glyph.
   */
  readonly icons?: Readonly<Record<string, ReactNode>>
  /** Each app's badge, as its client last set it. */
  readonly badges: Readonly<Record<string, ShellBadge>>
  readonly setBadge: (id: string, badge: ShellBadge | null) => void
  /**
   * Imports a client module by URL and checks its shape, rejecting a module that isn't a client. Defaults to a
   * dynamic `import()`; tests pass their own.
   */
  readonly load?: (url: string) => Promise<AppClientModule>
}

/** The client threw, or isn't a client this shell mounts. */
export class AppClientFailed extends Schema.TaggedError<AppClientFailed>()("AppClientFailed", {
  id: Schema.String,
  stage: Schema.Literals(["import", "contract", "mount", "update", "unmount"]),
  cause: Schema.Defect()
}) {}

type AppClientModule = typeof AppClientModule.Type

/** Checks an imported module default-exports a client; rejects otherwise. */
export const decodeClientModule = Schema.decodeUnknownPromise(AppClientModule)

/** The module at `url`, checked to default-export a client; a module that isn't one rejects like a failed import. */
const importClient = (url: string): Promise<AppClientModule> =>
  import(/* @vite-ignore */ url).then((loaded) => decodeClientModule(loaded))

/**
 * One of an app's client files. The version is a cache key only (the asset route ignores the query): an update that
 * keeps its file names must not come back from the browser's module cache.
 */
const assetUrl = (id: string, file: string, version: string) =>
  `/apps/${id}/app/assets/${file}?v=${encodeURIComponent(version)}`

/** A registered app that never answered has no manifest; its nav item carries its id until it does. */
const placeholderDescriptor = (id: string): ModuleDescriptor => ({
  id,
  label: id,
  defaultPage: "overview",
  pages: [{ id: "overview", label: id }],
  listeners: ["local"],
  requires: ["read"]
})

const AppPanel = ({ description, title }: { readonly title: string; readonly description: ReactNode }) => (
  <StatePanel className="superapp-app-panel" title={title} description={description} />
)

/** Logs a client failure; the page shows `client_failed`. */
const report = (error: AppClientFailed): void => {
  Effect.runFork(Effect.logError("App client failed", error))
}

const AppMount = ({
  manifest,
  mount,
  options,
  page,
  search
}: {
  readonly manifest: AppManifest
  readonly mount: ModulePageMount
  readonly options: AppModuleOptions
  readonly page: string
  readonly search: URLSearchParams
}): ReactElement => {
  const id = manifest.id
  const header = useContext(ShellHeaderContext)
  const root = useRef<HTMLDivElement>(null)
  const portalRoot = useRef<HTMLDivElement>(null)
  const mounted = useRef<MountedApp | null>(null)
  const [failed, setFailed] = useState(false)
  // The latest render's shell values: the client may arrive after several navigations, and is mounted with these.
  const latest = useRef({ mount, header, options, page, search })
  useLayoutEffect(() => {
    latest.current = { mount, header, options, page, search }
  })
  // Stable for the mount's life, so an app's effects keyed on them don't rerun on every navigation.
  const stable = useMemo(
    () => ({
      navigate: (href: string, history: "push" | "replace", focus?: "page" | "search" | null) =>
        latest.current.mount.navigate(href, history, focus),
      closeSelection: (parentHref: string) => latest.current.mount.closeSelection(parentHref),
      setHeaderMode: (mode: "shell" | "grouped") => latest.current.header?.setMode(id, { grouped: mode === "grouped" }),
      setEmpty: (empty: boolean) => latest.current.header?.setMode(id, { empty }),
      setBadge: (badge: ShellBadge | null) => latest.current.options.setBadge(id, badge),
      openHostAccess: () => latest.current.mount.openHostAccess?.(),
      api: (path: `/${string}`) => `/apps/${id}/v1/modules/${id}${path}`,
      href: (target: string, query?: URLSearchParams) => moduleHref(manifest.module, target, query),
      requestHeaders: () => ({})
    }),
    [id]
  )
  const context = (lent: HTMLElement): ShellContext => {
    const current = latest.current
    return {
      contract: 1,
      mode: "hub",
      caller: { login: current.options.viewer },
      host: current.options.host,
      page: current.page,
      search: current.search,
      active: current.mount.active,
      // The hub shell shows no crumb items or header slot yet; an app that sets them loses nothing else.
      setCrumb: () => {},
      setHeaderSlot: () => {},
      headerOutlet: current.header?.outlet ?? null,
      portalRoot: lent,
      ...stable
    }
  }
  const fail = (error: AppClientFailed) => {
    report(error)
    setFailed(true)
  }

  useEffect(() => {
    const links = manifest.client.css.map((file) => {
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = assetUrl(id, file, manifest.version)
      link.dataset.app = id
      document.head.append(link)
      return link
    })
    let live = true
    void (options.load ?? importClient)(assetUrl(id, manifest.client.entry, manifest.version)).then(
      (loaded) => {
        const target = root.current
        const lent = portalRoot.current
        if (!live || target === null || lent === null) return
        if (!mountedContracts.includes(loaded.default.contract)) {
          fail(new AppClientFailed({ id, stage: "contract", cause: null }))
          return
        }
        try {
          mounted.current = loaded.default.mount(target, context(lent))
        } catch (cause) {
          fail(new AppClientFailed({ id, stage: "mount", cause }))
          return
        }
        // The shell's arrival focus ran before this page existed; let it land on the page's link now.
        latest.current.header?.settleArrivalFocus(id)
      },
      (cause: unknown) => {
        if (live) fail(new AppClientFailed({ id, stage: "import", cause }))
      }
    )
    return () => {
      live = false
      const current = mounted.current
      mounted.current = null
      for (const link of links) link.remove()
      latest.current.header?.setMode(id, { grouped: false, empty: false })
      if (current === null) return
      try {
        current.unmount()
      } catch (cause) {
        report(new AppClientFailed({ id, stage: "unmount", cause }))
      }
    }
  }, [])

  // Only when what the client sees changes. The shell re-renders for its own reasons (an app's own header request
  // among them); answering each with an update would loop with an app that re-asks on every update.
  const searchKey = search.toString()
  const outlet = header?.outlet ?? null
  useEffect(() => {
    const current = mounted.current
    const lent = portalRoot.current
    if (current === null || lent === null) return
    try {
      current.update(context(lent))
    } catch (cause) {
      mounted.current = null
      fail(new AppClientFailed({ id, stage: "update", cause }))
      // A client that failed its update is done: let it release what it holds before the panel replaces it.
      try {
        current.unmount()
      } catch (unmountCause) {
        report(new AppClientFailed({ id, stage: "unmount", cause: unmountCause }))
      }
    }
    // A page this update showed renders on the client's schedule; the shell's arrival focus may have run before it.
    latest.current.header?.settleArrivalFocus(id)
  }, [page, searchKey, mount.active, outlet, options.viewer, options.host])

  return (
    <>
      {failed ? (
        <AppPanel
          title={manifest.module.label}
          description={unavailableDetail(manifest.module.label, "client_failed")}
        />
      ) : null}
      <div className="superapp-app-root" data-app={id} hidden={failed} ref={root} />
      <div className="superapp-app-portals" data-app={id} ref={portalRoot} />
    </>
  )
}

const AppPage = ({
  mount,
  options,
  page,
  search,
  state
}: {
  readonly state: AppState
  readonly page: string
  readonly search: URLSearchParams
  readonly mount: ModulePageMount
  readonly options: AppModuleOptions
}): ReactElement => {
  if (state._tag === "Unavailable") {
    return <AppPanel title={state.manifest?.module.label ?? state.id} description={state.detail} />
  }
  const { client } = state.manifest
  return (
    <AppMount
      // A new version, entry or stylesheet set is a new client: unmount the old instance and mount this one.
      key={[state.manifest.version, client.entry, ...client.css].join("\n")}
      manifest={state.manifest}
      mount={mount}
      options={options}
      page={page}
      search={search}
    />
  )
}

/** The superapp modules for the registry's app states, in their order; `duplicate` ids are left to core modules. */
export const makeAppModuleViews = (
  states: ReadonlyArray<AppState>,
  options: AppModuleOptions
): ReadonlyArray<ModuleViews<ModuleDescriptor>> =>
  states.flatMap((state) => {
    if (state._tag === "Unavailable" && state.reason === "duplicate") return []
    const descriptor =
      state._tag === "Ready" ? state.manifest.module : (state.manifest?.module ?? placeholderDescriptor(state.id))
    const view: ModuleViews<ModuleDescriptor> = {
      descriptor,
      pages: Object.fromEntries(
        descriptor.pages.map((page) => [
          page.id,
          (search: URLSearchParams, mount: ModulePageMount) => (
            <AppPage state={state} page={page.id} search={search} mount={mount} options={options} />
          )
        ])
      )
    }
    const icon = options.icons?.[descriptor.id]
    const badge = options.badges[descriptor.id]
    const drawn = icon === undefined ? view : { ...view, navigationIcon: icon }
    return [badge === undefined ? drawn : { ...drawn, navigationBadge: badge }]
  })
