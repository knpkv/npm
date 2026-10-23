// @vitest-environment happy-dom
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SuperappShell } from "../src/superapp-view.js"
import { makeTodayModuleViews, type TodayReadFailed } from "../src/today-module-view.js"
import { fleetModule, type ModuleViews, type NeedsYouResult } from "../src/modules.js"

let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const fleet: ModuleViews<typeof fleetModule> = {
  descriptor: fleetModule,
  pages: {
    approvals: () => <h1>Fleet approvals</h1>,
    connect: () => <h1>Fleet Connect</h1>,
    work: () => null,
    usage: () => null
  }
}
const render = async (read: Effect.Effect<NeedsYouResult, TodayReadFailed>) => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const today = makeTodayModuleViews({ read, now: 1_000, agents: null, history: null })
  await act(async () =>
    root?.render(
      <SuperappShell
        session={{ access: "tailscale", connection: "connected" }}
        modules={[today, fleet]}
        landing={{ module: "today", page: "overview" }}
        host="hub"
        hostCount={1}
        notifications={null}
      />
    )
  )
}
const click = async (href: string) => {
  const link = document.createElement("a")
  link.href = href
  document.body.append(link)
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })))
  link.remove()
}

it("lands on Today, keeps document anchors, and sends legacy approval selectors to Fleet", async () => {
  window.history.replaceState(null, "", "/#main")
  await render(Effect.succeed({ _tag: "Complete", items: [], contributions: [] }))
  expect(window.location.hash).toBe("#main")
  expect(document.querySelector('[data-module="today"]')?.hasAttribute("hidden")).toBe(false)
  expect(document.querySelector('[aria-label="Current page"]')?.textContent).toBe("Relay/Today")
  await click("?tab=approvals&approvalHost=ALPHA&approvalJob=job-1")
  expect(window.location.hash).toBe("#fleet/approvals")
  expect(window.location.search).toBe("?approvalHost=ALPHA&approvalJob=job-1")
  expect(document.querySelector('[aria-label="Current page"]')?.textContent).toBe("Relay/Fleet\u00a0/\u00a0Approvals")
})

it("canonicalizes a bare hub URL to Today", async () => {
  await render(Effect.succeed({ _tag: "Complete", items: [], contributions: [] }))
  expect(window.location.hash).toBe("#today/overview")
})

it("starts one read when active and visible, aborts it on navigation and ignores its late answer", async () => {
  let started = 0
  let interrupted = 0
  const answers: Array<(reading: Effect.Effect<NeedsYouResult, TodayReadFailed>) => void> = []
  const read = Effect.callback<NeedsYouResult, TodayReadFailed>((resume) => {
    started += 1
    answers.push(resume)
    return Effect.sync(() => {
      interrupted += 1
    })
  })
  window.history.replaceState(null, "", "/#fleet/approvals")
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  await render(read)
  expect(started).toBe(0)
  await click("?#today/overview")
  expect(started).toBe(0)
  visibility.mockReturnValue("visible")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  expect(started).toBe(1)
  await click("?#fleet/approvals")
  await vi.waitFor(() => expect(interrupted).toBe(1))
  await act(async () => answers[0]?.(Effect.succeed({ _tag: "Complete", items: [], contributions: [] })))
  expect(document.querySelector('[data-module="today"] h1')?.textContent).toBe("Checking your fleet.")
  await click("?#today/overview")
  expect(started).toBe(2)
  visibility.mockReturnValue("hidden")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  await vi.waitFor(() => expect(interrupted).toBe(2))
  expect(started).toBe(2)
})
