import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WorkSnapshots } from "../src/model.js"
import { workFidelitySnapshots, workFidelityStates } from "./browser/work-fidelity-fixture.js"

// Screenshot data crosses the same boundary as a hub response, including historical detail timestamps.
describe("Work reference fixtures", () => {
  for (const state of workFidelityStates) {
    it(`decodes ${state} through the production snapshot schema`, () => {
      const snapshot = workFidelitySnapshots(state)
      expect(Schema.decodeUnknownSync(WorkSnapshots)(snapshot)).toEqual(snapshot)
    })
  }
})
