// @vitest-environment happy-dom
import { act, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { WorkBoard } from "@knpkv/herdr-work/react"
import { decodeWorkNavigationSelection, workNavigationHref } from "@knpkv/herdr-work/navigation"
import type { WorkSnapshot, WorkSnapshots } from "@knpkv/herdr-work/model"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest"
import { fleetModule, type ModuleViews, moduleHref, type ModulePageMount } from "../src/modules.js"
import { SuperappShell } from "../src/superapp-view.js"
import { FleetShell, type FleetShellTab } from "../src/shell-view.js"
import { connectModule, defineModule, todayModule, usageModule } from "../src/modules.js"
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
  vi.restoreAllMocks()
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

const render = async (
  modules: Parameters<typeof SuperappShell>[0]["modules"] = [fleet],
  mobileModules: ReadonlyArray<string> = ["fleet"],
  session:
    | { readonly access: "tailscale" | "loopback"; readonly connection: "connected" | "unavailable" }
    | { readonly access: "tailscale" | "loopback"; readonly connection: "stale"; readonly observedAt: number } = {
    access: "tailscale",
    connection: "connected"
  }
) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <SuperappShell
        modules={modules}
        mobileModules={mobileModules}
        landing={{ module: "fleet", page: "approvals" }}
        host="hub"
        hostCount={1}
        session={session}
        notifications={<p>No recent activity</p>}
      />
    )
  )
}

it("names a module badge without replacing its visible destination name", async () => {
  await render([{ ...fleet, navigationBadge: { text: "3+", label: "at least 3 approvals waiting" } }])
  for (const selector of [".superapp-sidebar", ".superapp-bottom"]) {
    const link = document.querySelector(`${selector} .superapp-module-badge`)?.closest("a")
    expect(link?.getAttribute("aria-label")).toBe("Fleet, at least 3 approvals waiting")
    expect(link?.querySelector(".superapp-module-badge")?.textContent).toBe("3+")
    expect(link?.getAttribute("href")).toBe(moduleHref(fleetModule, "approvals"))
  }
})

it("names an unknown module reading without showing a zero badge", async () => {
  await render([{ ...fleet, navigationBadge: { text: "", label: "approvals unknown" } }])
  expect(document.querySelector('.superapp-module-nav a[aria-label="Fleet, approvals unknown"]')).not.toBeNull()
  expect(document.querySelector(".superapp-module-badge")).toBeNull()
})

it.each([
  { access: "tailscale", connection: "connected", copy: "Tailscale access", dot: true },
  { access: "loopback", connection: "connected", copy: "Local access", dot: true },
  { access: "tailscale", connection: "stale", observedAt: 0, copy: "Reconnecting, last seen", dot: false },
  { access: "tailscale", connection: "unavailable", copy: "Hub not reachable", dot: false }
] satisfies ReadonlyArray<Parameters<typeof render>[2] & { readonly copy: string; readonly dot: boolean }>)(
  "reports $access/$connection from the session instead of claiming a live tailnet connection",
  async ({ copy, dot, ...session }) => {
    await render([fleet], ["fleet"], session)
    const footer = document.querySelector(".superapp-session")
    expect(footer?.textContent).toContain(copy)
    expect(footer?.textContent?.includes("connected")).toBe(dot)
    expect(footer?.getAttribute("data-state")).toBe(session.connection)
    expect(footer?.querySelector(".superapp-session-online") !== null).toBe(dot)
    if (session.access === "loopback") expect(footer?.textContent).not.toContain("Tailscale")
    if (session.connection === "stale")
      expect(footer?.querySelector("time")?.dateTime).toBe(new Date(session.observedAt).toISOString())
  }
)

