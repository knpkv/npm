import { assert, describe, it } from "@effect/vitest"

import { renderGovernedActionIdempotencyQuery } from "../src/governedActions.js"

describe("governed action queries", () => {
  it("scopes idempotent action identity by workspace and connection", () => {
    const rendered = renderGovernedActionIdempotencyQuery({
      workspaceId: "workspace-1",
      pluginConnectionId: "connection-1",
      idempotencyKey: "proposal-1"
    })

    assert.match(rendered.sql, /from "governed_actions"/u)
    assert.match(rendered.sql, /"workspace_id" = \?/u)
    assert.match(rendered.sql, /"plugin_connection_id" = \?/u)
    assert.match(rendered.sql, /"idempotency_key" = \?/u)
    assert.deepStrictEqual(rendered.params, ["workspace-1", "connection-1", "proposal-1"])
  })
})
