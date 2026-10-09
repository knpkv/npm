// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RelayLauncher, relayShortcut } from "../../src/patterns/RelayLauncher.js"
import {
  RelayMark,
  RLY_RELAY_MARK_ACTIVITIES,
  RLY_RELAY_MARK_SIZES,
  RLY_RELAY_MARK_TILE_SIZES
} from "../../src/patterns/RelayMark.js"

const parse = (markup: string): Element => {
  const host = document.createElement("div")
  host.innerHTML = markup
  const element = host.firstElementChild
  if (element === null) throw new Error("RelayMark rendered nothing")
  return element
}

describe("RelayMark", () => {
  it("draws the baton (two hooks and the stroke between them) in the current colour at each size", () => {
    for (const size of RLY_RELAY_MARK_SIZES) {
      const svg = parse(renderToStaticMarkup(<RelayMark size={size} />))
      expect(svg.getAttribute("width")).toBe(String(size))
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24")
      expect(svg.getAttribute("stroke")).toBe("currentColor")
      expect(svg.getAttribute("stroke-width")).toBe("2.75")
      expect(svg.querySelectorAll("path")).toHaveLength(3)
    }
  })

  it("is decorative unless labelled, and a labelled mark is a named image", () => {
    const decorative = parse(renderToStaticMarkup(<RelayMark />))
    expect(decorative.getAttribute("aria-hidden")).toBe("true")
    expect(decorative.getAttribute("role")).toBeNull()
    const named = parse(renderToStaticMarkup(<RelayMark label="Relay" />))
    expect(named.getAttribute("role")).toBe("img")
    expect(named.getAttribute("aria-label")).toBe("Relay")
    expect(named.getAttribute("aria-hidden")).toBeNull()
    expect(() => renderToStaticMarkup(<RelayMark label=" " />)).toThrow(/visible text/)
    // Native naming is honoured, not overwritten by the decorative default.
    const native = parse(renderToStaticMarkup(<RelayMark aria-label="Relay" />))
    expect(native.getAttribute("aria-label")).toBe("Relay")
    expect(native.getAttribute("aria-hidden")).toBeNull()
    expect(native.getAttribute("role")).toBe("img")
    const referenced = parse(renderToStaticMarkup(<RelayMark.Tile aria-labelledby="relay-name" />))
    expect(referenced.getAttribute("aria-labelledby")).toBe("relay-name")
    expect(referenced.getAttribute("aria-hidden")).toBeNull()
    expect(referenced.getAttribute("role")).toBe("img")
    expect(() => renderToStaticMarkup(<RelayMark aria-label=" " />)).toThrow(/visible text/)
    expect(() => renderToStaticMarkup(<RelayMark.Tile aria-labelledby="" />)).toThrow(/visible text/)
  })

  it("sets a half-size glyph on the tile", () => {
    for (const size of RLY_RELAY_MARK_TILE_SIZES) {
      const tile = parse(renderToStaticMarkup(<RelayMark.Tile size={size} />))
      expect(tile.getAttribute("data-size")).toBe(String(size))
      expect(tile.querySelector("svg")?.getAttribute("width")).toBe(String(size / 2))
    }
    expect(parse(renderToStaticMarkup(<RelayMark.Tile label="Relay" />)).getAttribute("role")).toBe("img")
  })

  // The stylesheet keys every movement off these attributes; an idle mark carries no entrance.
  it("marks its activity on the glyph, idle and without an entrance unless given", () => {
    const still = parse(renderToStaticMarkup(<RelayMark />))
    expect(still.getAttribute("data-rly-relay-activity")).toBe("idle")
    expect(still.hasAttribute("data-rly-relay-entrance")).toBe(false)
    for (const activity of RLY_RELAY_MARK_ACTIVITIES) {
      expect(
        parse(renderToStaticMarkup(<RelayMark activity={activity} />)).getAttribute("data-rly-relay-activity")
      ).toBe(activity)
      const glyph = parse(renderToStaticMarkup(<RelayMark.Tile activity={activity} entrance />)).querySelector("svg")
      expect(glyph?.getAttribute("data-rly-relay-activity")).toBe(activity)
      expect(glyph?.hasAttribute("data-rly-relay-entrance")).toBe(true)
    }
    // Only the baton and the two hooks move, each by its own class.
    expect(still.querySelectorAll("path[class]")).toHaveLength(3)
  })

  it("shows the launcher's activity on its mark", () => {
    const launcher = parse(
      renderToStaticMarkup(<RelayLauncher activity="working" expanded={false} shortcut={relayShortcut(false)} />)
    )
    expect(launcher.querySelector("svg")?.getAttribute("data-rly-relay-activity")).toBe("working")
    expect(launcher.hasAttribute("activity")).toBe(false)
  })
})
