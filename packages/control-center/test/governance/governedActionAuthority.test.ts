import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  GovernedActionAttemptV1,
  GovernedActionAuthorizationV1,
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  GovernedActionEvidenceReference,
  GovernedActionPluginConnectionAuthorityDigest,
  GovernedActionPluginConnectionRevision,
  GovernedActionPolicyEvaluationV1,
  GovernedActionTargetSnapshotV1
} from "../../src/domain/governedAction/index.js"
import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginPayloadJson } from "../../src/domain/plugins/bounds.js"
import { NegotiatedPluginDescriptorV1 } from "../../src/domain/plugins/descriptor.js"
import { ProviderId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { SessionSummary } from "../../src/server/auth/models.js"
import { verifyGovernedActionDispatchAuthority } from "../../src/server/governance/governedActionAuthority.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  digestGovernedActionPolicyEvaluation,
  makeGovernedActionEnvelope
} from "../../src/server/governance/governedActionDigests.js"

const evaluatedAtRaw = "2026-07-15T10:01:01.000Z"
const actionId = "01890f00-0000-7000-8000-000000000401"
const workspaceId = "01890f00-0000-7000-8000-000000000402"
const connectionId = "01890f00-0000-7000-8000-000000000403"
const personId = "01890f00-0000-7000-8000-000000000404"
const sessionId = "01890f00-0000-7000-8000-000000000405"
const authorizationId = "01890f00-0000-7000-8000-000000000406"
const idempotencyKey = "governed-action:PAY-42:done:authority-test"

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeEnvelopeMaterial = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)
const decodeAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)
const decodeAttempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)
const decodeSession = Schema.decodeUnknownSync(SessionSummary)
const decodeCurrentPlugin = Schema.decodeUnknownSync(NegotiatedPluginDescriptorV1)
const decodeCurrentPolicy = Schema.decodeUnknownSync(GovernedActionPolicyEvaluationV1)
const decodeCurrentTarget = Schema.decodeUnknownSync(GovernedActionTargetSnapshotV1)
const decodeConnectionId = Schema.decodeUnknownSync(PluginConnectionId)
const decodeConnectionRevision = Schema.decodeUnknownSync(GovernedActionPluginConnectionRevision)
const decodeConnectionAuthority = Schema.decodeUnknownSync(GovernedActionPluginConnectionAuthorityDigest)
const decodeProviderId = Schema.decodeUnknownSync(ProviderId)
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)
const evaluatedAt = Schema.decodeUnknownSync(UtcTimestamp)(evaluatedAtRaw)

const originalEvidence = decodeEvidence({
  workspaceId,
  evidenceId: "01890f00-0000-7000-8000-000000000407",
  evidenceClaimIds: [],
  observedAt: "2026-07-15T09:55:00.000Z",
  validUntil: "2026-07-15T11:00:00.000Z",
  currentUntil: "2026-07-15T10:30:00.000Z",
  evaluatedAt: "2026-07-15T10:00:00.000Z",
  source: "current",
  validity: "valid"
})

const changedCurrentEvidence = decodeEvidence({
  ...Schema.encodeSync(GovernedActionEvidenceReference)(originalEvidence),
  observedAt: "2026-07-15T09:56:00.000Z"
})

