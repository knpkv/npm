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

  it("marks externally orchestrated entry motion on the complete modal layer", async () => {
    const { portal } = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content entryMotion="external" title="Transitioned details">
          Content
        </Dialog.Content>
      </Dialog.Root>
    )
    expect(portal.querySelector("[data-rly-dialog-layer]")?.getAttribute("data-rly-dialog-entry-motion")).toBe(
      "external"
    )
  })

  it("keeps entry ownership stable until the next open cycle", async () => {
    const renderDialog = (open: boolean, entryMotion: "external" | "intrinsic"): ReactElement => (
      <Dialog.Root onOpenChange={() => undefined} open={open}>
        <Dialog.Content entryMotion={entryMotion} title="Transitioned details">
          Content
        </Dialog.Content>
      </Dialog.Root>
    )
    const entry = await mount(renderDialog(true, "external"))
    const readEntryMotion = (): string | null | undefined =>
      entry.portal.querySelector("[data-rly-dialog-layer]")?.getAttribute("data-rly-dialog-entry-motion")

    expect(readEntryMotion()).toBe("external")
    await act(async () =>
      entry.root.render(<PortalProvider container={entry.portal}>{renderDialog(true, "intrinsic")}</PortalProvider>)
    )
    expect(readEntryMotion()).toBe("external")

    await act(async () =>
      entry.root.render(<PortalProvider container={entry.portal}>{renderDialog(false, "intrinsic")}</PortalProvider>)
    )
    await act(async () =>
      entry.root.render(<PortalProvider container={entry.portal}>{renderDialog(true, "intrinsic")}</PortalProvider>)
    )
    expect(readEntryMotion()).toBe("intrinsic")
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

  it.each([true, false])(
    "lets the host handle restoration when it returns %s, otherwise restores the opener",
    async (handled) => {
      const destination = document.createElement("button")
      destination.textContent = "Route destination"
      document.body.append(destination)
      const restoreFocus = vi.fn((opener: HTMLElement | null): boolean => {
        expect(opener).toBe(trigger)
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(destination.inert).toBe(false)
        expect(destination.closest('[aria-hidden="true"]')).toBeNull()
        if (handled) destination.focus()
        return handled
      })
      const { host, portal } = await mount(
        <Dialog.Root>
          <Dialog.Trigger>Open details</Dialog.Trigger>
          <Dialog.Content restoreFocus={restoreFocus} title="Details">
            <Dialog.Close>Done</Dialog.Close>
          </Dialog.Content>
        </Dialog.Root>
      )
      const trigger = host.querySelector<HTMLButtonElement>("button")
      await act(async () => trigger?.click())
      await act(async () => portal.querySelector<HTMLButtonElement>("button")?.click())
      await vi.waitFor(() => expect(restoreFocus).toHaveBeenCalledOnce())
      expect(document.activeElement).toBe(handled ? destination : trigger)
    }
  )

  it("gives focus restoration to the latest of two sequential dialog closes", async () => {
    const first = document.createElement("button")
    const last = document.createElement("button")
    document.body.append(first, last)
    const restoreFirst = vi.fn(() => {
      first.focus()
      return true
    })
    const restoreLast = vi.fn(() => {
      last.focus()
      return true
    })
    const dialogs = (firstOpen: boolean, lastOpen: boolean): ReactElement => (
      <>
        <Dialog.Root onOpenChange={() => undefined} open={firstOpen}>
          <Dialog.Content restoreFocus={restoreFirst} title="First">
            First
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root onOpenChange={() => undefined} open={lastOpen}>
          <Dialog.Content restoreFocus={restoreLast} title="Last">
            Last
          </Dialog.Content>
        </Dialog.Root>
      </>
    )
    const entry = await mount(dialogs(true, true))
    await act(async () =>
      entry.root.render(<PortalProvider container={entry.portal}>{dialogs(false, true)}</PortalProvider>)
    )
    await act(async () =>
      entry.root.render(<PortalProvider container={entry.portal}>{dialogs(false, false)}</PortalProvider>)
    )
    await vi.waitFor(() => expect(document.activeElement).toBe(last))
    expect(restoreFirst).not.toHaveBeenCalled()
    expect(restoreLast).toHaveBeenCalledOnce()
  })

  it("restores the external opener when an open dialog owner unmounts", async () => {
    const opener = document.createElement("button")
    opener.textContent = "Open details"
    document.body.append(opener)
    opener.focus()
    const entry = await mount(
      <Dialog.Root defaultOpen>
        <Dialog.Content title="Details">
          <Dialog.Close>Done</Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>
    )
    expect(document.activeElement).not.toBe(opener)
    await act(async () => entry.root.unmount())
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
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
