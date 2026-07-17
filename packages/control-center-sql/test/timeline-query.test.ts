import { describe, expect, it } from "@effect/vitest"

import { renderTimelineQueries } from "../src/index.js"

describe("renderTimelineQueries", () => {
  it("renders four independently bounded and parameterized source plans", () => {
    const rendered = renderTimelineQueries({
      actorKind: null,
      before: { eventKey: "relationship:rel-1:4", occurredAt: "2026-07-17T12:00:00.000Z" },
      from: "2026-07-01T00:00:00.000Z",
      limit: 25,
      to: "2026-07-17T23:59:59.999Z",
      workspaceId: "workspace-1"
    })

    expect(rendered.map(({ sourceKind }) => sourceKind)).toEqual([
      "action",
      "relationship",
      "plugin-sync",
      "system"
    ])
    for (const query of rendered) {
      expect(query.sql).toContain("order by")
      expect(query.sql).toContain("limit")
      expect(query.sql).not.toContain("workspace-1")
      expect(query.params).toContain("workspace-1")
      expect(query.params).toContain(25)
    }
  })

  it("omits sources that cannot match a human actor", () => {
    const rendered = renderTimelineQueries({
      actorKind: "human",
      before: null,
      from: null,
      limit: 10,
      to: null,
      workspaceId: "workspace-1"
    })

    expect(rendered.map(({ sourceKind }) => sourceKind)).toEqual(["action", "relationship"])
    expect(rendered.every(({ params }) => params.includes("human"))).toBe(true)
  })
})
