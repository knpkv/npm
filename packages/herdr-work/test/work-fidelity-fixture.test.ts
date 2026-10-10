import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WorkSnapshots } from "../src/model.js"
import { workTriage } from "../src/work-triage.js"
import { workFidelitySnapshots, workFidelityStates } from "./browser/work-fidelity-fixture.js"

// Screenshot data crosses the same boundary as a hub response, including historical detail timestamps.
describe("Work reference fixtures", () => {
  it("adds the long goal to the complete board, with honest response and finished cuts", () => {
    const snapshot = workFidelitySnapshots("3o").now
    expect(snapshot.goals).toHaveLength(13)
    expect(snapshot.goalsOmitted).toBe(10)
    expect(snapshot.finishedOmitted).toBe(9)
    expect(snapshot.goals.filter(({ id }) => id !== "long").map(({ id }) => id)).toEqual(
      workFidelitySnapshots("3a").now.goals.map(({ id }) => id)
    )
    expect(workTriage(snapshot).rows.find(({ goal }) => goal.id === "long")?.group).toBe("needs-you")
  })
  for (const state of workFidelityStates) {
    it(`decodes ${state} through the production snapshot schema`, () => {
      const snapshot = workFidelitySnapshots(state)
      expect(Schema.decodeUnknownSync(WorkSnapshots)(snapshot)).toEqual(snapshot)
    })
  }
})
