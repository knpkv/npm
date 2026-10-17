import { describe, expect, it } from "@effect/vitest"

import { permissionSummary } from "../../src/client/services/capabilityWords.js"

describe("permissionSummary", () => {
  it("says what the account can do in words, in the order negotiated", () => {
    expect(
      permissionSummary([
        { capabilityId: "entity.read", version: 1, state: "available" },
        { capabilityId: "diff.content", version: 2, state: "available" },
        { capabilityId: "pipeline.logs", version: 1, state: "available" }
      ])
    ).toEqual({ available: "Read items, read file changes, read pipeline logs", disabled: null })
  })

  it("names turned-off operations separately instead of hiding them", () => {
    expect(
      permissionSummary([
        { capabilityId: "entity.read", version: 1, state: "available" },
        { capabilityId: "action.execute", version: 1, state: "disabled" }
      ])
    ).toEqual({ available: "Read items", disabled: "Apply approved changes" })
  })

  it("reports nothing negotiated as no summary at all", () => {
    expect(permissionSummary([])).toEqual({ available: null, disabled: null })
  })
})
