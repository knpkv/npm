import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ConnectAgent } from "../src/model.js"
import { AgentDirectory, agentBucketCounts, ConnectSummary, silentHostsSentence } from "../src/view.js"

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
  it("says how many agents are live and how many need you, and leaves hosts to the line above the list", () => {
    const markup = summary({ agents: fleet, unavailable: false })
    // The count says what it counts: listed agents, and how many of them are working.
    expect(markup).toContain("3 agents, 1 working")
    expect(markup).toContain(">1 needs you<")
    // A host that didn't answer is named once, above the list; the summary only counts.
    expect(markup).not.toContain("answer")
    expect(markup).toContain('aria-label="Connect summary"')
  })

  it("leaves out the needs-you count when there is none", () => {
    const markup = summary({ agents: [fleet[0] ?? agent("agent-a", "working")], unavailable: false })
    expect(markup).toContain("1 agent, 1 working")
    expect(markup).not.toContain("needs you")
    expect(markup).not.toContain("answer")
  })

  it("says the directory is unavailable rather than claiming zero agents", () => {
    expect(summary({ agents: null, unavailable: true })).toContain("The fleet directory didn&#x27;t answer")
    expect(summary({ agents: null, unavailable: false })).toContain("Loading the fleet")
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

describe("one agents surface", () => {
  const directory = (props: Partial<Parameters<typeof AgentDirectory>[0]> = {}): string =>
    renderToStaticMarkup(
      <AgentDirectory
        activityFilter="all"
        agents={fleet}
        hostFilter={null}
        onActivityFilter={() => undefined}
        onHostFilter={() => undefined}
        onSelect={() => undefined}
        query=""
        selectedKey={null}
        timeZone="UTC"
        {...props}
      />
    )

  it("keeps each row's content as its name: state first, then name and work, last active, and the action", () => {
    const row = /<button[^>]*class="connect-agent"[^>]*>(.*?)<\/button>/.exec(directory())?.[1] ?? ""
    expect(row).not.toBe("")
    const text = row.replaceAll(/<[^>]+>/g, "")
    expect(text).toMatch(/^Working.*Agent agent-a.*npm, last active at \d\d:\d\d, open terminal$/)
    expect(/<button[^>]*class="connect-agent"[^>]*>/.exec(directory())?.[0]).not.toContain("aria-label")
  })

  it("counts each status within the host filter, ignoring the search", () => {
    const other = Schema.decodeUnknownSync(ConnectAgent)({ ...agent("agent-d", "waiting"), host: "BETA" })
    const agents = [...fleet, other]
    expect([...agentBucketCounts(agents, null)]).toEqual([
      ["all", 4],
      ["working", 1],
      ["needs-you", 2],
      ["ready", 0],
      ["finished", 1]
    ])
    expect(agentBucketCounts(agents, "BETA").get("needs-you")).toBe(1)
    expect(agentBucketCounts(agents, "BETA").get("all")).toBe(1)
    // The query narrows the rows, not the counts.
    expect(directory({ agents, query: "agent-a" })).toContain(
      'Needs you<span class="connect-visually-hidden">,</span> <span class="connect-filter-count">2</span>'
    )
  })

  it("names a host that didn't answer in the Host filter without offering it", () => {
    const markup = directory({ silentHosts: ["GAMMA"] })
    expect(markup).toContain('<span class="connect-host-silent">GAMMA <small>didn&#x27;t answer</small></span>')
    expect(markup).not.toMatch(/<button[^>]*>GAMMA/)
  })

  it("says which hosts didn't answer, why, and what that means for the list", () => {
    expect(silentHostsSentence([])).toBeNull()
    expect(silentHostsSentence([{ host: "GAMMA", reason: "timeout" }])).toBe(
      "GAMMA (timed out) didn't answer; its agents aren't listed."
    )
    expect(
      silentHostsSentence([
        { host: "ALPHA", reason: "offline" },
        { host: "BETA", reason: "invalid_response" }
      ])
    ).toBe("ALPHA (offline), BETA (unreadable answer) didn't answer; their agents aren't listed.")
  })
})
