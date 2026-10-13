// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import { Predicate, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ConnectHomeArchive } from "../src/archive-home.js"
import { archivedAgentKey } from "../src/archive-model.js"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { ConnectArchivePage } from "../src/model.js"

window.IS_REACT_ACT_ENVIRONMENT = true
const page = Schema.decodeUnknownSync(ConnectArchivePage)({
  agents: [
    {
      host: "alpha",
      agentId: "agent-closed",
      name: "Closed worker",
      kind: "codex",
      state: "done",
      work: "Completed",
      firstSeenAt: 1,
      closedAt: 20,
      lastWords: { text: "Checks passed", createdAt: 19 }
    }
  ],
  nextCursor: { host: "alpha", agentId: "agent-closed", closedAt: 20 }
})
const roots: Array<Root> = []
let reads = 0
beforeEach(() => {
  reads = 0
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(
      Predicate.isString(input) ? input : "href" in input ? input.href : input.url,
      "http://localhost"
    )
    if (url.pathname === "/v1/connect/archive") {
      reads += 1
      return Response.json({ ...page, nextCursor: null })
    }
    if (url.pathname === "/v1/connect/agents") return Response.json({ agents: [], failures: [], nextCursor: null })
    return Response.json({ hosts: [], failures: [], peersListed: true })
  })
})
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

/** Export51 paging states retain rows and expose a status or recovery action instead of a disabled control. */
it("renders the list, five skeletons, empty, initial failure and both retained paging states", () => {
  const render = (value: ConnectArchivePage | null, loading: boolean, failed: boolean) => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(
      <ConnectHomeArchive page={value} loading={loading} failed={failed} request={() => {}} open={() => {}} />
    )
    return host
  }
  const list = render(page, false, false)
  expect(list.textContent).toContain("1+ closed agents in the last 90 days")
  expect(list.textContent).toContain("Primary, alpha")
  expect(list.textContent).toContain("Checks passed")
  expect(list.querySelector(".connect-home-archive-row")?.textContent).toContain("Closed")
  expect(render(null, true, false).querySelectorAll(".connect-home-archive-skeleton")).toHaveLength(5)
  expect(render({ agents: [], nextCursor: null }, false, false).textContent).toBe(
    "No closed agents in the last 90 days"
  )
  expect(render(null, false, true).textContent).toContain(
    "Couldn’t load archived agentsTry again in a moment.Try again"
  )
  const older = render(page, true, false)
  expect(older.querySelector("[role='status']")?.textContent).toBe("Loading older agents…")
  expect(older.querySelector(".connect-home-archive-row")).not.toBeNull()
  expect(older.querySelector("button[disabled]")).toBeNull()
  const failed = render(page, false, true)
  expect(failed.querySelector("[role='alert']")?.textContent).toBe("Couldn’t load older agents.Try again")
  expect(failed.querySelector(".connect-home-archive-row")).not.toBeNull()
})

/** Pair/URL objects may change each render; only a paging request may start another archive read. */
it("retains the selected archive across inactive and unrelated parent renders without fetching again", async () => {
  const agent = page.agents[0]
  if (agent === undefined) throw new TypeError("Fixture missing closure")
  const url = new URL("http://localhost/?view=archived#connect/overview")
  url.searchParams.set("closed", archivedAgentKey(agent))
  window.history.replaceState({ foreign: "kept" }, "", "/?host=other#fleet/work")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const atoms = makeConnectAtoms()
  const navigate = vi.fn()
  const render = async (active: boolean) => {
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface
            atoms={atoms}
            embedded
            active={active}
            presentation={{ _tag: "home" }}
            directoryLocation={{
              url: new URL(url.href),
              navigate: (href, mode) => navigate(href, mode),
              closeSelection: (href) => navigate(href, "replace")
            }}
          />
        </RegistryProvider>
      )
    )
    await settle()
  }
  await render(true)
  await vi.waitFor(async () => {
    await settle()
    expect(document.querySelector("[role='dialog']")).not.toBeNull()
  })
  expect(reads).toBe(1)
  expect(host.querySelector<HTMLAnchorElement>(".connect-home-switch a")?.hash).toBe("#connect/overview")
  await render(false)
  expect(document.querySelector("[role='dialog']")).toBeNull()
  await render(false)
  await render(true)
  expect(document.querySelector("[role='dialog']")?.getAttribute("aria-labelledby")).not.toBeNull()
  expect(reads).toBe(1)
  expect(navigate).not.toHaveBeenCalled()
  expect(window.history.state).toEqual({ foreign: "kept" })
})

/** Replaced paging controls keep a focus anchor and land at the new result or recovery control. */
it("preserves focus through Show older and both retry controls on success and repeat failure", async () => {
  const first = page.agents[0]
  if (first === undefined) throw new TypeError("Missing archive fixture")
  const appended: ConnectArchivePage = {
    agents: [...page.agents, { ...first, agentId: "agent-new", name: "New closure" }],
    nextCursor: null
  }
  for (const initial of ["paging", "initial-retry", "paging-retry"]) {
    for (const failure of [false, true]) {
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      const value = initial === "initial-retry" ? null : page
      const render = async (current: ConnectArchivePage | null, loading: boolean, failed: boolean) => {
        await act(async () =>
          root.render(
            <ConnectHomeArchive page={current} loading={loading} failed={failed} request={() => {}} open={() => {}} />
          )
        )
      }
      await render(value, false, initial !== "paging")
      const control = host.querySelector<HTMLButtonElement>(".connect-home-archive-control")
      if (control === null) throw new TypeError("Missing paging control")
      control.focus()
      await act(async () => control.click())
      await render(value, true, false)
      expect(document.activeElement).toBe(host.querySelector(".connect-home-archive"))
      await render(failure ? value : initial === "initial-retry" ? page : appended, false, failure)
      const target = failure
        ? host.querySelector(".connect-home-archive-control")
        : host.querySelectorAll("button.connect-home-archive-row")[initial === "initial-retry" ? 0 : 1]
      expect(document.activeElement).toBe(target)
      expect(document.activeElement).not.toBe(document.body)
      await act(async () => root.unmount())
      host.remove()
      roots.splice(roots.indexOf(root), 1)
    }
  }
})
