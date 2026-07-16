// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  FreshnessStamp,
  RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS,
  RLY_FRESHNESS_STAMP_VARIANTS,
  type RlyFreshnessState
} from "../../src/patterns/FreshnessStamp.js"
import { render } from "../primitives/render.js"

const states = [
  { state: "current", word: "Current" },
  { state: "cached", word: "Cached" },
  { state: "stale", word: "Stale" },
  { state: "missing", word: "Missing" },
  { state: "unavailable", word: "Unavailable" }
] satisfies ReadonlyArray<{ readonly state: RlyFreshnessState; readonly word: string }>

describe("FreshnessStamp", () => {
  it("renders every supplied freshness state as a word with machine-readable time", () => {
    for (const fixture of states) {
      const stamp = render(
        <FreshnessStamp dateTime="2026-07-13T14:00:00Z" state={fixture.state} time="Observed 2 minutes ago" />
      )
      if (stamp === null) throw new Error(`FreshnessStamp did not render ${fixture.state}`)
      const time = stamp.querySelector("time")
      if (time === null) throw new Error(`FreshnessStamp did not render time for ${fixture.state}`)

      expect(stamp.textContent).toContain(fixture.word)
      expect(stamp.textContent).toContain("Observed 2 minutes ago")
      expect(stamp.getAttribute("data-rly-freshness-state")).toBe(fixture.state)
      expect(stamp.className).toContain(RLY_FRESHNESS_STAMP_VARIANTS.state[fixture.state].className)
      expect(time.getAttribute("datetime")).toBe("2026-07-13T14:00:00Z")
      expect(stamp.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
    }
  })

  it("keeps time optional and publishes the explicit five-state contract", () => {
    const unavailable = render(<FreshnessStamp size="compact" state="unavailable" />)
    expect(unavailable?.textContent).toBe("Unavailable")
    expect(unavailable?.querySelector("time")).toBeNull()
    expect(unavailable?.className).toContain(RLY_FRESHNESS_STAMP_VARIANTS.size.compact.className)
    expect(Object.keys(RLY_FRESHNESS_STAMP_VARIANTS.state)).toEqual([
      "current",
      "cached",
      "stale",
      "missing",
      "unavailable"
    ])
    expect(RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("rejects blank supplied time content", () => {
    expect(() =>
      renderToStaticMarkup(<FreshnessStamp dateTime="2026-07-13T14:00:00Z" state="current" time=" " />)
    ).toThrow("FreshnessStamp time")
    expect(() => renderToStaticMarkup(<FreshnessStamp dateTime=" " state="current" time="Just now" />)).toThrow(
      "FreshnessStamp dateTime"
    )
  })
})
