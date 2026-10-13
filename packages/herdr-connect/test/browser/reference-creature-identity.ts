import { expect, type Locator } from "@playwright/test"
import { strict as assert } from "node:assert"
import { creaturePalette } from "../../src/character.js"
import { referenceCreatureIdentities } from "../reference-creature-identities.js"

/** Check painted path topology and family paint, rather than trusting decorative metadata. */
export const expectReferenceCreatureIdentity = async (
  creature: Locator,
  host: string,
  name: string,
  closed = false
) => {
  const fixture = referenceCreatureIdentities.find((entry) => entry.host === host && entry.name === name)
  assert(fixture !== undefined, `No recorded identity for ${host}:${name}`)
  await expect(creature, `${host}:${name} has one recorded creature`).toHaveCount(1)
  const path = creature.locator(".connect-creature-body")
  await expect(path, `${host}:${name} has one painted body`).toHaveCount(1)
  const topology = await path.evaluate((node) => {
    const d = node.getAttribute("d") ?? ""
    return { arcs: d.match(/A/g)?.length ?? 0, cubics: d.match(/C/g)?.length ?? 0, corners: d.match(/Q/g)?.length ?? 0 }
  })
  const expected = {
    circle: { arcs: 2, cubics: 0, corners: 0 },
    squircle: { arcs: 0, cubics: 36, corners: 0 },
    pear: { arcs: 0, cubics: 0, corners: 4 },
    star: { arcs: 0, cubics: 0, corners: 10 },
    bean: { arcs: 0, cubics: 32, corners: 0 }
  }
  expect(topology, `${host}:${name} is ${fixture.bodyKind} in rev6`).toEqual(expected[fixture.bodyKind])
  await expect(path, `${host}:${name} carries the served ${fixture.family} family`).toHaveAttribute(
    "fill",
    creaturePalette(host, name, fixture.family, closed ? 0.1 : 1).p46
  )
}
