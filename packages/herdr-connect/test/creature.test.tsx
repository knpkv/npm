import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Creature, type CreatureAccessory, type CreatureMood } from "../src/creature.js"
import { agentCharacter, FOOT } from "../src/character.js"
import { ConnectAgent } from "../src/model.js"
import { AgentDirectory } from "../src/view.js"

const agent = (id: string, state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "claude",
    lastActivityAt: 1_000,
    name: id,
    state,
    work: "npm"
  })

const directory = (agents: ReadonlyArray<ReturnType<typeof agent>>, stale: boolean) =>
  renderToStaticMarkup(
    <AgentDirectory
      activityFilter="all"
      agents={agents}
      hostFilter={null}
      onActivityFilter={() => undefined}
      onHostFilter={() => undefined}
      onSelect={() => undefined}
      query=""
      selectedKey={null}
      stale={stale}
      timeZone="UTC"
    />
  )

describe("Creature", () => {
  it("ignores stage-only reactions on rows and cast, including their ordinary pose and overlays", () => {
    for (const size of ["row", "cast"] satisfies ReadonlyArray<"row" | "cast">) {
      for (const state of ["idle", "working", "done"]) {
        const ordinary = renderToStaticMarkup(<Creature host="atlas" id="agent-one" size={size} state={state} />)
        for (const reaction of ["poke", "listening"] satisfies ReadonlyArray<"poke" | "listening">) {
          const reacted = renderToStaticMarkup(
            <Creature host="atlas" id="agent-one" size={size} state={state} reaction={reaction} reactionKey={2} />
          )
          expect(reacted, `${size}/${state}/${reaction}`).toBe(ordinary)
        }
      }
    }
    expect(
      renderToStaticMarkup(<Creature host="atlas" id="agent-one" size="stage" state="idle" reaction="poke" />)
    ).toContain('data-mood="poke"')
  })

  it("uses worried for ordinary blocked/error agents and keeps the talking stuck pose", () => {
    for (const state of ["blocked", "error"]) {
      expect(renderToStaticMarkup(<Creature host="fixture-host" id="one" size="stage" state={state} />)).toContain(
        'data-mood="worried"'
      )
      expect(
        renderToStaticMarkup(<Creature host="fixture-host" id="one" size="stage" state={state} talking />)
      ).toContain('data-mood="stuck"')
    }
  })

  it("keeps ordinary idle and ready faces free of sleepy and happy overlays", () => {
    for (const state of ["idle", "ready"]) {
      const markup = renderToStaticMarkup(<Creature host="atlas" id="agent-pair-codex" size="row" state={state} />)
      expect(markup).not.toContain('class="connect-creature-z"')
      expect(markup).not.toContain('data-lidded=""')
      expect(markup).toContain("--connect-creature-lower:0;")
      expect(markup).not.toContain('data-loop=""')
    }
    expect(
      renderToStaticMarkup(<Creature host="atlas" id="agent-pair-codex" size="row" state="idle" mood="sleepy" />)
    ).toContain('class="connect-creature-z"')
    // Ordinary faces are still, but each working orbit keeps its negative per-agent phase.
    const phases = ["agent-ds-rly", "agent-sec-cc"].map((id) =>
      Number(
        /--connect-creature-phase:([^m]+)/.exec(
          renderToStaticMarkup(<Creature host="atlas" id={id} size="row" state="working" />)
        )?.[1]
      )
    )
    expect(phases.every((phase) => phase < 0)).toBe(true)
    expect(new Set(phases).size).toBe(2)
  })

  // Rev6 rings are circles, including wide beans; the square frame already reserves the longer axis.
  it("uses circular row rings without changing the fixed slot or clipping stroke", () => {
    const markup = renderToStaticMarkup(<Creature host="atlas" id="agent-ds-rly" size="row" state="working" />)
    const ring = /class="connect-creature-halo"[^>]+rx="([^"]+)" ry="([^"]+)"/.exec(markup)
    expect(ring).not.toBeNull()
    expect(ring?.[1]).toBe(ring?.[2])
  })

  it("keeps the done agent's happy arcs after mounting an already finished state", () => {
    const markup = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="row" state="done" />)
    expect(markup.match(/class="connect-creature-eye-mark" data-eyes="arc"/g)).toHaveLength(2)
  })

  it("uses half lids for stale agents and full lids for archived agents", () => {
    const stale = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="row" state="working" stale />)
    const closed = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="row" state="working" closed />)
    expect(stale).not.toContain("--connect-creature-open:1;")
    expect(stale).not.toContain("calc(c * 0.35)")
    expect(closed).toContain("--connect-creature-open:1;")
  })

  it("keeps the live seeded outline in a closed record and defaults to the live presentation", () => {
    for (const size of ["row", "cast", "stage"] satisfies ReadonlyArray<"row" | "cast" | "stage">) {
      const live = renderToStaticMarkup(<Creature host="fixture-host" id="agent-134" size={size} state="working" />)
      const closed = renderToStaticMarkup(
        <Creature closed host="fixture-host" id="agent-134" size={size} state="working" />
      )
      const outline = (markup: string) => /class="connect-creature-body" d="([^"]+)"/.exec(markup)?.[1]
      expect(outline(live)).toBeDefined()
      expect(outline(closed)).toBe(outline(live))
      expect(live).not.toContain("data-closed")
      expect(closed).toContain('data-closed=""')
      expect(closed).toContain("calc(c * 0.1)")
    }
  })
  // Behaviour follows the state language rows already use, so a creature never acts out a different state.
  it("takes its behaviour from the agent's state bucket and tone", () => {
    const markup = (state: string) => renderToStaticMarkup(<Creature host="nix" id="a1" size="row" state={state} />)
    expect(markup("working")).toContain('data-bucket="working"')
    expect(markup("waiting")).toContain('data-bucket="needs-you"')
    expect(markup("blocked")).toContain('data-tone="critical"')
    expect(markup("done")).toContain('data-bucket="finished"')
    expect(markup("a-new-state")).toContain('data-bucket="needs-you"')
  })

  // The same row root is used in 36px rows, 32px pins and 28px crew pills; identity cannot change its slot.
  it("keeps row roots and viewBoxes square for tall and wide outlines", () => {
    const fixtures: ReadonlyArray<readonly [string, string]> = [
      ["fixture-host", "agent-134"],
      ["atlas", "agent-ds-rly"],
      ["birch", "agent-pkgsrc"]
    ]
    for (const [host, id] of fixtures) {
      const markup = renderToStaticMarkup(<Creature host={host} id={id} size="row" state="working" />)
      const root = markup.slice(0, markup.indexOf(">"))
      expect(root).toContain('height="36"')
      expect(root).toContain('width="36"')
      const box = /viewBox="([^"]+)"/.exec(root)?.[1]?.split(" ").map(Number)
      expect(box).toHaveLength(4)
      expect(box?.[2]).toBe(box?.[3])
      expect((box?.[0] ?? 0) + (box?.[2] ?? 0) / 2).toBeCloseTo(50, 1)
    }
  })

  // Head overlays paint outside the fitted ring; switching moods must not shrink the list body.
  it("keeps the same row body framing when a head overlay appears", () => {
    const frame = (mood: CreatureMood) =>
      /viewBox="([^"]+)"/.exec(
        renderToStaticMarkup(<Creature host="fixture-host" id="drawing-1" size="row" state="working" mood={mood} />)
      )?.[1]
    expect(frame("stuck")).toBe(frame("happy"))
    expect(frame("focused")).toBe(frame("happy"))
  })

  // Export 66 RelayAgent draws all Home row states in -6 -6 44 44; Fleet has its own tighter track.
  it("frames live and closed Home rows at 44 design units without changing Fleet rows", () => {
    for (const closed of [false, true]) {
      for (const id of ["agent-pair-codex", "agent-rev-auth", "agent-ds-rly"]) {
        const { unit } = agentCharacter("atlas", id)
        const frame = (statePolicy: "home" | "fleet") =>
          /viewBox="([^"]+)"/
            .exec(
              renderToStaticMarkup(
                <Creature closed={closed} host="atlas" id={id} size="row" state="working" statePolicy={statePolicy} />
              )
            )?.[1]
            ?.split(" ")
            .map(Number)
        const home = frame("home")
        expect(home).toHaveLength(4)
        expect(home?.[0]).toBeCloseTo(50 - 22 * unit, 2)
        expect(home?.[1]).toBeCloseTo(FOOT - 36.75 * unit, 2)
        expect(home?.[2]).toBeCloseTo(44 * unit, 2)
        expect(home?.[3]).toBeCloseTo(44 * unit, 2)
        expect(home).not.toEqual(frame("fleet"))
      }
    }
  })

  // Rev6 closedCr rows have no ring and use the exported 0 2 32 32 body frame.
  it("frames archived row bodies at the reference's 32 design units", () => {
    for (const id of ["agent-pair-codex", "agent-rev-auth", "agent-ds-rly"]) {
      const { unit } = agentCharacter("atlas", id)
      const markup = renderToStaticMarkup(<Creature closed host="atlas" id={id} size="row" state="working" />)
      const frame = /viewBox="([^"]+)"/.exec(markup)?.[1]?.split(" ").map(Number)
      expect((frame?.[2] ?? 0) / unit).toBeCloseTo(32, 3)
    }
  })

  // The ring fits the body; headwear and marks must not shrink its row, pin or crew presentation.
  it("meets the body floors in every row slot, including accessories", () => {
    for (const id of Array.from({ length: 64 }, (_, index) => `drawing-${String(index)}`)) {
      const {
        bounds: [, , width, height]
      } = agentCharacter("fixture-host", id)
      for (const accessory of [
        "none",
        "headphones",
        "hard-hat",
        "scarf",
        "glasses"
      ] satisfies ReadonlyArray<CreatureAccessory>) {
        const markup = renderToStaticMarkup(
          <Creature host="fixture-host" id={id} size="row" state="working" accessory={accessory} />
        )
        const frame = /viewBox="([^"]+)"/.exec(markup)?.[1]?.split(" ").map(Number)
        expect(frame).toHaveLength(4)
        const edge = frame?.[2] ?? Infinity
        for (const track of [28, 32, 36]) {
          expect((width / edge) * track).toBeGreaterThanOrEqual(track * 0.58)
          expect((Math.max(width, height) / edge) * track).toBeGreaterThanOrEqual(track * 0.7)
        }
      }
    }
  })

  // Decorative: the row's words already say the state, so assistive technology hears it once.
  it("is hidden from assistive technology and keeps its look across states", () => {
    const working = renderToStaticMarkup(<Creature host="nix" id="a1" size="row" state="working" />)
    const done = renderToStaticMarkup(<Creature host="nix" id="a1" size="row" state="done" />)
    expect(working).toContain('aria-hidden="true"')
    const body = (markup: string) => /class="connect-creature-body" d="([^"]+)"/.exec(markup)?.[1]
    expect(body(working)).toBeDefined()
    expect(body(working)).toBe(body(done))
  })

  // Ids built from host and ID collide once cleaned ("a.b" and "a_b"), and one creature then wears another's colours.
  it("gives every creature on a page its own clip references", () => {
    const markup = renderToStaticMarkup(
      <>
        <Creature host="a.b" id="x" size="row" state="working" />
        <Creature host="a_b" id="x" size="row" state="working" />
      </>
    )
    const ids = [...markup.matchAll(/<(?:radialGradient|linearGradient|clipPath)[^>]* id="([^"]+)"/g)].map(
      (match) => match[1]
    )
    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // A face inside a scaling group stretches with the body: that is the squashed-eye look this rig exists to avoid.
  it("keeps the face out of every group that scales", () => {
    const markup = renderToStaticMarkup(<Creature arrived host="nix" id="a1" size="stage" state="waiting" />)
    const face = markup.indexOf('class="connect-creature-face"')
    const squash = markup.indexOf('class="connect-creature-squash"')
    expect(face).toBeGreaterThan(-1)
    expect(squash).toBeGreaterThan(-1)
    // The body's groups close before the face opens: the face is their sibling, not their child.
    const body = markup.slice(squash, face)
    expect(body.split("<g").length).toBe(body.split("</g>").length)
  })

  it("draws two open quadratic brow strokes in the face, using the palette ink", () => {
    const markup = renderToStaticMarkup(<Creature host="nix" id="a1" size="stage" state="working" />)
    const brows = [...markup.matchAll(/<path class="connect-creature-brow"[^>]*>/g)].map(([path]) => path)
    expect(brows).toHaveLength(2)
    expect(brows[0]).toContain('data-side="l"')
    expect(brows[1]).toContain('data-side="r"')
    for (const path of brows) expect(path).toMatch(/d="M[\d. ]+Q[\d. ]+"/)
    const bob = markup.indexOf('class="connect-creature-bob"')
    expect(bob).toBeGreaterThan(-1)
    const face = markup.slice(bob)
    expect(face.match(/class="connect-creature-brow"/g)).toHaveLength(2)
    expect(face).not.toContain('class="connect-creature-breath"')
    expect(markup).toContain("--connect-creature-ink:")
  })

  // A gaze not clipped to its eye paints iris over skin when it looks aside; lids painted over the eye show as
  // discs in another shade, so each eye closes as an aperture onto the body beneath.
  it("clips each eye's gaze to its white and closes the eye as an aperture", () => {
    const markup = renderToStaticMarkup(<Creature host="nix" id="a1" size="stage" state="ready" />)
    for (const clip of ["eye", "upper", "lower", "socket"]) {
      expect(markup.match(new RegExp(`clip-path="url\\(#[^)]+-${clip}-\\d\\)"`, "g")), clip).toHaveLength(2)
    }
  })

  it("gates mouths to a talking stage and retains blush for every ordinary agent", () => {
    const stage = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="stage" state="working" talking />)
    expect(stage).toContain('class="connect-creature-mouth"')
    for (const size of ["row", "cast"] satisfies ReadonlyArray<"row" | "cast">) {
      const markup = renderToStaticMarkup(<Creature host="fixture-host" id="one" size={size} state="working" talking />)
      expect(markup).not.toContain('class="connect-creature-mouth"')
      expect(markup.match(/class="connect-creature-blush"/g)).toHaveLength(2)
      expect(markup).not.toContain('data-talking=""')
    }
  })

  it("keeps closed identity but closes the lids, desaturates the paint and disables talk", () => {
    const closed = renderToStaticMarkup(
      <Creature closed host="fixture-host" id="one" size="stage" state="blocked" talking />
    )
    const live = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="stage" state="working" />)
    const body = (markup: string) => /class="connect-creature-body" d="([^"]+)"/.exec(markup)?.[1]
    expect(body(closed)).toBe(body(live))
    expect(closed).toContain('data-closed=""')
    expect(closed).toContain("--connect-creature-open:1;")
    expect(closed).toContain("calc(c * 0.1)")
    expect(closed).not.toContain('data-talking=""')
    expect(closed).not.toContain('class="connect-creature-mouth"')
    expect(closed).not.toContain('class="connect-creature-question"')
  })

  it("defaults accessories to none and draws only the closed agent accessory set", () => {
    const plain = renderToStaticMarkup(<Creature host="fixture-host" id="one" size="row" state="ready" />)
    expect(plain).not.toContain('class="connect-creature-accessory"')
    for (const accessory of [
      "none",
      "headphones",
      "hard-hat",
      "scarf",
      "glasses"
    ] satisfies ReadonlyArray<CreatureAccessory>) {
      const markup = renderToStaticMarkup(
        <Creature accessory={accessory} host="fixture-host" id="one" size="row" state="ready" />
      )
      expect(markup.includes('class="connect-creature-accessory"')).toBe(accessory !== "none")
    }
  })

  it("uses the agent name for hash colour and lets a served family override it on every slot", () => {
    for (const size of ["row", "cast", "stage"] satisfies ReadonlyArray<"row" | "cast" | "stage">) {
      const markup = renderToStaticMarkup(
        <Creature host="atlas" id="agent-ds-rly" name="ds-rly" size={size} state="working" />
      )
      expect(markup).toContain('fill="#7173d7"')
      expect(
        renderToStaticMarkup(
          <Creature host="atlas" hueFamily="rose" id="agent-ds-rly" name="ds-rly" size={size} state="working" />
        )
      ).toContain('fill="#cd4f66"')
    }
  })

  it("draws every row's agent, and marks them all stale when the directory couldn't refresh", () => {
    const agents = [agent("agent-one", "working"), agent("agent-two", "waiting")]
    const fresh = directory(agents, false)
    expect(fresh.match(/class="connect-creature"/g)).toHaveLength(2)
    expect(fresh).not.toContain("data-stale")
    expect(directory(agents, true).match(/class="connect-creature"[^>]*data-stale=""/g)).toHaveLength(2)
  })
})
