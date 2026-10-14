import { performance } from "node:perf_hooks"
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

  it("renders a warmed 256-agent directory within the 250ms polling budget", () => {
    renderFleet()
    const started = performance.now()
    const markup = renderFleet()
    const elapsed = performance.now() - started
    expect(markup.match(/data-creature=""/g)).toHaveLength(256)
    expect(elapsed, `256 warm renders took ${elapsed.toFixed(1)}ms`).toBeLessThan(250)
  })
})
