// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react"
import { WorkBoard } from "@knpkv/herdr-work/react"
import { decodeWorkNavigationSelection, workNavigationHref } from "@knpkv/herdr-work/navigation"
import type { WorkSnapshot, WorkSnapshots } from "@knpkv/herdr-work/model"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest"
import { fleetModule, type ModuleViews, moduleHref, type ModulePageMount } from "../src/modules.js"
import { SuperappShell } from "../src/superapp-view.js"
import { FleetShell, type FleetShellTab } from "../src/shell-view.js"
import { defineModule, usageModule } from "../src/modules.js"
import { makeFleetModuleViews } from "../src/fleet-module-view.js"
import { DashboardView } from "../src/dashboard-view.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { useApprovalTargetFocus } from "../src/internal/approval-target-focus.js"

const roots: Array<Root> = []
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))

it("types the landing destination from the installed module registry", () => {
  type Props = Parameters<typeof SuperappShell<readonly [ModuleViews<typeof fleetModule>]>>[0]
  expectTypeOf<Props["landing"]>().toEqualTypeOf<{
    readonly module: "fleet"
    readonly page: "approvals" | "connect" | "work" | "usage"
  }>()
  expectTypeOf<Props["mobileModules"]>().toEqualTypeOf<ReadonlyArray<"fleet"> | undefined>()
})
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
})

const FleetPage = ({
  mount,
  page,
  search,
  work
}: {
  readonly page: FleetShellTab
  readonly search: URLSearchParams
  readonly mount: ModulePageMount
  readonly work?: ReactNode
}) => (
  <FleetShell
    embedded
    active={mount.active}
    navigation={{ tab: page, onTabChange: (tab) => mount.navigate(moduleHref(fleetModule, tab, search), "replace") }}
    approvals={<h1>Approval queue</h1>}
    connect={<h1>Agent directory</h1>}
    work={
      work ?? (
        <section>
          <h1>Work board</h1>
          <a href="/connect/?agent=agent-1&host=hub&open=stage">Open in Connect</a>
        </section>
      )
    }
    usage={<h1>Usage history</h1>}
    hostCount={1}
  />
)
const fleetPage = (page: FleetShellTab) => (search: URLSearchParams, mount: ModulePageMount) => (
  <FleetPage page={page} search={search} mount={mount} />
)
const fleet: ModuleViews<typeof fleetModule> = {
  descriptor: fleetModule,
  pages: {
    approvals: fleetPage("approvals"),
    connect: fleetPage("connect"),
    work: fleetPage("work"),
    usage: fleetPage("usage")
  }
}

const render = async (modules: Parameters<typeof SuperappShell>[0]["modules"] = [fleet]) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <SuperappShell
        modules={modules}
        mobileModules={["fleet"]}
        landing={{ module: "fleet", page: "approvals" }}
        host="hub"
        hostCount={1}
        notifications={<p>No recent activity</p>}
      />
    )
  )
}

