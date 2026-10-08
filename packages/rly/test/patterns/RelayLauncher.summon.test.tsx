// @vitest-environment happy-dom

import { act, type ReactElement, useRef, useState } from "react"
import { createPortal } from "react-dom"
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
const Host = ({
  bound = true,
  composerLater = false,
  fullscreen = false
}: {
  readonly bound?: boolean
  readonly composerLater?: boolean
  readonly fullscreen?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const [pageControl, setPageControl] = useState(true)
  const [composerReady, setComposerReady] = useState(!composerLater)
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen,
    launcher,
    onOpenChange: setOpen,
    open,
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
        <aside aria-label="Relay" ref={regionRef}>
          <button data-testid="relay-option" type="button">
            Options
          </button>
          <button data-testid="composer-ready" onClick={() => setComposerReady(true)} type="button">
            Load composer
          </button>
          {composerReady ? <textarea aria-label="Message Relay" ref={composerRef} /> : null}
          <div data-testid="shadow-host" ref={attachShadowDialog} />
          <div data-testid="shadow-popup-host" ref={attachShadowPopup} />
          <input aria-controls="relay-mentions" aria-expanded="true" data-testid="combobox" role="combobox" />
          <div id="relay-mentions" role="listbox">
            Mentions
          </div>
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

/** A shadow root inside Relay holding a dialog with a focusable control. */
const attachShadowDialog = (host: HTMLDivElement | null): void => {
  if (host === null || host.shadowRoot !== null) return
  const shadow = host.attachShadow({ mode: "open" })
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  const button = document.createElement("button")
  button.textContent = "Inside a shadow dialog"
  dialog.append(button)
  shadow.append(dialog)
}

/** A shadow root inside Relay holding an open listbox and the expanded control that names it. */
const attachShadowPopup = (host: HTMLDivElement | null): void => {
  if (host === null || host.shadowRoot !== null) return
  const shadow = host.attachShadow({ mode: "open" })
  const control = document.createElement("button")
  control.setAttribute("aria-controls", "shadow-list")
  control.setAttribute("aria-expanded", "true")
  const list = document.createElement("div")
  list.id = "shadow-list"
  list.setAttribute("role", "listbox")
  list.tabIndex = -1
  shadow.append(control, list)
}

/** A host whose Relay stays mounted (hidden) while closed, composer included. */
const MountedHost = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: false,
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut: ctrlJ
  })
  return (
    <>
      <button data-testid="page" type="button">
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={ctrlJ} />
      <aside aria-label="Relay" hidden={!open} ref={regionRef}>
        <textarea aria-label="Message Relay" ref={composerRef} />
      </aside>
    </>
  )
}

/** A host whose popup closes itself on Escape (flipping its open state) without preventing the key. */
const SelfClosingPopupHost = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: false,
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut: ctrlJ
  })
  return (
    <>
      <button data-testid="page" type="button">
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={ctrlJ} />
      {open ? (
        <aside aria-label="Relay" ref={regionRef}>
          <textarea aria-label="Message Relay" ref={composerRef} />
          <div
            data-state="open"
            data-testid="self-closing"
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.setAttribute("data-state", "closed")
            }}
            role="listbox"
            tabIndex={-1}
          >
            Suggestions
          </div>
        </aside>
      ) : null}
    </>
  )
}

/** Records whether the page control received focus while Relay's surface was still mounted. */
let focusedWhileRelayMounted: boolean | undefined

/** A host whose region is a wrapper around a modal surface, like the dock's full-screen dialog. */
const SurfaceHost = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: true,
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut: ctrlJ
  })
  return (
    <>
      <button
        data-testid="page"
        onFocus={() => {
          focusedWhileRelayMounted = document.querySelector("[data-rly-relay-surface]") !== null
        }}
        type="button"
      >
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={ctrlJ} />
      {open ? (
        <div ref={regionRef}>
          <section aria-label="Relay" aria-modal data-rly-relay-surface="" role="dialog">
            <textarea aria-label="Message Relay" ref={composerRef} />
          </section>
        </div>
      ) : null}
    </>
  )
}

