import { assert, describe, it } from "@effect/vitest"

import {
  renderBindPluginConnectionQuery,
  renderCreatePluginConnectionQuery,
  renderPluginConnectionCountQuery,
  renderPluginConnectionsQuery,
  renderUpdatePluginConnectionQuery
} from "../src/index.js"

describe("plugin connection query plans", () => {
  it("creates an unbound connection and renders stable workspace reads", () => {
    const created = renderCreatePluginConnectionQuery({
      workspaceId: "workspace-a",
      pluginConnectionId: "connection-a",
      providerId: "codecommit",
      displayName: "Payments API",
      isEnabled: true,
      createdAt: "2026-07-18T10:00:00.000Z"
    })
    const listed = renderPluginConnectionsQuery("workspace-a")
    const counted = renderPluginConnectionCountQuery("workspace-a")

    assert.match(created.sql, /^insert into "plugin_connections"/u)
    assert.include(created.sql, "null, null")
    assert.deepStrictEqual(created.params, [
      "workspace-a",
      "connection-a",
      "codecommit",
      "Payments API",
      1,
      1,
      "2026-07-18T10:00:00.000Z",
      "2026-07-18T10:00:00.000Z"
    ])
    assert.include(listed.sql, "order by")
    assert.deepStrictEqual(listed.params, ["workspace-a"])
    assert.include(counted.sql, "count(")
    assert.deepStrictEqual(counted.params, ["workspace-a"])
  })

  it("binds one resource without coupling later metadata updates to ownership", () => {
    const bound = renderBindPluginConnectionQuery({
      workspaceId: "workspace-a",
      pluginConnectionId: "connection-a",
      providerAccountId: "account-a",
      followedResourceId: "resource-a",
      expectedRevision: 1,
      updatedAt: "2026-07-18T11:00:00.000Z"
    })
    const updated = renderUpdatePluginConnectionQuery({
      workspaceId: "workspace-a",
      pluginConnectionId: "connection-a",
      displayName: "Payments API archived",
      isEnabled: false,
      expectedRevision: 2,
      updatedAt: "2026-07-18T12:00:00.000Z"
    })

    assert.match(bound.sql, /^update "plugin_connections"/u)
    assert.deepStrictEqual(bound.params, [
      "account-a",
      "resource-a",
      2,
      "2026-07-18T11:00:00.000Z",
      "workspace-a",
      "connection-a",
      1
    ])
    assert.notInclude(updated.sql, "provider_account_id")
    assert.notInclude(updated.sql, "followed_resource_id")
    assert.deepStrictEqual(updated.params, [
      "Payments API archived",
      0,
      3,
      "2026-07-18T12:00:00.000Z",
      "workspace-a",
      "connection-a",
      2
    ])
  })
})
