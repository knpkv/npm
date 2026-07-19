import { assert, describe, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PluginDiscoveryV1 } from "../../src/domain/plugins/discovery.js"

const legacyDiscovery = {
  account: { providerImmutableId: "account-1", displayName: "Acme Engineering" },
  workspace: { providerImmutableId: "workspace-1", displayName: "Payments" },
  endpoints: [],
  discoveredAt: "2026-07-19T03:00:00.000Z"
}

describe("PluginDiscoveryV1", () => {
  it("defaults a missing v1 resource identity to null", () => {
    const discovery = Schema.decodeUnknownSync(PluginDiscoveryV1)(legacyDiscovery)

    assert.isNull(discovery.resource)
  })

  it("continues to reject a missing v1 account field", () => {
    const missingAccount = {
      workspace: legacyDiscovery.workspace,
      endpoints: legacyDiscovery.endpoints,
      discoveredAt: legacyDiscovery.discoveredAt
    }

    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PluginDiscoveryV1)(missingAccount)))
  })
})
