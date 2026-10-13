import type { ReactElement, ReactNode, TouchEventHandler } from "react"
import { fleetModule, fleetHubModule, moduleHref, type ModulePageMount, type ModuleViews } from "./modules.js"
import { FleetShell, type FleetShellTab } from "./shell-view.js"

export interface FleetModuleContent {
  readonly approvals: ReactNode
  readonly connect: ReactNode
  readonly work: ReactNode
  readonly usage: ReactNode
  readonly notice: ReactNode
  readonly hostCount: number
  readonly gesture: {
    readonly onTouchStart: TouchEventHandler<HTMLDivElement>
    readonly onTouchMove: TouchEventHandler<HTMLDivElement>
    readonly onTouchEnd: TouchEventHandler<HTMLDivElement>
    readonly onTouchCancel: TouchEventHandler<HTMLDivElement>
  }
}

/** Every Fleet page uses this same root, preserving the mounted Approvals decision. */
const FleetModulePage = ({
  canonical = false,
  content,
  mount,
  page,
  search
}: {
  readonly content: FleetModuleContent
  readonly canonical?: boolean
  readonly page: FleetShellTab
  readonly search: URLSearchParams
  readonly mount: ModulePageMount
}): ReactElement => (
  <div className="dashboard-gesture" {...content.gesture}>
    {canonical ? (
      <header className="superapp-module-heading">
        <h1>Fleet</h1>
        <p>Hosts, approvals and what they apply</p>
      </header>
    ) : null}
    <FleetShell
      active={mount.active}
      embedded
      {...(canonical ? { pages: ["approvals", "work"] } : {})}
      navigation={{ tab: page, onTabChange: (tab) => mount.navigate(moduleHref(fleetModule, tab, search), "replace") }}
      approvals={content.approvals}
      connect={content.connect}
      work={content.work}
      usage={content.usage}
      notice={content.notice}
      hostCount={content.hostCount}
    />
  </div>
)

/** Mount existing Fleet content through the shared page registry without remounting its root. */
export const makeFleetModuleViews = (content: FleetModuleContent): ModuleViews<typeof fleetModule> => {
  const page = (tab: FleetShellTab) => (search: URLSearchParams, mount: ModulePageMount) => (
    <FleetModulePage content={content} page={tab} search={search} mount={mount} />
  )
  return {
    descriptor: fleetModule,
    pages: { approvals: page("approvals"), connect: page("connect"), work: page("work"), usage: page("usage") }
  }
}

/** Canonical navigation retires Connect/Usage while preserving Fleet's shared Approvals owner. */
export const makeFleetHubModuleViews = (content: FleetModuleContent): ModuleViews<typeof fleetHubModule> => ({
  descriptor: fleetHubModule,
  pages: {
    approvals: (search, mount) => (
      <FleetModulePage canonical content={content} page="approvals" search={search} mount={mount} />
    ),
    work: (search, mount) => <FleetModulePage canonical content={content} page="work" search={search} mount={mount} />
  }
})
