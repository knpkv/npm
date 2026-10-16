import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentTaskKind } from "@knpkv/herdr-fleet/model"
import { agentCharacter, creatureBodySeed, FOOT } from "../src/character.js"
import { Creature, type CreatureSize } from "../src/creature.js"

describe("typed task motion", () => {
  it("renders the reading pose from typed evidence, without changing identity", () => {
    const draw = (taskKind?: "reading") =>
      renderToStaticMarkup(
        <Creature host="build-01" id="agent-builder-alpha" size="stage" state="working" taskKind={taskKind} />
      )
    const reading = draw("reading")
    expect(reading).toContain('data-task-kind="reading"')
    expect(reading).toContain("connect-creature-task-lean")
    expect(reading).not.toContain("connect-creature-mouth")
    expect(draw()).not.toContain('data-task-kind="reading"')
  })
  it("lets urgent lifecycle evidence override an incompatible debounced kind", () => {
    const waiting = renderToStaticMarkup(
      <Creature host="build-01" id="agent-builder-alpha" size="stage" state="blocked" taskKind="waiting" />
    )
    const finished = renderToStaticMarkup(
      <Creature host="build-01" id="agent-builder-alpha" size="stage" state="done" taskKind="blocked" />
    )
    expect(waiting).toContain('data-task-kind="blocked"')
    expect(finished).toContain('data-task-kind="done"')
    const blocked = renderToStaticMarkup(
      <Creature host="build-01" id="agent-builder-alpha" size="stage" state="blocked" taskKind="blocked" />
    )
    expect(blocked).toContain('data-task-kind="blocked"')
    for (const state of ["blocked", "done"]) {
      const failing = renderToStaticMarkup(
        <Creature host="build-01" id="agent-builder-alpha" size="stage" state={state} taskKind="failing" />
      )
      expect(failing).toContain('data-task-kind="failing"')
    }
    const unknown = renderToStaticMarkup(
      <Creature host="build-01" id="agent-builder-alpha" size="stage" state="future-state" taskKind="reading" />
    )
    expect(unknown).toContain('data-task-kind="reading"')
  })

  it("uses page13's family tone for typing ticks instead of the body's highlight", () => {
    const markup = renderToStaticMarkup(
      <Creature
        host="build-01"
        id="agent-builder-alpha"
        hueFamily="ember"
        size="stage"
        state="working"
        taskKind="writing"
      />
    )
    expect(markup).toMatch(/class="connect-creature-task-ticks"[^>]*stroke="#b54e0b"/)
  })

  it("hangs typing ticks off the seed's top and draws them at the reference's detail level", () => {
    const character = agentCharacter("build-01", "agent-builder-alpha")
    const seed = creatureBodySeed(character.bodyKind)
    // relay-creature-states: T = y0 (seed top); L and stroke are 1.8/0.55 at lvl >= 2, 2.4/1 at lvl 1 (under 64 px).
    const seedTop = FOOT - seed.height * character.unit
    for (const [size, length, stroke] of [
      ["stage", 1.8, 0.55],
      ["row", 2.4, 1],
      ["cast", 2.4, 1]
    ] satisfies ReadonlyArray<readonly [CreatureSize, number, number]>) {
      const markup = renderToStaticMarkup(
        <Creature host="build-01" id="agent-builder-alpha" size={size} state="working" taskKind="writing" />
      )
      const still =
        /class="connect-creature-task-still">[\s\S]*?<path class="connect-creature-task-ticks"([^>]*)>/.exec(
          markup
        )?.[1] ?? ""
      const width = Number(/stroke-width="([^"]+)"/.exec(still)?.[1])
      const [, , y, dx, dy] = /d="M([^ ]+) ([^l]+)l([^ ]+) ([^M"]+)/.exec(still)?.map(Number) ?? []
      expect(width).toBeCloseTo(stroke * character.unit, 3)
      expect(y).toBeCloseTo(seedTop + 3.5 * character.unit, 3)
      expect(Math.hypot(dx ?? 0, dy ?? 0)).toBeCloseTo(length * character.unit, 2)
    }
  })

  for (const taskKind of [
    "writing",
    "testing",
    "waiting",
    "blocked",
    "failing",
    "done",
    "unknown"
  ] satisfies ReadonlyArray<AgentTaskKind>) {
    it(`renders the ${taskKind} vocabulary at stage and row sizes`, () => {
      for (const size of ["stage", "row", "cast"] satisfies ReadonlyArray<"stage" | "row" | "cast">) {
        const markup = renderToStaticMarkup(
          <Creature host="build-01" id="agent-builder-alpha" size={size} state="working" taskKind={taskKind} />
        )
        expect(markup).toContain(`data-task-kind="${taskKind}"`)
        expect(markup).not.toContain("connect-creature-mouth")
      }
    })
  }
})
