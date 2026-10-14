// @vitest-environment happy-dom

import { Result, Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ConnectHomeArchive } from "../src/archive-home.js"
import { ConnectHomeDirectory } from "../src/home-directory.js"
import type { ConnectAgentHue } from "../src/model.js"
import { ConnectAgent, ConnectArchivePage } from "../src/model.js"
import { pin, type Pins } from "../src/pins.js"
import { AgentCast, AgentStage, PinnedAgents } from "../src/stage.js"
import { AgentDirectory, connectAgentKey } from "../src/view.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const palettes: ReadonlyArray<{ readonly label: string; readonly hue?: ConnectAgentHue; readonly ink: string }> = [
  { label: "absent served hue keeps the name hash", ink: "#3d0f18" },
  { label: "served sky wins over the rose hash", hue: "sky", ink: "#022538" }
]
const liveAgent = (hue?: ConnectAgentHue): ConnectAgent => {
  const agent = Schema.decodeUnknownSync(ConnectAgent)({
    host: "atlas",
    id: "agent-134",
    name: "sec-cc",
    kind: "worker",
    state: "waiting",
    work: "package-work",
    lastActivityAt: 1
  })
  return hue === undefined ? agent : { ...agent, hue }
}

const pinsFor = (agent: ConnectAgent): Pins =>
  Result.getOrThrow(
    pin(
      [],
      {
        host: agent.host,
        id: agent.id,
        key: connectAgentKey(agent),
        name: agent.name
      },
      0
    )
  )
const inkIn = (markup: string) => /--connect-creature-ink:([^;]+)/.exec(markup)?.[1]

/** Exercise surface owners, not just the already-tested Creature override. */
describe("creature identity across Connect surfaces", () => {
  const surfaces = [
    {
      label: "Home row",
      render: (agent: ConnectAgent) => (
        <ConnectHomeDirectory
          agents={[agent]}
          activityFilter="all"
          hostFilter={null}
          onActivityFilter={() => {}}
          onHostFilter={() => {}}
          onSelect={() => {}}
          query=""
          selectedKey={null}
          timeZone="UTC"
        />
      )
    },
    {
      label: "Fleet row",
      render: (agent: ConnectAgent) => (
        <AgentDirectory
          agents={[agent]}
          activityFilter="all"
          hostFilter={null}
          onActivityFilter={() => {}}
          onHostFilter={() => {}}
          onSelect={() => {}}
          query=""
          selectedKey={null}
          stale={false}
          timeZone="UTC"
        />
      )
    },
    { label: "Cast", render: (agent: ConnectAgent) => <AgentCast agents={[agent]} onOpen={() => {}} stale={false} /> },
    {
      label: "Pin",
      render: (agent: ConnectAgent) => (
        <PinnedAgents
          agentFor={() => agent}
          now={0}
          onOpen={() => {}}
          onUnpin={() => {}}
          pins={pinsFor(agent)}
          placement="float"
          stale={false}
        />
      )
    }
  ]
  for (const surface of surfaces) {
    it.each(palettes)(`${surface.label}: $label`, ({ hue, ink }) => {
      expect(inkIn(renderToStaticMarkup(surface.render(liveAgent(hue))))).toBe(ink)
    })
  }

  it.each(palettes)("Home archive snapshot: $label", ({ hue, ink }) => {
    const snapshot = {
      host: "atlas",
      agentId: "agent-134",
      name: "sec-cc",
      kind: "worker",
      state: "working",
      work: "package-work",
      firstSeenAt: 1,
      closedAt: 20
    }
    const page = Schema.decodeUnknownSync(ConnectArchivePage)({
      agents: [hue === undefined ? snapshot : { ...snapshot, hue }],
      nextCursor: null
    })

    const markup = renderToStaticMarkup(
      <ConnectHomeArchive page={page} failed={false} loading={false} open={() => {}} request={() => {}} />
    )
    expect(inkIn(markup)).toBe(`oklch(from ${ink} l calc(c * 0.1) h)`)
  })

  for (const presentation of ["fleet", "home"] satisfies ReadonlyArray<"fleet" | "home">) {
    it.each(palettes)(`${presentation} stage and its crew: $label`, async ({ hue, ink }) => {
      const parent = liveAgent(hue)
      const fields = {
        ...parent,
        id: "agent-child",
        name: "ds-rly",
        relationship: { parentAgentId: parent.id, relation: "delegated" }
      }
      const child = Schema.decodeUnknownSync(ConnectAgent)(hue === undefined ? fields : { ...fields, hue: "ember" })
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      try {
        await act(async () =>
          root.render(
            <AgentStage
              agent={parent}
              crew={[child]}
              onClose={() => {}}
              onOpen={() => {}}
              onOpenTerminal={() => {}}
              onPinChange={() => {}}
              pinned={false}
              presentation={presentation}
              stale={false}
              workGoal={{ _tag: "missing" }}
            />
          )
        )
        const hero = document.querySelector<SVGElement>(".connect-stage-hero .connect-creature")
        const crew = document.querySelector<SVGElement>(".connect-stage-crew-member .connect-creature")
        expect(hero?.style.getPropertyValue("--connect-creature-ink")).toBe(ink)
        expect(crew?.style.getPropertyValue("--connect-creature-ink")).toBe(hue === undefined ? "#1c1c41" : "#3a1500")
      } finally {
        await act(async () => root.unmount())
        host.remove()
      }
    })
  }

  it.each(palettes)("Overflow pin: $label", async ({ hue, ink }) => {
    const agent = liveAgent(hue)
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <PinnedAgents
            agentFor={() => agent}
            now={0}
            onOpen={() => {}}
            onUnpin={() => {}}
            pins={pinsFor(agent)}
            placement="float"
            room={0}
            stale={false}
          />
        )
      )
      const more = host.querySelector<HTMLButtonElement>(".connect-pins-more")
      expect(more).not.toBeNull()
      await act(async () => more?.click())
      const creature = host.querySelector<SVGElement>(".connect-pins-entry .connect-creature")
      expect(creature?.style.getPropertyValue("--connect-creature-ink")).toBe(ink)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
