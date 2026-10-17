import { describe, expect, it } from "@effect/vitest"

import { permissionSummary } from "../../src/client/services/capabilityWords.js"

describe("permissionSummary", () => {
  it("says what Control Center does with the connection in words, in the order negotiated", () => {
    expect(
      permissionSummary([
        { capabilityId: "entity.read", version: 1, state: "available" },
        { capabilityId: "diff.content", version: 2, state: "available" },
        { capabilityId: "action.cancel", version: 1, state: "available" },
        { capabilityId: "action.reconcile", version: 1, state: "available" }
      ])
    ).toEqual({
      operations: "Read items, read file changes, cancel pending changes, check whether changes were applied",
      paused: false
    })
  })

  // Availability follows the connection's own switch, so every operation pauses together.
  it("marks the operations paused while the connection is turned off", () => {
    expect(
      permissionSummary([
        { capabilityId: "entity.read", version: 1, state: "disabled" },
        { capabilityId: "sync.incremental", version: 1, state: "disabled" }
      ])
    ).toEqual({ operations: "Read items, sync changes", paused: true })
  })

  it("reports nothing negotiated as no operations", () => {
    expect(permissionSummary([])).toEqual({ operations: null, paused: false })
  })
})
