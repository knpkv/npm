import { describe, expect, it } from "@effect/vitest"
import * as character from "../src/character.js"

// Page17's literal FNV bytes for build-01:builder-alpha are59/17/c6/d5, low byte first.
describe("per-agent motion signature", () => {
  it("matches page17 tempo, amplitude, phase and family-dependent habit from the hue seed", () => {
    expect(character).toHaveProperty("creatureSignature")
    expect(character.creatureSignature("build-01", "agent-builder-alpha", "rose")).toEqual({
      seed: 0xd5c61759,
      tempo: 0.95,
      amplitude: 0.84,
      phase: 0.7734375,
      habit: "flick"
    })
    expect(character.creatureSignature("BUILD-01", "builder-alpha", "rose"))
      .toEqual(character.creatureSignature("build-01", "agent-builder-alpha", "rose"))
  })
  it("uses the allocator hash and only the rendered family changes the habit", () => {
    expect(character.creatureHueSeed("BUILD-01", "agent-builder-alpha")).toBe(0xd5c61759)
    const families: ReadonlyArray<character.CreatureHueFamily> = ["rose", "ember", "amber", "lime"]
    const signatures = families.map((family) => character.creatureSignature("build-01", "builder-alpha", family))
    expect(signatures.map(({ habit }) => habit)).toEqual(["flick", "hop", "squint", "tilt"])
    expect(signatures.map(({ habit: _habit, ...identity }) => identity))
      .toEqual(Array.from({ length: 4 }, () => ({ seed: 0xd5c61759, tempo: 0.95, amplitude: 0.84, phase: 0.7734375 })))
  })

  it("bounds all four signature values across a supported 256-agent directory", () => {
    const signatures = Array.from(
      { length: 256 },
      (_, index) => character.creatureSignature("build-01", `agent-worker-${String(index)}`, "rose")
    )
    expect(
      signatures.every(({ amplitude, phase, tempo }) =>
        tempo >= 0.85 && tempo <= 1.15 && amplitude >= 0.8 && amplitude <= 1.2 && phase >= 0 && phase < 1
      )
    ).toBe(true)
    expect(new Set(signatures.map(({ habit }) => habit)).size).toBe(4)
  })

  it("pushes only adjacent similar-task phases, including wraparound, without changing identity", () => {
    expect(character).toHaveProperty("guardCreatureNeighbours")
    const base = character.creatureSignature("build-01", "builder-alpha", "rose")
    const first = { ...base, phase: 0.95 }
    const second = { ...base, phase: 0.02 }
    const guarded = character.guardCreatureNeighbours([
      { task: "idle", signature: first },
      { task: "idle", signature: second }
    ])
    expect(guarded[0]).toBe(first)
    expect(guarded[1]).toEqual({ ...second, phase: 0.02 + 1 / 3 })
    expect(second.phase).toBe(0.02)
    expect(
      character.guardCreatureNeighbours([
        { task: "idle", signature: first },
        { task: "reading", signature: second }
      ])[1]
    ).toBe(second)
    const faster = { ...second, tempo: 1.15 }
    expect(
      character.guardCreatureNeighbours([
        { task: "idle", signature: first },
        { task: "idle", signature: faster }
      ])[1]
    ).toBe(faster)
  })
})
