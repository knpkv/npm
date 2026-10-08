// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { RelayLauncher, relayShortcut, useRelayShortcut } from "../../src/patterns/RelayLauncher.js"

const ctrlJ = relayShortcut(false)

const parse = (markup: string): Element => {
  const host = document.createElement("div")
  host.innerHTML = markup
  const element = host.firstElementChild
  if (element === null) throw new Error("RelayLauncher rendered nothing")
  return element
}

describe("RelayLauncher", () => {
  it("is a named button that reports whether Relay is open", () => {
    const closed = parse(renderToStaticMarkup(<RelayLauncher expanded={false} shortcut={ctrlJ} />))
    expect(closed.tagName).toBe("BUTTON")
    expect(closed.getAttribute("type")).toBe("button")
    expect(closed.getAttribute("aria-expanded")).toBe("false")
    expect(closed.textContent).toContain("Relay")
    expect(parse(renderToStaticMarkup(<RelayLauncher expanded shortcut={ctrlJ} />)).getAttribute("aria-expanded")).toBe(
      "true"
    )
  })

  it("advertises the bound shortcut once: aria-keyshortcuts for assistive technology, a hidden hint for sight", () => {
    // useRelayShortcut's server snapshot is the non-Apple form; the browser switches to ⌘ after hydration.
    const Host = () => <RelayLauncher expanded={false} shortcut={useRelayShortcut()} />
    const button = parse(renderToStaticMarkup(createElement(Host)))
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+J")
    const hint = button.querySelector("kbd")
    expect(hint?.textContent).toBe("Ctrl J")
    expect(hint?.getAttribute("aria-hidden")).toBe("true")
    expect(relayShortcut(true)).toEqual({ hint: "⌘J", keys: "Meta+J" })
  })

  it("drops the shortcut where the host does not bind it", () => {
    const button = parse(renderToStaticMarkup(<RelayLauncher expanded={false} shortcut={null} />))
    expect(button.getAttribute("aria-keyshortcuts")).toBeNull()
    expect(button.querySelector("kbd")).toBeNull()
  })

  it("requires a visible label", () => {
    expect(() => renderToStaticMarkup(<RelayLauncher expanded={false} label="" shortcut={ctrlJ} />)).toThrow(
      /visible text/
    )
    expect(
      parse(renderToStaticMarkup(<RelayLauncher expanded={false} label="Ask Relay" shortcut={null} />)).textContent
    ).toContain("Ask Relay")
  })

  it("requires the shortcut's ARIA keys, so a blank value cannot silently drop aria-keyshortcuts", () => {
    expect(() =>
      renderToStaticMarkup(<RelayLauncher expanded={false} shortcut={{ hint: "Ctrl J", keys: " " }} />)
    ).toThrow(/shortcut keys/)
  })
})
