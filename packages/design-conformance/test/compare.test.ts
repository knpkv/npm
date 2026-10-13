import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { PNG } from "pngjs"

import { comparePixels, compareSnapshots, coverageFailures, shotKey } from "../src/compare.js"
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
