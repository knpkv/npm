/** Canonical outline and motion phase seeded by host:id. Painting uses the separate host:name family palette. */
export interface AgentCharacter {
  readonly body: string
  readonly bodyKind: BodyKind
  /** Actual outline bounds: left, top, width, height. */
  readonly bounds: readonly [number, number, number, number]
  /** Encloses the outline between vertices, with clearance for the row's stroke. */
  readonly ringScale: number
  /** Vertical centre of the enclosing ellipse; tapered bodies need it below their bounding-box centre. */
  readonly ringCy: number
  /** Retained seed hue coordinates; rendered colours come from creaturePalette. */
  readonly hues: readonly [number, number, number]
  readonly eye: readonly [number, number]
  readonly eyeGap: number
  readonly eyeY: number
  /** Converts the reference's 32-unit drawing to the character's body. */
  readonly unit: number
  /** Strictly negative fraction of each looping state's duration. */
  readonly phase: number
}

/** New silhouettes can extend this set when their design references arrive. */
export type BodyKind = "circle" | "squircle" | "pear"
export const FOOT = 88
export const IRIS_SHARE = 0.74

type Point = readonly [number, number]
interface Outline {
  readonly path: string
  readonly points: ReadonlyArray<Point>
}
const fixed = (value: number): string => value.toFixed(3)
const pair = ([x, y]: Point): string => `${fixed(x)} ${fixed(y)}`
const field = (seed: number, shift: number, size: number): number => (seed >>> shift) % size

