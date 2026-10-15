/** Outline uses the stable ID payload; motion keeps the mixed host:id seed. Palette uses host:name or a served family. */
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

/** Five reference silhouettes, shared by body, face and accessory placement. */
export type BodyKind = "circle" | "squircle" | "pear" | "star" | "bean"
interface BodySeed {
  readonly width: number
  readonly height: number
  readonly eyeGap: number
  readonly eyeY: number
  readonly highlightX: number
  readonly highlightRotation: number
}
const bodySeeds = {
  circle: { width: 24, height: 24, eyeGap: 4.25, eyeY: 0.5, highlightX: 3.6, highlightRotation: -64 },
  squircle: { width: 23, height: 23, eyeGap: 4.4, eyeY: 0.5, highlightX: 2.4, highlightRotation: -82 },
  pear: { width: 28, height: 24, eyeGap: 4.25, eyeY: 0.5, highlightX: 6.6, highlightRotation: -68 },
  star: { width: 27.4, height: 26, eyeGap: 4.25, eyeY: 0.56, highlightX: 3.5, highlightRotation: -40 },
  bean: { width: 27, height: 22, eyeGap: 4.4, eyeY: 0.55, highlightX: 3, highlightRotation: -70 }
} satisfies Readonly<Record<BodyKind, BodySeed>>
export const creatureBodySeed = (kind: BodyKind): BodySeed => bodySeeds[kind]
export const FOOT = 88
export const IRIS_SHARE = 0.74

type Point = readonly [number, number]
interface Outline {
  readonly path: string
  readonly points: ReadonlyArray<Point>
  readonly originTop: number
}
const fixed = (value: number): string => value.toFixed(3)
const pair = ([x, y]: Point): string => `${fixed(x)} ${fixed(y)}`
const field = (seed: number, shift: number, size: number): number => (seed >>> shift) % size

