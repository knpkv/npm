import { describe, expect, it } from "vitest"

import {
  renderOpenPluginSyncAttemptsQuery,
  renderPluginSyncAttemptsQuery,
  renderPluginSyncAttemptStateQuery
} from "../src/index.js"

describe("open plugin sync attempts query", () => {
  it("renders one scoped anti-join in stable attempt order", () => {
    const rendered = renderOpenPluginSyncAttemptsQuery({
      workspaceId: "workspace-1",
      pluginConnectionId: "connection-1",
      streamKey: "releases"
    })

    expect(rendered.sql).toContain("from \"plugin_sync_attempts\"")
    expect(rendered.sql).toContain("not exists (select")
    expect(rendered.sql).toContain("from \"plugin_sync_attempt_completions\"")
    expect(rendered.sql).toContain("order by \"plugin_sync_attempts\".\"attempt_sequence\" asc")
    expect(rendered.params).toEqual(["workspace-1", "connection-1", "releases"])
  })

  it("renders the complete attempt history with nullable completion columns", () => {
    const rendered = renderPluginSyncAttemptsQuery({
      workspaceId: "workspace-1",
      pluginConnectionId: "connection-1",
      streamKey: "releases"
    })

    expect(rendered.sql).toContain(
      "from \"plugin_sync_attempts\" left join \"plugin_sync_attempt_completions\""
    )
    expect(rendered.sql).toContain(
      "\"plugin_sync_attempt_completions\".\"outcome\" as \"outcome\""
    )
    expect(rendered.sql).toContain(
      "order by \"plugin_sync_attempts\".\"attempt_sequence\" asc"
    )
    expect(rendered.params).toEqual(["workspace-1", "connection-1", "releases"])
  })

  it("bounds current state to the latest attempt and latest synchronized completion", () => {
    const rendered = renderPluginSyncAttemptStateQuery({
      workspaceId: "workspace-1",
      pluginConnectionId: "connection-1",
      streamKey: "releases"
    })

    expect(rendered.sql).toContain(" or ")
    expect(rendered.sql).toContain("order by \"plugin_sync_attempts\".\"attempt_sequence\" desc")
    expect(rendered.sql.match(/max\(/gu)).toHaveLength(2)
    expect(rendered.sql).toContain("\"synchronizedCompletions\".\"outcome\" = ?")
    expect(rendered.params.filter((parameter) => parameter === "workspace-1")).toHaveLength(3)
    expect(rendered.params.filter((parameter) => parameter === "connection-1")).toHaveLength(3)
    expect(rendered.params.filter((parameter) => parameter === "releases")).toHaveLength(3)
  })
})
