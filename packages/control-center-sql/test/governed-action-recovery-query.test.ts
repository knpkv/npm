import { describe, expect, it } from "vitest"

import { renderGovernedActionRecoveryQuery } from "../src/index.js"

describe("governed action recovery query", () => {
  it("renders a bounded stable scan without embedding the observed time", () => {
    const rendered = renderGovernedActionRecoveryQuery({
      limit: 64,
      observedAt: "2026-07-18T10:00:00.000Z"
    })

    expect(rendered.sql).toContain("from \"governed_actions\"")
    expect(rendered.sql).toContain("inner join \"governed_action_execution_leases\"")
    expect(rendered.sql).toContain("not exists (select")
    expect(rendered.sql).toContain("\"state\" in (?, ?, ?, ?)")
    expect(rendered.sql).toContain(
      "order by \"governed_action_execution_leases\".\"recovery_eligible_at\" asc, \"governed_actions\".\"workspace_id\" asc, \"governed_actions\".\"action_id\" asc"
    )
    expect(rendered.sql).toContain("limit ?")
    expect(rendered.sql.match(/\?/gu)).toHaveLength(rendered.params.length)
    expect(rendered.sql).not.toContain("2026-07-18")
    expect(rendered.params).toContain(64)
  })
})