it.each(["#today", "#today/overview", "#fleet/connect", "?tab=connect"])(
  "repairs the retired %s entry before selecting a module, retaining foreign history state",
  async (alias) => {
    const source = new URL(alias, window.location.href)
    source.searchParams.set("host", "ALPHA")
    source.searchParams.set("agent", "agent-1")
    source.searchParams.set("open", "stage")
    window.history.replaceState({ foreign: "kept" }, "", source)
    const connect: ModuleViews<typeof connectModule> = {
      descriptor: connectModule,
      pages: { overview: (search) => <h1>Connect home {search.get("agent")}</h1> }
    }
    const descriptor = defineModule({
      ...fleetModule,
      pages: [
        { id: "approvals", label: "Approvals" },
        { id: "work", label: "Work" }
      ]
    })
    const retiredFleet: ModuleViews<typeof descriptor> = {
      descriptor,
      pages: { approvals: fleetPage("approvals"), work: fleetPage("work") }
    }
    await render([retiredFleet, connect])
    expect(document.querySelector<HTMLElement>('[data-module="connect"]')?.hidden).toBe(false)
    expect(document.querySelector('[data-module="connect"] h1')?.textContent).toBe("Connect home agent-1")
    expect(window.location.hash).toBe("#connect/overview")
    expect(new URLSearchParams(window.location.search).get("host")).toBe("ALPHA")
    expect(window.history.state).toMatchObject({ foreign: "kept" })
  }
)

it("keeps Today reachable when it and Connect are both installed", async () => {
  window.history.replaceState(null, "", "#connect/overview")
  const connect: ModuleViews<typeof connectModule> = {
    descriptor: connectModule,
    pages: { overview: () => <h1>Connect home</h1> }
  }
  const today: ModuleViews<typeof todayModule> = {
    descriptor: todayModule,
    pages: { overview: () => <h1>Today reading</h1> }
  }
  await render([fleet, today, connect])
  const link = document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[href="?#today/overview"]')
  expect(link).not.toBeNull()
  await act(async () => link?.click())
  expect(window.location.hash).toBe("#today/overview")
  expect(document.querySelector<HTMLElement>('[data-module="today"]')?.hidden).toBe(false)
})

it("opens each module's default page instead of resuming a selected object on a previous page", async () => {
  window.history.replaceState(null, "", "?goal=goal-1&window=week#fleet/work")
  const notesDescriptor = defineModule({
    id: "notes",
    label: "Notes",
    defaultPage: "inbox",
    pages: [{ id: "inbox", label: "Inbox" }],
    listeners: ["serve"],
    requires: ["read"]
  })
  const notes: ModuleViews<typeof notesDescriptor> = {
    descriptor: notesDescriptor,
    pages: { inbox: () => <h1>Inbox</h1> }
  }
  await render([fleet, notes])
  const notesLink = document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[aria-label="Notes"]')
  expect(notesLink).not.toBeNull()
  await act(async () => notesLink?.click())
  const picker = document.querySelector<HTMLButtonElement>(".superapp-bottom > button")
  expect(picker).not.toBeNull()
  await act(async () => picker?.click())
  for (const nav of [".superapp-sidebar", ".superapp-bottom"]) {
    const link = document.querySelector<HTMLAnchorElement>(`${nav} a[href*="#fleet/"]`)
    expect(link?.getAttribute("href")).toBe(moduleHref(fleetModule, fleetModule.defaultPage))
  }
  const fleetLink = document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[href*="#fleet/"]')
  expect(fleetLink).not.toBeNull()
  await act(async () => fleetLink?.click())
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(window.location.search).toBe("")
  expect(document.querySelector<HTMLElement>('[data-module="fleet"]')?.hidden).toBe(false)
})

