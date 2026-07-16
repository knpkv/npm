// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  ReleaseRelay,
  RLY_RELEASE_RELAY_DEFAULT_VARIANTS,
  RLY_RELEASE_RELAY_SYMBOLS,
  RLY_RELEASE_RELAY_VARIANTS,
  type RlyReleaseRelaySymbolIndices
} from "../../src/patterns/ReleaseRelay.js"
import { render } from "../primitives/render.js"

const goldenNames = [
  "orbit",
  "split",
  "brace",
  "wave",
  "gate",
  "fork",
  "bridge",
  "beacon",
  "loop",
  "pulse",
  "anchor",
  "ladder",
  "knot",
  "spark",
  "stack",
  "compass"
]

const vectors = [
  {
    accessibleName: "Release relay, Copper Orbit, symbols bridge, wave, beacon.",
    codename: "Copper Orbit",
    symbolIndices: [6, 3, 7]
  },
  {
    accessibleName: "Release relay, Quiet Fork, symbols orbit, fork, compass.",
    codename: "Quiet Fork",
    symbolIndices: [0, 5, 15]
  },
  {
    accessibleName: "Release relay, Layered Anchor, symbols stack, brace, anchor.",
    codename: "Layered Anchor",
    symbolIndices: [14, 2, 10]
  }
] satisfies ReadonlyArray<{
  readonly accessibleName: string
  readonly codename: string
  readonly symbolIndices: RlyReleaseRelaySymbolIndices
}>

const catalogGroups = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [9, 10, 11],
  [12, 13, 14],
  [15, 0, 1]
] satisfies ReadonlyArray<RlyReleaseRelaySymbolIndices>

describe("ReleaseRelay", () => {
  it("locks the persisted 0 through 15 symbol-name contract", () => {
    expect(Object.values(RLY_RELEASE_RELAY_SYMBOLS).map(({ name }) => name)).toEqual(goldenNames)
    expect(Object.keys(RLY_RELEASE_RELAY_SYMBOLS)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15"
    ])
  })

  it("renders every code-owned current-color glyph", () => {
    const seen = new Set<string>()
    for (const symbolIndices of catalogGroups) {
      const relay = render(<ReleaseRelay algorithm="relay/v1" codename="Catalog Relay" symbolIndices={symbolIndices} />)
      if (relay === null) throw new Error("ReleaseRelay catalog fixture did not render")
      const tiles = relay.querySelectorAll("[data-rly-release-symbol-index]")
      expect(tiles).toHaveLength(3)
      for (const tile of tiles) {
        const name = tile.getAttribute("data-rly-release-symbol-name")
        const path = tile.querySelector("path")
        if (name === null || path === null) throw new Error("ReleaseRelay glyph metadata did not render")
        seen.add(name)
        expect(path.getAttribute("stroke")).toBe("currentColor")
        expect(path.getAttribute("fill")).toBe("none")
      }
    }
    expect([...seen]).toEqual(goldenNames)
  })

  it("pins golden persisted vectors and exposes algorithm separately", () => {
    for (const vector of vectors) {
      const relay = render(
        <ReleaseRelay algorithm="relay/v1" codename={vector.codename} symbolIndices={vector.symbolIndices} />
      )
      if (relay === null) throw new Error(`ReleaseRelay did not render ${vector.codename}`)
      const graphic = relay.querySelector("[role='img']")
      if (graphic === null) throw new Error(`ReleaseRelay graphic did not render ${vector.codename}`)

      expect(graphic.getAttribute("aria-label")).toBe(vector.accessibleName)
      expect(relay.textContent).toContain(vector.codename)
      expect(relay.textContent).toContain("Identity algorithm: relay/v1")
      expect(relay.querySelectorAll("[data-rly-release-symbol-index]")).toHaveLength(3)
      expect(relay.querySelectorAll("[data-rly-release-relay-handoff]")).toHaveLength(1)
    }
  })

  it("renders safely during SSR and publishes exact size variants", () => {
    const markup = renderToStaticMarkup(
      <ReleaseRelay algorithm="relay/v1" codename="Copper Orbit" size="hero" symbolIndices={[6, 3, 7]} />
    )
    expect(markup).toContain("Release relay, Copper Orbit, symbols bridge, wave, beacon.")
    expect(markup).toContain("Identity algorithm: relay/v1")
    expect(RLY_RELEASE_RELAY_DEFAULT_VARIANTS).toEqual({ size: "compact" })
    expect(Object.keys(RLY_RELEASE_RELAY_VARIANTS.size)).toEqual(["compact", "hero"])
  })

  it("rejects blank identity metadata", () => {
    expect(() =>
      renderToStaticMarkup(<ReleaseRelay algorithm=" " codename="Copper Orbit" symbolIndices={[6, 3, 7]} />)
    ).toThrow("ReleaseRelay algorithm")
    expect(() =>
      renderToStaticMarkup(<ReleaseRelay algorithm="relay/v1" codename=" " symbolIndices={[6, 3, 7]} />)
    ).toThrow("ReleaseRelay codename")
  })

  it("rejects malformed, out-of-range, and duplicate runtime indices", () => {
    const fractional: [number, number, number] = [0, 1, 2]
    Reflect.set(fractional, 1, 1.5)
    expect(() =>
      Reflect.apply(ReleaseRelay, undefined, [
        { algorithm: "relay/v1", codename: "Fractional", symbolIndices: fractional }
      ])
    ).toThrow("integers from 0 through 15")

    const outOfRange: [number, number, number] = [0, 1, 2]
    Reflect.set(outOfRange, 2, 16)
    expect(() =>
      Reflect.apply(ReleaseRelay, undefined, [{ algorithm: "relay/v1", codename: "Range", symbolIndices: outOfRange }])
    ).toThrow("integers from 0 through 15")

    const duplicate: [number, number, number] = [0, 1, 2]
    Reflect.set(duplicate, 2, 1)
    expect(() =>
      Reflect.apply(ReleaseRelay, undefined, [
        { algorithm: "relay/v1", codename: "Duplicate", symbolIndices: duplicate }
      ])
    ).toThrow("must be distinct")

    const tooShort: [number, number, number] = [0, 1, 2]
    Array.prototype.pop.call(tooShort)
    expect(() =>
      Reflect.apply(ReleaseRelay, undefined, [{ algorithm: "relay/v1", codename: "Short", symbolIndices: tooShort }])
    ).toThrow("exactly three indices")
  })
})
