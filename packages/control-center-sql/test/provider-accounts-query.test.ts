import { assert, describe, it } from "@effect/vitest"

import {
  renderCreateFollowedResourceQuery,
  renderCreateProviderAccountQuery,
  renderFollowedResourcesQuery,
  renderProviderAccountsQuery,
  renderUpdateFollowedResourceQuery
} from "../src/index.js"

describe("provider account query plans", () => {
  it("renders parameterized account creation and stable workspace listing", () => {
    const created = renderCreateProviderAccountQuery({
      workspaceId: "workspace-a",
      providerAccountId: "account-a",
      providerFamily: "aws",
      vendorAccountId: "123456789012",
      displayName: "Production AWS",
      createdAt: "2026-07-18T10:00:00.000Z"
    })
    const listed = renderProviderAccountsQuery("workspace-a")

    assert.match(created.sql, /^insert into "provider_accounts"/u)
    assert.notInclude(created.sql, "123456789012")
    assert.deepStrictEqual(created.params, [
      "workspace-a",
      "account-a",
      "aws",
      "123456789012",
      "Production AWS",
      "2026-07-18T10:00:00.000Z",
      1,
      "2026-07-18T10:00:00.000Z"
    ])
    assert.include(listed.sql, "order by")
    assert.deepStrictEqual(listed.params, ["workspace-a"])
  })

  it("renders account-scoped resource plans with numeric enabled state", () => {
    const created = renderCreateFollowedResourceQuery({
      workspaceId: "workspace-a",
      followedResourceId: "resource-a",
      providerAccountId: "account-a",
      providerFamily: "aws",
      providerId: "codecommit",
      vendorResourceId: "payments-api",
      displayName: "Payments API",
      isEnabled: true,
      createdAt: "2026-07-18T10:00:00.000Z"
    })
    const listed = renderFollowedResourcesQuery("workspace-a", "account-a")
    const updated = renderUpdateFollowedResourceQuery({
      workspaceId: "workspace-a",
      followedResourceId: "resource-a",
      displayName: "Payments API archived",
      isEnabled: false,
      expectedRevision: 1,
      updatedAt: "2026-07-18T11:00:00.000Z"
    })

    assert.match(created.sql, /^insert into "followed_resources"/u)
    assert.strictEqual(created.params[7], 1)
    assert.include(listed.sql, "\"provider_account_id\" = ?")
    assert.deepStrictEqual(listed.params, ["workspace-a", "account-a"])
    assert.match(updated.sql, /^update "followed_resources"/u)
    assert.deepStrictEqual(updated.params, [
      "Payments API archived",
      0,
      2,
      "2026-07-18T11:00:00.000Z",
      "workspace-a",
      "resource-a",
      1
    ])
  })
})
