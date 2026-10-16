import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { PNG } from "pngjs"

import { type Capture, cropRegions, RegionPixels } from "../src/browser.js"
import { compareLiveRegions, comparePixels, compareSnapshots, coverageFailures, shotKey } from "../src/compare.js"
import type { Identity } from "../src/schema.js"
import { identity, manifest, snapshot, state } from "./models.js"

it.effect("copy, geometry, token equality and overflow each detect their original defect shape", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const changed = {
      ...snapshot,
      overflow: true,
      regions: [{
        ...region,
        copy: "Wrong workspace",
        box: { ...region.box, x: 19 },
        styles: { color: "rgb(255, 0, 0)" }
      }]
    }
    const failures = compareSnapshots(identity, state, snapshot, changed)
    expect(new Set(failures.map((failure) => failure.rule))).toEqual(new Set(["copy", "geometry", "tokens"]))
    expect(
      compareSnapshots(identity, state, snapshot, {
        ...snapshot,
        regions: [{ ...region, box: { ...region.box, x: 18 } }]
      })
    ).toEqual([])
    expect(
      compareSnapshots({ ...identity, viewport: 1280 }, state, snapshot, {
        ...snapshot,
        regions: [{ ...region, box: { ...region.box, x: 20 } }]
      })
    ).toEqual([])
  }))

it.effect("a 360 phone uses the phone geometry tolerance, like 390", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const shifted = (x: number) => ({ ...snapshot, regions: [{ ...region, box: { ...region.box, x } }] })
    const phone: Identity = { ...identity, viewport: 360 }
    expect(compareSnapshots(phone, state, snapshot, shifted(region.box.x + 2))).toEqual([])
    expect(
      compareSnapshots(phone, state, snapshot, shifted(region.box.x + 4)).some((failure) => failure.rule === "geometry")
    )
      .toBe(true)
  }))

it.effect("per-viewport regions: a desktop-only region on a phone capture is undeclared there", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const split = { ...state, regions: { phone: ["other"], desktop: [region.name] } }
    expect(compareSnapshots({ ...identity, viewport: 1280 }, split, snapshot, snapshot)).toEqual([])
    expect(compareSnapshots(identity, split, snapshot, snapshot).some((failure) => failure.rule === "geometry")).toBe(
      true
    )
  }))

it.effect("missing, duplicated, undeclared, reordered and reparented regions fail geometry", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    for (const regions of [[], [region, region], [{ ...region, name: "other" }], [{ ...region, parent: "other" }]]) {
      expect(
        compareSnapshots(identity, state, snapshot, { ...snapshot, regions }).some((failure) =>
          failure.rule === "geometry"
        )
      ).toBe(true)
    }
    const nested = { ...snapshot, regions: [region, { ...region, name: "other", parent: "content" }] }
    expect(
      compareSnapshots(identity, { ...state, regions: ["content", "other"] }, nested, {
        ...nested,
        regions: [...nested.regions].reverse()
      }).some((failure) => failure.detail.includes("order"))
    ).toBe(true)
  }))

it.effect("coverage uses independent routes and catches removed captures", () =>
  Effect.sync(() => {
    const inventory = { routes: ["/screen.html", "/missing"], states: [state, { ...state, state: "new" }] }
    const failures = coverageFailures(manifest, inventory, new Set([shotKey(identity)]), [{
      ...identity,
      state: "removed"
    }])
    expect(failures.map((failure) => failure.detail)).toContain("Live state has no implemented reference")
    expect(failures.map((failure) => failure.detail)).toContain("Live state was not captured")
    expect(failures.some((failure) => failure.detail.includes("/missing"))).toBe(true)
    expect(failures.some((failure) => failure.state === "removed")).toBe(true)
    expect(coverageFailures(manifest, { routes: [state.route], states: [state] }, new Set([shotKey(identity)]), []))
      .toEqual([])
  }))

