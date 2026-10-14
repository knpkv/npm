import { describe, expect, it } from "vitest"

import { agentCharacter } from "../src/character.js"

const identities = Array.from({ length: 256 }, (_, index) => `agent-perf-${String(index)}`)

describe("creature geometry reuse", () => {
  it("reuses canonical host/id geometry across 256 identities and casing changes", () => {
    const first = identities.map((id) => agentCharacter("perf-host", id))
    identities.forEach((id, index) => {
      expect(agentCharacter("PERF-HOST", id), id).toBe(first[index])
    })
    expect(agentCharacter("perf-host", identities[0] ?? "")).not.toBe(agentCharacter("other-host", identities[0] ?? ""))
  })

  it("reuses all 1024 warmed geometry entries on the next directory pass", () => {
    const fleet = Array.from({ length: 1_024 }, (_, index) => `agent-fleet-${String(index)}`)
    const warmed = fleet.map((id) => agentCharacter("perf-host", id))
    const next = fleet.map((id) => agentCharacter("perf-host", id))
    const retained = next.filter((character, index) => character === warmed[index])
    expect(retained).toHaveLength(fleet.length)
  })
})
