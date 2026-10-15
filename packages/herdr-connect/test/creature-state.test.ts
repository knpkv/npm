import { describe, expect, it } from "@effect/vitest"
import { creatureAgentPose, type CreatureMood, creatureMood, creaturePose } from "../src/creature-state.js"

describe("creature state poses", () => {
  it("shares the directory's state language including unknown and case-insensitive states", () => {
    expect(creatureMood("WORKING")).toBe("focused")
    expect(creatureMood("running")).toBe("focused")
    expect(creatureMood("blocked")).toBe("worried")
    expect(creatureMood("error")).toBe("worried")
    expect(creatureMood("blocked", true)).toBe("stuck")
    expect(creatureMood("error", true)).toBe("stuck")
    expect(creatureMood("waiting")).toBe("waiting")
    expect(creatureMood("needs-you")).toBe("waiting")
    expect(creatureMood("new-state")).toBe("waiting")
    expect(creatureMood("idle")).toBe("sleepy")
    expect(creatureMood("ready")).toBe("happy")
    expect(creatureMood("done")).toBe("done")
  })

  it("pins reference state timings, eyes and brows without changing identity", () => {
    expect(creaturePose("focused")).toMatchObject({ duration: 2400, loops: true, brow: "focus", lid: 0.38 })
    expect(creaturePose("happy")).toMatchObject({ duration: 1600, loops: true, brow: "up", lower: 0.32 })
    expect(creaturePose("sleepy")).toMatchObject({ duration: 4800, loops: true, brow: "sleepy", lid: 0.7 })
    expect(creaturePose("waiting")).toMatchObject({ duration: 4800, loops: true, lid: 0 })
    expect(creaturePose("thinking")).toMatchObject({ duration: 1500, loops: true, look: [0.75, -0.95] })
    expect(creaturePose("listening")).toMatchObject({ duration: 720, loops: false, brow: "up" })
    expect(creaturePose("poke")).toMatchObject({ duration: 620, loops: false, eyes: "squeeze" })
    expect(creaturePose("stuck")).toMatchObject({ duration: 1000, loops: false, eyeScale: 1.1, brow: "worried" })
    expect(creaturePose("done")).toMatchObject({ duration: 900, loops: false, eyes: "arc" })
  })

  it("overrides every closed face with shut lids, lowered brows and zero duration", () => {
    for (
      const mood of ["happy", "focused", "stuck", "done"] satisfies ReadonlyArray<
        CreatureMood
      >
    ) {
      expect(creaturePose(mood, true)).toMatchObject({ duration: 0, loops: false, lid: 1, brow: "sleepy" })
    }
  })

  it("uses Connect waiting eyes and finished arcs without changing explicit talk poses", () => {
    expect(creatureAgentPose("waiting")).toMatchObject({ brow: "up", eyeScale: 1.08 })
    expect(creatureAgentPose("done")).toMatchObject({ brow: "up", eyes: "arc" })
    expect(creatureAgentPose("working")).toMatchObject({ brow: "focus", lid: 0.36 })
    expect(creaturePose("waiting")).toMatchObject({ brow: "rest", eyeScale: 1 })
    expect(creaturePose("happy")).toMatchObject({ eyes: "open", lower: 0.32 })
  })

  // Connect rev6 draw.P is the ordinary face map; explicit moods retain the richer state-sheet poses.
  it("uses rev6 ordinary rest faces and exact state poses without talk motion", () => {
    for (const state of ["idle", "ready"]) {
      expect(creatureAgentPose(state)).toMatchObject({ brow: "rest", lid: 0, lower: 0, loops: false })
    }
    expect(creatureAgentPose("working")).toMatchObject({ brow: "focus", lid: 0.36, look: [0, 0.6], loops: false })
    expect(creatureAgentPose("waiting")).toMatchObject({ brow: "up", eyeScale: 1.08, loops: false })
    for (const state of ["blocked", "error"]) {
      expect(creatureAgentPose(state)).toMatchObject({ brow: "worried", eyeScale: 1.1, loops: false })
    }
  })

  it("keeps stale half lids distinct from closed lids, with closed taking precedence", () => {
    expect(creaturePose("focused", false, true)).toMatchObject({ lid: 0.5, duration: 0, loops: false })
    expect(creaturePose("focused", true, true)).toMatchObject({ lid: 1, duration: 0, loops: false })
  })
})
