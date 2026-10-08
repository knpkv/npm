/** Agent cards show each herdr state with its own icon; only work in progress spins. */
import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { StateLabel } from "@knpkv/rly/primitives"
import { agentStatePresentation } from "../src/internal/agent-state.js"

describe("agent state presentation", () => {
  it("spins only for work in progress", () => {
    expect(agentStatePresentation("working")).toEqual({ icon: "loader", spins: true, tone: "progress" })
    expect(agentStatePresentation("Running").spins).toBe(true)
    for (const status of ["idle", "blocked", "done", "unknown", "something-new"]) {
      expect(agentStatePresentation(status).spins).toBe(false)
    }
  })

  it("gives idle, blocked and done each their own icon, not just another colour", () => {
    const icons = ["working", "idle", "blocked", "done"].map((status) => agentStatePresentation(status).icon)
    expect(new Set(icons).size).toBe(4)
    expect(agentStatePresentation("idle")).toEqual({ icon: "minus", spins: false, tone: "neutral" })
    expect(agentStatePresentation("blocked")).toEqual({ icon: "alert", spins: false, tone: "caution" })
    expect(agentStatePresentation("done")).toEqual({ icon: "check", spins: false, tone: "positive" })
  })

  it("renders a neutral state with its icon, since StateLabel drops the icon for neutral by default", () => {
    const { icon, tone } = agentStatePresentation("idle")
    expect(renderToStaticMarkup(<StateLabel icon={icon} label="idle" tone={tone} />)).toContain("<svg")
  })
})
