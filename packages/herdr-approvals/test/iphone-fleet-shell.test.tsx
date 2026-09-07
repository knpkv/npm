// @vitest-environment happy-dom

import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import {
  FleetShell,
  FleetWorkPanel,
  fleetWorkRequestStateFromResult,
  fleetWorkStateFromRequest
} from "../src/shell-view.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
})

const render = async (element: React.ReactNode): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(element))
}

describe("iPhone fleet shell regressions", () => {
  it("moves focus to the selected tab before hiding a focused panel", async () => {
    window.history.replaceState(null, "", "/?tab=connect")
    await render(
      <FleetShell
        approvals={<button type="button">Approve request</button>}
        connect={<button type="button">Focused terminal control</button>}
        hostCount={1}
        work={<section>Work board</section>}
      />
    )
    const inactivePanel = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="inactive"]')
    const nestedPanel = document.createElement("div")
    nestedPanel.setAttribute("data-state", "active")
    nestedPanel.setAttribute("role", "tabpanel")
    inactivePanel?.append(nestedPanel)
    const terminalControl = document.querySelector<HTMLButtonElement>("button:not([role=tab])")
    await act(async () => terminalControl?.focus())
    expect(document.activeElement).toBe(terminalControl)

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "3" })))

    expect(document.activeElement?.getAttribute("role")).toBe("tab")
    expect(document.activeElement?.textContent).toBe("Work")
    expect(document.body.textContent).toContain("Work board")
  })

  it("still selects a panel when its destination tab is missing", async () => {
    await render(
      <FleetShell
        approvals={<button type="button">Focused approval control</button>}
        connect={<section>Terminal</section>}
        hostCount={1}
        work={<section>Work board</section>}
      />
    )
    const approvalControl = document.querySelector<HTMLButtonElement>("button:not([role=tab])")
    await act(async () => approvalControl?.focus())
    document.querySelector('[role="tab"][data-tab-value="work"]')?.remove()

    await expect(
      act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "3" }))
      })
    ).resolves.toBeUndefined()

    expect(document.body.textContent).toContain("Work board")
  })

  it("measures the production tab list on mount and viewport changes", async () => {
    let tabBottom = 64
    const frames: Array<FrameRequestCallback> = []
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? new DOMRect(0, 0, 390, tabBottom) : new DOMRect()
    })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)

    await render(
      <FleetShell
        approvals={<section>Approvals</section>}
        connect={<section>Connect</section>}
        hostCount={1}
        work={null}
      />
    )
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
    const shell = document.querySelector<HTMLElement>(".fleet-shell")
    expect(shell?.style.getPropertyValue("--fleet-shell-tab-bottom")).toBe("64px")

    tabBottom = 72
    await act(async () => window.dispatchEvent(new Event("resize")))
    if (frames.length === 0) throw new Error("Fleet tab measurement did not schedule a frame")
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })

    expect(shell?.style.getPropertyValue("--fleet-shell-tab-bottom")).toBe("72px")
  })

  it("keeps loading, absence, and failure as distinct Work presentations", async () => {
    const unavailableRefresh = fleetWorkRequestStateFromResult({
      content: null,
      result: AsyncResult.fail({ _tag: "ConnectStatusError", status: 404 }, { waiting: true })
    })
    const initial = fleetWorkStateFromRequest({ _tag: "Initial", content: null })
    const initialWithContent = fleetWorkStateFromRequest({
      _tag: "Initial",
      content: <span>Server Work projection</span>
    })
    const retryingFailure = fleetWorkStateFromRequest({
      _tag: "Failure",
      content: null,
      detail: "Work request failed. Refresh to retry.",
      waiting: true
    })
    const revalidating = fleetWorkStateFromRequest({
      _tag: "Success",
      content: <span>Current Work projection</span>,
      waiting: true
    })
    const unavailable = fleetWorkStateFromRequest({ _tag: "Unavailable" })
    const failure = fleetWorkStateFromRequest({
      _tag: "Failure",
      content: null,
      detail: "Work request failed. Refresh to retry.",
      waiting: false
    })
    const failureWithContent = fleetWorkStateFromRequest({
      _tag: "Failure",
      content: <span>Stale Work projection</span>,
      detail: "Work request failed. Refresh to retry.",
      waiting: false
    })
    await render(
      <>
        <FleetWorkPanel state={initial} />
        <FleetWorkPanel state={initialWithContent} />
        <FleetWorkPanel state={retryingFailure} />
        <FleetWorkPanel state={revalidating} />
        <FleetWorkPanel state={unavailable} />
        <FleetWorkPanel state={failure} />
        <FleetWorkPanel state={failureWithContent} />
      </>
    )

    expect(initial._tag).toBe("Loading")
    expect(unavailableRefresh._tag).toBe("Unavailable")
    expect(initialWithContent._tag).toBe("Ready")
    expect(retryingFailure._tag).toBe("Loading")
    expect(revalidating._tag).toBe("Ready")
    expect(unavailable._tag).toBe("Unavailable")
    expect(failure._tag).toBe("Failure")
    expect(failureWithContent._tag).toBe("Failure")
    expect(document.body.textContent).toContain("Loading Work")
    expect(document.body.textContent).toContain("Goals unavailable")
    expect(document.body.textContent).toContain("Work unavailable")
    expect(document.body.textContent).toContain("Work request failed. Refresh to retry.")
    expect(document.body.textContent).toContain("Current Work projection")
    expect(document.body.textContent).toContain("Server Work projection")
    expect(document.body.textContent).toContain("Stale Work projection")
  })

  it("keeps stale Work mounted when a request failure settles", async () => {
    const mounted = vi.fn<() => void>()
    const WorkContent = () => {
      useEffect(() => {
        mounted()
      }, [])
      return <span>Stateful Work projection</span>
    }
    const content = <WorkContent />
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => root.render(<FleetWorkPanel state={{ _tag: "Ready", content }} />))
    await act(async () =>
      root.render(
        <FleetWorkPanel state={{ _tag: "Failure", content, detail: "Work request failed. Refresh to retry." }} />
      )
    )

    expect(mounted).toHaveBeenCalledTimes(1)
  })
})