it.effect("perceptual comparison detects pixel and dimension changes while equal pixels pass", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const reference = PNG.sync.write(image)
    expect(comparePixels(reference, reference).ratio).toBe(0)
    image.data[0] = 0
    image.data[1] = 0
    image.data[2] = 0
    expect(comparePixels(reference, PNG.sync.write(image)).ratio).toBeGreaterThan(0.001)
    expect(comparePixels(reference, PNG.sync.write(new PNG({ width: 11, height: 10 }))).ratio).toBe(1)
  }))

it.effect("region touched comparison keeps the 0.1% boundary and requires real changes above it", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 100, height: 10 })
    image.data.fill(255)
    const reference = PNG.sync.write(image)
    const evidence = (bytes: Uint8Array): Capture => ({
      frame: bytes,
      snapshot: {
        ...snapshot,
        regions: snapshot.regions.map((region) => ({
          ...region,
          box: { x: 0, y: 0, width: 100, height: 10 }
        }))
      },
      regions: new Map([["content", RegionPixels.Image({ bytes })]])
    })
    const base = evidence(reference)
    for (let channel = 0; channel < 3; channel++) image.data[channel] = 0
    const boundary = evidence(PNG.sync.write(image))
    expect(comparePixels(base.frame, boundary.frame).ratio).toBe(0.001)
    expect(compareLiveRegions(identity, base, boundary, ["content"]).touchedRegions).toEqual([])
    for (let channel = 4; channel < 7; channel++) image.data[channel] = 0
    const changed = evidence(PNG.sync.write(image))
    expect(comparePixels(base.frame, changed.frame).ratio).toBe(0.002)
    expect(compareLiveRegions(identity, base, changed, ["content"]).touchedRegions).toEqual(["content"])
  }))

it.effect("new region tags compare their own raw rectangle at the unchanged pixel threshold", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const image = new PNG({ width: 200, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    const base: Capture = { frame, snapshot: { overflow: false, regions: [] }, regions: new Map() }
    const tagged = { ...snapshot, regions: [{ ...region, box: { x: 100, y: 0, width: 100, height: 10 } }] }
    const evidence = (): Capture => {
      const bytes = PNG.sync.write(image)
      return { frame: bytes, snapshot: tagged, regions: cropRegions(bytes, tagged) }
    }
    for (let channel = 100 * 4; channel < 100 * 4 + 3; channel++) image.data[channel] = 0
    expect(compareLiveRegions(identity, base, evidence(), ["content"]))
      .toEqual({ touchedRegions: [], outsidePixelsChanged: false })
    for (let channel = 101 * 4; channel < 101 * 4 + 3; channel++) image.data[channel] = 0
    expect(compareLiveRegions(identity, base, evidence(), ["content"]))
      .toEqual({ touchedRegions: ["content"], outsidePixelsChanged: false })
    image.data.fill(255)
    for (let pixel = 0; pixel < 9; pixel++) {
      for (let channel = 0; channel < 3; channel++) image.data[pixel * 4 + channel] = 0
    }
    expect(compareLiveRegions(identity, base, evidence(), ["content"]))
      .toEqual({ touchedRegions: ["*"], outsidePixelsChanged: true })
  }))