/** Unsigned FNV-1a used by the reference identity and palette selectors. */
const identitySeed = (host: string, identity: string): number => {
  let hash = 2166136261
  for (const char of `${host.toLowerCase()}:${identity}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

/** Hue allocation and motion share the exact unsigned FNV input, before family collision probing. */
export const creatureHueSeed = (host: string, id: string): number =>
  identitySeed(host, id.startsWith("agent-") ? id.slice(6) : id)

/** Case-insensitive host identity; unsigned FNV-1a with the murmur3 finaliser separates neighbouring IDs. */
export const characterSeed = (host: string, id: string): number => {
  let hash = 2166136261
  for (const char of `${host.toLowerCase()}:${id}`) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Rev6 agentLook: stable ID payload, unsigned FNV-1a, then bits 8 upward. Display names never select bodies. */
export const characterBodyKind = (host: string, id: string): BodyKind => {
  const canonicalId = id.startsWith("agent-") ? id.slice(6) : id
  const seed = identitySeed(host, canonicalId)
  const kinds: ReadonlyArray<BodyKind> = ["circle", "squircle", "pear", "star", "bean"]
  return kinds[field(seed, 8, kinds.length)] ?? "circle"
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
  return { path: `M${pair(at(0))}${spans.join("")}Z`, points: samples, originTop: 0 }
}

/** Reference superellipse; eyes use exponent 2.4 and bodies use 4.2. */
export const softBoxPath = (x: number, y: number, width: number, height: number, exponent: number): string =>
  softBox(x, y, width, height, exponent).path

const softBox = (x: number, y: number, width: number, height: number, exponent: number, sample = false): Outline => ({
  ...smooth(
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
  ),
  originTop: y
})

/** Rounded reference polygons sample the same quadratic corners their path paints. */
const roundedPolygon = (
  vertices: ReadonlyArray<Point>,
  radii: ReadonlyArray<number>,
  unit: number,
  originTop: number
): Outline => {
  const at = (index: number): Point => vertices[(index + vertices.length) % vertices.length] ?? [50, FOOT]
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
  return { path: `${spans.join("")}Z`, points: samples, originTop }
}

/** Wide-based pear from the four rounded reference corners. */
const pear = (width: number, height: number, unit: number): Outline => {
  const top = FOOT - height
  return roundedPolygon(
    [
      [50 - width * 0.28, top],
      [50 + width * 0.28, top],
      [50 + width / 2, FOOT],
      [50 - width / 2, FOOT]
    ],
    [6, 6, 6.5, 6.5],
    unit,
    top
  )
}

/** Five rounded tips with 62%-radius valleys; align the actual bottom with the common foot. */
const starBody = (width: number, height: number, unit: number): Outline => {
  const radius = width / 2 / Math.sin(72 * Math.PI / 180)
  const top = FOOT - height
  const vertices = Array.from({ length: 10 }, (_, index): Point => {
    const angle = (-90 + index * 36) * Math.PI / 180
    const r = index % 2 === 0 ? radius : radius * 0.62
    return [50 + r * Math.cos(angle), top + radius + r * Math.sin(angle)]
  })
  const radii = vertices.map((_, index) => index % 2 === 0 ? 3 : 1.6)
  const outline = roundedPolygon(vertices, radii, unit, top)
  const offset = FOOT - Math.max(...outline.points.map(([, y]) => y))
  return roundedPolygon(vertices.map(([x, y]): Point => [x, y + offset]), radii, unit, top + offset)
}

/** The reference bean is a soft box with a shallow top cleft, never an oval. */
const beanBody = (width: number, height: number): Outline => {
  const top = FOOT - height
  const outline = smooth(
    Array.from({ length: 32 }, (_, index): Point => {
      const angle = index * Math.PI * 2 / 32
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      const x = Math.sign(c) * Math.abs(c) ** (2 / 2.6)
      const y = Math.sign(s) * Math.abs(s) ** (2 / 2.6) + 0.32 * Math.exp(-((angle - 1.5 * Math.PI) ** 2) / 0.22)
      return [50 + x * width / 2, top + height / 2 * (1 + y)]
    }),
    true
  )
  return { ...outline, originTop: top }
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

// Stable identities share geometry across polls and surfaces.
const characterCache = new Map<string, AgentCharacter>()
// One full supported directory must survive the next stable-order poll without eviction.
const CHARACTER_CACHE_LIMIT = 1_024

/** Pure and stable across polls, pages and devices; the body ignores mutable display names. */
export const agentCharacter = (host: string, id: string): AgentCharacter => {
  const key = `${host.toLowerCase()}\u0000${id}`
  const cached = characterCache.get(key)
  if (cached !== undefined) {
    characterCache.delete(key)
    characterCache.set(key, cached)
    return cached
  }
  const seed = characterSeed(host, id)
  const hue = (field(seed, 0, 12) * 30 + field(seed, 4, 14)) % 360
  const spread = 18 + field(seed, 9, 30)
  const bodyKind = characterBodyKind(host, id)
  const drawing = creatureBodySeed(bodyKind)
  const unit = Math.min(3, 78 / drawing.width, 72 / drawing.height)
  const height = drawing.height * unit
  const width = drawing.width * unit
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
      ),
      originTop: FOOT - height
    }
    : bodyKind === "squircle"
    ? softBox(50 - width / 2, FOOT - height, width, height, 4.2, true)
    : bodyKind === "pear" ?
    pear(width, height, unit)
    : bodyKind === "star" ?
    starBody(width, height, unit)
    : beanBody(width, height)
  const xs = outline.points.map(([x]) => x)
  const ys = outline.points.map(([, y]) => y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const actualWidth = Math.max(...xs) - left
  const actualHeight = Math.max(...ys) - top
  const ringCy = ringCentre(outline.points, top, actualWidth, actualHeight)
  const ringScale = Math.max(
    ...outline.points.map(([x, y]) => Math.hypot((x - 50) / (actualWidth / 2), (y - ringCy) / (actualHeight / 2)))
  ) * 1.015
  const character: AgentCharacter = {
    body: outline.path,
    bodyKind,
    bounds: [left, top, actualWidth, actualHeight],
    eye: [2.125 * unit, 2.5 * unit],
    eyeGap: drawing.eyeGap * unit,
    eyeY: outline.originTop + height * drawing.eyeY,
    hues: [hue, (hue + spread) % 360, (hue + 360 - Math.round(spread / 2)) % 360],
    phase: -(1 + field(seed, 4, 997)) / 1000,
    ringScale,
    ringCy,
    unit
  }
  if (characterCache.size >= CHARACTER_CACHE_LIMIT) {
    const oldest = characterCache.keys().next().value
    if (oldest !== undefined) characterCache.delete(oldest)
  }
  characterCache.set(key, character)
  return character
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

export type CreatureHabit = "tilt" | "flick" | "hop" | "squint"
export interface CreatureSignature {
  readonly seed: number
  readonly tempo: number
  readonly amplitude: number
  /** Share of the task loop, and separately of the eight-second habit loop. */
  readonly phase: number
  readonly habit: CreatureHabit
}

/** Page17 uses hue-seed bytes; only the rendered family's index changes the habit, never the seed. */
export const creatureSignature = (host: string, id: string, family: CreatureHueFamily): CreatureSignature => {
  const seed = creatureHueSeed(host, id)
  const habits: ReadonlyArray<CreatureHabit> = ["tilt", "flick", "hop", "squint"]
  return {
    seed,
    tempo: Math.round((0.85 + (seed & 255) / 255 * 0.3) * 100) / 100,
    amplitude: Math.round((0.8 + ((seed >>> 8) & 255) / 255 * 0.4) * 100) / 100,
    phase: ((seed >>> 16) & 255) / 256,
    habit: habits[(((seed >>> 24) & 255) + families.indexOf(family)) % habits.length] ?? "tilt"
  }
}

/** Page17 adjusts only a visible neighbour's phase; callers provide the actual rendered order. */
export const guardCreatureNeighbours = (
  entries: ReadonlyArray<{ readonly task: string; readonly signature: CreatureSignature }>
): ReadonlyArray<CreatureSignature> => {
  const result: Array<CreatureSignature> = []
  for (const [index, entry] of entries.entries()) {
    const previous = result[index - 1]
    const distance = previous === undefined ? 1 : Math.abs(entry.signature.phase - previous.phase)
    const close = previous !== undefined && entries[index - 1]?.task === entry.task &&
      Math.min(distance, 1 - distance) < 0.15 &&
      Math.abs(entry.signature.tempo - previous.tempo) / previous.tempo < 0.15
    result.push(close ? { ...entry.signature, phase: (entry.signature.phase + 1 / 3) % 1 } : entry.signature)
  }
  return result
}

/** Pure hash-only family assignment; a served family overrides it. The chef's plum family is outside the agent set.
 * The fallback may collide when older peers omit their served family. Chroma scales only closed/stale paint.
 */
export const creaturePalette = (
  host: string,
  name: string,
  family?: CreatureHueFamily,
  chroma = 1
): CreaturePalette => {
  const selected = family ?? families[identitySeed(host, name) % families.length] ?? "rose"
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