it("lists only off-bar installed modules in More and links to their default page", async () => {
  window.history.replaceState(null, "", "?goal=selected#fleet/work")
  await render([fleet], [])
  await act(async () => document.querySelector<HTMLButtonElement>(".superapp-bottom > button")?.click())
  const link = document.querySelector<HTMLAnchorElement>('[aria-label="More modules"] a[href*="#fleet/"]')
  expect(link?.getAttribute("href")).toBe(moduleHref(fleetModule, fleetModule.defaultPage))
  expect(document.querySelector(".superapp-more")?.textContent).toContain("Host access")
  expect(document.querySelector(".superapp-more")?.textContent).toContain("Notifications")
  expect(document.querySelector(".superapp-more")?.textContent).not.toContain("Appearance")
  await act(async () => {
    link?.click()
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  })
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(window.location.search).toBe("")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it("keeps an inactive page but remounts distinct page components after a default-page return", async () => {
  const descriptor = defineModule({
    id: "counter",
    label: "Counter",
    defaultPage: "first",
    pages: [
      { id: "first", label: "First" },
      { id: "second", label: "Second" }
    ],
    listeners: ["serve"],
    requires: ["read"]
  })
  const First = ({ mount }: { readonly mount: ModulePageMount }) => (
    <>
      <h1>First page</h1>
      <button onClick={() => mount.navigate(moduleHref(descriptor, "second"), "push")} type="button">
        Open second
      </button>
    </>
  )
  const Second = () => {
    const [count, setCount] = useState(0)
    return (
      <button onClick={() => setCount((value) => value + 1)} type="button">
        Count {count}
      </button>
    )
  }
  const counter: ModuleViews<typeof descriptor> = {
    descriptor,
    pages: { first: (_search, mount) => <First mount={mount} />, second: () => <Second /> }
  }
  window.history.replaceState(null, "", "#counter/second")
  await render([fleet, counter])
  const button = document.querySelector<HTMLButtonElement>('[data-module="counter"] button')
  expect(button).not.toBeNull()
  await act(async () => button?.click())
  expect(button?.textContent).toBe("Count 1")
  await act(async () => document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[aria-label="Fleet"]')?.click())
  expect(document.querySelector('[data-module="counter"] button')).toBe(button)
  expect(button?.textContent).toBe("Count 1")
  await act(async () => document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[aria-label="Counter"]')?.click())
  expect(window.location.hash).toBe("#counter/first")
  expect(document.querySelector('[data-module="counter"] h1')?.textContent).toBe("First page")
  await act(async () => document.querySelector<HTMLButtonElement>('[data-module="counter"] button')?.click())
  expect(window.location.hash).toBe("#counter/second")
  expect(document.querySelector('[data-module="counter"] button')?.textContent).toBe("Count 0")
  expect(document.querySelector('[data-module="counter"] button')).not.toBe(button)
})

it("keeps By tool aliases out of the generic router and repairs them at the shell boundary", async () => {
  const descriptor = defineModule({
    ...usageModule,
    pages: usageModule.pages
  })
  const usage: ModuleViews<typeof descriptor> = {
    descriptor,
    pages: {
      limits: () => <h1>Limits</h1>,
      tokens: () => <h1>Tokens</h1>,
      "by-tool": (search) => (
        <h1>
          By tool {search.get("range")} {search.get("host")}
        </h1>
      )
    }
  }
  window.history.replaceState({ foreign: "kept" }, "", "?range=30d&host=ALPHA#usage/by-agent")
  await render([fleet, usage])
  expect(document.querySelector<HTMLElement>('[data-module="usage"]')?.hidden).toBe(false)
  expect(document.querySelector('[data-module="usage"] h1')?.textContent).toBe("By tool 30d ALPHA")
  expect(window.location.hash).toBe("#usage/by-tool")
  expect(window.history.state).toMatchObject({ foreign: "kept" })
})

const selectionParent = "?range=7d#fleet/usage"
const selectionViews: ModuleViews<typeof fleetModule> = {
  ...fleet,
  pages: {
    ...fleet.pages,
    work: (_search, mount) => <button onClick={() => mount.navigate(selectionParent, "push", null)}>Open queue</button>,
    usage: (search, mount) => (
      <>
        <p>{search.has("ref") ? "Selected item" : "Selection queue"}</p>
        <button onClick={() => mount.navigate("?range=7d&ref=item-1#fleet/usage", "push", null)}>Open item</button>
        <button onClick={() => mount.navigate("?range=7d&ref=item-1&file=0#fleet/usage", "replace", null)}>
          Select file
        </button>
        <button onClick={() => mount.closeSelection(selectionParent)}>Close item</button>
      </>
    )
  }
}
const clickSelectionControl = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent === label)
  if (button === undefined) return expect.unreachable()
  await act(async () => button.click())
}

it("closing a pushed selection returns to its parent without a duplicate Back stop", async () => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render([selectionViews])
  await clickSelectionControl("Open queue")
  await clickSelectionControl("Open item")
  await clickSelectionControl("Close item")
  await vi.waitFor(() => expect(window.location.search).toBe("?range=7d"))
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.hash).toBe("#fleet/work")
})

