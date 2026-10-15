import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

import { agentCharacter, characterBodyKind, characterSeed, creaturePalette, FOOT } from "../src/character.js"
import { referenceBodyKind, referenceCreatureIdentities } from "./reference-creature-identities.js"

const fleet = Array.from({ length: 64 }, (_, index) => agentCharacter("fixture-host", `drawing-${String(index)}`))

describe("agentCharacter", () => {
  it.each(referenceCreatureIdentities)(
    "matches rev6 $host:$name shape and served family",
    ({ bodyKind, family, host, name }) => {
      expect(agentCharacter(host, `agent-${name}`).bodyKind).toBe(bodyKind)
      expect(referenceBodyKind(host, name)).toBe(bodyKind)
      expect(creaturePalette(host, name, family).family).toBe(family)
    }
  )

  it("reproduces the design formula from stable ID payloads without changing the motion seed", () => {
    for (const { bodyKind, host, name } of referenceCreatureIdentities) {
      expect(characterBodyKind(host, `agent-${name}`)).toBe(referenceBodyKind(host, name))
      expect(characterBodyKind(host.toUpperCase(), `agent-${name}`)).toBe(bodyKind)
      expect(characterBodyKind(host, name)).toBe(bodyKind)
    }
    expect(characterSeed("fixture-host", "drawing-0")).toBe(1330749424)
  })

  it("retains identity across polls and separates neighbouring host:id pairs", () => {
    expect(agentCharacter("fixture-host", "drawing-0")).toEqual(agentCharacter("fixture-host", "drawing-0"))
    expect(agentCharacter("fixture-host", "drawing-0")).not.toEqual(agentCharacter("other-host", "drawing-0"))
    expect(agentCharacter("fixture-host", "drawing-0")).not.toEqual(agentCharacter("fixture-host", "drawing-1"))
  })

  it("draws the same body, face, phase and fallback palette for ATLAS and atlas", () => {
    for (const id of ["agent-134", "agent-10", "agent-ds-rly"]) {
      expect({ character: agentCharacter("ATLAS", id), palette: creaturePalette("ATLAS", id) }).toEqual({
        character: agentCharacter("atlas", id),
        palette: creaturePalette("atlas", id)
      })
    }
  })

  it("uses all five canonical outlines and seeds a strictly negative phase", () => {
    const kinds = new Set<string>()
    for (const { body, bodyKind, phase } of fleet) {
      const arcs = body.match(/A/g)?.length ?? 0
      const cubics = body.match(/C/g)?.length ?? 0
      const corners = body.match(/Q/g)?.length ?? 0
      const kind = arcs === 2
        ? "circle"
        : cubics === 36
        ? "squircle"
        : corners === 4
        ? "pear"
        : corners === 10
        ? "star"
        : cubics === 32
        ? "bean"
        : "other"
      kinds.add(kind)
      expect(kind).not.toBe("other")
      expect(kind).toBe(bodyKind)
      expect(phase).toBeLessThan(0)
    }
    expect(kinds).toEqual(new Set(["circle", "squircle", "pear", "star", "bean"]))
    expect(new Set(fleet.map(({ phase }) => phase)).size).toBeGreaterThan(8)
  })

  it("stands all canonical bodies on one foot, centred within the existing stage bounds", () => {
    for (const { bounds: [left, top, width, height], eye, eyeGap, eyeY, hues, ringScale } of fleet) {
      expect(left + width / 2).toBeCloseTo(50, 6)
      expect(top + height).toBeCloseTo(FOOT, 6)
      expect(width).toBeLessThanOrEqual(78)
      expect(height).toBeLessThanOrEqual(72)
      expect(eye[1]).toBeGreaterThan(eye[0])
      expect(eyeGap - eye[0]).toBeGreaterThan(4)
      expect(eyeY - eye[1]).toBeGreaterThan(top)
      expect(eyeY + eye[1]).toBeLessThan(FOOT)
      expect(ringScale).toBeGreaterThan(1)
      for (const hue of hues) expect(hue).toBeGreaterThanOrEqual(0)
    }
  })

  it("handles both unsigned seed halves and preserves the existing hue families", () => {
    const seeds = Array.from({ length: 64 }, (_, index) => characterSeed("fixture-host", `drawing-${String(index)}`))
    expect(seeds.some((seed) => seed >= 2 ** 31)).toBe(true)
    expect(seeds.some((seed) => seed < 2 ** 31)).toBe(true)
    expect(new Set(fleet.map(({ hues }) => Math.floor(hues[0] / 30))).size).toBeGreaterThanOrEqual(9)
    // The hue assignment predates this drawing: changing the body must not recolour identity.
    expect(agentCharacter("fixture-host", "drawing-0").hues).toEqual([129, 156, 115])
  })
})

describe("creaturePalette", () => {
  it("pins design fixture assignments where the hash agrees, without private overrides", () => {
    expect(creaturePalette("atlas", "ds-rly")).toEqual({
      family: "iris",
      p26: "#1c1c41",
      p46: "#4c52a9",
      p58: "#7173d7",
      p70: "#9c9ef1",
      blush: "#b998ea",
      ring: "#7173d7",
      sclera: "#ffffff"
    })
    expect(creaturePalette("birch", "pkgsrc").family).toBe("ember")
    expect(creaturePalette("atlas", "sec-cc").family).toBe("rose")
    expect(creaturePalette("birch", "rev-usage").family).toBe("moss")
    expect(creaturePalette("atlas", "pair-codex").family).toBe("moss")
    // The reference allocated the next free family; hash-only allocation deliberately leaves this collision.
    expect(creaturePalette("atlas", "skills").family).toBe("rose")
  })

  it("keeps hash-only assignments stable, with all eight families represented and no chef plum", () => {
    const palettes = Array.from(
      { length: 64 },
      (_, index) => creaturePalette("fixture-host", `drawing-${String(index)}`)
    )
    expect(creaturePalette("fixture-host", "drawing-0")).toEqual(creaturePalette("fixture-host", "drawing-0"))
    expect(new Set(palettes.map(({ family }) => family))).toEqual(
      new Set(["rose", "ember", "amber", "lime", "moss", "teal", "sky", "iris"])
    )
  })

  it("uses a served family instead of the hash", () => {
    expect(creaturePalette("atlas", "ds-rly", "rose").p58).toBe("#cd4f66")
  })

  it("desaturates closed colours to ten percent without changing lightness or hue", () => {
    expect(creaturePalette("atlas", "ds-rly", "iris", 0.1).p58).toBe("oklch(from #7173d7 l calc(c * 0.1) h)")
    expect(creaturePalette("atlas", "ds-rly", "iris", 0.1).sclera).toBe("#ffffff")
  })
})

describe("creature keyframes", () => {
  it("scales only stale brow paths, with an identity reset for closed brows", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
    const browRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector?.includes(".connect-creature-brow"))
    expect(browRules.length).toBeGreaterThan(0)
    for (const [, selector, declarations] of browRules) {
      expect(declarations).not.toMatch(/\b(?:transform|skew)\s*:/)
      if (/\bscale\s*:/.test(declarations ?? "")) {
        if (selector?.trim() === ".connect-creature[data-closed] .connect-creature-brow") {
          expect(/\bscale\s*:\s*([^;]+);/.exec(declarations ?? "")?.[1]).toBe("1")
        } else {
          expect(selector?.trim()).toBe(".connect-creature[data-stale] .connect-creature-brow")
          expect(declarations).toContain("scale: 1 0.45;")
        }
      }
    }
  })
})
