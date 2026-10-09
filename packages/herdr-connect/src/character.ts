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
  /** The body's outline: a closed path of cubic curves. */
  readonly body: string
  /** Light, mid and deep hues (OKLCH degrees), close enough to read as one creature. */
  readonly hues: readonly [number, number, number]
  /** Eye half-width and half-height. */
  readonly eye: readonly [number, number]
  /** Distance of each eye from the centre line, and the eyes' height. */
  readonly eyeGap: number
  readonly eyeY: number
  /** Breath, blink and phase as multiples of `--rly-motion-slow-duration`; phase is negative, a head start. */
  readonly pace: number
  readonly blink: number
  readonly phase: number
}

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

const EYE_PROPORTIONS: ReadonlyArray<readonly [number, number]> = [
  [5.2, 5.6],
  [4.4, 6.2],
  [6, 5],
  [4.8, 4.8]
]

/** The character drawn for the agent `id` on `host`. Pure: the same pair always gives the same character. */
export const agentCharacter = (host: string, id: string): AgentCharacter => {
  const seed = characterSeed(host, id)
  // Twelve hue families 30° apart plus a small offset, then analogous neighbours, so the body stays one colour story.
  const hue = (field(seed, 0, 12) * 30 + field(seed, 4, 14)) % 360
  const spread = 18 + field(seed, 9, 30)
  const lobes = 2 + field(seed, 3, 5)
  const wobble = 0.04 + field(seed, 6, 14) / 100
  const tall = 0.82 + field(seed, 28, 4) / 10
  const turn = field(seed, 12, 628) / 100
  const points = Array.from({ length: POINTS }, (_, index): readonly [number, number] => {
    const angle = (index / POINTS) * Math.PI * 2
    const radius = 34 * (1 + wobble * Math.sin(lobes * angle + turn)) * (1 + 0.06 * Math.cos(angle * 2))
    return [50 + (radius / Math.sqrt(tall)) * Math.cos(angle), 56 + radius * tall * 0.92 * Math.sin(angle)]
  })
  return {
    blink: 13 + field(seed, 25, 5),
    body: smoothClosedPath(points),
    eye: EYE_PROPORTIONS[field(seed, 16, EYE_PROPORTIONS.length)] ?? [5, 5],
    eyeGap: 9 + field(seed, 18, 5),
    eyeY: 46 + field(seed, 21, 6),
    hues: [hue, (hue + spread) % 360, (hue + 360 - Math.round(spread / 2)) % 360],
    pace: 9 + field(seed, 23, 6),
    phase: -field(seed, 27, 20)
  }
}