it("preserves foreign history state and the selection parent through URL repairs and file changes", async () => {
  window.history.replaceState({ external: { reading: "saved" } }, "", "/?range=7d&tab=usage")
  await render([selectionViews])
  expect(window.history.state).toEqual({ external: { reading: "saved" } })
  await clickSelectionControl("Open item")
  await clickSelectionControl("Select file")
  expect(window.history.state).toMatchObject({ external: { reading: "saved" } })
  await clickSelectionControl("Close item")
  await vi.waitFor(() => expect(window.location.search).toBe("?range=7d"))
  await act(async () => {
    window.history.forward()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.search).toBe("?range=7d&ref=item-1&file=0")
  expect(document.querySelector('[data-module="fleet"] p')?.textContent).toBe("Selected item")
})

it("closes a direct selection in place without traversing to its unrelated preceding page", async () => {
  window.history.replaceState(null, "", "/#fleet/work")
  window.history.pushState(null, "", "/?range=7d&ref=item-1#fleet/usage")
  await render([selectionViews])
  await clickSelectionControl("Close item")
  expect(window.location.search).toBe("?range=7d")
  expect(window.location.hash).toBe("#fleet/usage")
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.hash).toBe("#fleet/work")
})

it("a new shell lifetime refuses to traverse a selection opened by the previous shell", async () => {
  window.history.replaceState(null, "", "/?range=7d#fleet/usage")
  await render([selectionViews])
  await clickSelectionControl("Open item")
  await act(async () => roots.pop()?.unmount())
  document.body.replaceChildren()
  await render([selectionViews])
  await clickSelectionControl("Close item")
  expect(window.location.search).toBe("?range=7d")
  // A replace leaves the original queue entry behind it; a Back would have moved onto it.
  await act(async () => {
    window.history.back()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.search).toBe("?range=7d")
  expect(window.location.hash).toBe("#fleet/usage")
})

it("a double close requests only one traversal", async () => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render([selectionViews])
  await clickSelectionControl("Open queue")
  await clickSelectionControl("Open item")
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "Close item")
  if (button === undefined) return expect.unreachable()
  await act(async () => {
    button.click()
    button.click()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.search).toBe("?range=7d")
  expect(window.location.hash).toBe("#fleet/usage")
})

it("uses Back when the parent URL has the same selectors in a different order", async () => {
  window.history.replaceState(null, "", "/?host=hub&range=7d#fleet/usage")
  const back = vi.spyOn(window.history, "back")
  await render([
    {
      ...selectionViews,
      pages: {
        ...selectionViews.pages,
        usage: (_search, mount) => (
          <>
            <button onClick={() => mount.navigate("?host=hub&range=7d&ref=item-1#fleet/usage", "push", null)}>
              Open item
            </button>
            <button onClick={() => mount.closeSelection("?range=7d&host=hub#fleet/usage")}>Close item</button>
          </>
        )
      }
    }
  ])
  await clickSelectionControl("Open item")
  await clickSelectionControl("Close item")
  expect(back).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(window.location.search).toBe("?host=hub&range=7d"))
})

it("a cancelled traversal lets a later Close replace the selected URL", async () => {
  window.history.replaceState(null, "", "/?range=7d#fleet/usage")
  await render([selectionViews])
  await clickSelectionControl("Open item")
  const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined)
  const now = vi.spyOn(window.performance, "now").mockReturnValue(0)
  await clickSelectionControl("Close item")
  expect(window.location.search).toBe("?range=7d&ref=item-1")
  now.mockReturnValue(100)
  await clickSelectionControl("Close item")
  expect(window.location.search).toBe("?range=7d&ref=item-1")
  now.mockReturnValue(501)
  await clickSelectionControl("Close item")
  expect(window.location.search).toBe("?range=7d")
  expect(back).toHaveBeenCalledOnce()
})

