import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { resolveLegacyLaneClaim } from "../src/internal/legacy-lane-claim.js"
import { WorkLaneClaimed } from "../src/model.js"

const lane = (fields: Partial<typeof WorkLaneClaimed.Encoded>): WorkLaneClaimed =>
  Schema.decodeUnknownSync(WorkLaneClaimed)({
    branch: "feat/legacy",
    expectedRevision: 0,
    goalId: "goal:legacy",
    head: "0123456789012345678901234567890123456789",
    laneId: "goal:legacy",
    operationId: "goal:legacy",
    owner: { id: "owner:legacy", name: "Legacy owner" },
    parent: null,
    phase: "implementation",
    revision: 1,
    worktree: "/worktrees/legacy",
    ...fields
  })

/** A legacy claim as the migration first reads it: both ids are the lane id. */
const legacy = lane({})
const bound = lane({ goalId: "goal:bound", operationId: "dispatch:sol" })

describe("resolveLegacyLaneClaim", () => {
  it("keeps the lane id when no running binding recorded the lane at the claim's revision", () => {
    expect(resolveLegacyLaneClaim(legacy, [])).toEqual({ _tag: "claim", lane: legacy })
    expect(resolveLegacyLaneClaim(legacy, [lane({ laneId: "goal:other", operationId: "dispatch:other" })]))
      .toEqual({ _tag: "claim", lane: legacy })
  })

  it("keeps the lane-id operation but takes the lane's goal when the claim moved past its bindings", () => {
    // The lane moved on after the binding: the binding is one revision behind.
    const advanced = lane({ expectedRevision: 1, revision: 2 })
    expect(resolveLegacyLaneClaim(advanced, [bound])).toEqual({
      _tag: "claim",
      lane: lane({ expectedRevision: 1, goalId: "goal:bound", revision: 2 })
    })
  })

  it("rejects a moved-past claim whose earlier bindings disagree on the lane's goal", () => {
    const advanced = lane({ expectedRevision: 1, revision: 2 })
    const otherGoal = lane({ goalId: "goal:other", operationId: "dispatch:luna" })
    expect(resolveLegacyLaneClaim(advanced, [bound, otherGoal])).toEqual({
      _tag: "ambiguous",
      bound: [bound, otherGoal],
      lane: advanced
    })
  })

  it("adopts the bound lane, ids included, when it agrees with every recorded field", () => {
    expect(resolveLegacyLaneClaim(legacy, [bound, bound])).toEqual({ _tag: "claim", lane: bound })
  })

  it("rejects two different bound lanes at the claim's revision", () => {
    const other = lane({ operationId: "dispatch:luna" })
    expect(resolveLegacyLaneClaim(legacy, [bound, other])).toEqual({
      _tag: "ambiguous",
      bound: [bound, other],
      lane: legacy
    })
  })

  it("rejects a bound lane that disagrees with a field the legacy claim recorded", () => {
    const moved = lane({ operationId: "dispatch:sol", phase: "validation" })
    expect(resolveLegacyLaneClaim(legacy, [moved])).toEqual({ _tag: "mismatch", bound: moved, lane: legacy })
  })
})
