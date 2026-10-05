// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { type RlyChartColumn, StackedBars, type StackedBarsProps } from "../../src/primitives/StackedBars.js"
import { render as renderRoot } from "./render.js"

const hour = 3_600_000
const columns: ReadonlyArray<RlyChartColumn> = Array.from({ length: 6 }, (_, index) => ({
  end: (index + 1) * hour,
  segments: [
    { id: "a", series: 1, value: index + 1 },
    { id: "b", series: 2, value: 1 }
  ],
  start: index * hour
}))

const props: StackedBarsProps = {
  columns,
  describeSelection: () => "",
  formatScale: (max) => `${max} per hour`,
  formatTick: (bin) => `${bin.first}h`,
  instructions: "Arrow keys move between bars.",
  label: "Spend by booking",
  onSelectionChange: () => undefined,
  selection: null
}

const render = (overrides: Partial<StackedBarsProps> = {}): HTMLElement => {
  const root = renderRoot(<StackedBars {...props} {...overrides} />)
  if (root === null) throw new Error("StackedBars rendered nothing")
  return root
}

describe("StackedBars", () => {
  it("is one labelled, described tab stop with a polite live region", () => {
    const root = render()
    const plot = root.querySelector('[role="group"]')
    expect(plot?.getAttribute("aria-label")).toBe("Spend by booking")
    expect(plot?.getAttribute("tabindex")).toBe("0")
    const described = plot?.getAttribute("aria-describedby") ?? ""
    expect(root.querySelector(`[id="${described}"]`)?.textContent).toBe("Arrow keys move between bars.")
    expect(root.querySelectorAll("[tabindex]")).toHaveLength(1)
    expect(root.querySelector('[aria-live="polite"]')).not.toBeNull()
    expect(root.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  })

  it("stacks each column's series and scales the tallest bin to the plot", () => {
    const root = render()
    expect(root.querySelectorAll('[data-series="1"]')).toHaveLength(6)
    expect(root.querySelectorAll('[data-series="2"]')).toHaveLength(6)
    expect(root.textContent).toContain("7 per hour")
  })

  it("marks the selected bins and nothing else", () => {
    const root = render({ selection: { from: 2, to: 3 } })
    expect(root.querySelectorAll('[data-selected="true"]')).toHaveLength(2)
  })

  it("draws limit bands on the same axis, with unknown stretches and the near mark", () => {
    const root = render({
      bands: [
        {
          id: "5h",
          label: "5-hour window",
          near: 80,
          segments: [
            { from: 0, level: 40, to: 3 * hour },
            { from: 3 * hour, level: null, to: 4 * hour },
            {
              from: 4 * hour,
              level: 92,
              to: 6 * hour
            }
          ]
        }
      ]
    })
    const band = root.querySelector('[data-band="5h"]')
    expect(band?.textContent).toContain("5-hour window")
    expect(band?.querySelectorAll("rect")).toHaveLength(3)
    expect(band?.querySelector('[data-tone="near"]')).not.toBeNull()
    expect(band?.querySelectorAll("line")).toHaveLength(1)
  })

  it("ends the axis on an end-anchored tick", () => {
    const ticks = [...render().querySelectorAll("[data-anchor]")]
    expect(ticks.at(-1)?.getAttribute("data-anchor")).toBe("end")
    expect(ticks.at(-1)?.textContent).toBe("5h")
  })
})
