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
  const launcher = useRef<HTMLButtonElement>(null)
  const [pageControl, setPageControl] = useState(true)
  useRelaySummon({
    composer,
    fullscreen,
    launcher,
    onOpenChange: setOpen,
    open,
    region,
    shortcut: bound ? ctrlJ : null
  })
  return (
    <>
      {pageControl ? (
        <button data-testid="page" type="button">
          Page control
        </button>
      ) : null}
      <RelayLauncher
        expanded={open}
        onClick={() => setOpen((value) => !value)}
        ref={launcher}
        shortcut={bound ? ctrlJ : null}
      />
      {open ? (
        <aside aria-label="Relay" ref={region}>
          <button data-testid="relay-option" type="button">
            Options
          </button>
          <textarea aria-label="Message Relay" ref={composer} />
          <button data-testid="remove-page" onClick={() => setPageControl(false)} type="button">
            Remove page control
          </button>
          <button aria-controls="relay-options" aria-expanded="true" type="button">
            Options
          </button>
          <div data-testid="menu" id="relay-options" role="listbox" tabIndex={-1}>
            Options menu
          </div>
          <div data-testid="chips" role="listbox" tabIndex={-1}>
            Always-rendered suggestions
          </div>
          <div
            data-testid="prevented"
            onKeyDown={(event) => {
              if (event.key === "Escape") event.preventDefault()
            }}
            tabIndex={-1}
          >
            Popup that handles Escape
          </div>
        </aside>
      ) : null}
    </>
  )
}

/** A host whose region is a wrapper around a modal surface, like the dock's full-screen dialog. */
const SurfaceHost = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const region = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  useRelaySummon({ composer, fullscreen: true, launcher, onOpenChange: setOpen, open, region, shortcut: ctrlJ })
  return (
    <>
      <button data-testid="page" type="button">
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={ctrlJ} />
      {open ? (
        <div ref={region}>
          <section aria-label="Relay" aria-modal data-rly-relay-surface="" role="dialog">
            <textarea aria-label="Message Relay" ref={composer} />
          </section>
        </div>
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

  it("leaves Escape to an IME composition in the composer", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    expect(await press("Escape", { isComposing: true })).toBe(false)
    expect(await press("Escape", { keyCode: 229 })).toBe(false)
    expect(composer()).not.toBeNull()
  })

  it("leaves Escape to a layer inside Relay, whether or not it prevents it", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("menu").focus()
    expect(await press("Escape")).toBe(false)
    expect(composer()).not.toBeNull()
    byTestId("prevented").focus()
    expect(await press("Escape")).toBe(true)
    expect(composer()).not.toBeNull()
  })

  it("still closes from a list that is always rendered, not an open popup", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("chips").focus()
    expect(await press("Escape")).toBe(true)
    expect(composer()).toBeNull()
  })

  it("closes a full-screen Relay whose region wraps the dock's dialog surface", async () => {
    await mount(<SurfaceHost />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(composer())
    expect(await press("Escape")).toBe(true)
    expect(composer()).toBeNull()
    expect(document.activeElement).toBe(byTestId("page"))
  })

  it("returns focus to the launcher when the element Relay came from is gone", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    await act(async () => byTestId("remove-page").click())
    composer()?.focus()
    expect(await press("j", { ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(launcher())
  })

  it("does nothing while the host's own surface owns the key", async () => {
    await mount(<Host bound={false} />)
    byTestId("page").focus()
    expect(await press("j", { ctrlKey: true })).toBe(false)
    expect(composer()).toBeNull()
  })
})
