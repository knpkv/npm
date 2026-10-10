import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Creature } from "../src/creature.js"
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
  // Behaviour follows the state language rows already use, so a creature never acts out a different state.
  it("takes its behaviour from the agent's state bucket and tone", () => {
    const markup = (state: string) => renderToStaticMarkup(<Creature host="nix" id="a1" size="row" state={state} />)
    expect(markup("working")).toContain('data-bucket="working"')
    expect(markup("waiting")).toContain('data-bucket="needs-you"')
    expect(markup("blocked")).toContain('data-tone="critical"')
    expect(markup("done")).toContain('data-bucket="finished"')
    expect(markup("a-new-state")).toContain('data-bucket="needs-you"')
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
  it("gives every creature on a page its own gradients", () => {
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

  // A gaze not clipped to its eye paints iris over skin when it looks aside; lids painted over the eye show as
  // discs in another shade, so each eye closes as an aperture onto the body beneath.
  it("clips each eye's gaze to its white and closes the eye as an aperture", () => {
    const markup = renderToStaticMarkup(<Creature host="nix" id="a1" size="stage" state="ready" />)
    for (const clip of ["eye", "upper", "lower", "socket"]) {
      expect(markup.match(new RegExp(`clip-path="url\\(#[^)]+-${clip}-\\d\\)"`, "g")), clip).toHaveLength(2)
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
