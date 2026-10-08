import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentStateLabel, agentStatePresentation } from "../src/agent-state.js"

// The agreed table (workers/ui2.agents-merge.plan.md, D2): every state herdr emits, plus an unknown one.
const table = [
  ["running", "Running", "loader", "progress", true, "working"],
  ["working", "Working", "loader", "progress", true, "working"],
  ["waiting", "Waiting", "clock", "caution", false, "needs-you"],
  ["blocked", "Blocked", "alert", "critical", false, "needs-you"],
  ["error", "Error", "alert", "critical", false, "needs-you"],
  ["ready", "Ready", "minus", "neutral", false, "ready"],
  ["idle", "Idle", "minus", "neutral", false, "ready"],
  ["done", "Done", "check", "positive", false, "finished"],
  ["compacting", "Compacting", "alert", "caution", false, "needs-you"],
  ["", "Unknown", "alert", "caution", false, "needs-you"]
] satisfies ReadonlyArray<readonly [string, string, string, string, boolean, string]>

describe("agent state language", () => {
  it.each(table)("maps %j to its word, icon, tone, motion and bucket", (state, word, icon, tone, spins, bucket) => {
    expect(agentStatePresentation(state)).toEqual({ bucket, icon, spins, tone, word })
  })

  it("reads states case-insensitively", () => {
    expect(agentStatePresentation("WORKING").bucket).toBe("working")
    expect(agentStatePresentation("Waiting").word).toBe("Waiting")
  })

  it("never shows an unknown state as idle", () => {
    const unknown = agentStatePresentation("compacting")
    const idle = agentStatePresentation("idle")
    expect([unknown.icon, unknown.tone]).not.toEqual([idle.icon, idle.tone])
  })

  it("spins only work in progress", () => {
    expect(renderToStaticMarkup(<AgentStateLabel state="working" />)).toContain("agent-state-spinning")
    expect(renderToStaticMarkup(<AgentStateLabel state="done" />)).not.toContain("agent-state-spinning")
  })
})
