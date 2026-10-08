// @vitest-environment happy-dom

import { act, type ReactElement, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { RelayLauncher, relayShortcut, useRelaySummon } from "../../src/patterns/RelayLauncher.js"

const ctrlJ = relayShortcut(false)
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

/** A host page: a page control, the launcher, and Relay's region with its composer while open. */
const Host = ({ bound = true, fullscreen = false }: { readonly bound?: boolean; readonly fullscreen?: boolean }) => {
  const [open, setOpen] = useState(false)
  const region = useRef<HTMLElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  useRelaySummon({ composer, fullscreen, onOpenChange: setOpen, open, region, shortcut: bound ? ctrlJ : null })
  return (
    <>
      <button data-testid="page" type="button">
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} shortcut={bound ? ctrlJ : null} />
      {open ? (
        <aside aria-label="Relay" ref={region}>
          <button data-testid="relay-option" type="button">
            Options
          </button>
          <textarea aria-label="Message Relay" ref={composer} />
        </aside>
      ) : null}
    </>
  )
}

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

const byTestId = (id: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-testid='${id}']`)
  if (element === null) throw new Error(`missing ${id}`)
  return element
}
const composer = (): HTMLElement | null => document.querySelector("textarea")
const launcher = (): HTMLElement | null => document.querySelector("[data-rly-relay-launcher]")

/** Presses a key on the focused element, as a user would; returns whether the page prevented it. */
const press = async (key: string, init: KeyboardEventInit = {}): Promise<boolean> => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init })
  await act(async () => {
    ;(document.activeElement ?? document.body).dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe("useRelaySummon", () => {
  it("opens with the shortcut and focuses the composer, then takes focus back to the page", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    expect(await press("j", { ctrlKey: true })).toBe(true)
    expect(launcher()?.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(composer())
    // Open with focus in Relay: back to where you were, Relay stays open.
    expect(await press("j", { ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(byTestId("page"))
    expect(composer()).not.toBeNull()
    // Open with focus on the page: to the composer again.
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(composer())
  })

  it("closes on Escape from inside Relay and returns focus, but leaves Escape on the page alone", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("relay-option").focus()
    expect(await press("Escape")).toBe(true)
    expect(composer()).toBeNull()
    expect(document.activeElement).toBe(byTestId("page"))

    await press("j", { ctrlKey: true })
    byTestId("page").focus()
    expect(await press("Escape")).toBe(false)
    expect(composer()).not.toBeNull()
  })

  it("remembers the launcher when Relay was opened by clicking it", async () => {
    await mount(<Host />)
    const button = launcher()
    button?.focus()
    await act(async () => button?.click())
    composer()?.focus()
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(button)
  })

  it("closes with the shortcut when Relay is full screen", async () => {
    await mount(<Host fullscreen />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(composer())
    expect(await press("j", { ctrlKey: true })).toBe(true)
    expect(composer()).toBeNull()
    expect(document.activeElement).toBe(byTestId("page"))
  })

  it("never prevents Ctrl+K, ?, g or Alt chords", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    expect(await press("k", { ctrlKey: true })).toBe(false)
    expect(await press("?", { shiftKey: true })).toBe(false)
    expect(await press("g")).toBe(false)
    expect(await press("j", { altKey: true, ctrlKey: true })).toBe(false)
    expect(composer()).toBeNull()
  })

  it("does nothing while the host's own surface owns the key", async () => {
    await mount(<Host bound={false} />)
    byTestId("page").focus()
    expect(await press("j", { ctrlKey: true })).toBe(false)
    expect(composer()).toBeNull()
  })
})
