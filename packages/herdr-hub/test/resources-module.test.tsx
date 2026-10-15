// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ResourcesReadFailed } from "../src/resources-client.js"
import { makeResourcesModuleViews } from "../src/resources-module-view.js"
import type { ModulePageMount } from "../src/modules.js"
import { resourceFixtureNow, resourcesFixture } from "./superapp-browser/resources-fixture.js"

let root: Root | null = null
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  vi.setSystemTime(resourceFixtureNow)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const snapshot = resourcesFixture("live-busy").snapshot
if (snapshot === null) throw new TypeError("busy resources fixture missing")
const mount: ModulePageMount = { active: true, navigate: () => {}, closeSelection: () => {} }
const render = async (view: ReturnType<typeof makeResourcesModuleViews>, active = true) => {
  if (root === null) {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root?.render(view.pages.overview(new URLSearchParams(), { ...mount, active })))
}

it("polls every ten seconds and pauses while inactive or hidden", async () => {
  let calls = 0
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const view = makeResourcesModuleViews({
    host: "maple",
    read: Effect.sync(() => {
      calls++
      return snapshot
    })
  })
  await render(view)
  expect(calls).toBe(1)
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(calls).toBe(2)
  await render(view, false)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(calls).toBe(2)
  await render(view)
  expect(calls).toBe(3)
  visibility.mockReturnValue("hidden")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(calls).toBe(3)
  visibility.mockReturnValue("visible")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  expect(calls).toBe(4)
})
it("retains the last sample and labels every section after a failed refresh", async () => {
  let calls = 0
  const view = makeResourcesModuleViews({
    host: "maple",
    read: Effect.suspend(() =>
      ++calls === 1 ? Effect.succeed(snapshot) : Effect.fail(new ResourcesReadFailed({ reason: "network" }))
    )
  })
  await render(view)
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(document.querySelector('[data-region="notice"]')?.textContent).toContain("maple is offline")
  expect(document.querySelector('[data-region="memory"]')?.textContent).toContain("6.1 GiB")
  expect(document.querySelector('[data-region="memory"]')?.textContent).toContain("last values, not current")
})
it("interrupts an in-flight request when its module leaves the page", async () => {
  const cancelled = Deferred.makeUnsafe<void>()
  const view = makeResourcesModuleViews({
    host: "maple",
    read: Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)))
  })
  await render(view)
  expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(8)
  await render(view, false)
  await Effect.runPromise(Deferred.await(cancelled))
})

it("announces a client-clock transition to stale through the designed header status", async () => {
  const view = makeResourcesModuleViews({ host: "maple", read: Effect.succeed(snapshot) })
  await render(view)
  await act(async () => vi.advanceTimersByTimeAsync(31_000))
  const header = document.querySelector('[data-region="header"]')
  expect(header?.textContent).toContain("Stale,")
  expect(header?.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull()
})

it("keeps one quiet header status through the stale boundary and recovery", async () => {
  let sample = { ...snapshot, sampledAt: resourceFixtureNow }
  const view = makeResourcesModuleViews({ host: "maple", read: Effect.sync(() => sample) })
  await render(view)
  const header = document.querySelector('[data-region="header"]')
  const status = header?.querySelector('[role="status"][aria-live="polite"]')
  expect(status).not.toBeNull()
  expect(status?.textContent).toBe("Live")
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(header?.textContent).not.toContain("Stale,")
  expect(header?.querySelector('[role="status"]')).toBe(status)
  expect(status?.textContent).toBe("Live")
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(header?.textContent).toContain("Stale, sampled 31s ago")
  expect(header?.querySelector('[role="status"]')).toBe(status)
  expect(status?.textContent).toBe("Stale, last sample 14:14.")
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(header?.textContent).toContain("Stale, sampled 32s ago")
  expect(status?.textContent).toBe("Stale, last sample 14:14.")
  sample = { ...snapshot, sampledAt: resourceFixtureNow + 40_000 }
  await act(async () => vi.advanceTimersByTimeAsync(8_000))
  expect(header?.querySelector('[role="status"]')).toBe(status)
  expect(status?.textContent).toBe("Live")
  expect(header?.textContent).not.toContain("Stale,")
})