const makeAuthorityFixture = Effect.fn("GovernedActionAuthorityTest.fixture")(function*() {
  const payload = decodePayload({ fields: { resolution: null, status: "Done" }, notify: true })
  const payloadDigest = yield* digestGovernedActionPayload(payload)
  const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([originalEvidence])
  const envelope = yield* makeGovernedActionEnvelope(decodeEnvelopeMaterial({
    schemaVersion: 1,
    actionId,
    idempotencyKey,
    workspaceId,
    pluginConnectionId: connectionId,
    pluginConnectionRevision: 7,
    pluginConnectionAuthorityDigest: `sha256:${"b".repeat(64)}`,
    pluginId: "dev.knpkv.jira",
    pluginContractVersion: { major: 1, minor: 0, patch: 0 },
    pluginAdapterVersion: { major: 1, minor: 2, patch: 3 },
    providerId: "jira",
    capability: { capabilityId: "action.execute", version: 1 },
    targetEntityId: "01890f00-0000-7000-8000-000000000408",
    proposal: {
      proposalKey: "transition:PAY-42:done",
      capabilityVersion: 1,
      request: {
        actionKind: "transition",
        target: { entityType: "issue", vendorImmutableId: "PAY-42" },
        expectedRevision: "7",
        payload,
        evidenceIds: ["provider-evidence-1"]
      },
      payloadDigest,
      summary: "Move PAY-42 to Done",
      impact: { level: "medium", summary: "Changes the issue workflow state" },
      proposedAt: "2026-07-15T10:00:00.000Z"
    },
    evidence: [Schema.encodeSync(GovernedActionEvidenceReference)(originalEvidence)],
    evidenceSetDigest,
    policy: {
      policyId: "jira.transition",
      policyVersion: 1,
      policyDigest: `sha256:${"d".repeat(64)}`,
      requiredPermission: "issue-owner"
    },
    origin: {
      _tag: "agent",
      actor: { _tag: "agent", agentId: "01890f00-0000-7000-8000-000000000409" },
      jobId: "01890f00-0000-7000-8000-000000000410",
      initiatingSessionId: sessionId
    },
    proposalExpiresAt: "2026-07-15T10:10:00.000Z",
    causationId: null,
    correlationId: "action:authority-test"
  }))
  const authorization = decodeAuthorization({
    schemaVersion: 1,
    authorizationId,
    actionId,
    workspaceId,
    pluginConnectionId: connectionId,
    pluginConnectionRevision: 7,
    pluginConnectionAuthorityDigest: envelope.envelope.pluginConnectionAuthorityDigest,
    actionEnvelopeDigest: envelope.envelope.envelopeDigest,
    idempotencyKey,
    payloadDigest,
    evidenceSetDigest,
    policyDigest: envelope.envelope.policy.policyDigest,
    expectedRevision: "7",
    capabilityVersion: 1,
    actor: { _tag: "human", personId },
    sessionId,
    sessionPermission: "workspace-owner",
    sessionExpiresAt: "2026-07-15T10:30:00.000Z",
    requiredPermission: "issue-owner",
    authorizedAt: "2026-07-15T10:01:00.000Z",
    expiresAt: "2026-07-15T10:05:00.000Z"
  })
  const currentPolicy = decodeCurrentPolicy({
    schemaVersion: 1,
    actionId,
    workspaceId,
    policy: envelope.envelope.policy,
    payloadDigest,
    evidenceSetDigest,
    expectedRevision: "7",
    decision: "allowed",
    evaluatedAt: evaluatedAtRaw
  })
  const attempt = decodeAttempt({
    schemaVersion: 1,
    attemptId: "01890f00-0000-7000-8000-000000000411",
    authorizationId,
    actionId,
    workspaceId,
    pluginConnectionId: connectionId,
    idempotencyKey,
    attemptNumber: 1,
    actionEnvelopeDigest: envelope.envelope.envelopeDigest,
    expectedRevision: "7",
    policyEvaluationDigest: yield* digestGovernedActionPolicyEvaluation(currentPolicy),
    preflight: { _tag: "ready", checkedRevision: "7", checkedAt: "2026-07-15T10:01:00.000Z" },
    startedAt: evaluatedAtRaw
  })
  const session = decodeSession({
    sessionId,
    workspaceId,
    actor: { _tag: "human", personId },
    permission: "workspace-owner",
    createdAt: "2026-07-15T09:00:00.000Z",
    lastSeenAt: "2026-07-15T10:01:00.000Z",
    idleExpiresAt: "2026-07-15T10:20:00.000Z",
    absoluteExpiresAt: "2026-08-15T09:00:00.000Z",
    revokedAt: null
  })
  const currentPlugin = {
    authorityDigest: envelope.envelope.pluginConnectionAuthorityDigest,
    connectionId: envelope.envelope.pluginConnectionId,
    enabled: true,
    providerId: envelope.envelope.providerId,
    revision: envelope.envelope.pluginConnectionRevision,
    workspaceId: envelope.envelope.workspaceId,
    negotiated: decodeCurrentPlugin({
      descriptor: {
        contractId: "dev.knpkv.control-center.plugin",
        contractVersion: { major: 1, minor: 0, patch: 0 },
        pluginId: "dev.knpkv.jira",
        adapterVersion: { major: 1, minor: 2, patch: 3 },
        displayName: "Jira",
        configurationFields: [],
        capabilities: [{
          capabilityId: "action.execute",
          supportedVersions: [1],
          requirement: "optional"
        }]
      },
      capabilities: [{ capabilityId: "action.execute", version: 1 }]
    })
  }
  const currentTarget = decodeCurrentTarget({
    workspaceId,
    entityId: envelope.envelope.targetEntityId,
    entityType: "issue",
    sourceRevision: {
      providerId: "jira",
      pluginConnectionId: connectionId,
      vendorImmutableId: "PAY-42",
      revision: "7",
      sourceUrl: null,
      firstObservedAt: "2026-07-15T09:00:00.000Z",
      lastObservedAt: "2026-07-15T10:00:00.000Z",
      synchronizedAt: "2026-07-15T10:00:01.000Z",
      normalizationSchemaVersion: 1
    }
  })
  return {
    attempt,
    authorization,
    currentPlugin,
    currentPolicy,
    currentTarget,
    envelope: envelope.envelope,
    session
  }
})