it.effect("a new region without usable base or current pixels cannot be inherited", () =>
  Effect.sync(() => {
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const image = new PNG({ width: 20, height: 20 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    const base: Capture = { frame, snapshot: { overflow: false, regions: [] }, regions: new Map() }
    for (const box of [{ x: 30, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
      const tagged = { ...snapshot, regions: [{ ...region, box }] }
      const current: Capture = { frame, snapshot: tagged, regions: cropRegions(frame, tagged) }
      expect(compareLiveRegions(identity, base, current, ["content"]).touchedRegions).toContain("content")
    }
    const larger = new PNG({ width: 40, height: 20 })
    larger.data.fill(255)
    const biggerFrame = PNG.sync.write(larger)
    const tagged = { ...snapshot, regions: [{ ...region, box: { x: 30, y: 0, width: 10, height: 10 } }] }
    expect(
      compareLiveRegions(identity, base, {
        frame: biggerFrame,
        snapshot: tagged,
        regions: cropRegions(biggerFrame, tagged)
      }, ["content"]).touchedRegions
    ).toContain("content")
  }))

it.effect("base metadata uses existing rule tolerances and inherited overflow stays untouched", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    const base: Capture = {
      frame,
      snapshot,
      regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
    }
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const drift = (change: Partial<typeof region>): Capture => ({
      ...base,
      snapshot: { ...snapshot, regions: [{ ...region, ...change }] }
    })
    expect(compareLiveRegions(identity, base, drift({ box: { ...region.box, x: 18 } }), ["content"]).touchedRegions)
      .toEqual([])
    expect(compareLiveRegions(identity, base, drift({ box: { ...region.box, x: 19 } }), ["content"]).touchedRegions)
      .toEqual([
        "content"
      ])
    for (
      const change of [
        { copy: "Different visible copy" },
        { parent: "nav" },
        { overflow: true },
        { styles: { color: "rgb(255, 0, 0)" } }
      ]
    ) expect(compareLiveRegions(identity, base, drift(change), ["content"]).touchedRegions).toEqual(["content"])
    const inherited = {
      ...drift({ overflow: true }),
      snapshot: { ...drift({ overflow: true }).snapshot, overflow: true }
    }
    expect(compareLiveRegions(identity, inherited, inherited, ["content"]).touchedRegions).toEqual([])
    expect(compareLiveRegions(identity, undefined, base, ["nav", "content"]).touchedRegions).toEqual([
      "*",
      "nav",
      "content"
    ])
  }))

it.effect("off-frame base regions stay inherited until membership or image availability changes", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    const base: Capture = { frame, snapshot, regions: new Map([["content", RegionPixels.OffFrame()]]) }
    expect(compareLiveRegions(identity, base, base, ["content"]).touchedRegions).toEqual([])
    expect(
      compareLiveRegions(identity, base, {
        ...base,
        regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
      }, ["content"]).touchedRegions
    ).toEqual(["content"])
    expect(
      compareLiveRegions(identity, base, {
        ...base,
        snapshot: { ...snapshot, regions: [] },
        regions: new Map()
      }, ["content"]).touchedRegions
    ).toEqual(["*", "content"])
  }))

it.effect("frame enforcement catches outside-region pixels at the unchanged threshold and uncovered size changes", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 100, height: 10 })
    image.data.fill(255)
    const crop = new PNG({ width: 50, height: 10 })
    crop.data.fill(255)
    const region = snapshot.regions[0]
    if (region === undefined) return expect.unreachable()
    const base: Capture = {
      frame: PNG.sync.write(image),
      snapshot: { ...snapshot, regions: [{ ...region, box: { x: 0, y: 0, width: 50, height: 10 } }] },
      regions: new Map([["content", RegionPixels.Image({ bytes: PNG.sync.write(crop) })]])
    }
    for (let channel = 75 * 4; channel < 75 * 4 + 3; channel++) image.data[channel] = 0
    expect(compareLiveRegions(identity, base, { ...base, frame: PNG.sync.write(image) }, ["content"]))
      .toEqual({ touchedRegions: [], outsidePixelsChanged: false })
    for (let channel = 76 * 4; channel < 76 * 4 + 3; channel++) image.data[channel] = 0
    expect(compareLiveRegions(identity, base, { ...base, frame: PNG.sync.write(image) }, ["content"]))
      .toEqual({ touchedRegions: ["*"], outsidePixelsChanged: true })
    const wider = new PNG({ width: 101, height: 10 })
    wider.data.fill(255)
    expect(compareLiveRegions(identity, base, { ...base, frame: PNG.sync.write(wider) }, ["content"]))
      .toEqual({ touchedRegions: ["*"], outsidePixelsChanged: true })
  }))

