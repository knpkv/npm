import { describe, expect, it } from "vitest"

import { renderCurrentReleaseReadinessQuery } from "../src/index.js"

describe("current release readiness query", () => {
  it("renders one bounded, parameterized query for all requested release heads", () => {
    const rendered = renderCurrentReleaseReadinessQuery({
      workspaceId: "workspace-secret",
      releaseIds: ["release-secret-1", "release-secret-2", "release-secret-3"]
    })

    expect(rendered.params).toEqual([
      "release",
      "",
      "workspace-secret",
      "release-secret-1",
      "release-secret-2",
      "release-secret-3"
    ])
    expect(rendered.sql.match(/\?/gu)).toHaveLength(rendered.params.length)
    expect(rendered.sql).toContain("from \"readiness_release_heads\"")
    expect(rendered.sql).toContain("left join \"readiness_head_history\"")
    expect(rendered.sql).toContain("left join \"readiness_assessments\"")
    expect(rendered.sql.match(/exists \(select/gu)).toHaveLength(2)
    expect(rendered.sql).toContain("\"release_id\" in (?, ?, ?)")
    expect(rendered.sql).toContain("order by \"readiness_release_heads\".\"release_id\" asc")
    expect(rendered.sql).not.toContain("workspace-secret")
    expect(rendered.sql).not.toContain("release-secret")
  })
})