describe("governed action dispatch authority", () => {
  it.effect("returns a nominal proof only after all current authority bindings verify", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const authority = yield* verifyGovernedActionDispatchAuthority({
        ...fixture,
        currentEvidence: [originalEvidence],
        evaluatedAt
      })

      assert.deepStrictEqual(authority.envelope.envelope, fixture.envelope)
      assert.deepStrictEqual(authority.authorization, fixture.authorization)
      assert.deepStrictEqual(authority.attempt, fixture.attempt)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a structurally decoded envelope with a forged outer digest", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const forgedEnvelope = Schema.decodeUnknownSync(GovernedActionEnvelopeV1)({
        ...Schema.encodeSync(GovernedActionEnvelopeV1)(fixture.envelope),
        envelopeDigest: `sha256:${"e".repeat(64)}`
      })
      const result = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        envelope: forgedEnvelope,
        currentEvidence: [originalEvidence],
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(result))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails closed when evidence or the current human session changed", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const rejected = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        currentEvidence: [changedCurrentEvidence],
        session: decodeSession({
          ...Schema.encodeSync(SessionSummary)(fixture.session),
          permission: "watcher",
          idleExpiresAt: "2026-07-15T10:01:00.000Z",
          revokedAt: "2026-07-15T10:00:30.000Z"
        }),
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionAuthorityRejected")
        if (rejected.failure._tag === "GovernedActionAuthorityRejected") {
          assert.include(rejected.failure.mismatches, "evidence-set-changed")
          assert.include(rejected.failure.mismatches, "session-permission-mismatch")
          assert.include(rejected.failure.mismatches, "session-revoked")
          assert.include(rejected.failure.mismatches, "authorization-session-expired")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a disabled or renegotiated plugin and a changed or denied policy", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const incompatiblePlugin = decodeCurrentPlugin({
        descriptor: {
          contractId: "dev.knpkv.control-center.plugin",
          contractVersion: { major: 1, minor: 1, patch: 0 },
          pluginId: "dev.knpkv.jira.next",
          adapterVersion: { major: 2, minor: 0, patch: 0 },
          displayName: "Jira next",
          configurationFields: [],
          capabilities: [{
            capabilityId: "action.propose",
            supportedVersions: [1],
            requirement: "optional"
          }]
        },
        capabilities: [{ capabilityId: "action.propose", version: 1 }]
      })
      const changedPolicy = decodeCurrentPolicy({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(fixture.currentPolicy),
        policy: {
          ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(fixture.currentPolicy).policy,
          policyDigest: `sha256:${"a".repeat(64)}`
        },
        decision: "denied"
      })
      const rejected = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        currentEvidence: [originalEvidence],
        currentPlugin: {
          authorityDigest: fixture.currentPlugin.authorityDigest,
          connectionId: fixture.currentPlugin.connectionId,
          enabled: false,
          negotiated: incompatiblePlugin,
          providerId: fixture.currentPlugin.providerId,
          revision: fixture.currentPlugin.revision,
          workspaceId: fixture.currentPlugin.workspaceId
        },
        currentPolicy: changedPolicy,
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionAuthorityRejected")
        if (rejected.failure._tag === "GovernedActionAuthorityRejected") {
          assert.include(rejected.failure.mismatches, "current-plugin-unavailable")
          assert.include(rejected.failure.mismatches, "current-plugin-mismatch")
          assert.include(rejected.failure.mismatches, "current-capability-unavailable")
          assert.include(rejected.failure.mismatches, "current-policy-denied")
          assert.include(rejected.failure.mismatches, "current-policy-mismatch")
          assert.include(rejected.failure.mismatches, "attempt-policy-evaluation-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds the live connection scope, authority generation, and capability version", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const versionTwoPlugin = decodeCurrentPlugin({
        descriptor: {
          ...Schema.encodeSync(NegotiatedPluginDescriptorV1)(fixture.currentPlugin.negotiated).descriptor,
          capabilities: [{
            capabilityId: "action.execute",
            supportedVersions: [1, 2],
            requirement: "optional"
          }]
        },
        capabilities: [{ capabilityId: "action.execute", version: 2 }]
      })
      const rejected = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        currentEvidence: [originalEvidence],
        currentPlugin: {
          authorityDigest: decodeConnectionAuthority(`sha256:${"c".repeat(64)}`),
          connectionId: decodeConnectionId("01890f00-0000-7000-8000-000000000498"),
          enabled: true,
          negotiated: versionTwoPlugin,
          providerId: decodeProviderId("confluence"),
          revision: decodeConnectionRevision(8),
          workspaceId: decodeWorkspaceId("01890f00-0000-7000-8000-000000000499")
        },
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionAuthorityRejected")
        if (rejected.failure._tag === "GovernedActionAuthorityRejected") {
          assert.include(rejected.failure.mismatches, "current-plugin-connection-mismatch")
          assert.include(rejected.failure.mismatches, "current-plugin-workspace-mismatch")
          assert.include(rejected.failure.mismatches, "current-plugin-provider-mismatch")
          assert.include(rejected.failure.mismatches, "current-plugin-revision-mismatch")
          assert.include(rejected.failure.mismatches, "current-plugin-authority-mismatch")
          assert.include(rejected.failure.mismatches, "current-capability-version-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds dispatch intent to the latest canonical target and policy evaluation", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const changedTarget = decodeCurrentTarget({
        ...Schema.encodeSync(GovernedActionTargetSnapshotV1)(fixture.currentTarget),
        workspaceId: "01890f00-0000-7000-8000-000000000499",
        entityId: "01890f00-0000-7000-8000-000000000497",
        entityType: "page",
        sourceRevision: {
          ...Schema.encodeSync(GovernedActionTargetSnapshotV1)(fixture.currentTarget).sourceRevision,
          providerId: "confluence",
          pluginConnectionId: "01890f00-0000-7000-8000-000000000498",
          vendorImmutableId: "PAGE-42",
          revision: "8"
        }
      })
      const changedAttempt = decodeAttempt({
        ...Schema.encodeSync(GovernedActionAttemptV1)(fixture.attempt),
        policyEvaluationDigest: `sha256:${"9".repeat(64)}`
      })
      const rejected = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        attempt: changedAttempt,
        currentEvidence: [originalEvidence],
        currentTarget: changedTarget,
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionAuthorityRejected")
        if (rejected.failure._tag === "GovernedActionAuthorityRejected") {
          assert.include(rejected.failure.mismatches, "current-target-workspace-mismatch")
          assert.include(rejected.failure.mismatches, "current-target-entity-mismatch")
          assert.include(rejected.failure.mismatches, "current-target-type-mismatch")
          assert.include(rejected.failure.mismatches, "current-target-source-mismatch")
          assert.include(rejected.failure.mismatches, "current-target-revision-mismatch")
          assert.include(rejected.failure.mismatches, "attempt-policy-evaluation-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects cross-workspace evidence and authorization that predates its session", () =>
    Effect.gen(function*() {
      const fixture = yield* makeAuthorityFixture()
      const crossWorkspaceEvidence = decodeEvidence({
        ...Schema.encodeSync(GovernedActionEvidenceReference)(originalEvidence),
        workspaceId: "01890f00-0000-7000-8000-000000000499"
      })
      const rejected = yield* Effect.result(verifyGovernedActionDispatchAuthority({
        ...fixture,
        currentEvidence: [crossWorkspaceEvidence],
        session: decodeSession({
          ...Schema.encodeSync(SessionSummary)(fixture.session),
          createdAt: "2026-07-15T10:01:00.001Z"
        }),
        evaluatedAt
      }))

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionAuthorityRejected")
        if (rejected.failure._tag === "GovernedActionAuthorityRejected") {
          assert.include(rejected.failure.mismatches, "evidence-set-changed")
          assert.include(rejected.failure.mismatches, "evidence-workspace-mismatch")
          assert.include(rejected.failure.mismatches, "authorization-session-chronology")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