it.effect("unpainted border colors and styles do not create reference or touched-region failures", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    for (const property of ["border-top", "border-right", "border-bottom", "border-left"]) {
      const evidence = (border: string): Capture => ({
        frame,
        snapshot: {
          ...snapshot,
          regions: snapshot.regions.map((region) => ({ ...region, styles: { [property]: border } }))
        },
        regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
      })
      const base = evidence("0px none rgb(0, 0, 0)")
      for (
        const border of [
          "0px solid rgb(255, 0, 0)",
          "0 dashed rgb(0, 0, 255)",
          "1px none rgb(0, 255, 0)",
          "0px dashed rgba(0, 0, 255, 0.5)",
          "0px none rgba(178.5, 93.5, 51, 0.5)",
          "0px solid rgb(146.06, 107.46, 131.2)",
          "0px dashed rgb(0.125, 254.999, 255)",
          "0px solid oklch(0.9677 0.0027 286.35)",
          "0px dashed oklch(0.5 0.1 20 / 0.5)",
          "0px none oklch(1 0 none)",
          "0px solid oklch(none 0.1 20)",
          "0px dashed oklch(0.5 none 20)",
          "0px solid oklch(none none 20)",
          "0px dashed oklch(none 0.1 none)",
          "0px solid oklch(0.5 none none)",
          "0px dashed oklch(none none none)",
          "0px solid oklch(0.5 0.1 20 / none)",
          "0px dashed oklch(none 0.1 20 / none)",
          "0px solid oklch(0.5 none 20 / none)",
          "0px dashed oklch(0.5 0.1 none / none)",
          "0px solid oklch(none none 20 / none)",
          "0px dashed oklch(none 0.1 none / none)",
          "0px solid oklch(0.5 none none / none)",
          "0px dashed oklch(none none none / none)",
          "0px solid oklch(1 calc(infinity) 20)",
          "0px dashed oklch(none calc(infinity) none / none)",
          "0px solid oklch(0.5 0.1 20 / 1.00000e-9)"
        ]
      ) {
        const current = evidence(border)
        expect({
          reference: compareSnapshots(identity, state, base.snapshot, current.snapshot),
          touched: compareLiveRegions(identity, base, current, ["content"]).touchedRegions
        }, `${property}: ${border}`).toEqual({ reference: [], touched: [] })
      }
      expect(base.snapshot.regions[0]?.styles[property]).toBe("0px none rgb(0, 0, 0)")
    }
  }))

it.effect("painted border color, style, width and removal remain required token differences", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    for (const property of ["border-top", "border-right", "border-bottom", "border-left"]) {
      const evidence = (border: string): Capture => ({
        frame,
        snapshot: {
          ...snapshot,
          regions: snapshot.regions.map((region) => ({ ...region, styles: { [property]: border } }))
        },
        regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
      })
      const base = evidence("1px solid rgb(0, 0, 0)")
      for (
        const border of [
          "1px solid rgb(255, 0, 0)",
          "1px dashed rgb(0, 0, 0)",
          "2px solid rgb(0, 0, 0)",
          "0px none rgb(0, 0, 0)"
        ]
      ) {
        const current = evidence(border)
        expect(compareSnapshots(identity, state, base.snapshot, current.snapshot)).toEqual([
          expect.objectContaining({ region: "content", rule: "tokens", detail: expect.stringContaining(property) })
        ])
        expect(compareLiveRegions(identity, base, current, ["content"]).touchedRegions).toEqual(["content"])
      }
    }
  }))

it.effect("hidden borders remain significant even at zero width in both comparators", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    for (const property of ["border-top", "border-right", "border-bottom", "border-left"]) {
      const evidence = (border: string): Capture => ({
        frame,
        snapshot: {
          ...snapshot,
          regions: snapshot.regions.map((region) => ({ ...region, styles: { [property]: border } }))
        },
        regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
      })
      const hidden = evidence("0px hidden rgb(0, 0, 0)")
      const none = evidence("0px none rgb(255, 0, 0)")
      for (const pair of [{ before: hidden, after: none }, { before: none, after: hidden }]) {
        expect(compareSnapshots(identity, state, pair.before.snapshot, pair.after.snapshot)).toEqual([
          expect.objectContaining({ region: "content", rule: "tokens", detail: expect.stringContaining(property) })
        ])
        expect(compareLiveRegions(identity, pair.before, pair.after, ["content"]).touchedRegions).toEqual(["content"])
      }
      const solid = evidence("0px solid rgb(255, 0, 0)")
      const dashed = evidence("0px dashed rgb(0, 0, 255)")
      expect(compareSnapshots(identity, state, solid.snapshot, dashed.snapshot)).toEqual([])
      expect(compareLiveRegions(identity, solid, dashed, ["content"]).touchedRegions).toEqual([])
    }
  }))

