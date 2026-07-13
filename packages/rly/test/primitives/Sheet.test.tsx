// @vitest-environment happy-dom

import { act, createRef, type ReactElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import {
  RLY_SHEET_DEFAULT_VARIANTS,
  RLY_SHEET_VARIANTS,
  Sheet,
  type RlySheetSide,
  type SheetContentProps
} from "../../src/primitives/Sheet.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface MountedSheet {
  readonly background: HTMLDivElement
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedSheet> = []

const mount = async (element: ReactElement): Promise<MountedSheet> => {
  const background = document.createElement("div")
  const host = document.createElement("div")
  const portal = document.createElement("div")
  background.dataset.background = ""
  background.innerHTML = "<button>Background action</button>"
  document.body.append(background, host, portal)
  const root = createRoot(host)
  const entry = { background, host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const pressEscape = async (target: Element): Promise<void> => {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
})

describe("Sheet", () => {
  it("supports controlled state, sets focus, restores focus, and cleans modal isolation", async () => {
    const changes: Array<boolean> = []
    const initialFocusRef = createRef<HTMLButtonElement>()

    const Controlled = (): ReactElement => {
      const [open, setOpen] = useState(false)
      return (
        <Sheet.Root
          onOpenChange={(nextOpen) => {
            changes.push(nextOpen)
            setOpen(nextOpen)
          }}
          open={open}
        >
          <Sheet.Trigger>Inspect release</Sheet.Trigger>
          <Sheet.Content
            description="Review evidence before approval."
            initialFocusRef={initialFocusRef}
            title="Release evidence"
          >
            <Sheet.Body>
              <button ref={initialFocusRef} type="button">
                Review checks
              </button>
            </Sheet.Body>
          </Sheet.Content>
        </Sheet.Root>
      )
    }

    const { background, host, portal } = await mount(<Controlled />)
    const trigger = host.querySelector<HTMLButtonElement>("button")
    await act(async () => trigger?.click())
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')

    expect(changes).toEqual([true])
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy()
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy()
    expect(portal.querySelector("h2")?.textContent).toBe("Release evidence")
    expect(document.activeElement).toBe(initialFocusRef.current)
    expect(background.inert).toBe(true)
    expect(document.head.inert).toBe(false)
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(true)

    if (dialog !== null) await pressEscape(dialog)
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(changes).toEqual([true, false])
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(background.inert).toBe(false)
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false)
  })

  it("supports an uncontrolled default and pointer dismissal", async () => {
    const changes: Array<boolean> = []
    const { portal } = await mount(
      <Sheet.Root defaultOpen onOpenChange={(open) => changes.push(open)}>
        <Sheet.Trigger>Open navigation</Sheet.Trigger>
        <Sheet.Content side="start" title="Release navigation">
          <Sheet.Body>Navigation destinations</Sheet.Body>
        </Sheet.Content>
      </Sheet.Root>
    )
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = portal.querySelector<HTMLElement>("[data-rly-sheet-overlay]")
    expect(dialog?.dataset.rlySheetSide).toBe("start")
    expect(document.activeElement).toBe(dialog)

    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    await act(async () =>
      overlay?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, cancelable: true }))
    )
    expect(changes).toEqual([false])
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
  })

  it("keeps nested dismissal and focus restoration scoped to the top sheet", async () => {
    const { host, portal, root } = await mount(
      <Sheet.Root defaultOpen>
        <Sheet.Trigger>Open outer</Sheet.Trigger>
        <Sheet.Content title="Outer sheet">
          <Sheet.Body>
            <Sheet.Root>
              <Sheet.Trigger>Open inner</Sheet.Trigger>
              <Sheet.Content title="Inner sheet">
                <Sheet.Body>Nested detail</Sheet.Body>
              </Sheet.Content>
            </Sheet.Root>
          </Sheet.Body>
        </Sheet.Content>
      </Sheet.Root>
    )
    const innerTrigger = portal.querySelector<HTMLButtonElement>("button:not([aria-label])")
    await act(async () => innerTrigger?.click())
    const dialogs = portal.querySelectorAll<HTMLElement>('[role="dialog"]')
    expect(dialogs).toHaveLength(2)

    const innerDialog = dialogs.item(1)
    await pressEscape(innerDialog)
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(portal.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.activeElement).toBe(innerTrigger)

    await act(async () => root.unmount())
    mounted.splice(
      mounted.findIndex((entry) => entry.root === root),
      1
    )
    expect(portal.childElementCount).toBe(0)
    expect(host.inert).toBe(false)
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false)
  })

  it("does not escape an unavailable portal boundary", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <PortalProvider container={null}>
          <Sheet.Root defaultOpen>
            <Sheet.Trigger>Open unavailable sheet</Sheet.Trigger>
            <Sheet.Content title="Unavailable sheet">
              <Sheet.Body>Not mounted</Sheet.Body>
            </Sheet.Content>
          </Sheet.Root>
        </PortalProvider>
      )
    )
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector("[data-rly-sheet-overlay]")).toBeNull()
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false)
    await act(async () => root.unmount())
  })

  it("publishes side metadata and enforces visible owned labels", () => {
    expect(RLY_SHEET_DEFAULT_VARIANTS).toEqual({ side: "end" })
    expect(Object.keys(RLY_SHEET_VARIANTS.side)).toEqual(["end", "start"])
    expect(RLY_SHEET_VARIANTS.side.end.className).not.toBe(RLY_SHEET_VARIANTS.side.start.className)
    expectTypeOf<SheetContentProps["side"]>().toEqualTypeOf<RlySheetSide | undefined>()

    expect(() =>
      renderToStaticMarkup(
        <Sheet.Root>
          <Sheet.Content title=" ">
            <Sheet.Body>Content</Sheet.Body>
          </Sheet.Content>
        </Sheet.Root>
      )
    ).toThrow("Sheet title")
    expect(() =>
      renderToStaticMarkup(
        <Sheet.Root>
          <Sheet.Trigger> </Sheet.Trigger>
        </Sheet.Root>
      )
    ).toThrow("Sheet.Trigger children")
  })
})
