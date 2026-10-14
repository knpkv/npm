import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { agentCharacter } from "../src/character.js"
import { Creature } from "../src/creature.js"

const identities = Array.from({ length: 256 }, (_, index) => `agent-perf-${String(index)}`)
const renderFleet = (ids: ReadonlyArray<string> = identities) =>
  renderToStaticMarkup(
    <>
      {ids.map((id) => (
        <Creature host="perf-host" id={id} key={id} size="row" state="working" />
      ))}
    </>
  )

describe("creature geometry reuse", () => {
  it("reuses canonical host/id geometry across 256 identities and casing changes", () => {
    const first = identities.map((id) => agentCharacter("perf-host", id))
    identities.forEach((id, index) => {
      expect(agentCharacter("PERF-HOST", id), id).toBe(first[index])
    })
    expect(agentCharacter("perf-host", identities[0] ?? "")).not.toBe(agentCharacter("other-host", identities[0] ?? ""))
  })

  it("keeps all 1024 geometry entries cached across full directory renders", () => {
    const fleet = Array.from({ length: 1_024 }, (_, index) => `agent-fleet-${String(index)}`)
    const warmed = fleet.map((id) => agentCharacter("perf-host", id))
    for (let render = 0; render < 2; render++) {
      const markup = renderFleet(fleet)
      expect(markup.match(/data-creature=""/g)).toHaveLength(fleet.length)
      const retained = fleet.filter((id, index) => agentCharacter("perf-host", id) === warmed[index])
      expect(retained).toHaveLength(fleet.length)
    }
  })
})
