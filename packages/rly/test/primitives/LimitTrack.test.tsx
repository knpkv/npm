// @vitest-environment happy-dom

import type { ReactElement } from "react"
import { describe, expect, it } from "vitest"
import { LimitTrack, limitTrackTone, RLY_LIMIT_TRACK_VARIANTS } from "../../src/primitives/LimitTrack.js"
import { render as renderRoot } from "./render.js"

const render = (element: ReactElement): HTMLElement => {
  const root = renderRoot(element)
  if (root === null) throw new Error("LimitTrack rendered nothing")
  return root
}

const part = (root: HTMLElement, name: string): HTMLElement | null => root.querySelector(`[data-part="${name}"]`)

describe("LimitTrack", () => {
  it("derives its tone from the reading and the near mark", () => {
    expect(limitTrackTone(null, 80)).toBe("unknown")
    expect(limitTrackTone(79.9, 80)).toBe("ok")
    expect(limitTrackTone(80, 80)).toBe("near")
    expect(limitTrackTone(100, 80)).toBe("full")
    expect(limitTrackTone(130, 80)).toBe("full")
    expect(limitTrackTone(60, 50)).toBe("near")
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(limitTrackTone(value, 80)).toBe("unknown")
    }
  })

  it("fills to the reading, clamped to the track, and marks the near threshold", () => {
    const root = render(<LimitTrack value={130} />)
    expect(root.dataset.tone).toBe("full")
    expect(part(root, "fill")?.style.inlineSize).toBe("100%")
    expect(part(root, "near")?.style.insetInlineStart).toBe("80%")
    expect(root.getAttribute("aria-hidden")).toBe("true")
    expect(root.className).toContain(RLY_LIMIT_TRACK_VARIANTS.size.default.className)
  })

  it("draws the projection from the reading to the projected level, never past the track", () => {
    const projected = render(<LimitTrack projected={140} value={62} />)
    expect(part(projected, "projection")?.style.insetInlineStart).toBe("62%")
    expect(part(projected, "projection")?.style.inlineSize).toBe("38%")
    expect(part(render(<LimitTrack projected={40} value={62} />), "projection")).toBeNull()
    expect(part(render(<LimitTrack projected={90} value={null} />), "projection")).toBeNull()
  })

  it("hatches a stale reading and draws no fill for an unknown one", () => {
    expect(render(<LimitTrack stale value={40} />).dataset.stale).toBe("true")
    expect(render(<LimitTrack value={40} />).dataset.stale).toBeUndefined()
    expect(part(render(<LimitTrack value={null} />), "fill")).toBeNull()
  })

  it("becomes a labelled meter only when asked, with the caller's words for its value", () => {
    const meter = render(<LimitTrack decorative={false} label="5-hour window" value={62} valueText="62% used" />)
    expect(meter.getAttribute("role")).toBe("meter")
    expect(meter.getAttribute("aria-label")).toBe("5-hour window")
    expect(meter.getAttribute("aria-valuemin")).toBe("0")
    expect(meter.getAttribute("aria-valuemax")).toBe("100")
    expect(meter.getAttribute("aria-valuenow")).toBe("62")
    expect(meter.getAttribute("aria-valuetext")).toBe("62% used")
    expect(meter.getAttribute("aria-hidden")).toBeNull()
    expect(() => render(<LimitTrack decorative={false} label=" " value={1} valueText="1%" />)).toThrow()
  })

  it("describes an unknown reading without claiming a numeric meter value", () => {
    const unknown = render(<LimitTrack decorative={false} label="Weekly" value={null} valueText="No reading yet" />)
    expect(unknown.getAttribute("role")).toBe("img")
    expect(unknown.getAttribute("aria-label")).toBe("Weekly: No reading yet")
    for (const attribute of ["aria-hidden", "aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-valuetext"]) {
      expect(unknown.getAttribute(attribute)).toBeNull()
    }
  })

  it("refuses blank value descriptions for known and unknown accessible readings", () => {
    for (const value of [62, null]) {
      expect(() => render(<LimitTrack decorative={false} label="Weekly" value={value} valueText=" " />)).toThrow()
    }
  })

  it("treats a non-finite reading as no reading, ignores a non-finite projection, and refuses a non-finite mark", () => {
    const failed = render(<LimitTrack decorative={false} label="Weekly" value={Number.NaN} valueText="No reading" />)
    expect(failed.dataset.tone).toBe("unknown")
    expect(failed.getAttribute("role")).toBe("img")
    expect(failed.getAttribute("aria-valuenow")).toBeNull()
    expect(part(failed, "fill")).toBeNull()
    expect(part(render(<LimitTrack projected={Number.NaN} value={62} />), "projection")).toBeNull()
    expect(part(render(<LimitTrack projected={Number.POSITIVE_INFINITY} value={62} />), "projection")).toBeNull()
    expect(() => render(<LimitTrack near={Number.NaN} value={62} />)).toThrow("finite")
  })
})
