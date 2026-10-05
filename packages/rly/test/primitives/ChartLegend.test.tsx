// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { describe, expect, it } from "vitest"
import { ChartLegend, rlySeriesColor } from "../../src/primitives/ChartLegend.js"
import { render as renderRoot } from "./render.js"

const render = (element: ReactElement): HTMLElement => {
  const root = renderRoot(element)
  if (root === null) throw new Error("ChartLegend rendered nothing")
  return root
}

describe("ChartLegend", () => {
  it("maps a series to its token", () => {
    expect(rlySeriesColor(1)).toBe("var(--rly-color-series-1)")
    expect(rlySeriesColor("other")).toBe("var(--rly-color-series-other)")
  })

  it("puts each swatch before its label and keeps the caller's order", () => {
    const root = render(
      <ChartLegend
        items={[
          { id: "a", label: "RLY-142", series: 1 },
          { id: "b", label: "RLY-150", series: 2 },
          { id: "rest", label: "Other (3)", series: "other" }
        ]}
        label="Bookings by colour"
      />
    )
    expect(root.tagName).toBe("UL")
    expect(root.getAttribute("aria-label")).toBe("Bookings by colour")
    const items = [...root.querySelectorAll("li")]
    expect(items.map((item) => item.textContent)).toEqual(["RLY-142", "RLY-150", "Other (3)"])
    const swatches = items.map((item) => item.firstElementChild)
    expect(swatches.map((swatch) => swatch?.getAttribute("data-series"))).toEqual(["1", "2", "other"])
    expect(swatches.every((swatch) => swatch?.getAttribute("aria-hidden") === "true")).toBe(true)
  })

  it("renders nothing for no series, and refuses a blank label", () => {
    expect(renderToStaticMarkup(<ChartLegend items={[]} label="Bookings" />)).toBe("")
    expect(() => render(<ChartLegend items={[{ id: "a", label: "", series: 1 }]} label="Bookings" />)).toThrow()
  })
})