it("keeps a first-load document anchor while rendering the landing module", async () => {
  window.history.replaceState(null, "", "/#main")
  await render()
  expect(window.location.hash).toBe("#main")
  expect(document.querySelector("h1")?.textContent).toBe("Approval queue")
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it.each<"page" | null | undefined>([undefined, "page", null])(
  "module navigation applies the %s focus policy",
  async (focus) => {
    window.history.replaceState(null, "", "/#fleet/usage")
    const view: ModuleViews<typeof fleetModule> = {
      ...fleet,
      pages: {
        ...fleet.pages,
        usage: (_search, mount) => (
          <>
            <a href="#fleet/usage" data-module-page="usage">
              Usage
            </a>
            <button onClick={() => mount.navigate("?range=30d#fleet/usage", "replace", focus)}>Range</button>
          </>
        )
      }
    }
    await render([view])
    const page = document.querySelector<HTMLElement>('[data-module-page="usage"]')
    const button = document.querySelector<HTMLButtonElement>('[data-module="fleet"] button')
    if (page === null || button === null) return expect.unreachable()
    await vi.waitFor(() => expect(document.activeElement).toBe(page))
    button.focus()
    await act(async () => button.click())
    await vi.waitFor(() => expect(document.activeElement).toBe(focus === null ? button : page))
    expect(window.location.search).toBe("?range=30d")
  }
)

it("keeps personal modules behind the mobile picker and announces its current module", async () => {
  window.history.replaceState(null, "", "/#usage/limits")
  await render([
    fleet,
    { descriptor: usageModule, pages: { limits: () => <h1>Limits</h1>, tokens: () => <h1>Tokens</h1> } }
  ])
  const bottom = document.querySelector('nav[aria-label="Mobile modules"]')
  expect([...(bottom?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual(["Fleet"])
  const picker = bottom?.querySelector("button")
  expect(picker?.getAttribute("aria-current")).toBe("page")
  expect(picker?.getAttribute("aria-label")).toBe("All modules, current module Usage details")
  expect(picker?.getAttribute("aria-label")?.startsWith(picker.textContent?.trim() ?? "")).toBe(true)
  expect(document.querySelector('nav[aria-label="Modules"] a[aria-label="Usage details"]')).not.toBeNull()
})

it("starts the host button name with its visible label and keeps the host named when that label is hidden", async () => {
  await render()
  const button = document.querySelector<HTMLButtonElement>(".superapp-host")
  expect(button).not.toBeNull()
  const label = button?.querySelector("span")
  expect(label?.textContent).toBe("1 host configured")
  expect(button?.getAttribute("aria-label")?.startsWith(label?.textContent ?? "")).toBe(true)
  label?.setAttribute("hidden", "")
  expect(button?.getAttribute("aria-label")).toContain("hub")
})

it("links the breadcrumb module to its landing page and names the current page as text", async () => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render()
  const breadcrumb = document.querySelector('nav[aria-label="Breadcrumb"]')
  const module = breadcrumb?.querySelector<HTMLAnchorElement>("a")
  expect(module?.textContent).toBe("Fleet")
  expect(module?.getAttribute("href")).toBe("?#fleet/approvals")
  expect(breadcrumb?.querySelector('[aria-current="page"]')?.textContent).toBe("Work")
  expect(breadcrumb?.querySelector('[aria-current="page"]')?.tagName).toBe("SPAN")
  const historyLength = window.history.length
  await act(async () => module?.click())
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(window.history.length).toBe(historyLength + 1)
})

it("retains the approval answer across all Fleet pages and another installed module", async () => {
  const Approval = () => {
    const [answer, setAnswer] = useState("Waiting")
    return (
      <button onClick={() => setAnswer("Approved")} type="button">
        {answer}
      </button>
    )
  }
  const views = makeFleetModuleViews({
    approvals: <Approval />,
    connect: <p>Terminal</p>,
    work: <p>Work</p>,
    usage: <p>Usage</p>,
    notice: null,
    hostCount: 1,
    gesture: {
      onTouchStart: () => undefined,
      onTouchMove: () => undefined,
      onTouchEnd: () => undefined,
      onTouchCancel: () => undefined
    }
  })
  const other = defineModule({
    id: "other",
    label: "Other",
    defaultPage: "home",
    pages: [{ id: "home", label: "Home" }],
    listeners: ["serve"],
    requires: ["read"]
  })
  await render([views, { descriptor: other, pages: { home: () => <h1>Other page</h1> } }])
  const answer = document.querySelector<HTMLButtonElement>('[data-module="fleet"] button:not([role="tab"])')
  await act(async () => answer?.click())
  for (const page of ["connect", "work", "usage", "approvals"]) {
    await act(async () => {
      window.location.hash = `#fleet/${page}`
      window.dispatchEvent(new HashChangeEvent("hashchange"))
    })
    expect(document.querySelector('[data-module="fleet"] button:not([role="tab"])')).toBe(answer)
    expect(answer?.textContent).toBe("Approved")
  }
  await act(async () => {
    window.location.hash = "#fleet/work"
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  })
  await act(async () => document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[href*="#other/"]')?.click())
  expect(document.querySelector<HTMLElement>('[data-module="fleet"]')?.hidden).toBe(true)
  await act(async () => document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[href*="#fleet/"]')?.click())
  expect(document.querySelector('[data-module="fleet"] button:not([role="tab"])')).toBe(answer)
  expect(answer?.textContent).toBe("Approved")
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Work")
})

it.each([
  ["approvals", "approvalHost=remote&approvalJob=job-1", "Approvals"],
  ["work", "goal=goal-1", "Work"]
])("opens a legacy %s link with its selectors and target tab focus", async (page, query, label) => {
  window.history.replaceState(null, "", `/?tab=${page}&${query}`)
  await render()
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  })
  expect(window.location.hash).toBe(`#fleet/${page}`)
  expect(window.location.search).toBe(`?${query}`)
  expect(document.activeElement?.getAttribute("role")).toBe("tab")
  expect(document.activeElement?.textContent).toBe(label)
})

it("returns to Work after opening its exact agent in Connect", async () => {
  window.history.replaceState(null, "", "/?goal=goal-1#fleet/work")
  await render()
  const link = document.querySelector<HTMLAnchorElement>('[data-module="fleet"] a')
  await act(async () => link?.click())
  expect(window.location.hash).toBe("#fleet/connect")
  expect(window.location.search).toBe("?agent=agent-1&host=hub&open=stage")
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.hash).toBe("#fleet/work")
  expect(window.location.search).toBe("?goal=goal-1")
  expect(document.activeElement?.textContent).toBe("Work")
})

it("opens a saved Work goal link with its legacy row anchor", async () => {
  window.history.replaceState(null, "", "/?tab=work&goal=goal-1#work-selected-goal")
  await render()
  expect(window.location.hash).toBe("#fleet/work")
  expect(window.location.search).toBe("?goal=goal-1")
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Work")
})

it("keeps the current page when a document anchor changes during the session", async () => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render()
  await act(async () => {
    window.location.hash = "#main"
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  })
  expect(window.location.hash).toBe("#main")
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Work")
})

it("shows a not-found page without displaying the landing module", async () => {
  window.history.replaceState(null, "", "/#fleet/missing")
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("This page doesn't exist in Relay.")
  expect(document.querySelector<HTMLElement>('[data-module="fleet"]')?.hidden).toBe(true)
  expect(window.location.hash).toBe("#fleet/missing")
  await act(async () => document.querySelector<HTMLAnchorElement>(".superapp-not-found a")?.click())
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(document.querySelector<HTMLElement>('[data-module="fleet"]')?.hidden).toBe(false)
})

it("replaces an internal Work window without losing focus, and restores it after a cross-link Back", async () => {
  const snapshot = (window: WorkSnapshot["window"]): WorkSnapshot => ({
    window,
    asOf: 1_000,
    observedAt: 1_000,
    goals: []
  })
  const snapshots: WorkSnapshots = {
    observedAt: 1_000,
    now: snapshot("now"),
    day: snapshot("day"),
    week: snapshot("week"),
    month: snapshot("month")
  }
  const Page = ({
    mount,
    page,
    search
  }: {
    readonly page: FleetShellTab
    readonly search: URLSearchParams
    readonly mount: ModulePageMount
  }) => {
    const selection = decodeWorkNavigationSelection(search.toString())
    return (
      <FleetPage
        page={page}
        search={search}
        mount={mount}
        work={
          <>
            <WorkBoard
              snapshots={snapshots}
              initialWindow={selection.window}
              initialGoalId={selection.goalId}
              navigation={workNavigationHref}
            />
            <a href="?tab=connect">Open agents</a>
          </>
        }
      />
    )
  }
  const page = (page: FleetShellTab) => (search: URLSearchParams, mount: ModulePageMount) => (
    <Page page={page} search={search} mount={mount} />
  )
  window.history.replaceState(null, "", "/?window=now#fleet/work")
  await render([
    {
      descriptor: fleetModule,
      pages: { approvals: page("approvals"), connect: page("connect"), work: page("work"), usage: page("usage") }
    }
  ])
  const previousWeek = [...document.querySelectorAll<HTMLAnchorElement>(".work-time-option")].find(
    (link) => link.textContent === "7 days ago"
  )
  expect(previousWeek).toBeDefined()
  previousWeek?.focus()
  const length = window.history.length
  await act(async () => {
    previousWeek?.click()
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  })
  expect(window.history.length).toBe(length)
  expect(document.activeElement).toBe(previousWeek)
  expect(previousWeek?.getAttribute("aria-current")).toBe("page")
  await act(async () => document.querySelector<HTMLAnchorElement>('a[href="?tab=connect"]')?.click())
  expect(window.history.length).toBe(length + 1)
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(new URLSearchParams(window.location.search).get("window")).toBe("week")
  expect(document.querySelector('.work-time-option[aria-current="page"]')?.textContent).toBe("7 days ago")
  expect(document.activeElement?.textContent).toBe("Work")
})

it("selects and focuses an exact approval after a handoff from another module", async () => {
  const snapshot: DashboardSnapshot = {
    host: "hub",
    observedAt: 1_000,
    approvalsEnabled: true,
    approvalApp: { canonical: true, canonicalUrl: "https://example.invalid/", pushEnabled: false, workEnabled: true },
    work: null,
    directory: null,
    historyNextCursor: null,
    records: [],
    pendingApprovals: {
      failures: [],
      remote: [],
      nextCursors: [],
      local: ["job-1", "job-2"].map((id) => ({
        id,
        actor: "Requester",
        status: "pending_approval",
        payload: { kind: "nix.apply", ref: "main" },
        approvalAvailable: true,
        approvalExpiresAt: 61_000,
        approvedAt: null,
        approvedBy: null,
        createdAt: 1_000,
        expiredAt: null,
        rejectedAt: null,
        rejectedBy: null,
        updatedAt: 1_000
      }))
    },
    status: {
      host: "hub",
      applyConfigured: true,
      branch: "main",
      dirty: false,
      repository: "npm",
      revision: "abc123",
      herdr: { agents: [], available: true, error: null }
    }
  }
  const other = defineModule({
    id: "other",
    label: "Other",
    defaultPage: "home",
    pages: [{ id: "home", label: "Home" }],
    listeners: ["serve"],
    requires: ["read"]
  })
  const App = () => {
    const [search, setSearch] = useState(window.location.search)
    useApprovalTargetFocus(search, snapshot.observedAt, null)
    const fleet = makeFleetModuleViews({
      approvals: (
        <DashboardView
          approvalOnly
          showHeader={false}
          busyJobId={null}
          notificationState="disabled"
          onDecision={undefined}
          onDisableNotifications={undefined}
          onEnableNotifications={undefined}
          onRefresh={undefined}
          pull={{ distance: 0, ready: false, refreshing: false }}
          snapshot={snapshot}
        />
      ),
      work: null,
      connect: null,
      usage: null,
      notice: null,
      hostCount: 1,
      gesture: {
        onTouchStart: () => undefined,
        onTouchMove: () => undefined,
        onTouchEnd: () => undefined,
        onTouchCancel: () => undefined
      }
    })
    return (
      <SuperappShell
        modules={[
          fleet,
          {
            descriptor: other,
            pages: { home: () => <a href="?tab=approvals&approvalHost=hub&approvalJob=job-2">Open request</a> }
          }
        ]}
        landing={{ module: "fleet", page: "approvals" }}
        host="hub"
        hostCount={1}
        notifications={null}
        onLocationChange={setSearch}
      />
    )
  }
  window.history.replaceState(null, "", "/#other/home")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<App />))
  await act(async () => {
    document.querySelector<HTMLAnchorElement>('a[href*="approvalJob=job-2"]')?.click()
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  })
  const request = document.querySelector<HTMLElement>('[data-approval-target="true"]')
  expect(request?.dataset.approvalJob).toBe("job-2")
  expect(document.querySelectorAll('[data-approval-target="true"]')).toHaveLength(1)
  expect(document.activeElement).toBe(request)
  expect(window.location.hash).toBe("#fleet/approvals")
})

