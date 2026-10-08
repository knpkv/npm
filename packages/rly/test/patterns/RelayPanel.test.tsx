// @vitest-environment happy-dom

import { act, type ReactElement, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { RelayPanel, type RlyRelayPanelPresentation, useRelayPresentation } from "../../src/patterns/RelayPanel.js"

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const scope = { label: "infra-core #12", revision: "bbbbbbb" }

/** A host with a launcher and the panel, which it unmounts when the panel asks to close. */
const Host = ({
  pinnable = false,
  presentation = "overlay"
}: {
  readonly pinnable?: boolean
  readonly presentation?: RlyRelayPanelPresentation
}): ReactElement => {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState("conversation")
  const [pinned, setPinned] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  return (
    <PortalProvider>
      <button data-testid="launcher" ref={launcher} type="button">
        Relay
      </button>
      {open ? (
        <RelayPanel
          footer={<textarea aria-label="Message Relay" />}
          freshness="Current head. Reads freely, asks before writes."
          launcher={launcher}
          onClose={() => setOpen(false)}
          onTabChange={setTab}
          presentation={presentation}
          scope={scope}
          selectedTab={tab}
          tabs={[
            { content: <p>Conversation body</p>, label: "Conversation", value: "conversation" },
            {
              content: (
                <>
                  <div data-state="open" data-testid="popup" role="listbox" tabIndex={-1}>
                    Suggestions
                  </div>
                  <div
                    data-state="open"
                    data-testid="self-closing"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") event.currentTarget.setAttribute("data-state", "closed")
                    }}
                    role="menu"
                    tabIndex={-1}
                  >
                    Menu
                  </div>
                </>
              ),
              count: 3,
              label: "Findings",
              value: "findings"
            }
          ]}
          {...(pinnable ? { pin: { onPinnedChange: setPinned, pinned } } : {})}
        />
      ) : null}
    </PortalProvider>
  )
}

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

const panel = (): HTMLElement | null => document.querySelector("[data-rly-relay-panel]")
const byTestId = (id: string): HTMLElement | null => document.querySelector(`[data-testid='${id}']`)
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name
  )

