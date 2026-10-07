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
  formatTick: (at) => `${at / hour}h`,
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

  // ui-b B2: full-width bars covered the selection's edges, so a tall selected bar showed almost none of it.
  it("outlines the selection again above every bar, over the same columns", () => {
    const root = render({ selection: { from: 2, to: 3 } })
    const edge = root.querySelector('[data-part="selection-edge"]')
    const bars = root.querySelector("[data-bin]")?.parentElement
    // The halo sits between the last bar and the edge, so the edge reads on bars of any colour.
    expect(edge?.previousElementSibling).toBe(root.querySelector('[data-part="selection-halo"]'))
    expect(edge?.previousElementSibling?.previousElementSibling).toBe(bars)
    expect(numeric(edge, "x")).toBeCloseTo(1000 / 3)
    expect(numeric(edge, "width")).toBeCloseTo(1000 / 3)
  })

  // ui-b S2: each bin's ring was painted over by the next bar, so it showed 2px on one side and 1px on the other.
  // ui-b V4: the last bin's ring merged with the plot's own outline into one thick edge.
  it("draws one focus ring above every bar, inside the focused bin", async () => {
    const root = await mount(<StackedBars {...props} />)
    const plot = root.querySelector('[role="group"]')
    expect(root.querySelector('[data-part="focus-ring"]')).toBeNull()
    act(() => void plot?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" })))
    const rings = root.querySelectorAll('[data-part="focus-ring"]')
    expect(rings).toHaveLength(1)
    const ring = rings[0]
    expect(ring?.nextElementSibling).toBeNull()
    // Inside its bin by half the 2px stroke (720px wide: 1000/720 units), so it never meets the plot outline.
    expect(numeric(ring, "x")).toBeCloseTo(1000 / 720)
    expect(numeric(ring, "width")).toBeCloseTo(1000 / 6 - 2000 / 720)
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
      noReadingLabel: "No reading",
      bands: [
        {
          id: "5h",
          label: "5-hour window",
          near: { label: "Near the limit, 80%", level: 80 },
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

  it("names every band mark in the visible key, and requires no-reading copy when a band has a gap", () => {
    const band = {
      id: "5h",
      label: "5-hour window",
      near: { label: "Near the limit, 80%", level: 80 },
      segments: [
        { from: 0, level: 40, to: 3 * hour },
        { from: 3 * hour, level: null, to: 6 * hour }
      ]
    }
    const keys = [...render({ bands: [band], noReadingLabel: "No reading" }).querySelectorAll("li")]
    expect(keys.map((item) => item.textContent)).toEqual(["Near the limit, 80%", "No reading"])
    expect(() => render({ bands: [band] })).toThrow("noReadingLabel")
    expect(() =>
      render({ bands: [{ ...band, near: { label: " ", level: 80 } }], noReadingLabel: "No reading" })
    ).toThrow("visible text")
  })

  it("ends the axis on an end-anchored tick", () => {
    const ticks = [...render().querySelectorAll("[data-anchor]")]
    expect(ticks.at(-1)?.getAttribute("data-anchor")).toBe("end")
    expect(ticks.at(-1)?.textContent).toBe("6h")
  })

  it("draws a folded final bin on the same time scale as the window over its last hour", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    // 25 hourly columns at 400px bin in pairs; the odd last hour joins the bin before it.
    const root = await mount(
      <StackedBars {...props} columns={hours(25)} window={{ from: 24 * hour, label: "Last hour", to: 25 * hour }} />
    )
    await resizeTo(400)
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
    // At 240px the 30 columns bin in threes, so no bin lies wholly inside columns 2–3.
    await resizeTo(240)
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
    const bar = (index: number): Element | undefined => root.querySelectorAll("[data-bin]")[index]
    press("Home")
    act(() => void bar(3)?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    press("ArrowRight")
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 4, to: 4 })
    press("ArrowRight")
    // At 240px the columns bin in threes; the cursor on column 5 is now bin 1 (columns 3–5).
    await resizeTo(240)
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
    const bar = (index: number): Element | undefined => root.querySelectorAll("[data-bin]")[index]
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

  it("keeps the window's edge over a full or unknown band stretch", () => {
    const root = render({
      noReadingLabel: "No reading",
      bands: [
        {
          id: "5h",
          label: "5-hour window",
          segments: [
            { from: 0, level: 100, to: 3 * hour },
            { from: 3 * hour, level: null, to: 6 * hour }
          ]
        }
      ],
      window: { from: 2 * hour, label: "Current window", to: 4 * hour }
    })
    const band = root.querySelector('[data-band="5h"] svg')
    expect(band?.lastElementChild?.getAttribute("data-part")).toBe("window-edge")
  })

  it("captions the scale with a rate per bin, so a folded last bin is not read as a bigger total", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const formatScale = vi.fn((max: number, size: number) => `${max} per ${size}`)
    // 25 hourly columns of 1 at 400px bin in pairs; the last bin folds three hours (total 3).
    await mount(<StackedBars {...props} columns={hours(25)} formatScale={formatScale} />)
    await resizeTo(400)
    expect(formatScale).toHaveBeenLastCalledWith(2, 2)
  })

  it("starts a fresh touch gesture after the selection clears, by Escape or by its owner", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
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
    const bar = (index: number): Element | undefined => root.querySelectorAll("[data-bin]")[index]
    const tap = (index: number): void =>
      act(() => {
        bar(index)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }))
        bar(index)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
    tap(1)
    act(
      () =>
        void root
          .querySelector('[role="group"]')
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }))
    )
    tap(3)
    tap(5)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 3, to: 5 })
  })

  it("keeps time labels under their bars in right-to-left text, on the SVG's physical axis", () => {
    const root = render({ dir: "rtl" })
    const first = root.querySelector('[data-anchor="start"]')
    expect(first?.getAttribute("style")).toContain("left:")
    expect(first?.getAttribute("style")).not.toContain("inset-inline")
    expect(root.querySelector('[data-anchor="end"]')?.getAttribute("style")).toContain("right:")
  })

  it("extends a touch span across a rebin, comparing the first tap's column, not its old bar index", async () => {
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
    const tap = (index: number): void =>
      act(() => {
        const bar = root.querySelectorAll("[data-bin]")[index]
        bar?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }))
        bar?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
    tap(1)
    // At 240px bar 1 holds columns 3–5: a different instant from the first tap's column 1.
    await resizeTo(240)
    tap(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 1, to: 5 })
  })

  it("starts a fresh touch span after the keyboard moves the selection", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
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
    const bar = (index: number): Element | undefined => root.querySelectorAll("[data-bin]")[index]
    const tap = (index: number): void =>
      act(() => {
        bar(index)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }))
        bar(index)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
    tap(1)
    act(
      () =>
        void root
          .querySelector('[role="group"]')
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }))
    )
    tap(4)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 4, to: 4 })
  })

  it("never draws the plot under a 24px pointer target, whatever height it is given", () => {
    const plot = (height: number) => render({ height }).querySelector<HTMLElement>('[role="group"]')
    expect(plot(10)?.style.blockSize).toBe("24px")
    expect(plot(24)?.style.blockSize).toBe("24px")
    expect(plot(180)?.style.blockSize).toBe("180px")
  })

  it("keeps list semantics on its markerless key", () => {
    const root = render({ window: { from: 0, label: "Current window", to: hour } })
    expect(root.querySelector("ul")?.getAttribute("role")).toBe("list")
  })

  /** The chart under an owner that keeps the selection, with the polite region and a key press. */
  const announcing = async (columnsFor: (tick: number) => ReadonlyArray<RlyChartColumn> = () => columns) => {
    let rerender: (tick: number) => void = () => undefined
    const Owner = (): ReactElement => {
      const [selection, setSelection] = useState<RlyChartSelection | null>({ from: 2, to: 2 })
      const [tick, setTick] = useState(0)
      rerender = setTick
      return (
        <StackedBars
          {...props}
          columns={columnsFor(tick)}
          data-tick={tick}
          // A fresh formatter on every render, as an inline callback would be.
          describeSelection={(next) => (next === null ? "None" : `Columns ${next.from}–${next.to}`)}
          onSelectionChange={setSelection}
          selection={selection}
        />
      )
    }
    const root = await mount(<Owner />)
    const plot = root.querySelector('[role="group"]')
    return {
      press: (key: string) =>
        act(() => void plot?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }))),
      region: () => root.querySelector('[aria-live="polite"]')?.textContent,
      rerender: (tick: number) => act(() => rerender(tick))
    }
  }

  it("announces a return to the last announced selection again", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    vi.useFakeTimers()
    try {
      const chart = await announcing()
      chart.press("ArrowRight")
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("Columns 3–3")
      chart.press("ArrowLeft")
      // Moving away empties the region, so the same words coming back are a change it announces.
      expect(chart.region()).toBe("")
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("Columns 2–2")
      chart.press("ArrowRight")
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("Columns 3–3")
    } finally {
      vi.useRealTimers()
    }
  })

  // ui-b S4: the region announced on mount, and again on every data poll under an unchanged selection.
  it("announces only selections the user made, not the first render or a data refresh", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    vi.useFakeTimers()
    try {
      // Each tick is a poll that brings new values for the same periods.
      const chart = await announcing((tick) =>
        columns.map((column) => ({
          ...column,
          segments: column.segments.map((segment) => ({ ...segment, value: segment.value + tick }))
        }))
      )
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("")
      chart.rerender(1)
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("")
      chart.press("ArrowRight")
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("Columns 3–3")
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts a fresh touch span when the owner replaces the selection after the first tap", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const view = (selection: RlyChartSelection | null) => (
      <StackedBars {...props} onSelectionChange={onSelectionChange} selection={selection} />
    )
    await act(async () => root.render(view(null)))
    const bar = (index: number): Element | undefined => container.querySelectorAll("[data-bin]")[index]
    const tap = (index: number): void =>
      act(() => {
        bar(index)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }))
        bar(index)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
    tap(1)
    // The owner swaps in a disjoint range; the first tap no longer anchors anything.
    await act(async () => root.render(view({ from: 4, to: 5 })))
    tap(2)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 2, to: 2 })
  })

  it("moves the keyboard from the owner's replacement selection, not the last click", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    const onSelectionChange = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const view = (selection: RlyChartSelection | null) => (
      <StackedBars {...props} onSelectionChange={onSelectionChange} selection={selection} />
    )
    await act(async () => root.render(view(null)))
    act(
      () => void container.querySelectorAll("[data-bin]")[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    )
    await act(async () => root.render(view({ from: 4, to: 4 })))
    act(
      () =>
        void container
          .querySelector('[role="group"]')
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }))
    )
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from: 5, to: 5 })
  })

  it("draws band levels as finite percentages and rejects a non-finite near mark", () => {
    const band = (near: number, level: number) => ({
      id: "5h",
      label: "5-hour window",
      near: { label: "Near the limit", level: near },
      segments: [{ from: 0, level, to: 6 * hour }]
    })
    const line = (near: number) => render({ bands: [band(near, 40)] }).querySelector("[data-band] line")
    expect(line(80)?.getAttribute("y1")).toBe("20")
    expect(line(150)?.getAttribute("y1")).toBe("0")
    expect(line(-10)?.getAttribute("y1")).toBe("100")
    expect(() => render({ bands: [band(Number.NaN, 40)] })).toThrow("finite")
    // A non-finite reading is no reading, so the key must name it.
    expect(() => render({ bands: [band(80, Number.NaN)] })).toThrow("noReadingLabel")
    const unread = render({ bands: [band(80, Number.POSITIVE_INFINITY)], noReadingLabel: "No reading" })
    expect(unread.querySelector("[data-band] [class*='unknown']")).not.toBeNull()
  })

  it("announces a settled selection even while its owner keeps re-rendering", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
    vi.useFakeTimers()
    try {
      const chart = await announcing()
      chart.press("ArrowRight")
      for (let tick = 1; tick <= 6; tick += 1) {
        await act(async () => vi.advanceTimersByTime(200))
        chart.rerender(tick)
      }
      await act(async () => vi.advanceTimersByTime(600))
      expect(chart.region()).toBe("Columns 3–3")
    } finally {
      vi.useRealTimers()
    }
  })
})