/** A host that portals Relay into another document (an iframe's), as PortalProvider allows. */
const OtherDocumentHost = ({ target }: { readonly target: HTMLElement }): ReactElement => {
  const [open, setOpen] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: false,
    launcher,
    onOpenChange: setOpen,
    open,
    shortcut: ctrlJ
  })
  return (
    <>
      <button data-testid="page" type="button">
        Page control
      </button>
      <RelayLauncher expanded={open} onClick={() => setOpen((value) => !value)} ref={launcher} shortcut={ctrlJ} />
      {open
        ? createPortal(
            <aside aria-label="Relay" ref={regionRef}>
              <textarea aria-label="Message Relay" ref={composerRef} />
            </aside>,
            target
          )
        : null}
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

  it("focuses a composer that mounts after Relay opened", async () => {
    await mount(<Host composerLater />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    expect(composer()).toBeNull()
    await act(async () => byTestId("composer-ready").click())
    expect(document.activeElement).toBe(composer())
  })

  it("returns focus only after a full-screen Relay has closed", async () => {
    focusedWhileRelayMounted = undefined
    await mount(<SurfaceHost />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    focusedWhileRelayMounted = undefined
    await press("Escape")
    expect(document.activeElement).toBe(byTestId("page"))
    expect(focusedWhileRelayMounted).toBe(false)
  })

  it("leaves Escape to a dialog inside a shadow root in Relay", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    const inner = byTestId("shadow-host").shadowRoot?.querySelector("button")
    inner?.focus()
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Escape" })
    await act(async () => {
      inner?.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(composer()).not.toBeNull()
  })

  it("follows Relay into another document", async () => {
    const other = document.implementation.createHTMLDocument("relay frame")
    await mount(<OtherDocumentHost target={other.body} />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    const otherComposer = other.querySelector("textarea")
    expect(otherComposer).not.toBeNull()
    otherComposer?.focus()
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "j" })
    await act(async () => {
      otherComposer?.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(byTestId("page"))
  })

  it("focuses a composer that was already mounted when Relay opens", async () => {
    await mount(<MountedHost />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(composer())
  })

  it("leaves Escape to a combobox inside Relay whose popup is open", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("combobox").focus()
    expect(await press("Escape")).toBe(false)
    expect(composer()).not.toBeNull()
  })

  it("finds a popup's expanded control inside the same shadow root", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    const list = byTestId("shadow-popup-host").shadowRoot?.querySelector<HTMLElement>("[role='listbox']")
    list?.focus()
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Escape" })
    await act(async () => {
      list?.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(composer()).not.toBeNull()
  })

  it("drops a pending composer focus once focus has gone back to the page", async () => {
    await mount(<Host composerLater />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("relay-option").focus()
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(byTestId("page"))
    await act(async () => byTestId("composer-ready").click())
    expect(composer()).not.toBeNull()
    expect(document.activeElement).not.toBe(composer())
  })

  it("leaves Escape to a popup that closes itself without preventing it", async () => {
    await mount(<SelfClosingPopupHost />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    byTestId("self-closing").focus()
    expect(await press("Escape")).toBe(false)
    expect(composer()).not.toBeNull()
    expect(byTestId("self-closing").getAttribute("data-state")).toBe("closed")
  })

  it("returns to the same place after going back once and coming in again", async () => {
    await mount(<Host />)
    byTestId("page").focus()
    await press("j", { ctrlKey: true })
    await press("j", { ctrlKey: true })
    expect(document.activeElement).toBe(byTestId("page"))
    byTestId("relay-option").focus()
    await press("Escape")
    expect(document.activeElement).toBe(byTestId("page"))
  })

  it("keeps Escape working when the host's own surface owns the shortcut", async () => {
    await mount(<Host bound={false} />)
    await act(async () => launcher()?.click())
    composer()?.focus()
    expect(await press("Escape")).toBe(true)
    expect(composer()).toBeNull()
  })

  it("does nothing while the host's own surface owns the key", async () => {
    await mount(<Host bound={false} />)
    byTestId("page").focus()
    expect(await press("j", { ctrlKey: true })).toBe(false)
    expect(composer()).toBeNull()
  })
})
