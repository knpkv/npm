import { describe, expect, it } from "vitest"

import { workspaceScrollRestorationKey } from "../../src/client/workspaceScrollRestoration.js"

describe("workspace scroll restoration", () => {
  it("keys the exact route, filters, selection, and anchor independently of history identity", () => {
    const route = {
      hash: "#release-work",
      pathname: "/w/workspace/releases/release",
      search: "?object=issue&relationship=delivery-link"
    }
    const firstHistoryEntry = { ...route, key: "first" }
    const secondHistoryEntry = { ...route, key: "second" }

    expect(workspaceScrollRestorationKey(route)).toBe(
      "/w/workspace/releases/release?object=issue&relationship=delivery-link#release-work"
    )
    expect(workspaceScrollRestorationKey(firstHistoryEntry)).toBe(workspaceScrollRestorationKey(secondHistoryEntry))
    expect(workspaceScrollRestorationKey({ ...route, search: "?object=other" })).not.toBe(
      workspaceScrollRestorationKey(route)
    )
  })
})
