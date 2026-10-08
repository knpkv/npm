import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ConnectAgent } from "../src/model.js"
import { AgentDirectory, ConnectSummary } from "../src/view.js"

const agent = (id: string, state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "SER8",
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "codex",
    lastActivityAt: 1_000,
    name: `Agent ${id}`,
    state,
    work: "npm"
  })

const fleet = [agent("agent-a", "working"), agent("agent-b", "blocked"), agent("agent-c", "done")]

const summary = (props: Parameters<typeof ConnectSummary>[0]): string =>
  renderToStaticMarkup(<ConnectSummary {...props} />)

describe("Connect summary", () => {
  it("says how many agents are live, how many need attention, and which hosts are offline", () => {
    const markup = summary({ agents: fleet, offlineHosts: ["GAMMA"], unavailable: false })
    // The count says what it counts: listed agents, and how many of them are working.
    expect(markup).toContain("3 agents, 1 working")
    expect(markup).toContain(">1 needs attention<")
    expect(markup).toContain(">GAMMA offline<")
    expect(markup).toContain('aria-label="Connect summary"')
  })

  it("leaves out attention and offline hosts when there are none", () => {
    const markup = summary({ agents: [fleet[0] ?? agent("agent-a", "working")], offlineHosts: [], unavailable: false })
    expect(markup).toContain("1 agent, 1 working")
    expect(markup).not.toContain("attention")
    expect(markup).not.toContain("offline")
  })

  it("says the directory is unavailable rather than claiming zero agents", () => {
    expect(summary({ agents: null, offlineHosts: [], unavailable: true })).toContain(
      "The fleet directory is unavailable"
    )
    expect(summary({ agents: null, offlineHosts: [], unavailable: false })).toContain("Loading the fleet")
  })
})

describe("AgentDirectory rows", () => {
  it("show the state as the shared icon label, with no presence dot", () => {
    const markup = renderToStaticMarkup(
      <AgentDirectory
        activityFilter="all"
        agents={fleet}
        hostFilter={null}
        onActivityFilter={() => undefined}
        onHostFilter={() => undefined}
        onSelect={() => undefined}
        query=""
        selectedKey={null}
      />
    )
    expect(markup).not.toContain("agent-presence")
    // The shared state language: a blocked agent counts as needing you and reads "Blocked" beside its icon.
    expect(markup).toMatch(/class="connect-agent-state" data-activity="needs-you"><span[^>]*>.*<svg.*Blocked</)
    expect(markup).toContain(">Working<")
    // The label beside it carries the state; the work line names only relation and work.
    expect(markup).not.toMatch(/(Working|Ready|Needs attention|Last active) in /)
  })

  it("name a listed parent and shorten an unlisted one instead of printing its full hash", () => {
    const parent = agent("agent-1f49bd901df108248299", "working")
    const child = Schema.decodeUnknownSync(ConnectAgent)({
      host: "SER8",
      id: Schema.decodeUnknownSync(AgentStableId)("agent-child"),
      kind: "claude",
      lastActivityAt: 1_000,
      name: "pair-claude",
      relationship: { parentAgentId: "agent-1f49bd901df108248299", relation: "review" },
      state: "working",
      work: "npm"
    })
    const render = (agents: ReadonlyArray<typeof child>) =>
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
        />
      )
    expect(render([parent, child])).toContain(
      'review for <span class="connect-token">Agent agent-1f49bd901df108248299</span>'
    )
    const orphan = render([child])
    expect(orphan).toContain('<span class="connect-token">agent-1f49bd90…</span>')
    expect(orphan).not.toContain("agent-1f49bd901df108248299")
  })

  it("repeat the host on a row only when the directory lists more than one host", () => {
    const render = (agents: ReadonlyArray<ReturnType<typeof agent>>) =>
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
        />
      )
    expect(render(fleet)).not.toContain('<span class="connect-token">SER8</span>,')
    const elsewhere = Schema.decodeUnknownSync(ConnectAgent)({
      host: "BETA",
      id: Schema.decodeUnknownSync(AgentStableId)("agent-beta"),
      kind: "codex",
      lastActivityAt: 1_000,
      name: "Agent beta",
      state: "working",
      work: "npm"
    })
    const two = render([...fleet, elsewhere])
    expect(two).toContain('<span class="connect-token">SER8</span>,')
    expect(two).toContain('<span class="connect-token">BETA</span>,')
  })
})
