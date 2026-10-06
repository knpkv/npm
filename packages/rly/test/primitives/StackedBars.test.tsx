// @vitest-environment happy-dom

import { act, createRef, type ReactElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type RlyChartColumn,
  type RlyChartSelection,
  StackedBars,
  type StackedBarsProps
} from "../../src/primitives/StackedBars.js"
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

// A ResizeObserver whose width the test sets, so rebinning runs on the natural measurement path.
const observers: Array<{ readonly callback: ResizeObserverCallback; readonly target: Element }> = []
class TestResizeObserver {
  readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element): void {
    observers.push({ callback: this.callback, target })
  }
  unobserve(): void {}
  disconnect(): void {
    const index = observers.findIndex((observer) => observer.callback === this.callback)
    if (index >= 0) observers.splice(index, 1)
  }
}
const resizeTo = async (width: number): Promise<void> => {
  await act(async () => {
    for (const { callback, target } of observers) {
      const entry: ResizeObserverEntry = {
        borderBoxSize: [],
        contentBoxSize: [],
        contentRect: new DOMRectReadOnly(0, 0, width, 100),
        devicePixelContentBoxSize: [],
        target
      }
      callback([entry], new TestResizeObserver(callback))
    }
  })
}

const roots: Array<Root> = []
const mount = async (element: ReactElement): Promise<HTMLElement> => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(element))
  return container
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const hours = (count: number): ReadonlyArray<RlyChartColumn> =>
  Array.from({ length: count }, (_, index) => ({
    end: (index + 1) * hour,
    segments: [{ id: "a", series: 1, value: 1 }],
    start: index * hour
  }))
