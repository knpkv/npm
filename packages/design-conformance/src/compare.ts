import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

import { normalizeCopy } from "./capture.js"
import type { Failure, Identity, Inventory, Manifest, Snapshot, State } from "./schema.js"

export const shotKey = (identity: Identity): string =>
  `${identity.screen}--${identity.state}--${identity.viewport}--${identity.theme}`
export const stateKey = (state: { readonly screen: string; readonly state: string }): string =>
  `${state.screen}/${state.state}`
export const stateShots = (state: Inventory["states"][number]): ReadonlyArray<Identity> =>
  state.viewports.flatMap((viewport) =>
    state.themes.map((theme) => ({ screen: state.screen, state: state.state, viewport, theme }))
  )

/** A dimension change always differs. Include anti-alias detection like the #844 comparison. */
export const comparePixels = (reference: Uint8Array, live: Uint8Array) => {
  const ref = PNG.sync.read(Buffer.from(reference))
  const actual = PNG.sync.read(Buffer.from(live))
  const width = Math.max(ref.width, actual.width)
  const height = Math.max(ref.height, actual.height)
  const diff = new PNG({ width, height })
  if (ref.width !== actual.width || ref.height !== actual.height) {
    diff.data.fill(255)
    return { ratio: 1, diff: PNG.sync.write(diff) }
  }
  const count = pixelmatch(ref.data, actual.data, diff.data, width, height, { threshold: 0.2, includeAA: false })
  return { ratio: count / (width * height), diff: PNG.sync.write(diff) }
}

export const compareSnapshots = (
  identity: Identity,
  state: State,
  ref: Snapshot,
  live: Snapshot
): ReadonlyArray<Failure> => {
  const failures: Array<Failure> = []
  const fail = (region: string, rule: Failure["rule"], detail: string) => {
    failures.push({ ...identity, region, rule, detail })
  }
  const tolerance = identity.viewport === 390 ? 2 : 4
  const refNames = ref.regions.map((region) => region.name)
  const liveNames = live.regions.map((region) => region.name)
  if (ref.overflow || live.overflow) fail("*", "geometry", "Horizontal page overflow")
  if (refNames.join("|") !== liveNames.join("|")) fail("*", "geometry", "Region order or membership differs")
  for (const name of new Set([...state.regions, ...refNames, ...liveNames])) {
    const expected = ref.regions.filter((region) => region.name === name)
    const actual = live.regions.filter((region) => region.name === name)
    const reference = expected[0]
    const region = actual[0]
    if (
      expected.length !== 1 || actual.length !== 1 || reference === undefined || region === undefined ||
      !state.regions.includes(name)
    ) {
      fail(name, "geometry", "Each declared region must occur exactly once on both sides; undeclared regions forbidden")
      continue
    }
    if (normalizeCopy(reference.copy) !== normalizeCopy(region.copy)) {
      fail(name, "copy", `Expected ${normalizeCopy(reference.copy)}; received ${normalizeCopy(region.copy)}`)
    }
    if (reference.parent !== region.parent) fail(name, "geometry", "Region nesting differs")
    if (reference.overflow || region.overflow) fail(name, "geometry", "Region has horizontal overflow")
    for (const coordinate of ["x", "y", "width", "height"] satisfies ReadonlyArray<keyof typeof region.box>) {
      if (Math.abs(reference.box[coordinate] - region.box[coordinate]) > tolerance) {
        fail(
          name,
          "geometry",
          `${coordinate}: expected ${reference.box[coordinate]}, received ${
            region.box[coordinate]
          }, tolerance ${tolerance}px`
        )
      }
    }
    for (const token of new Set([...Object.keys(reference.styles), ...Object.keys(region.styles)])) {
      if (reference.styles[token] !== region.styles[token]) {
        fail(name, "tokens", `${token}: expected ${reference.styles[token]}, received ${region.styles[token]}`)
      }
    }
  }
  return failures
}

/** Compare both inventories so deleted states and missing captures cannot silently disappear. */
export const coverageFailures = (
  manifest: Manifest,
  inventory: Inventory,
  captured: ReadonlySet<string>,
  base: ReadonlyArray<Identity>
): ReadonlyArray<Failure> => {
  const failures: Array<Failure> = []
  const fail = (identity: Identity, detail: string) => {
    failures.push({ ...identity, region: "*", rule: "coverage", detail })
  }
  for (const state of inventory.states) {
    const reference = manifest.states.find((ref) => stateKey(ref) === stateKey(state))
    for (const identity of stateShots(state)) {
      if (reference === undefined || reference.status !== "implemented") {
        fail(identity, "Live state has no implemented reference")
      } else if (
        reference.route !== state.route || !reference.viewports.includes(identity.viewport) ||
        !reference.themes.includes(identity.theme)
      ) fail(identity, "Live route, viewport or theme is not covered by its reference")
      if (!captured.has(shotKey(identity))) fail(identity, "Live state was not captured")
    }
    if (!inventory.routes.includes(state.route)) {
      fail(
        stateShots(state)[0] ?? { screen: state.screen, state: state.state, viewport: 390, theme: "light" },
        "State route missing from live route table"
      )
    }
  }
  for (const state of manifest.states.filter((state) => state.status === "implemented")) {
    for (const identity of stateShots(state)) {
      if (!captured.has(shotKey(identity))) fail(identity, "Implemented reference has no live capture")
    }
  }
  for (const route of inventory.routes) {
    if (!inventory.states.some((state) => state.route === route)) {
      fail({ screen: "routes", state: "uncovered", viewport: 390, theme: "light" }, `Live route has no state: ${route}`)
    }
  }
  for (const identity of base) {
    if (!captured.has(shotKey(identity))) fail(identity, "Previously captured live state was removed")
  }
  return failures
}
