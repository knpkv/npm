import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { agentCharacter } from "../src/character.js"
import { Creature } from "../src/creature.js"

const identities = Array.from({ length: 256 }, (_, index) => `agent-perf-${String(index)}`)
const renderFleet = () =>
  renderToStaticMarkup(
    <>
      {identities.map((id) => (
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

  it("keeps all 256 geometry entries cached across warm directory renders", () => {
    const warmed = identities.map((id) => agentCharacter("perf-host", id))
    for (let render = 0; render < 2; render++) {
      const markup = renderFleet()
      expect(markup.match(/data-creature=""/g)).toHaveLength(identities.length)
      identities.forEach((id, index) => {
        expect(agentCharacter("perf-host", id), id).toBe(warmed[index])
      })
    }
  })
})