it.effect("incomplete or unknown-style border evidence never normalizes in either comparator", () =>
  Effect.sync(() => {
    const image = new PNG({ width: 10, height: 10 })
    image.data.fill(255)
    const frame = PNG.sync.write(image)
    for (const property of ["border-top", "border-right", "border-bottom", "border-left"]) {
      const evidence = (border: string): Capture => ({
        frame,
        snapshot: {
          ...snapshot,
          regions: snapshot.regions.map((region) => ({ ...region, styles: { [property]: border } }))
        },
        regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
      })
      const complete = evidence("0px none rgb(0, 0, 0)")
      for (
        const value of ["0px", "0px nonsense", "0px nonsense rgb(0, 0, 0)", "0px none", "nonsense none rgb(0, 0, 0)"]
      ) {
        const incomplete = evidence(value)
        for (const pair of [{ before: incomplete, after: complete }, { before: complete, after: incomplete }]) {
          expect(compareSnapshots(identity, state, pair.before.snapshot, pair.after.snapshot), value).toEqual([
            expect.objectContaining({ region: "content", rule: "tokens", detail: expect.stringContaining(property) })
          ])
          expect(compareLiveRegions(identity, pair.before, pair.after, ["content"]).touchedRegions, value)
            .toEqual(["content"])
        }
      }
    }
  }))

for (
  const color of [
    "nonsense",
    "rgb(",
    "rgb(0, 0, 0) trailing",
    "rgb(0, 0)",
    "rgba(0, 0, 0)",
    "rgba(178.5, 93.5, 51)",
    "rgba(255.001, 93.5, 51, 0.5)",
    "rgb(-0.001, 93.5, 51)",
    "rgb(256, 93.5, 51)",
    "rgb(1e309, 93.5, 51)",
    "rgba(0, 0, 0, 0.5) trailing",
    "oklch(0.5 0.1)",
    "oklch(0.5 0.1 20) trailing",
    "oklch(1 none)",
    "oklch(none none)",
    "oklch(none none none none)",
    "oklch(none none none /)",
    "oklch(none none none / none none)",
    "oklch(none none none / auto)",
    "oklch(1 0 none) trailing",
    "oklch(1 0 nones)",
    "oklch(1 calc(infinity) 20) trailing",
    "oklch(1 calc(infinity + 1) 20)",
    "rgb(none, 0, 0)",
    "rgba(0, 0, 0, none)",
    "rgba(0, 0, 0, -0.1)",
    "rgba(0, 0, 0, 1.1)",
    "oklch(0.5 0.1 20 / -0.1)",
    "oklch(0.5 0.1 20 / 1.1)",
    "oklch(0.5 0.1 20 / 1e309)"
  ]
) {
  it.effect(`malformed computed border color stays strict in both comparators: ${color}`, () =>
    Effect.sync(() => {
      const image = new PNG({ width: 10, height: 10 })
      image.data.fill(255)
      const frame = PNG.sync.write(image)
      for (const property of ["border-top", "border-right", "border-bottom", "border-left"]) {
        const evidence = (border: string): Capture => ({
          frame,
          snapshot: {
            ...snapshot,
            regions: snapshot.regions.map((region) => ({ ...region, styles: { [property]: border } }))
          },
          regions: new Map([["content", RegionPixels.Image({ bytes: frame })]])
        })
        const complete = evidence("0px solid rgb(0, 0, 0)")
        const malformed = evidence(`0px none ${color}`)
        for (const pair of [{ before: malformed, after: complete }, { before: complete, after: malformed }]) {
          expect({
            reference: compareSnapshots(identity, state, pair.before.snapshot, pair.after.snapshot),
            touched: compareLiveRegions(identity, pair.before, pair.after, ["content"]).touchedRegions
          }).toEqual({
            reference: [
              expect.objectContaining({ region: "content", rule: "tokens", detail: expect.stringContaining(property) })
            ],
            touched: ["content"]
          })
        }
      }
    }))
}