const numeric = (element: Element | null | undefined, name: string): number => Number(element?.getAttribute(name))

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

  it("draws the selection once over its columns, behind the bars", () => {
    const root = render({ selection: { from: 2, to: 3 } })
    const selection = root.querySelector('[data-part="selection"]')
    // Columns 2–3 of six hours, on the 0–1000 time scale.
    expect(numeric(selection, "x")).toBeCloseTo(1000 / 3)
    expect(numeric(selection, "width")).toBeCloseTo(1000 / 3)
    const bars = root.querySelector("svg:not([class*='band'])")
    expect(bars?.firstElementChild).toBe(selection)
    expect(render().querySelector('[data-part="selection"]')).toBeNull()
  })

  it("shades a window across the band and the bars and names it under the axis", () => {
    const root = render({
      bands: [{ id: "5h", label: "5-hour window", segments: [{ from: 0, level: 40, to: 6 * hour }] }],
      window: { from: 3 * hour, label: "Current 5-hour window, resets 06:00", to: 6 * hour }
    })
    const [band, bars] = root.querySelectorAll('[data-part="window"]')
    expect(band?.getAttribute("x")).toBe("500")
    expect(band?.getAttribute("width")).toBe("500")
    // The bars share the band's time scale, so the shading lines up exactly.
    expect(bars?.getAttribute("x")).toBe("500")
    expect(bars?.getAttribute("width")).toBe("500")
    // Its edges are drawn again over the bars, where a narrow window would otherwise hide.
    const edge = root.querySelector('[data-part="window-edge"]')
    expect(edge?.parentElement?.lastElementChild).toBe(edge)
    expect(edge?.getAttribute("x")).toBe("500")
    expect(root.textContent).toContain("Current 5-hour window, resets 06:00")
    expect(() => render({ window: { from: 0, label: " ", to: hour } })).toThrow("visible text")
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

  it("draws a folded final bin on the same time scale as the window over its last hour", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    // 25 hourly columns at 100px bin in pairs; the odd last hour joins the bin before it.
    const root = await mount(
      <StackedBars {...props} columns={hours(25)} window={{ from: 24 * hour, label: "Last hour", to: 25 * hour }} />
    )
    await resizeTo(100)
    const bars = root.querySelector("svg:not([class*='band'])")
    const last = bars?.querySelectorAll("[class*='hit']")
    const final = last?.[last.length - 1]
    const window = bars?.querySelector('[data-part="window"]')
    expect(last).toHaveLength(12)
    // The last bar spans hours 22–24 and ends exactly where the window over hour 24 ends.
    expect(numeric(final, "width")).toBeCloseTo((numeric(last?.[0], "width") * 3) / 2)
    expect(numeric(final, "x") + numeric(final, "width")).toBeCloseTo(numeric(window, "x") + numeric(window, "width"))
    expect(numeric(window, "x")).toBeGreaterThan(numeric(final, "x"))
  })

  it("keeps a controlled selection visible when a resize rebins it", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const selection: RlyChartSelection = { from: 2, to: 3 }
    const root = await mount(<StackedBars {...props} columns={hours(30)} selection={selection} />)
    await resizeTo(720)
    const wide = root.querySelector('[data-part="selection"]')
    const before = { width: numeric(wide, "width"), x: numeric(wide, "x") }
    // At 80px the 30 columns bin in threes, so no bin lies wholly inside columns 2–3.
    await resizeTo(80)
    const narrow = root.querySelector('[data-part="selection"]')
    expect({ width: numeric(narrow, "width"), x: numeric(narrow, "x") }).toEqual(before)
    expect(root.querySelectorAll('[data-selected="true"]').length).toBeGreaterThan(0)
  })

  it("hands the root to the caller's object and callback refs, and releases them on unmount", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const object = createRef<HTMLDivElement>()
    const seen: Array<HTMLDivElement | null> = []
    await mount(<StackedBars {...props} ref={object} />)
    await mount(<StackedBars {...props} ref={(element) => void seen.push(element)} />)
    // A React 19 callback ref that returns a cleanup gets that cleanup instead of a null call.
    const cleanups: Array<string> = []
    const attached: Array<HTMLDivElement | null> = []
    await mount(
      <StackedBars
        {...props}
        ref={(element) => {
          attached.push(element)
          return () => void cleanups.push("released")
        }}
      />
    )
    expect(object.current?.querySelector('[role="group"]')).not.toBeNull()
    expect(seen[0]?.querySelector('[role="group"]')).not.toBeNull()
    for (const root of roots.splice(0)) await act(async () => root.unmount())
    expect(object.current).toBeNull()
    expect(seen.at(-1)).toBeNull()
    expect(cleanups).toEqual(["released"])
    expect(attached).toHaveLength(1)
  })

  it("moves the keyboard cursor from the last clicked bar and keeps it on its column across a rebin", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
    const Owner = (): ReactElement => {
      const [selection, setSelection] = useState<RlyChartSelection | null>(null)
      return (
        <StackedBars
          {...props}
          columns={hours(30)}
          onSelectionChange={(next) => {
            onSelectionChange(next)
            setSelection(next)
          }}
          selection={selection}
        />
      )
    }
    const root = await mount(<Owner />)
    await resizeTo(720)
    const plot = root.querySelector('[role="group"]')
    const press = (key: string): void =>
      act(() => void plot?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })))
    const bar = (index: number): Element | undefined => root.querySelectorAll("svg:not([class*='band']) g")[index]
    press("Home")
    act(() => void bar(3)?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    press("ArrowRight")
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 4, to: 4 })
    press("ArrowRight")
    // At 80px the columns bin in threes; the cursor on column 5 is now bin 1 (columns 3–5).
    await resizeTo(80)
    press("ArrowRight")
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 6, to: 8 })
  })

  it("leaves Home, End and the arrows to the browser when there is nothing to move to", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
    const empty = await mount(<StackedBars {...props} columns={[]} onSelectionChange={onSelectionChange} />)
    const filled = await mount(<StackedBars {...props} onSelectionChange={onSelectionChange} />)
    const press = (container: HTMLElement, key: string): boolean => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
      act(() => void container.querySelector('[role="group"]')?.dispatchEvent(event))
      return event.defaultPrevented
    }
    for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"]) expect(press(empty, key)).toBe(false)
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(press(filled, "Home")).toBe(true)
    expect(onSelectionChange).toHaveBeenCalledWith({ from: 0, to: 0 })
  })

  it("replaces the selection on each mouse click and extends only on Shift or a second touch tap", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
    // Owns the selection like a real caller, so an extension grows what the last click chose.
    const Owner = (): ReactElement => {
      const [selection, setSelection] = useState<RlyChartSelection | null>(null)
      return (
        <StackedBars
          {...props}
          onSelectionChange={(next) => {
            onSelectionChange(next)
            setSelection(next)
          }}
          selection={selection}
        />
      )
    }
    const root = await mount(<Owner />)
    const bar = (index: number): Element | undefined => root.querySelectorAll("svg:not([class*='band']) g")[index]
    const tap = (index: number, pointerType: string, shiftKey = false): void =>
      act(() => {
        bar(index)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }))
        bar(index)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }))
      })
    tap(0, "mouse")
    tap(2, "mouse")
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 2, to: 2 })
    tap(4, "mouse", true)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 2, to: 4 })
    tap(1, "touch")
    tap(3, "touch")
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 1, to: 3 })
  })
})
