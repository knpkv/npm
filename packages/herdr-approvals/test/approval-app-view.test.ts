import { describe, expect, it } from "@effect/vitest"
import { connectWorkerHref } from "../src/approval-app-view.js"

describe("worker Connect links", () => {
  it("links an exact remote worker to its remote Connect room", () => {
    expect(connectWorkerHref({
      agentId: "agent-remote-worker",
      host: "PI",
      name: "Remote worker",
      paneId: "w2:p3",
      relationship: {
        parentAgentId: "agent-coordinator",
        relation: "delegated"
      }
    })).toBe("/connect/?agent=agent-remote-worker&host=PI")
  })
})
