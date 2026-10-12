// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { Cause, Effect, Option, Schema } from "effect"
import type * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { makeConnectModuleViews } from "../src/connect-module-view.js"

beforeAll(() => vi.stubGlobal("fetch", async () => new Response("", { status: 503 })))
afterAll(() => vi.unstubAllGlobals())

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
    readApprovals: Effect.succeed({ _tag: "Complete", items: [] })
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