it("keeps a supported bare-module alias of the current page without moving focus", async () => {
  window.history.replaceState(null, "", "/#fleet/approvals")
  await render()
  const host = document.querySelector<HTMLButtonElement>(".superapp-host")
  await act(async () => host?.focus())
  await act(async () => {
    window.location.hash = "#fleet"
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  expect(window.location.hash).toBe("#fleet")
  expect(document.activeElement).toBe(host)
})

it("repairs a redundant legacy tab on the current page without moving focus", async () => {
  window.history.replaceState(null, "", "/#fleet/approvals")
  await render()
  const host = document.querySelector<HTMLButtonElement>(".superapp-host")
  await act(async () => host?.focus())
  await act(async () => {
    window.history.replaceState(window.history.state, "", "/?tab=approvals#fleet/approvals")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  expect(window.location.search).toBe("")
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(document.activeElement).toBe(host)
})

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
    {
      descriptor: usageModule,
      pages: { limits: () => <h1>Limits</h1>, tokens: () => <h1>Tokens</h1>, "by-tool": () => <h1>By tool</h1> }
    }
  ])
  const bottom = document.querySelector('nav[aria-label="Mobile modules"]')
  expect([...(bottom?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual(["Fleet"])
  const picker = bottom?.querySelector("button")
  expect(picker?.getAttribute("aria-current")).toBe("page")
  expect(picker?.getAttribute("aria-label")).toBe("More, current module Usage")
  expect(picker?.getAttribute("aria-label")?.startsWith(picker.textContent?.trim() ?? "")).toBe(true)
  expect(document.querySelector('nav[aria-label="Modules"] a[aria-label="Usage"]')).not.toBeNull()
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
  const breadcrumb = document.querySelector('nav[aria-label="Current page"]')
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
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Approvals")
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
    approvalApp: {
      canonical: true,
      canonicalUrl: "https://example.invalid/",
      pushEnabled: false,
      superapp: true,
      fleet: true,
      workEnabled: true,
      sandboxesEnabled: false
    },
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
      repository: { branch: "main", dirty: false, path: "npm", revision: "abc123" },
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
        session={{ access: "tailscale", connection: "connected" }}
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
  ["sidebar modules", ".superapp-sidebar > button", "More"],
  ["bottom modules", ".superapp-bottom > button", "More"],
  ["hosts", ".superapp-host", "Hosts"],
  ["notifications", '.superapp-header button[aria-label="Notifications"]', "Notifications"]
])("clears cancelled navigation when the %s open path starts a new panel cycle", async (_name, selector, title) => {
  window.history.replaceState(null, "", "/#fleet/work")
  await render([fleet], [])
  const pickerOpener = document.querySelector<HTMLButtonElement>(".superapp-sidebar > button")
  await act(async () => pickerOpener?.click())
  const link = document.querySelector<HTMLAnchorElement>('[aria-label="More modules"] a[href*="#fleet/"]')
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
    document.querySelector<HTMLAnchorElement>('[aria-label="More modules"] a[href*="#other/"]')?.click()
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  })
  expect(window.location.hash).toBe("#other/home")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")))
})

it("Settings reports dialog expansion without claiming the current page", async () => {
  await render()
  const settings = document.querySelector<HTMLButtonElement>(".superapp-settings")
  if (settings === null) return expect.unreachable()
  const current = () => [...document.querySelectorAll('.superapp-sidebar [aria-current="page"]')]
  expect(current()).toHaveLength(1)
  expect(current()[0]?.tagName).toBe("A")
  expect(settings.hasAttribute("aria-current")).toBe(false)
  expect(settings.getAttribute("aria-haspopup")).toBe("dialog")
  expect(settings.getAttribute("aria-expanded")).toBe("false")
  await act(async () => settings.click())
  expect(settings.getAttribute("aria-expanded")).toBe("true")
  expect(current()).toHaveLength(1)
  const close = document.querySelector<HTMLButtonElement>(".superapp-dialog-close")
  if (close === null) return expect.unreachable()
  await act(async () => close.click())
  expect(settings.getAttribute("aria-expanded")).toBe("false")
  expect(current()).toHaveLength(1)
  expect(current()[0]?.tagName).toBe("A")
})

/** Design rule 45: the phone header names the product; the breadcrumb line under it names the module and page. */
it("keeps the product name in the phone header and puts the breadcrumb under the header", async () => {
  const descriptor = defineModule({
    ...fleetModule,
    pages: [
      { id: "approvals", label: "Approvals", showInPhoneTitle: true },
      { id: "work", label: "Work" }
    ]
  })
  await render([{ descriptor, pages: { approvals: fleetPage("approvals"), work: fleetPage("work") } }])
  expect(document.querySelector(".superapp-phone-title")?.textContent).toBe("Relay")
  const breadcrumb = document.querySelector('nav[aria-label="Current page"]')
  expect(breadcrumb?.closest("header")).toBeNull()
  expect(breadcrumb?.previousElementSibling?.matches(".superapp-header")).toBe(true)
  await act(async () => {
    window.history.pushState(null, "", "#fleet/work")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  expect(document.querySelector(".superapp-phone-title")?.textContent).toBe("Relay")
  expect(breadcrumb?.querySelector('[aria-current="page"]')?.textContent).toBe("Work")
})

it("names a single-page module once in the breadcrumb and marks an unknown route", async () => {
  const descriptor = defineModule({ ...fleetModule, pages: [{ id: "approvals", label: "Approvals" }] })
  window.history.replaceState(null, "", "/#fleet/approvals")
  await render([{ descriptor, pages: { approvals: fleetPage("approvals") } }])
  const breadcrumb = () => document.querySelector('nav[aria-label="Current page"]')
  expect(breadcrumb()?.querySelector("a")).toBeNull()
  expect(breadcrumb()?.querySelector('[aria-current="page"]')?.textContent).toBe("Approvals")
  await act(async () => {
    window.history.pushState(null, "", "#nowhere/at-all")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  expect(breadcrumb()?.getAttribute("data-route-found")).toBe("false")
})

/** Back can activate a child before the shell layout effect schedules its arrival callback. */
it.each(["same page", "reactivated module"])(
  "preserves the target claimed before the parent effect on Back to %s",
  async (departure) => {
    const other = defineModule({
      id: "other",
      label: "Other",
      defaultPage: "home",
      pages: [{ id: "home", label: "Home" }],
      listeners: ["serve"],
      requires: ["read"]
    })
    const Target = ({ mount, search }: { readonly mount: ModulePageMount; readonly search: URLSearchParams }) => {
      const target = useRef<HTMLButtonElement>(null)
      const selected = search.get("target") === "recorded"
      useLayoutEffect(() => {
        if (mount.active && selected) target.current?.focus()
      }, [mount.active, selected])
      return (
        <section>
          <button onClick={() => mount.navigate("?target=recorded#fleet/work", "push", null)}>
            Open recorded target
          </button>
          <button ref={target}>Recorded target</button>
          <button
            onClick={() =>
              mount.navigate(departure === "same page" ? "?target=discussion#fleet/work" : "#other/home", "push", null)
            }
          >
            Leave target
          </button>
        </section>
      )
    }
    const installed = {
      ...fleet,
      pages: {
        ...fleet.pages,
        work: (search: URLSearchParams, mount: ModulePageMount) => (
          <FleetPage page="work" mount={mount} search={search} work={<Target mount={mount} search={search} />} />
        )
      }
    }
    window.history.replaceState(null, "", "/#fleet/work")
    await render([installed, { descriptor: other, pages: { home: () => <h1>Other page</h1> } }])
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)
    await act(async () => button("Open recorded target")?.click())
    await vi.waitFor(() => expect(document.activeElement).toBe(button("Recorded target")))
    await act(async () => {
      button("Leave target")?.focus()
      button("Leave target")?.click()
    })
    await act(async () => {
      window.history.back()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    await vi.waitFor(() => expect(document.activeElement).toBe(button("Recorded target")))
  }
)

/** A standalone computer names itself, not a fleet host count. */
it("labels a standalone computer as this computer instead of counting hosts", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <SuperappShell
        modules={[fleet]}
        landing={{ module: "fleet", page: "approvals" }}
        host="atlas"
        hostCount={1}
        standalone
        session={{ access: "loopback", connection: "connected" }}
        notifications={<p>No recent activity</p>}
      />
    )
  )
  expect(host.textContent).toContain("This computer")
  expect(host.textContent).not.toContain("host configured")
})
