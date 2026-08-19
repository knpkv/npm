import { assert, describe, it } from "@effect/vitest"

import { opaqueProviderBindingEvidence, opaqueProviderIdentityEvidence } from "./liveEvidence.js"
import { assertSensitiveTextAbsent } from "./liveSecretAssertions.js"

describe("live integration evidence", () => {
  it("omits provider identifiers, display names, and safe messages from CI evidence", () => {
    const personalDisplayName = "Provider Person live-display-name-canary"
    const providerImmutableId = "live-provider-immutable-id-canary"
    const safeMessage = "Live failure live-safe-message-canary"
    const evidence = [
      opaqueProviderIdentityEvidence({
        _tag: "healthy",
        providerId: "jira",
        identity: {
          kind: "human",
          displayName: personalDisplayName,
          providerImmutableId
        }
      }),
      opaqueProviderIdentityEvidence({
        _tag: "failed",
        providerId: "confluence",
        safeMessage,
        failureClass: "authentication"
      })
    ]
    const accountDisplayName = "Account live-account-name-canary"
    const resourceDisplayName = "Resource live-resource-name-canary"
    const binding = opaqueProviderBindingEvidence({
      displayName: accountDisplayName,
      providerFamily: "atlassian",
      resources: [{
        displayName: resourceDisplayName,
        providerId: "jira"
      }]
    })
    const serialized = JSON.stringify({ binding, evidence })

    for (
      const canary of [
        personalDisplayName,
        providerImmutableId,
        safeMessage,
        accountDisplayName,
        resourceDisplayName
      ]
    ) {
      assertSensitiveTextAbsent(serialized, canary)
    }
    assert.deepStrictEqual(evidence, [
      { providerId: "jira", status: "healthy", kind: "human" },
      { providerId: "confluence", status: "failed", kind: "unknown" }
    ])
    assert.deepStrictEqual(binding, {
      providerFamily: "atlassian",
      resources: [{ providerId: "jira" }]
    })
  })
})
