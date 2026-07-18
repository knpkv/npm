import { describe, expect, it } from "vitest"

import { renderOpenPluginSyncAttemptsQuery, renderPluginSyncAttemptsQuery } from "../src/index.js"

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
})
