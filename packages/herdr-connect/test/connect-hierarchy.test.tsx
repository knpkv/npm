// @vitest-environment happy-dom

import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ConnectAgent } from "../src/model.js"
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
    expect(markup).toContain("1 matching agent")
    expect(markup).toContain(primary.name)
    expect(markup).not.toContain("agent-independent")
  })

  it("names a missing primary and holds stale creatures still", () => {
    const markup = renderToStaticMarkup(
      directory({ agents: [agent("agent-orphan", "ready", "agent-absent")], stale: true })
    )
    expect(markup).toContain("Primary not listed")
    expect(markup).toContain("agent-absent")
    expect(markup).toContain("Old reading")
    expect(markup).toContain('data-stale=""')
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
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(5)
      const more = host.querySelector<HTMLButtonElement>(".connect-family-more")
      expect(more?.textContent).toBe("Show 2 more")
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
    expect(markup).toContain('Reviewer for <span class="connect-token">agent-grandchild</span>')
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
      await act(async () => host.querySelector<HTMLButtonElement>(".connect-filters-clear")?.click())
      expect(clearHost).toHaveBeenCalledWith(null)
      expect(clearActivity).toHaveBeenCalledWith("all")
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
