import { describe, expect, it } from "vitest"
import { archiveFixture } from "./superapp-browser/archive-fixture.js"
import { connectFixture } from "./superapp-browser/connect-fixture.js"

/** Reference data uses canonical fixture IDs; ordinary interaction fixtures keep their independent identities. */
describe("Connect Home reference fixtures", () => {
  it("carries the export's stable identities, states and served families", () => {
    const page = connectFixture(1_791_721_200_000, "design")
    expect(page.agents.map(({ host, hue, id, name, state }) => ({ host, id, name, state, hue }))).toEqual([
      { host: "atlas", id: "agent-coord", name: "coord", state: "waiting", hue: "iris" },
      { host: "atlas", id: "agent-release", name: "release", state: "waiting", hue: "lime" },
      { host: "birch", id: "agent-rev-usage", name: "rev-usage", state: "blocked", hue: "moss" },
      { host: "atlas", id: "agent-ds-rly", name: "ds-rly", state: "working", hue: "rose" },
      { host: "atlas", id: "agent-pair-codex", name: "pair-codex", state: "working", hue: "moss" },
      { host: "cedar", id: "agent-sec-cc", name: "sec-cc", state: "working", hue: "rose" },
      { host: "birch", id: "agent-pkgsrc", name: "pkgsrc", state: "done", hue: "ember" }
    ])
    expect(connectFixture(1_791_721_200_000, "normal").agents[0]?.id).toBe("agent-1")
  })

  it("keeps the Ready and archive fixture identities and recorded families", () => {
    const ready = connectFixture(1_791_721_200_000, "designready")
    expect(ready.agents.slice(-2).map(({ host, hue, id, state }) => ({ host, id, state, hue }))).toEqual([
      { host: "atlas", id: "agent-lint-watch", state: "ready", hue: "ember" },
      { host: "birch", id: "agent-docs-sync", state: "idle", hue: "sky" }
    ])
    expect(archiveFixture().agents.map(({ hue, name }) => ({ name, hue }))).toEqual([
      { name: "fix-pins", hue: "teal" },
      { name: "doc-pass", hue: "teal" },
      { name: "probe-cedar", hue: "sky" },
      { name: "tok-audit", hue: "amber" },
      { name: "rev-tabs", hue: "amber" },
      { name: "pair-css", hue: "sky" },
      { name: "seed-data", hue: "amber" }
    ])
  })
})
