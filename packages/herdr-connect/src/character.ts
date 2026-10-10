/**
 * Each agent's character: the look Connect draws it with, seeded by its host and stable ID.
 *
 * **Mental model**
 *
 * - **The look is identity, never state.** Body outline, hues, eye shape, breathing pace, blink rhythm and
 *   phase come only from `host:id`, so an agent looks the same on every poll, page and device. Its state
 *   changes how the creature behaves (see `Creature`), never what it looks like.
 * - **Seeds use unsigned bit fields.** The hash is FNV-1a mixed with the murmur3 finaliser, so neighbouring
 *   IDs land far apart and every field reads from `>>>`, never a sign-extending shift.
 * - **Paces are multiples of the slow motion token,** so Connect's in-app reduced-motion setting, which
 *   zeroes the token, stops them as well as the system preference does.
 *
 * @module
 */

/** One agent's drawn identity. Numbers are in the creature's 100-unit viewBox. */
export interface AgentCharacter {
  /** The body's outline: a closed path of cubic curves, centred on x 50 and standing on {@link FOOT}. */
  readonly body: string
  /**
   * The box of the outline's points: left, top, width, height, its bottom on {@link FOOT}. The curves between
   * the points can bulge past it by under half a unit.
   */
  readonly bounds: readonly [number, number, number, number]
  /** Light, mid and deep hues (OKLCH degrees), close enough to read as one creature. */
  readonly hues: readonly [number, number, number]
  /** Eye half-width and half-height. Never wider than tall, so a squint never reads as a frown. */
  readonly eye: readonly [number, number]
  /** Distance of each eye from the centre line, and the eyes' height. */
  readonly eyeGap: number
  readonly eyeY: number
  /** Breath, blink and phase as multiples of `--rly-motion-slow-duration`; phase is negative, a head start. */
  readonly pace: number
  readonly blink: number
  readonly phase: number
}

/** Where every body stands: its lowest point, and the point its squash and stretch pivot on. */
export const FOOT = 88

/** The iris's radius as a share of the eye's shorter half-axis. What's left over is the gaze's room. */
export const IRIS_SHARE = 0.66

/**
 * How far any gaze moves the iris from the eye's centre, in viewBox units. The stylesheet's gaze keyframes stay
 * inside it, and every eye leaves at least this much room round its iris, so a look never leaves the eye.
 */
export const GAZE_REACH = 1.6

const fnv1a = (text: string): number => {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  return hash
}

/** murmur3's finaliser: spreads a hash so nearby keys don't share colours. */
const mix = (value: number): number => {
  let hash = value ^ (value >>> 16)
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/** The seed for an agent's identity. */
export const characterSeed = (host: string, id: string): number => mix(fnv1a(`${host}:${id}`))

/** `size` values read from `shift` bits up: unsigned, so a seed with its top bit set still gives a valid field. */
const field = (seed: number, shift: number, size: number): number => (seed >>> shift) % size

const POINTS = 24

/** A smooth closed outline through points, as Catmull-Rom spans written as cubic Béziers. */
const smoothClosedPath = (points: ReadonlyArray<readonly [number, number]>): string => {
  const at = (index: number): readonly [number, number] => points[(index + points.length) % points.length] ?? [50, 50]
  const fixed = (value: number): string => value.toFixed(1)
  const spans = points.map((_, index) => {
    const [x0, y0] = at(index - 1)
    const [x1, y1] = at(index)
    const [x2, y2] = at(index + 1)
    const [x3, y3] = at(index + 2)
    const c1 = `${fixed(x1 + (x2 - x0) / 6)} ${fixed(y1 + (y2 - y0) / 6)}`
    const c2 = `${fixed(x2 - (x3 - x1) / 6)} ${fixed(y2 - (y3 - y1) / 6)}`
    return `C${c1} ${c2} ${fixed(x2)} ${fixed(y2)}`
  })
  const [startX, startY] = at(0)
  return `M${fixed(startX)} ${fixed(startY)}${spans.join("")}Z`
}

/** How much of the wobble each lobe count keeps, from two lobes to five. */
const LOBE_WOBBLE: ReadonlyArray<number> = [1, 1, 0.75, 0.6]

/** Eye height over width: round to gently tall. */
const EYE_ASPECTS: ReadonlyArray<number> = [1, 1.08, 1.16, 1.24]

/** The largest box a body may fill, so every creature reads as the same size whatever its proportions. */
const MAX_WIDTH = 78
const MAX_HEIGHT = 72

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** The character drawn for the agent `id` on `host`. Pure: the same pair always gives the same character. */
export const agentCharacter = (host: string, id: string): AgentCharacter => {
  const seed = characterSeed(host, id)
  // Twelve hue families 30° apart plus a small offset, then analogous neighbours, so the body stays one colour story.
  const hue = (field(seed, 0, 12) * 30 + field(seed, 4, 14)) % 360
  const spread = 18 + field(seed, 9, 30)
  // Two to five soft lobes; more lobes get less wobble, so a lobed outline stays a soft flower, never a star.
  const lobes = 2 + field(seed, 3, 4)
  const wobble = (0.04 + field(seed, 6, 10) / 100) * (LOBE_WOBBLE[lobes - 2] ?? 0.6)
  const tall = 0.9 + field(seed, 28, 4) * 0.07
  // Lobes placed symmetrically about the vertical axis, with only a slight lean of their own: a free rotation
  // tilts the whole outline, and a tilted creature reads as skewed. An odd count always puts a trough at the
  // base, so the creature sits flat instead of on a point; an even count may turn either way.
  const flip = lobes % 2 === 1 ? 1 : field(seed, 12, 2)
  const turn = (Math.PI * (1 - lobes)) / 2 - flip * Math.PI + (field(seed, 13, 7) - 3) * 0.04
  const raw = Array.from({ length: POINTS }, (_, index): readonly [number, number] => {
    const angle = (index / POINTS) * Math.PI * 2
    const radius = 34 * (1 + wobble * Math.sin(lobes * angle + turn)) * (1 + 0.06 * Math.cos(angle * 2))
    return [(radius / Math.sqrt(tall)) * Math.cos(angle), radius * tall * Math.sin(angle)]
  })
  // Fit the outline to one box, centred and standing on the foot: transforms pivot on the same point for every
  // creature, and an asymmetric outline no longer moves its own pivot.
  const xs = raw.map(([x]) => x)
  const ys = raw.map(([, y]) => y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = Math.min(MAX_WIDTH / (maxX - minX), MAX_HEIGHT / (maxY - minY))
  const width = (maxX - minX) * scale
  const height = (maxY - minY) * scale
  const points = raw.map(([x, y]): readonly [number, number] => [
    50 + (x - (minX + maxX) / 2) * scale,
    FOOT - (maxY - y) * scale
  ])
  const top = FOOT - height
  const eyeWidth = 5.2 + field(seed, 16, 5) * 0.2
  const aspect = EYE_ASPECTS[field(seed, 19, EYE_ASPECTS.length)] ?? 1
  return {
    blink: 13 + field(seed, 25, 5),
    body: smoothClosedPath(points),
    bounds: [50 - width / 2, top, width, height],
    eye: [eyeWidth, eyeWidth * aspect],
    eyeGap: clamp(width * 0.135, 9.2, 11.2) + (field(seed, 18, 3) - 1) * 0.4,
    eyeY: top + height * 0.4 + (field(seed, 21, 3) - 1) * 0.8,
    hues: [hue, (hue + spread) % 360, (hue + 360 - Math.round(spread / 2)) % 360],
    pace: 9 + field(seed, 23, 6),
    phase: -field(seed, 27, 20)
  }
}
