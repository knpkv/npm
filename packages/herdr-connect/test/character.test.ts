import { describe, expect, it } from "@effect/vitest"

import { agentCharacter, characterSeed } from "../src/character.js"

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
})
