// @vitest-environment happy-dom

import { act, createRef, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { Dialog, RLY_DIALOG_DEFAULT_VARIANTS, RLY_DIALOG_VARIANTS } from "../../src/primitives/Dialog.js"
import { Sheet } from "../../src/primitives/Sheet.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface MountedDialog {
  readonly background: HTMLElement
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedDialog> = []

const mount = async (element: ReactElement): Promise<MountedDialog> => {
  const background = document.createElement("main")
  const host = document.createElement("div")
  const portal = document.createElement("div")
  background.textContent = "Application"
  document.body.append(background, host, portal)
  const root = createRoot(host)
  const entry = { background, host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("Dialog", () => {
  it("publishes meaningful content sizes", () => {
    expect(RLY_DIALOG_DEFAULT_VARIANTS).toEqual({ size: "default" })
    expect(Object.keys(RLY_DIALOG_VARIANTS.size)).toEqual(["default", "wide"])
  })

  it("keeps portal content unavailable during SSR and rejects blank naming", () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root defaultOpen>
        <Dialog.Trigger>Open details</Dialog.Trigger>
        <Dialog.Content title="Details">Content</Dialog.Content>
      </Dialog.Root>
    )
    expect(markup).toContain("Open details")
    expect(markup).not.toContain('role="dialog"')
    expect(() =>
      renderToStaticMarkup(
        <Dialog.Root>
          <Dialog.Content title=" ">Content</Dialog.Content>
        </Dialog.Root>
      )
    ).toThrow("Dialog title")
    expect(() =>
      renderToStaticMarkup(
        <Dialog.Root>
          <Dialog.Content description=" " title="Details">
            Content
          </Dialog.Content>
        </Dialog.Root>
      )
    ).toThrow("Dialog description")
  })

  it("reports controlled changes without changing owner state", async () => {
    const onOpenChange = vi.fn()
    const { host, portal } = await mount(
      <Dialog.Root onOpenChange={onOpenChange} open={false}>
        <Dialog.Trigger>Open details</Dialog.Trigger>
        <Dialog.Content title="Details">Content</Dialog.Content>
      </Dialog.Root>
    )
    const trigger = host.querySelector<HTMLButtonElement>("button")
    await act(async () => trigger?.click())
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
  })

  it("sets focus, relationships, inert background, scroll lock, and restores focus after Escape", async () => {
    const initialFocusRef = createRef<HTMLInputElement>()
    const { background, host, portal } = await mount(
      <Dialog.Root>
        <Dialog.Trigger>Open details</Dialog.Trigger>
        <Dialog.Content
          description="Review the exact change before continuing."
          initialFocusRef={initialFocusRef}
          title="Change details"
        >
          <input aria-label="Reason" ref={initialFocusRef} />
          <Dialog.Close>Done</Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>
    )
    const trigger = host.querySelector<HTMLButtonElement>("button")
    await act(async () => trigger?.click())
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const title = portal.querySelector<HTMLElement>("h2")
    const description = portal.querySelector<HTMLElement>("p")

    expect(document.activeElement).toBe(initialFocusRef.current)
    expect(dialog?.getAttribute("aria-labelledby")).toBe(title?.id)
    expect(dialog?.getAttribute("aria-describedby")).toBe(description?.id)
    expect(background.inert).toBe(true)
    expect(document.body.getAttribute("data-scroll-locked")).toBe("1")

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
      )
    })
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(background.inert).toBe(false)
    expect(document.body.getAttribute("data-scroll-locked")).toBeNull()
  })

  it("dismisses on an outside pointer", async () => {
    const dismissible = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Trigger>Open</Dialog.Trigger>
        <Dialog.Content title="Dismissible">Content</Dialog.Content>
      </Dialog.Root>
    )
    const overlay = dismissible.portal.querySelector<HTMLElement>("[data-rly-dialog-overlay]")
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    await act(async () =>
      overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
    )
    expect(dismissible.portal.querySelector('[role="dialog"]')).toBeNull()
  })

  it("does not mount modal behavior when its portal target is unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <PortalProvider container={null}>
          <Dialog.Root defaultOpen>
            <Dialog.Content title="Unavailable">Content</Dialog.Content>
          </Dialog.Root>
        </PortalProvider>
      )
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector("[data-rly-dialog-layer]")).toBeNull()
    expect(document.body.getAttribute("data-scroll-locked")).toBeNull()
    await act(async () => root.unmount())
  })

  it("reference-counts nested inert state and cleans up an open tree on unmount", async () => {
    const entry = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content title="Outer dialog">
          <Dialog.Root defaultOpen>
            <Dialog.Content title="Inner dialog">Nested content</Dialog.Content>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Root>
    )
    const layers = entry.portal.querySelectorAll<HTMLElement>("[data-rly-dialog-layer]")
    expect(layers).toHaveLength(2)
    expect(layers[0]?.inert).toBe(true)
    expect(layers[1]?.inert).toBe(false)
    expect(entry.background.inert).toBe(true)

    mounted.splice(mounted.indexOf(entry), 1)
    await act(async () => entry.root.unmount())
    expect(entry.background.inert).toBe(false)
    expect(entry.portal.childElementCount).toBe(0)
    expect(document.body.getAttribute("data-scroll-locked")).toBeNull()
  })

  it("shares isolation cleanup across mixed dialog and sheet nesting", async () => {
    const entry = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content title="Outer dialog">
          <Sheet.Root defaultOpen>
            <Sheet.Content title="Inner sheet">
              <Sheet.Body>
                Nested detail
                <Sheet.Close>Close inner sheet</Sheet.Close>
              </Sheet.Body>
            </Sheet.Content>
          </Sheet.Root>
        </Dialog.Content>
      </Dialog.Root>
    )
    const dialogs = entry.portal.querySelectorAll<HTMLElement>('[role="dialog"]')
    const layers = entry.portal.querySelectorAll<HTMLElement>("[data-rly-modal-layer]")
    expect(dialogs).toHaveLength(2)
    expect([...layers].map((layer) => layer.inert)).toEqual([true, false])
    expect(entry.background.inert).toBe(true)

    const closeInner = entry.portal.querySelector<HTMLButtonElement>("button:not([aria-label])")
    await act(async () => closeInner?.click())
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(entry.portal.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(entry.portal.querySelector<HTMLElement>("[data-rly-modal-layer]")?.inert).toBe(false)
    expect(entry.background.inert).toBe(true)

    mounted.splice(mounted.indexOf(entry), 1)
    await act(async () => entry.root.unmount())
    expect(entry.background.inert).toBe(false)
    expect(document.head.inert).toBe(false)
    expect(document.body.getAttribute("data-scroll-locked")).toBeNull()
  })
})
