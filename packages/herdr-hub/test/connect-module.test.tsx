// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { Cause, Effect, Option, Schema } from "effect"
import type * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { TodayReadFailed } from "../src/today-module-view.js"
import { type NeedsYouResult } from "../src/modules.js"
import { makeConnectModuleViews } from "../src/connect-module-view.js"
import { archiveFixture } from "./superapp-browser/archive-fixture.js"

beforeAll(() => vi.stubGlobal("fetch", async () => new Response("", { status: 503 })))
afterAll(() => vi.unstubAllGlobals())

/** The embedded archive delegates dismissal to the shell's selection owner, not ordinary navigation. */
it("forwards archived-stage close to the mounted selection owner", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(archiveFixture()), {
        headers: { "content-type": "application/json" }
      })
  )
  const atoms = makeConnectAtoms()
  const registry = AtomRegistry.make()
  const views = makeConnectModuleViews({
    atoms,
    now: 2000,
    notificationState: "enabled",
    readApprovals: Effect.succeed({ _tag: "Complete", items: [], contributions: [] })
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const navigations: Array<string> = []
  const closeSelection = vi.fn<(href: string) => void>()
  const paint = async (search: URLSearchParams) =>
    act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          {views.pages.overview(search, {
            active: true,
            navigate: (href) => {
              navigations.push(href)
            },
            closeSelection
          })}
        </RegistryContext.Provider>
      )
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  try {
    await paint(new URLSearchParams({ view: "archived" }))
    await vi.waitFor(() => expect(host.querySelector(".connect-home-archive-row")).not.toBeNull())
    await act(async () => host.querySelector<HTMLButtonElement>(".connect-home-archive-row")?.click())
    const href = navigations[0]
    if (href === undefined) return expect.unreachable()
    await paint(new URL(href, window.location.href).searchParams)
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')?.click()
    )
    expect(closeSelection).toHaveBeenCalledOnce()
    expect(closeSelection).toHaveBeenCalledWith(expect.stringContaining("view=archived#connect/overview"))
    expect(navigations).toHaveLength(1)
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    host.remove()
    vi.unstubAllGlobals()
  }
})

const renderEmpty = (hosts: ReadonlyArray<string> | undefined, stale: boolean): string => {
  const atoms = makeConnectAtoms()
  const empty = { agents: [], failures: [], nextCursor: null }
  const value = Schema.decodeUnknownSync(FleetConnectAgentPage)(hosts === undefined ? empty : { ...empty, hosts })
  const previous = AsyncResult.success(value, { timestamp: 1_000 })
  const reading: Atom.Type<typeof atoms.agents> = stale
    ? AsyncResult.failureWithPrevious(Cause.die("fixture directory failed"), { previous: Option.some(previous) })
    : previous
  const registry = AtomRegistry.make({
    initialValues: [
      [atoms.agents, reading],
      [atoms.work, AsyncResult.initial()]
    ]
  })
  const views = makeConnectModuleViews({
    atoms,
    now: 2_000,
    notificationState: "enabled",
    readApprovals: Effect.succeed({ _tag: "Complete", items: [], contributions: [] })
  })
  try {
    return renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        {views.pages.overview(new URLSearchParams(), { active: true, navigate: () => {}, closeSelection: () => {} })}
      </RegistryContext.Provider>
    )
  } finally {
    registry.dispose()
  }
}

/** Optional host inventory cannot turn an empty reading into a subjectless liveness claim. */
it.each([undefined, ["atlas", "birch"]])("names the empty current reading truthfully with hosts %s", (hosts) => {
  const element = document.createElement("div")
  element.innerHTML = renderEmpty(hosts, false)
  const card = element.querySelector(".connect-home-empty")
  expect(card?.textContent).toContain("No host reported any agents.")
  expect(card?.textContent).not.toContain("answered")
  expect(card?.textContent).toContain("Checked")
})

/** A retained empty reading says what was observed then, not what hosts report now. */
it("frames a retained empty result as a previous reading", () => {
  const element = document.createElement("div")
  element.innerHTML = renderEmpty(["atlas"], true)
  const card = element.querySelector(".connect-home-empty")
  expect(card?.querySelector("h2")?.textContent).toBe("No agents in the previous reading.")
  expect(card?.textContent).toContain("Previous reading")
  expect(card?.textContent).toContain("Trying again.")
  expect(card?.textContent).not.toContain("answered")
  expect(card?.textContent).not.toContain("have no agents running")
})

/** Empty agents do not imply no approvals when their independent source is partial or failed. */
it.each<"complete" | "partial" | "failed" | "one">(["complete", "partial", "failed", "one"])(
  "keeps approval uncertainty on empty Home for %s",
  async (state) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
    const atoms = makeConnectAtoms()
    const registry = AtomRegistry.make({
      initialValues: [
        [atoms.agents, AsyncResult.success({ agents: [], failures: [], nextCursor: null })],
        [atoms.work, AsyncResult.initial()]
      ]
    })
    let calls = 0
    const read = Effect.suspend(() => {
      calls += 1
      if (state === "failed" && calls > 1) return Effect.fail(new TodayReadFailed({ reason: "network" }))
      const result: NeedsYouResult =
        state === "one"
          ? {
              _tag: "Complete",
              items: [
                {
                  key: "fleet:hub:job-1",
                  provider: "fleet",
                  destination: { _tag: "FleetApproval", module: "fleet", host: "hub", jobId: "job-1" },
                  kind: "nix.apply",
                  actor: "operator",
                  createdAt: 1000,
                  expiresAt: null
                }
              ],
              contributions: []
            }
          : state === "partial"
            ? {
                _tag: "Partial",
                items: [],
                sources: [{ provider: "fleet", issue: { state: "failed", reason: "offline" } }],
                contributions: []
              }
            : { _tag: "Complete", items: [], contributions: [] }
      return Effect.succeed(result)
    })
    const views = makeConnectModuleViews({ atoms, now: 2000, notificationState: "enabled", readApprovals: read })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const paint = async (active: boolean) =>
      act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            {views.pages.overview(new URLSearchParams(), { active, navigate: () => {}, closeSelection: () => {} })}
          </RegistryContext.Provider>
        )
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      })
    try {
      await paint(true)
      if (state === "failed") {
        await paint(false)
        await paint(true)
      }
      expect(calls).toBe(state === "failed" ? 2 : 1)
      const strip = host.querySelector(".connect-home-strip")
      if (state === "complete") expect(strip).toBeNull()
      else if (state === "one") {
        expect(strip?.querySelector(".connect-home-approvals-word")?.textContent).toBe("approval waiting")
      } else {
        expect(strip).not.toBeNull()
        expect(strip?.querySelector('a[href*="fleet/approvals"]')).not.toBeNull()
        expect(strip?.textContent).toContain("Approvals unknown")
        expect(strip?.querySelector("strong")).toBeNull()
        expect(strip?.textContent).not.toContain("need you")
      }
    } finally {
      await act(async () => root.unmount())
      registry.dispose()
      host.remove()
      vi.unstubAllGlobals()
    }
  }
)
