// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import {
  RelayDock,
  type RlyRelayDockDesktopPresentation,
  type RlyRelayDockState
} from "../../src/patterns/RelayDock.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

interface MountedDock {
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedDock> = []
const modelOptions = [{ label: "Codex", value: "codex" }]
const profileOptions = [{ label: "Review", value: "review" }]

const mount = async (element: ReactElement): Promise<MountedDock> => {
  const host = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(host, portal)
  const root = createRoot(host)
  const entry = { host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const mountWithOwnedPortal = async (element: ReactElement): Promise<MountedDock> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<PortalProvider>{element}</PortalProvider>))
  const portal = host.querySelector<HTMLDivElement>("[data-rly-portal-root]")
  if (portal === null) throw new Error("PortalProvider did not create its portal root")
  const entry = { host, portal, root }
  mounted.push(entry)
  return entry
}

const dock = ({
  defaultOpen,
  presentation = "overlay",
  state = { content: <p>One review thread</p>, status: "ready" }
}: {
  readonly defaultOpen?: boolean
  readonly presentation?: RlyRelayDockDesktopPresentation
  readonly state?: RlyRelayDockState
} = {}): ReactElement => (
  <RelayDock
    context={[
      { id: "product", label: "Product", value: "CodeCommit" },
      { id: "pull-request", label: "PR", value: "#184" },
      { id: "head", label: "Head", value: "8fa21c7" }
    ]}
    {...(defaultOpen === undefined ? {} : { defaultOpen })}
    desktopPresentation={presentation}
    footer={<textarea aria-label="Message Relay" />}
    selection={{
      model: { onValueChange: () => undefined, options: modelOptions, value: "codex" },
      profile: { onValueChange: () => undefined, options: profileOptions, value: "review" }
    }}
    state={state}
  />
)

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
})

describe("RelayDock", () => {
  it("RD-01 and RD-02 render one trigger and start collapsed", async () => {
    const { host, portal } = await mount(dock())
    const triggers = host.querySelectorAll("[data-rly-relay-dock-trigger]")

    expect(triggers).toHaveLength(1)
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector("[data-rly-relay-dock-presentation]")).toBeNull()
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
  })

  it("RD-05, RD-16, and RD-17 keep one immutable context and selector set visible", async () => {
    const { host, portal } = await mount(dock({ defaultOpen: true, presentation: "rail" }))
    const rail = portal.querySelector<HTMLElement>('[data-rly-relay-dock-presentation="rail"]')
    if (rail === null) throw new Error("RelayDock rail did not render")

    expect(rail.querySelectorAll('[data-rly-relay-dock-context="product"]')).toHaveLength(1)
    expect(rail.querySelector('[data-rly-relay-dock-context="pull-request"]')?.textContent).toContain("#184")
    expect(rail.querySelector('[data-rly-relay-dock-context="head"]')?.textContent).toContain("8fa21c7")
    expect(rail.querySelectorAll('[role="combobox"]')).toHaveLength(2)
    expect(rail.querySelector('[aria-labelledby*="rly-relay-dock-profile-"]')).not.toBeNull()
    expect(rail.querySelector('[aria-labelledby*="rly-relay-dock-model-"]')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")?.hidden).toBe(true)
    expect(rail.querySelectorAll('[aria-label="Close Relay"]')).toHaveLength(1)
  })

  it("keeps profile and model label associations unique across Dock instances", async () => {
    const { portal } = await mount(
      <>
        {dock({ defaultOpen: true, presentation: "rail" })}
        {dock({ defaultOpen: true, presentation: "rail" })}
      </>
    )
    const controls = [...portal.querySelectorAll<HTMLElement>('[role="combobox"]')]
    const controlIds = controls.map((control) => control.id)
    const labelIds = controls.map((control) => control.getAttribute("aria-labelledby"))

    expect(controls).toHaveLength(4)
    expect(new Set(controlIds).size).toBe(4)
    expect(new Set(labelIds).size).toBe(4)
    for (const labelId of labelIds) {
      if (labelId === null) throw new Error("RelayDock selector has no label")
      expect(portal.querySelectorAll(`[id="${labelId}"]`)).toHaveLength(1)
    }
  })

  it.each([
    [{ description: "Reading the thread", status: "loading", title: "Loading review" }, "loading", "status"],
    [{ description: "Ask the first question", status: "empty", title: "No messages yet" }, "empty", "status"],
    [{ content: <p>Review ready</p>, status: "ready" }, "ready", null],
    [{ description: "Retry from the product", status: "error", title: "Review failed" }, "error", "alert"],
    [
      { description: "Pair Relay before continuing", status: "unavailable", title: "Relay unavailable" },
      "unavailable",
      "status"
    ]
  ] satisfies ReadonlyArray<readonly [RlyRelayDockState, string, string | null]>)(
    "RD-11 renders the typed $status state",
    async (state, status, role) => {
      const { portal } = await mount(dock({ defaultOpen: true, presentation: "rail", state }))
      const panel = portal.querySelector(`[data-rly-relay-dock-state="${status}"]`)
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute("role")).toBe(role)
      expect(portal.querySelectorAll('[role="combobox"]')).toHaveLength(2)
    }
  )

  it("RD-12 keeps the desktop rail non-modal and restores focus after Escape", async () => {
    const { host, portal } = await mount(dock({ presentation: "rail" }))
    const trigger = host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    if (trigger === null) throw new Error("RelayDock trigger did not render")
    trigger.focus()
    await act(async () => trigger.click())

    const rail = portal.querySelector<HTMLElement>('[data-rly-relay-dock-presentation="rail"]')
    expect(rail?.getAttribute("role")).not.toBe("dialog")
    expect(document.activeElement).toBe(rail?.querySelector('[aria-label="Close Relay"]'))
    await act(async () => rail?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(portal.querySelector('[data-rly-relay-dock-presentation="rail"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("RD-12 traps overlay focus and restores the collapsed trigger on close", async () => {
    const { host, portal } = await mount(dock())
    const trigger = host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    if (trigger === null) throw new Error("RelayDock trigger did not render")
    trigger.focus()
    await act(async () => trigger.click())

    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.tagName).toBe("SECTION")
    expect(dialog?.contains(document.activeElement)).toBe(true)
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("focuses an initially open dialog after the owned portal target mounts", async () => {
    const { portal } = await mountWithOwnedPortal(dock({ defaultOpen: true }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')

    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })
})
