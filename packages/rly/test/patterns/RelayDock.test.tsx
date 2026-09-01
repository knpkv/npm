// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import {
  RelayDock,
  type RlyRelayDockDesktopPresentation,
  type RlyRelayDockState
} from "../../src/patterns/RelayDock.js"
import { Dialog } from "../../src/primitives/Dialog.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

interface MountedDock {
  readonly host: HTMLDivElement
  readonly portal: ParentNode
  readonly root: Root
}

interface MountedShadowDock extends Omit<MountedDock, "portal"> {
  readonly portal: ShadowRoot
}

interface MountedShadowApp extends MountedDock {
  readonly shadow: ShadowRoot
}

interface MountedIframeDock extends MountedDock {
  readonly portalDocument: Document
}

const mounted: Array<MountedDock> = []
const modelOptions = [{ label: "Codex", value: "codex" }]
const profileOptions = [{ label: "Review", value: "review" }]
const shadowPortalTargets: ReadonlyArray<"explicit" | "owned"> = ["owned", "explicit"]

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

const mountWithoutPortalTarget = async (element: ReactElement): Promise<MountedDock> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const entry = { host, portal: host, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={null}>{element}</PortalProvider>))
  return entry
}

const mountWithIframePortal = async (element: ReactElement): Promise<MountedIframeDock> => {
  const host = document.createElement("div")
  const frame = document.createElement("iframe")
  document.body.append(host, frame)
  const portalDocument = frame.contentDocument
  if (portalDocument === null) throw new Error("Iframe portal document did not mount")
  const portal = portalDocument.body
  const root = createRoot(host)
  const entry = { host, portal, portalDocument, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const mountInShadowRoot = async (element: ReactElement): Promise<MountedShadowDock> => {
  const host = document.createElement("div")
  const portalHost = document.createElement("div")
  const portal = portalHost.attachShadow({ mode: "open" })
  document.body.append(host, portalHost)
  const root = createRoot(host)
  const entry = { host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const mountAppInShadowRoot = async (
  element: ReactElement,
  portalTarget: "explicit" | "owned"
): Promise<MountedShadowApp> => {
  const shadowHost = document.createElement("div")
  const shadow = shadowHost.attachShadow({ mode: "open" })
  const host = document.createElement("div")
  shadow.append(host)
  document.body.append(shadowHost)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      portalTarget === "explicit" ? (
        <PortalProvider container={shadow}>{element}</PortalProvider>
      ) : (
        <PortalProvider>{element}</PortalProvider>
      )
    )
  )
  const portal = portalTarget === "explicit" ? shadow : host.querySelector<HTMLDivElement>("[data-rly-portal-root]")
  if (portal === null) throw new Error("PortalProvider did not create its ShadowRoot portal")
  const entry = { host, portal, root, shadow }
  mounted.push(entry)
  return entry
}

const dock = ({
  defaultOpen,
  footer = <textarea aria-label="Message Relay" />,
  presentation = "overlay",
  state = { content: <p>One review thread</p>, status: "ready" }
}: {
  readonly defaultOpen?: boolean
  readonly footer?: ReactNode
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
    footer={footer}
    selection={{
      model: { onValueChange: () => undefined, options: modelOptions, value: "codex" },
      profile: { onValueChange: () => undefined, options: profileOptions, value: "review" }
    }}
    state={state}
  />
)

const ControlledDock = (): ReactElement => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open controlled Relay
      </button>
      <RelayDock
        context={[
          { id: "product", label: "Product", value: "CodeCommit" },
          { id: "pull-request", label: "PR", value: "#184" }
        ]}
        footer={<textarea aria-label="Message Relay" />}
        onOpenChange={setOpen}
        open={open}
        selection={{
          model: { onValueChange: () => undefined, options: modelOptions, value: "codex" },
          profile: { onValueChange: () => undefined, options: profileOptions, value: "review" }
        }}
        state={{ content: <p>One review thread</p>, status: "ready" }}
      />
    </>
  )
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
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
    expect(rail.parentElement?.hasAttribute("data-rly-modal-layer")).toBe(false)
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
    vi.useFakeTimers()
    await act(async () => rail?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await act(async () => vi.runAllTimers())
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
    expect(host.inert).toBe(true)
    expect(document.documentElement.style.overflow).toBe("hidden")
    vi.useFakeTimers()
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await act(async () => vi.runAllTimers())
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(host.inert).toBe(false)
    expect(document.documentElement.style.overflow).toBe("")
    expect(document.activeElement).toBe(trigger)
  })

  it("restores to the built-in trigger when click activation starts elsewhere", async () => {
    const unrelated = document.createElement("button")
    unrelated.textContent = "Unrelated action"
    document.body.append(unrelated)
    const { host, portal } = await mount(dock())
    const trigger = host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    if (trigger === null) throw new Error("RelayDock trigger did not render")
    unrelated.focus()
    await act(async () => trigger.click())

    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    expect(document.activeElement).toBe(close)
    vi.useFakeTimers()
    await act(async () => close?.click())
    await act(async () => vi.runAllTimers())
    expect(document.activeElement).toBe(trigger)
  })

  it("restores controlled docks to the element focused before opening", async () => {
    const { host, portal } = await mount(<ControlledDock />)
    const opener = host.querySelector<HTMLButtonElement>("button")
    if (opener === null) throw new Error("Controlled RelayDock opener did not render")
    opener.focus()
    await act(async () => opener.click())

    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    expect(document.activeElement).toBe(close)
    vi.useFakeTimers()
    await act(async () => close?.click())
    await act(async () => vi.runAllTimers())
    expect(document.activeElement).toBe(opener)
  })

  it("restores a controlled iframe-portal dock to its parent-document opener", async () => {
    const { host, portal, portalDocument } = await mountWithIframePortal(<ControlledDock />)
    const opener = host.querySelector<HTMLButtonElement>("button")
    if (opener === null) throw new Error("Controlled RelayDock opener did not render")
    opener.focus()
    await act(async () => opener.click())

    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    expect(portalDocument.activeElement).toBe(close)
    vi.useFakeTimers()
    await act(async () => close?.click())
    await act(async () => vi.runAllTimers())
    expect(document.activeElement).toBe(opener)
  })

  it("preserves the opener across StrictMode effect probes", async () => {
    const { host, portal } = await mount(<StrictMode>{dock()}</StrictMode>)
    const trigger = host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    if (trigger === null) throw new Error("RelayDock trigger did not render")
    trigger.focus()
    await act(async () => trigger.click())

    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    expect(document.activeElement).toBe(close)
    vi.useFakeTimers()
    await act(async () => close?.click())
    await act(async () => vi.runAllTimers())
    expect(document.activeElement).toBe(trigger)
  })

  it.each(shadowPortalTargets)(
    "restores controlled docks to a ShadowRoot launcher with an %s portal target",
    async (portalTarget) => {
      const { host, portal, shadow } = await mountAppInShadowRoot(<ControlledDock />, portalTarget)
      const opener = host.querySelector<HTMLButtonElement>("button")
      if (opener === null) throw new Error("Controlled RelayDock opener did not render")
      opener.focus()
      expect(shadow.activeElement).toBe(opener)
      await act(async () => opener.click())

      const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
      expect(shadow.activeElement).toBe(close)
      vi.useFakeTimers()
      await act(async () => close?.click())
      await act(async () => vi.runAllTimers())
      expect(shadow.activeElement).toBe(opener)
    }
  )

  it("stages an initially open overlay behind its parent dialog and restores parent focus", async () => {
    const { portal } = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content title="Outer dialog">{dock({ defaultOpen: true })}</Dialog.Content>
      </Dialog.Root>
    )
    const layers = portal.querySelectorAll<HTMLElement>("[data-rly-modal-layer]")
    const dialogs = portal.querySelectorAll<HTMLElement>('[role="dialog"]')
    const outer = dialogs[0]
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')

    expect(layers).toHaveLength(2)
    expect(layers[0]?.hasAttribute("data-rly-dialog-layer")).toBe(true)
    expect(layers[1]?.hasAttribute("data-rly-relay-dock-modal")).toBe(true)
    expect(document.activeElement).toBe(close)
    vi.useFakeTimers()
    await act(async () => close?.click())
    await act(async () => vi.runAllTimers())
    expect(portal.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(outer?.contains(document.activeElement)).toBe(true)
  })

  it("excludes controls hidden by an ancestor from the modal focus boundary", async () => {
    const footer = (
      <>
        <textarea aria-label="Last visible control" />
        <div style={{ display: "none" }}>
          <button type="button">Hidden trailing control</button>
        </div>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const lastVisible = portal.querySelector<HTMLTextAreaElement>('[aria-label="Last visible control"]')
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    lastVisible?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes explicitly non-tabbable editors from the modal focus boundary", async () => {
    const footer = (
      <>
        <textarea aria-label="Last sequential editor" />
        <div aria-label="Programmatic editor" contentEditable tabIndex={-1} />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const lastSequential = portal.querySelector<HTMLTextAreaElement>('[aria-label="Last sequential editor"]')
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    lastSequential?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes controls disabled by an ancestor from the modal focus boundary", async () => {
    const footer = (
      <>
        <fieldset>
          <button type="button">Last enabled control</button>
        </fieldset>
        <fieldset disabled>
          <button type="button">Disabled trailing control</button>
        </fieldset>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const lastEnabled = [...portal.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Last enabled control"
    )
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    lastEnabled?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("includes a native summary as the final modal focus stop", async () => {
    const footer = (
      <details open>
        <summary>Review evidence</summary>
        <p>One finding</p>
      </details>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const summary = portal.querySelector<HTMLElement>("summary")
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    summary?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes controls inside closed details from the modal focus boundary", async () => {
    const footer = (
      <details>
        <summary>Collapsed evidence</summary>
        <button type="button">Collapsed evidence action</button>
      </details>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const summary = portal.querySelector<HTMLElement>("summary")
    const collapsedAction = [...portal.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Collapsed evidence action"
    )
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })
    const reverse = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true })

    summary?.focus()
    await act(async () => dialog?.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    await act(async () => dialog?.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(summary)
    expect(document.activeElement).not.toBe(collapsedAction)
  })

  it("keeps focusable descendants of a closed details summary in the modal boundary", async () => {
    const footer = (
      <details>
        <summary>
          Collapsed evidence
          <button type="button">Visible summary action</button>
        </summary>
        <button type="button">Collapsed evidence action</button>
      </details>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const summaryAction = [...portal.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Visible summary action"
    )
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    summaryAction?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes unchecked members after the checked radio from the modal boundary", async () => {
    const footer = (
      <fieldset>
        <legend>Review route</legend>
        <label>
          <input defaultChecked name="review-route" type="radio" /> Checked route
        </label>
        <label>
          <input name="review-route" type="radio" /> Unchecked trailing route
        </label>
      </fieldset>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const checked = portal.querySelector<HTMLInputElement>('input[type="radio"]:checked')
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" })

    checked?.focus()
    await act(async () => dialog?.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("keeps the trigger operable while its portal target is unavailable", async () => {
    const { host } = await mountWithoutPortalTarget(dock())
    const trigger = host.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    if (trigger === null) throw new Error("RelayDock trigger did not render")

    await act(async () => trigger.click())
    expect(trigger.hidden).toBe(false)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector("[data-rly-relay-dock-presentation]")).toBeNull()
  })

  it("honors Tab and Escape already prevented by inline content", async () => {
    const editor = (
      <textarea
        aria-label="Owned editor"
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") event.preventDefault()
        }}
      />
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer: editor }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const textarea = portal.querySelector<HTMLTextAreaElement>('[aria-label="Owned editor"]')

    textarea?.focus()
    await act(async () =>
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }))
    )
    expect(document.activeElement).toBe(textarea)
    await act(async () =>
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }))
    )
    expect(portal.querySelector('[role="dialog"]')).toBe(dialog)
  })

  it("keeps a composing Escape inside caller-owned content", async () => {
    const { portal } = await mount(dock({ defaultOpen: true, footer: <textarea defaultValue="Draft reply" /> }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const composer = portal.querySelector<HTMLTextAreaElement>("textarea")

    composer?.focus()
    await act(async () =>
      composer?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, isComposing: true, key: "Escape" })
      )
    )
    expect(portal.querySelector('[role="dialog"]')).toBe(dialog)
    expect(composer?.value).toBe("Draft reply")

    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const forward = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Tab"
    })
    await act(async () => composer?.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    const reverse = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Tab",
      shiftKey: true
    })
    await act(async () => close?.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(composer)
  })

  it("isolates background siblings mounted after the modal opens", async () => {
    const { portal } = await mount(dock({ defaultOpen: true }))
    const lateBackgroundAction = document.createElement("button")
    lateBackgroundAction.textContent = "Late background action"

    await act(async () => document.body.append(lateBackgroundAction))
    expect(lateBackgroundAction.inert).toBe(true)

    const insideAction = document.createElement("button")
    insideAction.textContent = "Late dock action"
    await act(async () => portal.querySelector('[role="dialog"]')?.append(insideAction))
    expect(insideAction.inert).toBe(false)

    await act(async () => portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')?.click())
    expect(lateBackgroundAction.inert).toBe(false)
  })

  it("keeps a nested desktop rail interactive inside its parent modal", async () => {
    const { portal } = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content title="Outer dialog">{dock({ presentation: "rail" })}</Dialog.Content>
      </Dialog.Root>
    )
    const open = portal.querySelector<HTMLButtonElement>("[data-rly-relay-dock-trigger]")
    await act(async () => open?.click())
    const railLayer = portal.querySelector<HTMLElement>('[data-rly-relay-dock-modal="false"]')
    const close = railLayer?.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')

    expect(railLayer).not.toBeNull()
    expect(railLayer?.hasAttribute("data-rly-modal-layer")).toBe(true)
    expect(railLayer?.inert).toBe(false)
    await act(async () => close?.click())
    expect(portal.querySelector('[data-rly-relay-dock-presentation="rail"]')).toBeNull()
    expect(portal.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it("focuses an initially open dialog after the owned portal target mounts", async () => {
    const { portal } = await mountWithOwnedPortal(dock({ defaultOpen: true }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')

    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })

  it("omits a null footer while rendering supplied footer content", async () => {
    const withoutFooter = await mount(dock({ defaultOpen: true, footer: null }))
    const withFooter = await mount(dock({ defaultOpen: true }))

    expect(withoutFooter.portal.querySelector("footer")).toBeNull()
    expect(withFooter.portal.querySelectorAll("footer")).toHaveLength(1)
    expect(withFooter.portal.querySelector('[aria-label="Message Relay"]')).not.toBeNull()
  })

  it("isolates light-DOM siblings when the modal portal target is a ShadowRoot", async () => {
    const { host, portal } = await mountInShadowRoot(dock({ defaultOpen: true }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const controls = dialog?.querySelectorAll<HTMLElement>('[role="combobox"]')
    const composer = dialog?.querySelector<HTMLTextAreaElement>('[aria-label="Message Relay"]')

    expect(dialog).not.toBeNull()
    expect(host.inert).toBe(true)
    controls?.[0]?.focus()
    await act(async () =>
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }))
    )
    expect(portal.activeElement).toBe(controls?.[0])
    controls?.[1]?.focus()
    await act(async () =>
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true })
      )
    )
    expect(portal.activeElement).toBe(controls?.[1])
    composer?.focus()
    await act(async () =>
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }))
    )
    expect(portal.activeElement).toBe(close)
    close?.focus()
    await act(async () =>
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true })
      )
    )
    expect(portal.activeElement).toBe(composer)
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(host.inert).toBe(false)
  })

  it("traps focus inside caller-owned nested open shadow content", async () => {
    const { portal } = await mount(dock({ defaultOpen: true, footer: <div data-rly-shadow-footer="" /> }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    if (dialog === null) throw new Error("RelayDock shadow dialog did not render")
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const footer = dialog.querySelector<HTMLElement>("[data-rly-shadow-footer]")
    if (close === null || footer === null) throw new Error("RelayDock shadow footer did not render")

    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const internal = shadow.appendChild(document.createElement("button"))
    internal.textContent = "Nested footer action"
    footer.append(host)

    internal.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    close.focus()
    const reverse = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
      shiftKey: true
    })
    await act(async () => dialog.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(shadow.activeElement).toBe(internal)
  })

  it("traps focus on controls assigned through an open shadow slot", async () => {
    const footer = (
      <div data-rly-slot-focus-host="">
        <button type="button">Slotted footer action</button>
      </div>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-slot-focus-host]")
    if (dialog === null || close === null || host === null) throw new Error("RelayDock slot fixture did not render")
    const shadow = host.attachShadow({ mode: "open" })
    shadow.append(document.createElement("slot"))
    const slotted = host.querySelector<HTMLButtonElement>("button")
    if (slotted === null) throw new Error("RelayDock slotted action did not render")

    slotted.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("visits children of a light-DOM slot as ordinary content", async () => {
    const footer = (
      <slot data-rly-light-slot="">
        <button data-rly-light-slot-action="" type="button">
          Light slot action
        </button>
      </slot>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const action = portal.querySelector<HTMLButtonElement>("[data-rly-light-slot-action]")
    if (dialog === null || close === null || action === null) {
      throw new Error("RelayDock light-DOM slot fixture did not render")
    }

    action.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("does not treat a slot replaced by non-focusable assigned content as a tab stop", async () => {
    const footer = (
      <>
        <button data-rly-slot-preceding-action="" type="button">
          Preceding footer action
        </button>
        <div data-rly-slot-placeholder-host="">
          <span>Assigned decoration</span>
        </div>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-slot-placeholder-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-slot-preceding-action]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock slot placeholder fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("does not treat an empty slot as a tab stop", async () => {
    const footer = (
      <>
        <button data-rly-empty-slot-preceding-action="" type="button">
          Preceding footer action
        </button>
        <div data-rly-empty-slot-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-empty-slot-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-empty-slot-preceding-action]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock empty slot fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)

    close.focus()
    const reverse = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
      shiftKey: true
    })
    await act(async () => dialog.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(preceding)
  })

  it("keeps only the checked radio as a shadow-scope tab stop", async () => {
    const footer = <div data-rly-radio-focus-host="" />
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-radio-focus-host]")
    if (dialog === null || close === null || host === null) throw new Error("RelayDock radio fixture did not render")
    const shadow = host.attachShadow({ mode: "open" })
    const checked = shadow.appendChild(document.createElement("input"))
    checked.type = "radio"
    checked.name = "shadow-review-route"
    checked.checked = true
    const unchecked = shadow.appendChild(document.createElement("input"))
    unchecked.type = "radio"
    unchecked.name = "shadow-review-route"

    checked.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    expect(shadow.activeElement).not.toBe(unchecked)
  })

  it("groups an assigned radio with its light-DOM native peers", async () => {
    const footer = (
      <>
        <input data-rly-native-radio="" defaultChecked name="document-review-route" type="radio" />
        <div data-rly-radio-slot-host="">
          <input data-rly-assigned-radio="" name="document-review-route" type="radio" />
        </div>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-radio-slot-host]")
    const native = portal.querySelector<HTMLInputElement>("[data-rly-native-radio]")
    if (dialog === null || close === null || host === null || native === null) {
      throw new Error("RelayDock assigned radio fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    shadow.append(document.createElement("slot"))
    const assigned = host.querySelector<HTMLInputElement>("[data-rly-assigned-radio]")
    if (assigned === null) throw new Error("RelayDock assigned radio did not render")

    native.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    expect(document.activeElement).not.toBe(assigned)
  })

  it("excludes assigned controls hidden by their shadow ancestry", async () => {
    const footer = (
      <>
        <button data-rly-assigned-ancestry-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-assigned-ancestry-host="">
          <button data-rly-assigned-ancestry-action="" type="button">
            Assigned footer action
          </button>
        </div>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-assigned-ancestry-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-assigned-ancestry-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock assigned ancestry fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const hidden = shadow.appendChild(document.createElement("div"))
    hidden.style.display = "none"
    hidden.append(document.createElement("slot"))

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("keeps a shadow control inside the first disabled-fieldset legend", async () => {
    const footer = (
      <fieldset disabled>
        <legend>
          Review route
          <div data-rly-legend-shadow-host="" />
        </legend>
        <button data-rly-legend-preceding="" type="button">
          Preceding footer action
        </button>
      </fieldset>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-legend-shadow-host]")
    if (dialog === null || close === null || host === null) throw new Error("RelayDock legend fixture did not render")
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.type = "button"
    action.textContent = "Legend shadow action"

    action.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("recognizes radio inputs with case-insensitive type attributes", async () => {
    const footer = <div data-rly-uppercase-radio-host="" />
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-uppercase-radio-host]")
    if (dialog === null || close === null || host === null)
      throw new Error("RelayDock uppercase radio fixture did not render")
    const checked = document.createElement("input")
    checked.setAttribute("type", "RADIO")
    checked.name = "uppercase-review-route"
    checked.checked = true
    const trailing = document.createElement("input")
    trailing.setAttribute("type", "RADIO")
    trailing.name = "uppercase-review-route"
    host.append(checked, trailing)

    checked.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    expect(document.activeElement).not.toBe(trailing)
  })

  it("orders positive tabindex controls within a shadow focus scope", async () => {
    const footer = <div data-rly-positive-tabindex-host="" />
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-positive-tabindex-host]")
    if (dialog === null || close === null || host === null)
      throw new Error("RelayDock positive tabindex fixture did not render")
    const shadow = host.attachShadow({ mode: "open" })
    const higher = shadow.appendChild(document.createElement("button"))
    higher.textContent = "Higher priority action"
    higher.tabIndex = 2
    const lower = shadow.appendChild(document.createElement("button"))
    lower.textContent = "Lower priority action"
    lower.tabIndex = 1

    higher.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    expect(shadow.activeElement).not.toBe(lower)
  })

  it("orders positive tabindex descendants across shadow-scope wrappers", async () => {
    const footer = <div data-rly-positive-wrapper-host="" />
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-positive-wrapper-host]")
    if (dialog === null || close === null || host === null) {
      throw new Error("RelayDock positive wrapper fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const higherWrapper = shadow.appendChild(document.createElement("div"))
    const higher = higherWrapper.appendChild(document.createElement("button"))
    higher.textContent = "Higher priority action"
    higher.tabIndex = 2
    const lowerWrapper = shadow.appendChild(document.createElement("div"))
    const lower = lowerWrapper.appendChild(document.createElement("button"))
    lower.textContent = "Lower priority action"
    lower.tabIndex = 1

    higher.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    expect(shadow.activeElement).not.toBe(lower)
  })

  it("keeps assigned-slot positive tabindex ordering local to the slot scope", async () => {
    const footer = (
      <div data-rly-slot-order-host="">
        <button data-rly-slot-order-assigned="" type="button" />
      </div>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-slot-order-host]")
    const assigned = portal.querySelector<HTMLButtonElement>("[data-rly-slot-order-assigned]")
    if (dialog === null || close === null || host === null || assigned === null) {
      throw new Error("RelayDock slot ordering fixture did not render")
    }
    assigned.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open" })
    const direct = shadow.appendChild(document.createElement("button"))
    direct.tabIndex = 2
    direct.textContent = "Direct priority action"
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0

    assigned.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("preserves nested fallback slot scopes", async () => {
    const footer = (
      <div data-rly-nested-slot-host="">
        <button data-rly-nested-slot-assigned="" slot="inner" type="button">
          Assigned inner action
        </button>
      </div>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-nested-slot-host]")
    const assigned = portal.querySelector<HTMLButtonElement>("[data-rly-nested-slot-assigned]")
    if (dialog === null || close === null || host === null || assigned === null) {
      throw new Error("RelayDock nested slot fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const outer = shadow.appendChild(document.createElement("slot"))
    const fallback = outer.appendChild(document.createElement("div"))
    const fallbackAction = fallback.appendChild(document.createElement("button"))
    fallbackAction.tabIndex = 2
    fallbackAction.textContent = "Outer fallback action"
    const inner = fallback.appendChild(document.createElement("slot"))
    inner.name = "inner"

    assigned.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("uses the delegated shadow control as the modal focus endpoint", async () => {
    const footer = (
      <>
        <div data-rly-delegates-focus-host="" />
        <button data-rly-delegates-focus-last="" type="button">
          Last footer action
        </button>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-delegates-focus-host]")
    const last = portal.querySelector<HTMLButtonElement>("[data-rly-delegates-focus-last]")
    if (dialog === null || host === null || last === null) {
      throw new Error("RelayDock delegatesFocus fixture did not render")
    }
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    Object.defineProperty(shadow, "delegatesFocus", { configurable: true, value: true })
    const action = shadow.appendChild(document.createElement("button"))
    action.textContent = "Delegated action"

    action.focus()
    const reverse = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
      shiftKey: true
    })
    await act(async () => dialog.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
  })

  it("keeps a negative-tabindex delegated control as the modal endpoint", async () => {
    const footer = (
      <>
        <div data-rly-negative-delegates-focus-host="" />
        <button data-rly-negative-delegates-focus-last="" type="button">
          Last footer action
        </button>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-negative-delegates-focus-host]")
    const last = portal.querySelector<HTMLButtonElement>("[data-rly-negative-delegates-focus-last]")
    if (dialog === null || host === null || last === null) {
      throw new Error("RelayDock negative delegatesFocus fixture did not render")
    }
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    Object.defineProperty(shadow, "delegatesFocus", { configurable: true, value: true })
    const action = shadow.appendChild(document.createElement("button"))
    action.tabIndex = -1
    action.textContent = "Programmatic delegated action"

    action.focus()
    const reverse = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
      shiftKey: true
    })
    await act(async () => dialog.dispatchEvent(reverse))
    expect(reverse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
  })

  it("excludes targetless delegated hosts from modal endpoints", async () => {
    const footer = (
      <>
        <button data-rly-targetless-delegates-focus-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-targetless-delegates-focus-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-targetless-delegates-focus-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-targetless-delegates-focus-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock targetless delegatesFocus fixture did not render")
    }
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    Object.defineProperty(shadow, "delegatesFocus", { configurable: true, value: true })
    const disabled = shadow.appendChild(document.createElement("button"))
    disabled.disabled = true

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes content-visibility-hidden shadow descendants from modal endpoints", async () => {
    const footer = (
      <>
        <button data-rly-content-visibility-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-content-visibility-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-content-visibility-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-content-visibility-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock content visibility fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const hidden = shadow.appendChild(document.createElement("div"))
    hidden.style.contentVisibility = "hidden"
    const action = hidden.appendChild(document.createElement("button"))
    action.textContent = "Hidden action"

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("retains a focusable content-visibility container as an endpoint", async () => {
    const footer = (
      <button data-rly-content-visibility-own="" type="button">
        Hidden-content container
      </button>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const action = portal.querySelector<HTMLButtonElement>("[data-rly-content-visibility-own]")
    if (dialog === null || close === null || action === null) {
      throw new Error("RelayDock content visibility endpoint fixture did not render")
    }
    action.style.contentVisibility = "hidden"

    action.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("preserves SVG composed ancestry when checking rendered focusability", async () => {
    const footer = (
      <>
        <button data-rly-svg-preceding="" type="button">
          Preceding footer action
        </button>
        <svg data-rly-svg-hidden="">
          <foreignObject>
            <button data-rly-svg-hidden-action="" type="button">
              Hidden SVG action
            </button>
          </foreignObject>
        </svg>
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const svg = portal.querySelector<SVGElement>("[data-rly-svg-hidden]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-svg-preceding]")
    if (dialog === null || close === null || svg === null || preceding === null) {
      throw new Error("RelayDock SVG ancestry fixture did not render")
    }
    svg.style.display = "none"

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("skips shadow controls behind an explicit negative host tabindex", async () => {
    const footer = (
      <>
        <button data-rly-negative-tabindex-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-negative-tabindex-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-negative-tabindex-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-negative-tabindex-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock negative tabindex fixture did not render")
    }
    host.tabIndex = -1
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.textContent = "Negative host shadow action"

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes implicit overflow scrollers from modal endpoints", async () => {
    const footer = (
      <>
        <button data-rly-overflow-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-overflow-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-overflow-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-overflow-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock overflow fixture did not render")
    }
    const shadow = host.attachShadow({ mode: "open" })
    const scroller = shadow.appendChild(document.createElement("div"))
    scroller.style.overflow = "auto"
    scroller.append(document.createTextNode("Non-focusable overflow content"))

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("excludes inert shadow subtrees from modal endpoints", async () => {
    const footer = (
      <>
        <button data-rly-inert-preceding="" type="button">
          Preceding footer action
        </button>
        <div data-rly-inert-host="" />
      </>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-inert-host]")
    const preceding = portal.querySelector<HTMLButtonElement>("[data-rly-inert-preceding]")
    if (dialog === null || close === null || host === null || preceding === null) {
      throw new Error("RelayDock inert fixture did not render")
    }
    host.inert = true
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.textContent = "Inert shadow action"

    preceding.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })

  it("keeps a shadow descendant of the first closed-details summary in the modal boundary", async () => {
    const footer = (
      <details>
        <summary>
          Collapsed evidence
          <div data-rly-summary-focus-host="" />
        </summary>
        <button type="button">Collapsed evidence action</button>
      </details>
    )
    const { portal } = await mount(dock({ defaultOpen: true, footer }))
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const close = portal.querySelector<HTMLButtonElement>('[aria-label="Close Relay"]')
    const host = portal.querySelector<HTMLElement>("[data-rly-summary-focus-host]")
    if (dialog === null || close === null || host === null) throw new Error("RelayDock summary fixture did not render")
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.type = "button"
    action.textContent = "Visible shadow summary action"

    action.focus()
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" })
    await act(async () => dialog.dispatchEvent(forward))
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
  })
})
