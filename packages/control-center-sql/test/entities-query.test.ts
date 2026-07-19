import { assert, describe, it } from "@effect/vitest"

import { renderEntitySourceIdentityQuery } from "../src/entities.js"

describe("entity queries", () => {
  it("scopes immutable source identity by workspace, connection, and provider", () => {
    const rendered = renderEntitySourceIdentityQuery({
      workspaceId: "workspace-1",
      pluginConnectionId: "connection-1",
      providerId: "jira",
      vendorImmutableId: "10042"
    })

    assert.match(rendered.sql, /from "entities"/u)
    assert.match(rendered.sql, /"workspace_id" = \?/u)
    assert.match(rendered.sql, /"plugin_connection_id" = \?/u)
    assert.match(rendered.sql, /"provider_id" = \?/u)
    assert.match(rendered.sql, /"vendor_immutable_id" = \?/u)
    assert.deepStrictEqual(rendered.params, ["workspace-1", "connection-1", "jira", "10042"])
  })
})
