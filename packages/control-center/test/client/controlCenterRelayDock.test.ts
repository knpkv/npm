import { describe, expect, it } from "@effect/vitest"

import { selectControlCenterRelayCandidate } from "../../src/client/controlCenterRelayDock.js"
import { EntityId } from "../../src/domain/identifiers.js"

const candidate = {
  accountLabel: "Production · AWS 111111111111",
  entityId: EntityId.make("019c3df0-2222-7000-8000-000000000002"),
  title: "PR 184"
}

describe("Control Center Relay locator", () => {
  it("rejects a unique match outside the explicit account constraint", () => {
    expect(selectControlCenterRelayCandidate({ _tag: "found", candidate }, "Development · AWS 222222222222"))
      .toBeUndefined()
  })

  it("selects the exact account from an ambiguous result", () => {
    expect(
      selectControlCenterRelayCandidate({
        _tag: "ambiguous",
        candidates: [candidate, { ...candidate, accountLabel: "Development · AWS 222222222222" }]
      }, "222222222222")?.accountLabel
    ).toBe("Development · AWS 222222222222")
  })
})