it.each([
  ["sidebar modules", ".superapp-sidebar > button", "Your modules"],
  ["bottom modules", ".superapp-bottom > button", "Your modules"],
  ["hosts", ".superapp-host", "Hosts"],
  ["notifications", '.superapp-header button[aria-label="Notifications"]', "Notifications"]
])("clears cancelled navigation when the %s open path starts a new panel cycle", async (_name, selector, title) => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render()
  const pickerOpener = document.querySelector<HTMLButtonElement>(".superapp-sidebar > button")
  await act(async () => pickerOpener?.click())
  const link = document.querySelector<HTMLAnchorElement>('[aria-label="Module picker"] a[href*="#fleet/"]')
  expect(link).not.toBeNull()
  await act(async () => link?.click())
  const opener = document.querySelector<HTMLButtonElement>(selector)
  expect(opener).not.toBeNull()
  await act(async () => {
    opener?.focus()
    opener?.click()
  })
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(title)
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
    )
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(opener))
})

it("closes the module picker and focuses the chosen module after modal cleanup", async () => {
  const other = defineModule({
    id: "other",
    label: "Other",
    defaultPage: "home",
    pages: [{ id: "home", label: "Home" }],
    listeners: ["serve"],
    requires: ["read"]
  })
  await render([fleet, { descriptor: other, pages: { home: () => <h1>Other page</h1> } }])
  await act(async () => document.querySelector<HTMLButtonElement>(".superapp-sidebar > button")?.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => {
    document.querySelector<HTMLAnchorElement>('[aria-label="Module picker"] a[href*="#other/"]')?.click()
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  })
  expect(window.location.hash).toBe("#other/home")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")))
})
