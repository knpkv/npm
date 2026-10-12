// @vitest-environment happy-dom

import { Schema, type Types } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ConnectAgent, type ConnectAgentRelationship } from "../src/model.js"
import { AgentDirectory } from "../src/view.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const agent = (id: string, state = "working", parent?: string, relation = "delegated") => {
  const fields = {
    host: "ALPHA",
    id,
    name: id,
    kind: "codex",
    state,
    work: "Package work",
    lastActivityAt: 1_000
  }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? fields : { ...fields, relationship: { parentAgentId: parent, relation } }
  )
}
const primary = agent("agent-primary")
const partner = agent("agent-partner", "blocked", primary.id, "pair")
const fleet = [agent("agent-independent"), primary, partner]
const directory = (props: Partial<Parameters<typeof AgentDirectory>[0]> = {}) => (
  <AgentDirectory
    agents={fleet}
    activityFilter="all"
    hostFilter={null}
    query=""
    selectedKey={null}
    onActivityFilter={() => undefined}
    onHostFilter={() => undefined}
    onSelect={() => undefined}
    {...props}
  />
)

describe("Connect families", () => {
  it("keeps an unfiltered no-match sentence concise and offers Clear search", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(directory({ query: "zzz" }))
    expect(host.querySelector(".connect-no-matches")?.textContent).toBe("No agents match “zzz”.")
    expect(host.querySelector(".connect-empty button")?.textContent).toBe("Clear search")
    expect(host.querySelector(".connect-filter-summary button")).toBeNull()
  })

  it("names the no-match scope, exposes its active-filter count, and offers Clear beside the scope", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(directory({ query: "zzz", hostFilter: "ALPHA" }))
    expect(host.querySelector(".connect-filters-toggle .connect-filter-count")?.textContent).toBe("1")
    expect(host.querySelector(".connect-filter-summary button")?.textContent).toBe("Clear")
    expect(host.querySelector(".connect-empty")?.textContent).toBe(
      "No agents match “zzz” on ALPHA, in all states.Clear filters"
    )
  })

  it("prioritizes a family needing attention and keeps its primary before its pair partner", () => {
    const markup = renderToStaticMarkup(directory())
    expect(markup).toContain('class="connect-family"')
    const keys = [...markup.matchAll(/data-agent-key="ALPHA:([^"]+)"/g)].map((match) => match[1])
    expect(keys).toEqual([primary.id, partner.id, "agent-independent"])
    expect(markup).toContain("Pair partner")
  })

  it("retains ancestors as context without counting them as search matches", () => {
    const markup = renderToStaticMarkup(directory({ query: partner.name }))
    expect(markup).toContain('data-context="true"')
    expect(markup).toContain("1 agent in 1 family")
    expect(markup).toContain(primary.name)
    expect(markup).not.toContain("agent-independent")
  })

  it("groups siblings of the same unlisted primary without inventing a live parent", () => {
    const one = agent("agent-one", "ready", "agent-missing", "pair")
    const two = agent("agent-two", "working", "agent-missing", "review")
    const markup = renderToStaticMarkup(directory({ agents: [one, two] }))
    expect(markup.match(/class="connect-family"/g)).toHaveLength(1)
    expect(markup).toContain("Parent agent not found")
    expect(markup).toContain("Pair partner")
    expect(markup).toContain("Reviewer")
    expect(markup).not.toContain('data-agent-key="SER8:agent-missing"')
  })

  it("does not replace an unknown parent's name with its id and holds stale creatures still", () => {
    const markup = renderToStaticMarkup(
      directory({ agents: [agent("agent-orphan", "ready", "agent-absent")], stale: true })
    )
    expect(markup).toContain("Parent agent not found")
    expect(markup).not.toContain("agent-absent")
    expect(markup).not.toContain("Unknown parent")
    expect(markup).toContain("Old reading")
    expect(markup).toContain('data-stale=""')
  })

  it("keeps a lone unknown-parent issue inline, with its icon and a remembered name when known", () => {
    for (const parentName of [undefined, "former coordinator"]) {
      const relationship: Types.Mutable<ConnectAgentRelationship> = {
        parentAgentId: "agent-missing",
        relation: "delegated"
      }
      if (parentName !== undefined) relationship.parentName = parentName
      const orphan = Schema.decodeUnknownSync(ConnectAgent)({
        ...agent("agent-orphan", "working", "agent-missing"),
        relationship
      })
      const host = document.createElement("div")
      host.innerHTML = renderToStaticMarkup(directory({ agents: [orphan] }))
      expect(host.querySelectorAll(".connect-family-missing")).toHaveLength(0)
      const issue = host.querySelector(".connect-agent-issue")
      expect(host.querySelectorAll(".connect-agent-issue svg")).toHaveLength(1)
      expect(issue?.textContent).toBe(
        parentName === undefined ? "Parent agent not found" : "Unknown parent former coordinator"
      )
      expect(host.textContent).not.toContain("agent-missing")
    }
  })

  it("keeps the sibling group notice when a filter shows only one orphan", () => {
    const one = agent("agent-one", "ready", "agent-missing", "pair")
    const two = agent("agent-two", "working", "agent-missing", "review")
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(directory({ agents: [one, two], query: one.name }))
    expect(host.querySelectorAll(".connect-agent")).toHaveLength(1)
    expect(host.querySelectorAll(".connect-family-missing")).toHaveLength(1)
    expect(host.querySelectorAll(".connect-agent-issue")).toHaveLength(0)
  })

  it("names a remembered parent once per orphan family without duplicate row warnings", () => {
    const child = (id: string, relation: string) =>
      Schema.decodeUnknownSync(ConnectAgent)({
        ...agent(id, "working", "agent-missing", relation),
        relationship: { parentAgentId: "agent-missing", relation, parentName: "former coordinator" }
      })
    const markup = renderToStaticMarkup(
      directory({ agents: [child("agent-one", "pair"), child("agent-two", "review")] })
    )
    const host = document.createElement("div")
    host.innerHTML = markup
    expect(host.querySelectorAll(".connect-family-missing")).toHaveLength(1)
    expect(host.querySelector(".connect-family-missing")?.textContent).toContain(
      "former coordinator on ALPHA isn't in the directory; its children are shown here."
    )
    expect(host.querySelectorAll(".connect-agent-issue")).toHaveLength(0)
    expect(host.querySelectorAll(".connect-token")).toHaveLength(2)
    expect(host.querySelectorAll(".connect-agent small")[0]?.textContent).toContain(
      "Pair partner of former coordinator"
    )
    expect(host.querySelectorAll(".connect-agent small")[1]?.textContent).toContain("Reviewer of former coordinator")
    expect(host.textContent).not.toContain("agent-missing")
  })

  it("expands children, keeps expansion through polling, and always reveals a matching or needy child", async () => {
    const children = Array.from({ length: 5 }, (_, index) =>
      agent(`agent-child-${String(index)}`, "working", primary.id)
    )
    const needy = agent("agent-needy", "waiting", primary.id)
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(directory({ agents: [primary, ...children, needy] })))
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(4)
      const more = host.querySelector<HTMLButtonElement>(".connect-family-more")
      expect(more?.textContent).toBe("Show 3 more")
      await act(async () => more?.click())
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(7)
      await act(async () => root.render(directory({ agents: [...children, needy, primary] })))
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(7)
      await act(async () => root.render(directory({ agents: [primary, ...children], query: "agent-child-4" })))
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(2)
      expect(host.querySelector(".connect-family-more")).toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it("keeps invalid relationships standalone and caps deep nesting while naming the immediate parent", () => {
    const cycleA = agent("agent-cycle-a", "working", "agent-cycle-b")
    const cycleB = agent("agent-cycle-b", "working", "agent-cycle-a")
    const foreign = Schema.decodeUnknownSync(ConnectAgent)({ ...primary, host: "BETA" })
    const cross = agent("agent-cross", "working", primary.id)
    const invalid = renderToStaticMarkup(directory({ agents: [cycleA, cycleB, foreign, cross] }))
    expect(invalid.match(/class="connect-family"/g)).toHaveLength(4)
    expect(invalid).toContain("Cyclic relationship")
    expect(invalid).toContain("Cross-host parent")
    const child = agent("agent-child", "working", primary.id)
    const grandchild = agent("agent-grandchild", "working", child.id)
    const deep = agent("agent-deep", "working", grandchild.id, "review")
    const markup = renderToStaticMarkup(directory({ agents: [primary, child, grandchild, deep], query: deep.name }))
    expect(markup.match(/class="connect-family"/g)).toHaveLength(1)
    expect(markup.match(/data-context="true"/g)).toHaveLength(3)
    expect(markup).not.toContain('data-depth="3"')
    expect(markup).toContain('Reviewer of <span class="connect-token">agent-grandchild</span>')
  })

  it("blocks repeated own identities but keeps a child with an ambiguous parent openable", () => {
    const duplicate = Schema.decodeUnknownSync(ConnectAgent)({ ...primary, host: "alpha" })
    const child = agent("agent-child", "working", primary.id)
    const markup = renderToStaticMarkup(directory({ agents: [primary, duplicate, child] }))
    expect(markup.match(/disabled=""/g)).toHaveLength(2)
    expect(markup.match(/Can&#x27;t open: this host lists the same agent identity more than once/g)).toHaveLength(2)
    const childButton = /<button[^>]*data-agent-key="ALPHA:agent-child"[^>]*>/.exec(markup)?.[0]
    expect(childButton).toBeDefined()
    expect(childButton).not.toContain("disabled")
    expect(markup).toContain("Ambiguous ownership")
  })

  it("opens the filter disclosure and clears its active scope", async () => {
    const clearHost = vi.fn()
    const clearActivity = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          directory({
            activityFilter: "needs-you",
            hostFilter: "ALPHA",
            onHostFilter: clearHost,
            onActivityFilter: clearActivity
          })
        )
      )
      const toggle = host.querySelector<HTMLButtonElement>(".connect-filters-toggle")
      expect(toggle?.getAttribute("aria-expanded")).toBe("false")
      expect(toggle?.textContent).toContain("Filters 2")
      await act(async () => toggle?.click())
      expect(toggle?.getAttribute("aria-expanded")).toBe("true")
      await act(async () => host.querySelector<HTMLButtonElement>(".connect-filter-summary button")?.click())
      expect(clearHost).toHaveBeenCalledWith(null)
      expect(clearActivity).toHaveBeenCalledWith("all")
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