/** Unsigned FNV-1a with the murmur3 finaliser keeps neighbouring identities apart. */
export const characterSeed = (host: string, id: string): number => {
  let hash = 2166136261
  for (const char of `${host}:${id}`) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Catmull-Rom spans and sampled curves share one geometry for painting and fitting the enclosing ring. */
const smooth = (points: ReadonlyArray<Point>, sample = false): Outline => {
  const at = (index: number): Point => points[(index + points.length) % points.length] ?? [50, 50]
  const samples: Array<Point> = []
  const spans = points.map((point, index) => {
    const before = at(index - 1)
    const next = at(index + 1)
    const after = at(index + 2)
    const a: Point = [point[0] + (next[0] - before[0]) / 6, point[1] + (next[1] - before[1]) / 6]
    const b: Point = [next[0] - (after[0] - point[0]) / 6, next[1] - (after[1] - point[1]) / 6]
    if (sample) {
      for (let step = 0; step <= 20; step++) {
        const t = step / 20
        const u = 1 - t
        samples.push([
          u ** 3 * point[0] + 3 * u ** 2 * t * a[0] + 3 * u * t ** 2 * b[0] + t ** 3 * next[0],
          u ** 3 * point[1] + 3 * u ** 2 * t * a[1] + 3 * u * t ** 2 * b[1] + t ** 3 * next[1]
        ])
      }
    }
    return `C${pair(a)} ${pair(b)} ${pair(next)}`
  })
  return { path: `M${pair(at(0))}${spans.join("")}Z`, points: samples }
}

/** Reference superellipse; eyes use exponent 2.4 and bodies use 4.2. */
export const softBoxPath = (x: number, y: number, width: number, height: number, exponent: number): string =>
  softBox(x, y, width, height, exponent).path

const softBox = (x: number, y: number, width: number, height: number, exponent: number, sample = false): Outline =>
  smooth(
    Array.from({ length: 36 }, (_, index): Point => {
      const angle = index * Math.PI * 2 / 36
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      return [
        x + width / 2 * (1 + Math.sign(c) * Math.abs(c) ** (2 / exponent)),
        y + height / 2 * (1 + Math.sign(s) * Math.abs(s) ** (2 / exponent))
      ]
    }),
    sample
  )

/** Rounded trapezoid from the pear reference, including samples of each quadratic corner. */
const pear = (width: number, height: number, unit: number): Outline => {
  const top = FOOT - height
  const vertices: ReadonlyArray<Point> = [
    [50 - width * 0.28, top],
    [50 + width * 0.28, top],
    [50 + width / 2, FOOT],
    [50 - width / 2, FOOT]
  ]
  const radii = [6, 6, 6.5, 6.5]
  const at = (index: number): Point => vertices[(index + 4) % 4] ?? [50, FOOT]
  const toward = (a: Point, b: Point, distance: number): Point => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    return [a[0] + (b[0] - a[0]) * distance / length, a[1] + (b[1] - a[1]) * distance / length]
  }
  const samples: Array<Point> = []
  const spans = vertices.map((point, index) => {
    const radius = (radii[index] ?? 6) * unit
    const a = toward(point, at(index - 1), radius)
    const b = toward(point, at(index + 1), radius)
    for (let step = 0; step <= 40; step++) {
      const t = step / 40
      const u = 1 - t
      samples.push([
        u * u * a[0] + 2 * u * t * point[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * point[1] + t * t * b[1]
      ])
    }
    return `${index === 0 ? "M" : "L"}${pair(a)}Q${pair(point)} ${pair(b)}`
  })
  return { path: `${spans.join("")}Z`, points: samples }
}

/** Fit the ellipse to the outline itself. Its maximum normalized radius is convex in the vertical centre. */
const ringCentre = (points: ReadonlyArray<Point>, top: number, width: number, height: number): number => {
  const radiusAt = (centre: number): number =>
    Math.max(...points.map(([x, y]) => Math.hypot((x - 50) / (width / 2), (y - centre) / (height / 2))))
  let low = top
  let high = top + height
  for (let step = 0; step < 32; step++) {
    const lower = (2 * low + high) / 3
    const upper = (low + 2 * high) / 3
    if (radiusAt(lower) < radiusAt(upper)) high = upper
    else low = lower
  }
  return (low + high) / 2
}

/** Pure and stable across polls, pages and devices; retains the existing hue-family assignment. */
export const agentCharacter = (host: string, id: string): AgentCharacter => {
  const seed = characterSeed(host, id)
  const hue = (field(seed, 0, 12) * 30 + field(seed, 4, 14)) % 360
  const spread = 18 + field(seed, 9, 30)
  const kinds: ReadonlyArray<BodyKind> = ["circle", "squircle", "pear"]
  const bodyKind = kinds[field(seed, 3, kinds.length)] ?? "circle"
  const unit = bodyKind === "pear" ? 78 / 28 : 3
  const height = (bodyKind === "squircle" ? 23 : 24) * unit
  const width = (bodyKind === "pear" ? 28 : bodyKind === "squircle" ? 23 : 24) * unit
  const radius = width / 2
  const cy = FOOT - height / 2
  const outline: Outline = bodyKind === "circle"
    ? {
      path: `M${fixed(50 - radius)} ${fixed(cy)}A${fixed(radius)} ${fixed(radius)} 0 1 0 ${fixed(50 + radius)} ${
        fixed(cy)
      }A${fixed(radius)} ${fixed(radius)} 0 1 0 ${fixed(50 - radius)} ${fixed(cy)}Z`,
      points: Array.from(
        { length: 360 },
        (
          _,
          index
        ): Point => [50 + radius * Math.cos(index * Math.PI / 180), cy + radius * Math.sin(index * Math.PI / 180)]
      )
    }
    : bodyKind === "squircle"
    ? softBox(50 - width / 2, FOOT - height, width, height, 4.2, true)
    : pear(width, height, unit)
  const xs = outline.points.map(([x]) => x)
  const ys = outline.points.map(([, y]) => y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const actualWidth = Math.max(...xs) - left
  const actualHeight = Math.max(...ys) - top
  const ringCy = bodyKind === "pear"
    ? ringCentre(outline.points, top, actualWidth, actualHeight)
    : top + actualHeight / 2
  const ringScale = Math.max(
    ...outline.points.map(([x, y]) => Math.hypot((x - 50) / (actualWidth / 2), (y - ringCy) / (actualHeight / 2)))
  ) * 1.015
  return {
    body: outline.path,
    bodyKind,
    bounds: [left, top, actualWidth, actualHeight],
    eye: [2.125 * unit, 2.5 * unit],
    eyeGap: (bodyKind === "squircle" ? 4.4 : 4.25) * unit,
    eyeY: FOOT - height + height * 0.5,
    hues: [hue, (hue + spread) % 360, (hue + 360 - Math.round(spread / 2)) % 360],
    phase: -(1 + field(seed, 4, 997)) / 1000,
    ringScale,
    ringCy,
    unit
  }
}

export type CreatureHueFamily = "rose" | "ember" | "amber" | "lime" | "moss" | "teal" | "sky" | "iris"

export interface CreaturePalette {
  readonly family: CreatureHueFamily
  readonly p26: string
  readonly p46: string
  readonly p58: string
  readonly p70: string
  readonly blush: string
  readonly ring: string
  readonly sclera: string
}
interface HueSet {
  readonly ink: string
  readonly base: string
  readonly shade: string
  readonly highlight: string
  readonly blush: string
  readonly ring: string
}
const families: ReadonlyArray<CreatureHueFamily> = ["rose", "ember", "amber", "lime", "moss", "teal", "sky", "iris"]
const colours = {
  rose: { ink: "#3d0f18", base: "#cd4f66", shade: "#9e2f4c", highlight: "#ec848f", blush: "#ec8e78", ring: "#cd4f66" },
  ember: { ink: "#3a1500", base: "#c55f1d", shade: "#9a3d00", highlight: "#e49060", blush: "#db9d4f", ring: "#c55f1d" },
  amber: { ink: "#2f1e00", base: "#a57710", shade: "#7d5502", highlight: "#c8a157", blush: "#baad4b", ring: "#a57710" },
  lime: { ink: "#1d2600", base: "#738c12", shade: "#576609", highlight: "#99b462", blush: "#7abf79", ring: "#738c12" },
  moss: { ink: "#032a15", base: "#2c965d", shade: "#11703a", highlight: "#6cbc8d", blush: "#3ec3a9", ring: "#2c965d" },
  teal: { ink: "#042826", base: "#129390", shade: "#086c67", highlight: "#5db9b8", blush: "#30bed9", ring: "#129390" },
  sky: { ink: "#022538", base: "#0e89c4", shade: "#07658d", highlight: "#66b0e3", blush: "#7eabf6", ring: "#0e89c4" },
  iris: { ink: "#1c1c41", base: "#7173d7", shade: "#4c52a9", highlight: "#9c9ef1", blush: "#b998ea", ring: "#7173d7" }
} satisfies Record<CreatureHueFamily, HueSet>

/** Matches the design's un-mixed FNV-1a over host:name; body seeds retain their separate mixed hash. */
const familySeed = (host: string, name: string): number => {
  let hash = 2166136261
  for (const char of `${host}:${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

/** Pure hash-only family assignment; a served family overrides it. The chef's plum family is outside the agent set.
 * Same-host collisions remain possible until the hub persists family allocations. Chroma scales only closed/stale paint.
 */
export const creaturePalette = (
  host: string,
  name: string,
  family?: CreatureHueFamily,
  chroma = 1
): CreaturePalette => {
  const selected = family ?? families[familySeed(host, name) % families.length] ?? "rose"
  const set = colours[selected]
  const muted = (colour: string): string =>
    chroma === 1 ? colour : `oklch(from ${colour} l calc(c * ${String(chroma)}) h)`
  return {
    family: selected,
    p26: muted(set.ink),
    p46: muted(set.shade),
    p58: muted(set.base),
    p70: muted(set.highlight),
    blush: muted(set.blush),
    ring: muted(set.ring),
    sclera: "#ffffff"
  }
}
