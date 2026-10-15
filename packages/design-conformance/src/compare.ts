import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

import { type Capture, cropRegions } from "./browser.js"
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

export const LIVE_CHANGE_MAX_DIFF_RATIO = 0.001
const pixelOptions = { threshold: 0.2, includeAA: false }
const geometryTolerance = (identity: Identity): number => identity.viewport === 390 ? 2 : 4

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
  const count = pixelmatch(ref.data, actual.data, diff.data, width, height, pixelOptions)
  return { ratio: count / (width * height), diff: PNG.sync.write(diff) }
}

/** Count original comparator differences outside both captures' named boxes, without changing AA neighbours. */
const compareOutsideRegions = (base: Capture, live: Capture): boolean => {
  const before = PNG.sync.read(Buffer.from(base.frame))
  const after = PNG.sync.read(Buffer.from(live.frame))
  const width = Math.max(before.width, after.width)
  const height = Math.max(before.height, after.height)
  const previous = before.width === width && before.height === height ? before : new PNG({ width, height })
  const current = after.width === width && after.height === height ? after : new PNG({ width, height })
  if (previous !== before) PNG.bitblt(before, previous, 0, 0, before.width, before.height, 0, 0)
  if (current !== after) PNG.bitblt(after, current, 0, 0, after.width, after.height, 0, 0)
  const diff = new PNG({ width, height })
  pixelmatch(previous.data, current.data, diff.data, width, height, { ...pixelOptions, diffMask: true })
  const named = new Uint8Array(width * height)
  for (const region of [...base.snapshot.regions, ...live.snapshot.regions]) {
    if (region.box.width === 0 || region.box.height === 0) continue
    const left = Math.max(0, Math.floor(region.box.x))
    const right = Math.min(width, Math.ceil(region.box.x + region.box.width))
    const top = Math.max(0, Math.floor(region.box.y))
    const bottom = Math.min(height, Math.ceil(region.box.y + region.box.height))
    if (left >= right || top >= bottom) continue
    for (let y = top; y < bottom; y++) named.fill(1, y * width + left, y * width + right)
  }
  let differences = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (named[index] === 1) continue
      // Extent changes outside every named box retain the comparator's strict dimension rule.
      if ((x < before.width && y < before.height) !== (x < after.width && y < after.height)) return true
      if (diff.data[index * 4 + 3] !== 0) differences++
    }
  }
  return differences / (width * height) > LIVE_CHANGE_MAX_DIFF_RATIO
}

export interface LiveChanges {
  readonly touchedRegions: ReadonlyArray<string>
  readonly outsidePixelsChanged: boolean
}