const press = async (target: Element | null, key: string, init: KeyboardEventInit = {}): Promise<boolean> => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key, ...init })
  await act(async () => {
    target?.dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe("RelayPanel", () => {
  it("is a labelled complementary region over the page, with no backdrop and no modal state", async () => {
    await mount(<Host />)
    const region = panel()
    expect(region?.tagName).toBe("ASIDE")
    expect(region?.getAttribute("aria-modal")).toBeNull()
    const title = document.getElementById(region?.getAttribute("aria-labelledby") ?? "")
    expect(title?.textContent).toBe("Relay")
    // The title names the region without adding a heading to the page outline.
    expect(title?.tagName).toBe("P")
    expect(region?.textContent).toContain("infra-core #12 at bbbbbbb")
    expect(region?.hasAttribute("data-rly-relay-surface")).toBe(true)
  })

  it("names a tab's count in its accessible name and switches views", async () => {
    await mount(<Host />)
    const findings = [...document.querySelectorAll("[role='tab']")].find((tab) => tab.textContent === "Findings 3")
    expect(findings).toBeDefined()
    expect(document.body.textContent).toContain("Conversation body")
  })

  it("closes on Escape and the close button, returning focus to the launcher", async () => {
    await mount(<Host />)
    button("Close Relay")?.focus()
    expect(await press(document.activeElement, "Escape")).toBe(true)
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(byTestId("launcher"))

    await act(async () => root?.render(<Host key="again" />))
    await act(async () => button("Close Relay")?.click())
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(byTestId("launcher"))
  })

  it("leaves Escape to an IME composition and to open popups inside, even one that closes itself", async () => {
    await mount(<Host />)
    expect(await press(panel(), "Escape", { isComposing: true })).toBe(false)
    expect(panel()).not.toBeNull()
    const findings = [...document.querySelectorAll<HTMLElement>("[role='tab']")].find(
      (tab) => tab.textContent === "Findings 3"
    )
    await act(async () => {
      findings?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      findings?.focus()
    })
    await act(async () => findings?.click())
    const popup = byTestId("popup")
    expect(popup).not.toBeNull()
    expect(await press(popup, "Escape")).toBe(false)
    expect(panel()).not.toBeNull()
    expect(await press(byTestId("self-closing"), "Escape")).toBe(false)
    expect(panel()).not.toBeNull()
    expect(byTestId("self-closing")?.getAttribute("data-state")).toBe("closed")
  })

  it("offers the pin only when the host passes it, as a pressed toggle", async () => {
    await mount(<Host />)
    expect(button("Pin beside the page")).toBeUndefined()
    await act(async () => root?.render(<Host pinnable />))
    const pin = button("Pin beside the page")
    expect(pin?.getAttribute("aria-pressed")).toBe("false")
    await act(async () => pin?.click())
    expect(button("Unpin")?.getAttribute("aria-pressed")).toBe("true")
  })

  it("is a modal dialog full screen, closing on Escape back to the launcher", async () => {
    await mount(<Host presentation="fullscreen" />)
    const dialog = document.querySelector("[role='dialog'][data-rly-relay-panel='fullscreen']")
    expect(dialog).not.toBeNull()
    expect(dialog?.hasAttribute("data-rly-relay-surface")).toBe(true)
    await press(dialog, "Escape")
    // Radix hands focus back from a timer once the dialog has unmounted and released the page.
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(document.querySelector("[data-rly-relay-panel]")).toBeNull()
    expect(document.activeElement).toBe(byTestId("launcher"))
  })

  it("renders a single body without tabs, and refuses a blank scope", () => {
    const launcher = { current: null }
    const markup = renderToStaticMarkup(
      <RelayPanel launcher={launcher} onClose={() => undefined} presentation="pinned" scope={{ label: "Settings" }}>
        <p>Choose an agent</p>
      </RelayPanel>
    )
    expect(markup).toContain("Choose an agent")
    expect(markup).not.toContain('role="tablist"')
    expect(markup).toContain('data-rly-relay-panel="pinned"')
    expect(() =>
      renderToStaticMarkup(
        <RelayPanel launcher={launcher} onClose={() => undefined} presentation="overlay" scope={{ label: " " }}>
          <p />
        </RelayPanel>
      )
    ).toThrow(/visible text/)
  })
})

describe("useRelayPresentation", () => {
  const Probe = ({ minHostWidth, pinned }: { readonly minHostWidth: number; readonly pinned: boolean }) => {
    const { canPin, presentation } = useRelayPresentation({ minHostWidth, pinned })
    return <output data-can-pin={String(canPin)}>{presentation}</output>
  }
  const viewport = (width: number): void => {
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width: (\d+)px/.exec(query)
      const min = /min-width: (\d+)px/.exec(query)
      const matches = max !== null ? width <= Number(max[1]) : min !== null ? width >= Number(min[1]) : false
      return { addEventListener: () => undefined, matches, media: query, removeEventListener: () => undefined }
    })
  }
  const read = async (width: number, pinned: boolean, minHostWidth = 960): Promise<string> => {
    viewport(width)
    await mount(<Probe minHostWidth={minHostWidth} pinned={pinned} />)
    const output = document.querySelector("output")
    const result = `${output?.textContent} canPin=${output?.getAttribute("data-can-pin")}`
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
    return result
  }

  it("goes full screen at 640 and narrower, pins only when pinned and wide enough", async () => {
    expect(await read(390, true)).toBe("fullscreen canPin=false")
    expect(await read(640, false)).toBe("fullscreen canPin=false")
    expect(await read(1280, true)).toBe("overlay canPin=false")
    expect(await read(1440, false)).toBe("overlay canPin=true")
    expect(await read(1440, true)).toBe("pinned canPin=true")
    // The host's own minimum beside the 440px column can push the threshold past 1440.
    expect(await read(1440, true, 1100)).toBe("overlay canPin=false")
  })
})
