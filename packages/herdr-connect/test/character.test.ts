import { describe, expect, it } from "@effect/vitest"

import { readFileSync } from "node:fs"

import { agentCharacter, characterSeed, FOOT, GAZE_REACH, IRIS_SHARE } from "../src/character.js"

const fleet = Array.from(
  { length: 40 },
  (_, index) => ({ host: index % 3 === 0 ? "mbp" : "nix", id: `agent-${String(index)}` })
)

describe("agentCharacter", () => {
  // Identity is the whole point: an agent must look the same on every poll, page and device.
  it("gives the same character for the same host and ID, and a different one for another", () => {
    expect(agentCharacter("nix", "a1")).toEqual(agentCharacter("nix", "a1"))
    expect(agentCharacter("nix", "a1")).not.toEqual(agentCharacter("mbp", "a1"))
    expect(agentCharacter("nix", "a1")).not.toEqual(agentCharacter("nix", "a2"))
  })

  // A sign-extending shift on a seed with its top bit set gives negative fields: undefined eye shapes and
  // invalid CSS. Every character in a fleet, high bit or not, must be drawable.
  it("draws a valid character for seeds with the top bit set and clear", () => {
    const seeds = fleet.map(({ host, id }) => characterSeed(host, id))
    expect(seeds.some((seed) => seed >= 2 ** 31)).toBe(true)
    expect(seeds.some((seed) => seed < 2 ** 31)).toBe(true)
    for (const { host, id } of fleet) {
      const character = agentCharacter(host, id)
      expect(character.body).toMatch(/^M[\d.]+ [\d.]+(C[\d. ]+)+Z$/)
      for (const hue of character.hues) expect(hue).toBeGreaterThanOrEqual(0)
      expect(character.eye.every((radius) => radius > 0)).toBe(true)
      expect(character.pace).toBeGreaterThan(0)
      expect(character.blink).toBeGreaterThan(0)
      expect(character.phase).toBeLessThanOrEqual(0)
    }
  })

  // A cast in one colour reads as one character; the light hues should cover most of the wheel.
  it("spreads a fleet's hues round the wheel", () => {
    const families = new Set(fleet.map(({ host, id }) => Math.floor(agentCharacter(host, id).hues[0] / 30)))
    expect(families.size).toBeGreaterThanOrEqual(9)
  })

  // Sixty-four seeds across four hosts: the grid the contact sheet shows. No combination may look broken.
  const grid = Array.from(
    { length: 64 },
    (_, index) => agentCharacter(["nix", "mbp", "studio", "w24"][index % 4] ?? "nix", String(index * 7 + 3))
  )

  it("stands every body on the same foot, centred, inside one box", () => {
    for (const { bounds } of grid) {
      const [left, top, width, height] = bounds
      expect(top + height).toBeCloseTo(FOOT, 6)
      expect(left + width / 2).toBeCloseTo(50, 6)
      expect(width).toBeLessThanOrEqual(78 + 1e-9)
      expect(height).toBeLessThanOrEqual(72 + 1e-9)
    }
  })

  it("gives every face two separate, upright eyes with room to look round inside them", () => {
    for (const { bounds, eye, eyeGap, eyeY } of grid) {
      const [width, height] = eye
      const [left, top, bodyWidth, bodyHeight] = bounds
      expect(height).toBeGreaterThanOrEqual(width)
      // The socket is 1.2 beyond the eye; neighbouring sockets never touch.
      expect(eyeGap - width - 1.2).toBeGreaterThanOrEqual(1.5)
      expect(Math.min(width, height) * (1 - IRIS_SHARE)).toBeGreaterThanOrEqual(GAZE_REACH)
      expect(50 - eyeGap - width).toBeGreaterThan(left + bodyWidth * 0.12)
      expect(eyeY - height).toBeGreaterThan(top + bodyHeight * 0.12)
      expect(eyeY + height).toBeLessThan(top + bodyHeight * 0.7)
    }
  })
})

/** Each `@keyframes name { … }` block of Connect's stylesheet, by name. */
const keyframes = (): Map<string, string> => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  return new Map(
    [...css.matchAll(/@keyframes ([a-z-]+) \{([\s\S]*?)\n {2}\}/g)].map((match) => [match[1] ?? "", match[2] ?? ""])
  )
}

describe("creature keyframes", () => {
  // A stretch without the matching squash grows or shrinks the body, and reads as a skew rather than a breath.
  it("keep the body's area whenever it squashes or stretches", () => {
    const frames = keyframes()
    const names = [...frames.keys()].filter((name) => /^connect-creature-(breathe|hop-squash|call-squash)$/.test(name))
    expect(names).toHaveLength(3)
    for (const name of names) {
      for (const [, x, y] of (frames.get(name) ?? "").matchAll(/scale: ([\d.]+) ([\d.]+);/g)) {
        expect(Number(x) * Number(y)).toBeCloseTo(1, 2)
      }
    }
  })

  // Every gaze offset must stay within the reach every eye leaves room for, or the iris leaves the eye.
  it("move the gaze no further than every eye has room for", () => {
    const frames = keyframes()
    for (const name of ["connect-creature-wander", "connect-creature-read"]) {
      const offsets = [...(frames.get(name) ?? "").matchAll(/translate: (-?[\d.]+)px (-?[\d.]+)px;/g)]
      expect(offsets.length).toBeGreaterThan(0)
      for (const [, x, y] of offsets) expect(Math.hypot(Number(x), Number(y))).toBeLessThanOrEqual(GAZE_REACH)
    }
  })
})