// CSSOM emits legacy comma-separated sRGB and preserves OKLCH missing components as none.
// Other serializations stay strict until explicitly supported with comparator controls.
const computedNumber = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:e[+-]?[0-9]+)?`
const computedAlpha = (value: string | undefined): boolean =>
  value === undefined || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1)
const computedRgb = new RegExp(
  String
    .raw`^(rgb|rgba)\((${computedNumber}),\s*(${computedNumber}),\s*(${computedNumber})(?:,\s*(${computedNumber}))?\)$`,
  "u"
)
const computedRgbColor = (value: string): boolean => {
  const match = computedRgb.exec(value)
  if (match === null || (match[1] === "rgba") !== (match[5] !== undefined) || !computedAlpha(match[5])) return false
  return match.slice(2, 5).every((component) => {
    const channel = Number(component)
    return Number.isFinite(channel) && channel >= 0 && channel <= 255
  })
}
const computedOklchComponent = String.raw`(?:${computedNumber}|none)`
// Unbounded chroma can retain positive infinity; L, hue and alpha resolve/clamp before serialization.
const computedOklchChroma = String.raw`(?:${computedOklchComponent}|calc\(infinity\))`
const computedOklch = new RegExp(
  String
    .raw`^oklch\(${computedOklchComponent}\s+${computedOklchChroma}\s+${computedOklchComponent}(?:\s+/\s+(${computedNumber}|none))?\)$`,
  "u"
)

const computedOklchColor = (value: string): boolean => {
  const match = computedOklch.exec(value)
  return match !== null && (match[1] === "none" || computedAlpha(match[1]))
}

const unpaintedBorder = (value: string): boolean => {
  const shorthand =
    /^(0(?:\.0+)?(?:px)?|[0-9]+(?:\.[0-9]+)?px)\s+(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)\s+(.*)$/u
      .exec(value)
  if (shorthand === null || shorthand[2] === "hidden") return false
  const color = shorthand[3]
  if (color === undefined || !(computedRgbColor(color) || computedOklchColor(color))) return false
  const width = shorthand[1]
  return width !== undefined && (shorthand[2] === "none" || /^0(?:\.0+)?(?:px)?$/u.test(width))
}

/** Ignore only border details that cannot paint; retain raw captured tokens for evidence. */
const tokensMatch = (property: string, left: string | undefined, right: string | undefined): boolean =>
  left === right ||
  (/^border-(?:top|right|bottom|left)$/u.test(property) && left !== undefined && right !== undefined &&
    unpaintedBorder(left) && unpaintedBorder(right))

/** Compare merge-base and PR evidence for this shot; reference drift never selects touched regions. */
export const compareLiveRegions = (
  identity: Identity,
  base: Capture | undefined,
  live: Capture,
  declared: ReadonlyArray<string>
): LiveChanges => {
  const names = Array.from(
    new Set([
      "*",
      ...declared,
      ...base?.snapshot.regions.map((region) => region.name) ?? [],
      ...live.snapshot.regions.map((region) => region.name)
    ])
  )
  if (base === undefined) return { touchedRegions: names, outsidePixelsChanged: true }
  const baseNames = new Set(base.snapshot.regions.map((region) => region.name))
  // These are pixel crops at PR coordinates, not region metadata attributed to the base.
  const baseAtLiveBoxes = live.snapshot.regions.some((region) => !baseNames.has(region.name))
    ? cropRegions(base.frame, live.snapshot)
    : undefined
  const outsidePixelsChanged = compareOutsideRegions(base, live)
  const touchedRegions = names.filter((name) => {
    const before = base.snapshot.regions.filter((region) => region.name === name)
    const after = live.snapshot.regions.filter((region) => region.name === name)
    const metadataChanged = name === "*"
      ? base.snapshot.overflow !== live.snapshot.overflow ||
        base.snapshot.regions.map((region) => region.name).join("|") !==
          live.snapshot.regions.filter((region) => baseNames.has(region.name)).map((region) => region.name).join("|")
      : before.length !== after.length || before.some((region, index) => {
        const current = after[index]
        return current === undefined || normalizeCopy(region.copy) !== normalizeCopy(current.copy) ||
          region.parent !== current.parent || region.overflow !== current.overflow ||
          (["x", "y", "width", "height"] satisfies ReadonlyArray<keyof typeof region.box>).some((coordinate) =>
            Math.abs(region.box[coordinate] - current.box[coordinate]) > geometryTolerance(identity)
          ) ||
          Array.from(new Set([...Object.keys(region.styles), ...Object.keys(current.styles)])).some((token) =>
            !tokensMatch(token, region.styles[token], current.styles[token])
          )
      })
    if (name === "*") {
      return metadataChanged || outsidePixelsChanged
    }
    const previous = base.regions.get(name)
    const current = live.regions.get(name)
    if (before.length === 0 && after.length === 1) {
      const basePixels = baseAtLiveBoxes?.get(name)
      return basePixels?._tag !== "Image" || current?._tag !== "Image" ||
        comparePixels(basePixels.bytes, current.bytes).ratio > LIVE_CHANGE_MAX_DIFF_RATIO
    }
    if (metadataChanged || previous?._tag !== current?._tag) return true
    return previous?._tag === "Image" && current?._tag === "Image" &&
      comparePixels(previous.bytes, current.bytes).ratio > LIVE_CHANGE_MAX_DIFF_RATIO
  })
  return { touchedRegions, outsidePixelsChanged }
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
  const tolerance = geometryTolerance(identity)
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
      if (!tokensMatch(token, reference.styles[token], region.styles[token])) {
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
