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
  GovernedActionPolicyEvaluationV1,
  GovernedActionTransitionCommand,
  GovernedActionTransitionMaterialV1,
  GovernedActionTransitionV1
} from "../../src/domain/governedAction/index.js"
import { PluginPayloadJson } from "../../src/domain/plugins/bounds.js"
import {
  canonicalizeGovernedActionJson,
  digestGovernedActionAttempt,
  digestGovernedActionAuthorization,
  digestGovernedActionEnvelope,
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  digestGovernedActionPolicyEvaluation,
  digestGovernedActionTransition,
  digestGovernedActionTransitionCommand,
  makeGovernedActionEnvelope,
  makeGovernedActionTransition,
  verifyGovernedActionAttempt,
  verifyGovernedActionAuthorization,
  verifyGovernedActionEnvelope,
  verifyGovernedActionPolicyEvaluation,
  verifyGovernedActionTransition,
  verifyGovernedActionTransitionCommandDigest,
  verifyGovernedActionTransitionDigest
} from "../../src/server/governance/governedActionDigests.js"

const proposedAt = "2026-07-15T10:00:00.000Z"
const evidenceId = "01890f00-0000-7000-8000-000000000201"
const evidenceClaimId = "01890f00-0000-7000-8000-000000000202"

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeEnvelope = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)
const decodePolicyEvaluation = Schema.decodeUnknownSync(GovernedActionPolicyEvaluationV1)
const decodeAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)
const decodeAttempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)

const evidenceRaw = {
  workspaceId: "01890f00-0000-7000-8000-000000000204",
  evidenceId,
  evidenceClaimIds: [evidenceClaimId],
  observedAt: "2026-07-15T09:55:00.000Z",
  validUntil: "2026-07-15T11:00:00.000Z",
  currentUntil: "2026-07-15T10:30:00.000Z",
  evaluatedAt: proposedAt,
  source: "current",
  validity: "valid"
}
const evidence = decodeEvidence(evidenceRaw)

const envelopeRaw = (payloadDigest: string, evidenceSetDigest: string) => ({
  schemaVersion: 1,
  actionId: "01890f00-0000-7000-8000-000000000203",
  idempotencyKey: "governed-action:PAY-42:done:7",
  workspaceId: "01890f00-0000-7000-8000-000000000204",
  pluginConnectionId: "01890f00-0000-7000-8000-000000000205",
  pluginConnectionRevision: 7,
  pluginConnectionAuthorityDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "dev.knpkv.jira",
  pluginContractVersion: { major: 1, minor: 0, patch: 0 },
  pluginAdapterVersion: { major: 1, minor: 2, patch: 3 },
  providerId: "jira",
  capability: { capabilityId: "action.execute", version: 1 },
  targetEntityId: "01890f00-0000-7000-8000-000000000206",
  proposal: {
    proposalKey: "transition:PAY-42:done",
    capabilityVersion: 1,
    request: {
      actionKind: "transition",
      target: { entityType: "issue", vendorImmutableId: "PAY-42" },
      expectedRevision: "7",
      payload: { fields: { resolution: null, status: "Done" }, notify: true },
      evidenceIds: ["provider-evidence-1"]
    },
    payloadDigest,
    summary: "Move PAY-42 to Done",
    impact: { level: "medium", summary: "Changes the issue workflow state" },
    proposedAt
  },
  evidence: [evidenceRaw],
  evidenceSetDigest,
  policy: {
    policyId: "jira.transition",
    policyVersion: 1,
    policyDigest: `sha256:${"c".repeat(64)}`,
    requiredPermission: "issue-owner"
  },
  origin: {
    _tag: "human",
    actor: { _tag: "human", personId: "01890f00-0000-7000-8000-000000000207" },
    sessionId: "01890f00-0000-7000-8000-000000000208"
  },
  proposalExpiresAt: "2026-07-15T10:10:00.000Z",
  causationId: null,
  correlationId: "action:test-1"
})

const policyEvaluationRaw = {
  schemaVersion: 1,
  actionId: "01890f00-0000-7000-8000-000000000203",
  workspaceId: "01890f00-0000-7000-8000-000000000204",
  policy: {
    policyId: "jira.transition",
    policyVersion: 1,
    policyDigest: `sha256:${"c".repeat(64)}`,
    requiredPermission: "issue-owner"
  },
  payloadDigest: "1".repeat(64),
  evidenceSetDigest: `sha256:${"2".repeat(64)}`,
  expectedRevision: "7",
  decision: "allowed",
  evaluatedAt: proposedAt
}

const authorizationRaw = {
  schemaVersion: 1,
  authorizationId: "01890f00-0000-7000-8000-000000000212",
  actionId: "01890f00-0000-7000-8000-000000000203",
  workspaceId: "01890f00-0000-7000-8000-000000000204",
  pluginConnectionId: "01890f00-0000-7000-8000-000000000205",
  pluginConnectionRevision: 7,
  pluginConnectionAuthorityDigest: `sha256:${"a".repeat(64)}`,
  actionEnvelopeDigest: `sha256:${"f".repeat(64)}`,
  idempotencyKey: "governed-action:PAY-42:done:7",
  payloadDigest: "1".repeat(64),
  evidenceSetDigest: `sha256:${"2".repeat(64)}`,
  policyDigest: `sha256:${"c".repeat(64)}`,
  expectedRevision: "7",
  capabilityVersion: 1,
  actor: { _tag: "human", personId: "01890f00-0000-7000-8000-000000000207" },
  sessionId: "01890f00-0000-7000-8000-000000000208",
  sessionPermission: "issue-owner",
  sessionExpiresAt: "2026-07-15T10:20:00.000Z",
  requiredPermission: "issue-owner",
  authorizedAt: "2026-07-15T10:01:00.000Z",
  expiresAt: "2026-07-15T10:05:00.000Z"
}

const attemptRaw = {
  schemaVersion: 1,
  attemptId: "01890f00-0000-7000-8000-000000000213",
  authorizationId: "01890f00-0000-7000-8000-000000000212",
  actionId: "01890f00-0000-7000-8000-000000000203",
  workspaceId: "01890f00-0000-7000-8000-000000000204",
  pluginConnectionId: "01890f00-0000-7000-8000-000000000205",
  idempotencyKey: "governed-action:PAY-42:done:7",
  attemptNumber: 1,
  actionEnvelopeDigest: `sha256:${"f".repeat(64)}`,
  expectedRevision: "7",
  policyEvaluationDigest: `sha256:${"3".repeat(64)}`,
  preflight: {
    _tag: "ready",
    checkedRevision: "7",
    checkedAt: "2026-07-15T10:01:00.000Z"
  },
  startedAt: "2026-07-15T10:02:00.000Z"
}

describe("governed action canonical digests", () => {
  it("canonicalizes nested object order while preserving array semantics", () => {
    const first = decodePayload({
      z: { second: 2, first: 1 },
      list: [{ beta: true, alpha: false }, "tail"]
    })
    const permuted = decodePayload({
      list: [{ alpha: false, beta: true }, "tail"],
      z: { first: 1, second: 2 }
    })
    const reorderedArray = decodePayload({
      list: ["tail", { alpha: false, beta: true }],
      z: { first: 1, second: 2 }
    })

    assert.strictEqual(canonicalizeGovernedActionJson(first), canonicalizeGovernedActionJson(permuted))
    assert.notStrictEqual(canonicalizeGovernedActionJson(first), canonicalizeGovernedActionJson(reorderedArray))
  })

  it.prop(
    "is invariant to arbitrary top-level object insertion order",
    [Schema.toArbitrary(Schema.Record(Schema.String, Schema.Json))],
    ([record]) => {
      const reversed = Schema.decodeUnknownSync(Schema.Json)(Object.fromEntries(Object.entries(record).reverse()))
      return canonicalizeGovernedActionJson(record) === canonicalizeGovernedActionJson(reversed)
    }
  )

  it.effect("keeps payload digests stable across key permutations and sensitive to ordered values", () =>
    Effect.gen(function*() {
      const first = decodePayload({ fields: { status: "Done", resolution: null }, labels: ["release", "eod"] })
      const permuted = decodePayload({ labels: ["release", "eod"], fields: { resolution: null, status: "Done" } })
      const changedOrder = decodePayload({ labels: ["eod", "release"], fields: { resolution: null, status: "Done" } })

      const firstDigest = yield* digestGovernedActionPayload(first)
      assert.strictEqual(yield* digestGovernedActionPayload(permuted), firstDigest)
      assert.notStrictEqual(yield* digestGovernedActionPayload(changedOrder), firstDigest)
      assert.match(firstDigest, /^[0-9a-f]{64}$/u)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("hashes transition commands for exact retry comparison", () =>
    Effect.gen(function*() {
      const decodeCommand = Schema.decodeUnknownSync(GovernedActionTransitionCommand)
      const first = decodeCommand({
        _tag: "deny",
        reason: "policy-denied",
        safeSummary: "Policy denied this action"
      })
      const changed = decodeCommand({
        _tag: "deny",
        reason: "policy-denied",
        safeSummary: "Policy changed after proposal"
      })

      assert.strictEqual(
        yield* digestGovernedActionTransitionCommand(first),
        yield* digestGovernedActionTransitionCommand(first)
      )
      assert.notStrictEqual(
        yield* digestGovernedActionTransitionCommand(first),
        yield* digestGovernedActionTransitionCommand(changed)
      )
      const firstDigest = yield* digestGovernedActionTransitionCommand(first)
      assert.isTrue(
        Result.isFailure(yield* Effect.result(verifyGovernedActionTransitionCommandDigest(changed, firstDigest)))
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("verifies complete policy evaluations and rejects changed decisions", () =>
    Effect.gen(function*() {
      const evaluation = decodePolicyEvaluation(policyEvaluationRaw)
      const digest = yield* digestGovernedActionPolicyEvaluation(evaluation)
      const verified = yield* verifyGovernedActionPolicyEvaluation(evaluation, digest)
      const changed = decodePolicyEvaluation({ ...policyEvaluationRaw, decision: "denied" })
      const rejected = yield* Effect.result(verifyGovernedActionPolicyEvaluation(changed, digest))

      assert.deepStrictEqual(verified.evaluation, evaluation)
      assert.strictEqual(verified.digest, digest)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionBindingMismatch")
        if (rejected.failure._tag === "GovernedActionBindingMismatch") {
          assert.strictEqual(rejected.failure.reason, "policy-evaluation-digest-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("canonicalizes complete authorizations and rejects changed authority", () =>
    Effect.gen(function*() {
      const authorization = decodeAuthorization(authorizationRaw)
      const permuted = decodeAuthorization({
        expiresAt: authorizationRaw.expiresAt,
        authorizedAt: authorizationRaw.authorizedAt,
        requiredPermission: authorizationRaw.requiredPermission,
        sessionExpiresAt: authorizationRaw.sessionExpiresAt,
        sessionPermission: authorizationRaw.sessionPermission,
        sessionId: authorizationRaw.sessionId,
        actor: { personId: authorizationRaw.actor.personId, _tag: "human" },
        capabilityVersion: authorizationRaw.capabilityVersion,
        expectedRevision: authorizationRaw.expectedRevision,
        policyDigest: authorizationRaw.policyDigest,
        evidenceSetDigest: authorizationRaw.evidenceSetDigest,
        payloadDigest: authorizationRaw.payloadDigest,
        idempotencyKey: authorizationRaw.idempotencyKey,
        actionEnvelopeDigest: authorizationRaw.actionEnvelopeDigest,
        pluginConnectionAuthorityDigest: authorizationRaw.pluginConnectionAuthorityDigest,
        pluginConnectionRevision: authorizationRaw.pluginConnectionRevision,
        pluginConnectionId: authorizationRaw.pluginConnectionId,
        workspaceId: authorizationRaw.workspaceId,
        actionId: authorizationRaw.actionId,
        authorizationId: authorizationRaw.authorizationId,
        schemaVersion: authorizationRaw.schemaVersion
      })
      const digest = yield* digestGovernedActionAuthorization(authorization)
      const verified = yield* verifyGovernedActionAuthorization(authorization, digest)
      const changed = decodeAuthorization({ ...authorizationRaw, pluginConnectionRevision: 8 })
      const rejected = yield* Effect.result(verifyGovernedActionAuthorization(changed, digest))

      assert.strictEqual(yield* digestGovernedActionAuthorization(permuted), digest)
      assert.deepStrictEqual(verified.authorization, authorization)
      assert.strictEqual(verified.digest, digest)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionBindingMismatch")
        if (rejected.failure._tag === "GovernedActionBindingMismatch") {
          assert.strictEqual(rejected.failure.reason, "authorization-digest-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("verifies complete attempts and rejects changed dispatch intent", () =>
    Effect.gen(function*() {
      const attempt = decodeAttempt(attemptRaw)
      const digest = yield* digestGovernedActionAttempt(attempt)
      const verified = yield* verifyGovernedActionAttempt(attempt, digest)
      const changed = decodeAttempt({ ...attemptRaw, idempotencyKey: "governed-action:PAY-42:done:8" })
      const rejected = yield* Effect.result(verifyGovernedActionAttempt(changed, digest))

      assert.deepStrictEqual(verified.attempt, attempt)
      assert.strictEqual(verified.digest, digest)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "GovernedActionBindingMismatch")
        if (rejected.failure._tag === "GovernedActionBindingMismatch") {
          assert.strictEqual(rejected.failure.reason, "attempt-digest-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("constructs and verifies complete transitions against command and record digests", () =>
    Effect.gen(function*() {
      const decodeMaterial = Schema.decodeUnknownSync(GovernedActionTransitionMaterialV1)
      const material = decodeMaterial({
        schemaVersion: 1,
        transitionId: "01890f00-0000-7000-8000-000000000211",
        previousTransitionId: "01890f00-0000-7000-8000-000000000210",
        commandId: "command:action:test-1:deny",
        actionId: "01890f00-0000-7000-8000-000000000203",
        workspaceId: "01890f00-0000-7000-8000-000000000204",
        sequence: 2,
        fromState: "proposed",
        toState: "denied",
        actionEnvelopeDigest: `sha256:${"f".repeat(64)}`,
        command: {
          _tag: "deny",
          reason: "policy-denied",
          safeSummary: "Policy denied this action"
        },
        cause: {
          _tag: "human",
          actor: { _tag: "human", personId: "01890f00-0000-7000-8000-000000000207" },
          sessionId: "01890f00-0000-7000-8000-000000000208"
        },
        occurredAt: proposedAt,
        causationId: null,
        correlationId: "action:test-1"
      })
      const verified = yield* makeGovernedActionTransition(material)
      const transition = verified.transition
      const transitionDigest = yield* digestGovernedActionTransition(transition)
      const verifiedRecord = yield* verifyGovernedActionTransitionDigest(transition, transitionDigest)

      assert.deepStrictEqual((yield* verifyGovernedActionTransition(transition)).transition, transition)
      assert.deepStrictEqual(verifiedRecord.transition, transition)
      assert.strictEqual(verifiedRecord.digest, transitionDigest)

      const encoded = Schema.encodeSync(GovernedActionTransitionV1)(transition)
      const changedCommand = Schema.decodeUnknownSync(GovernedActionTransitionV1)({
        ...encoded,
        command: {
          _tag: "deny",
          reason: "policy-denied",
          safeSummary: "Changed command under an existing identity"
        }
      })
      const changedRecord = Schema.decodeUnknownSync(GovernedActionTransitionV1)({
        ...encoded,
        occurredAt: "2026-07-15T10:01:00.000Z"
      })
      const commandRejected = yield* Effect.result(
        verifyGovernedActionTransitionDigest(changedCommand, transitionDigest)
      )
      const recordRejected = yield* Effect.result(
        verifyGovernedActionTransitionDigest(changedRecord, transitionDigest)
      )

      assert.isTrue(Result.isFailure(commandRejected))
      if (Result.isFailure(commandRejected)) {
        assert.strictEqual(commandRejected.failure._tag, "GovernedActionBindingMismatch")
        if (commandRejected.failure._tag === "GovernedActionBindingMismatch") {
          assert.strictEqual(commandRejected.failure.reason, "command-digest-mismatch")
        }
      }
      assert.isTrue(Result.isFailure(recordRejected))
      if (Result.isFailure(recordRejected)) {
        assert.strictEqual(recordRejected.failure._tag, "GovernedActionBindingMismatch")
        if (recordRejected.failure._tag === "GovernedActionBindingMismatch") {
          assert.strictEqual(recordRejected.failure.reason, "transition-digest-mismatch")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects noncanonical, duplicate, and oversized evidence sets before hashing", () =>
    Effect.gen(function*() {
      const secondEvidence = decodeEvidence({
        ...evidenceRaw,
        evidenceId: "01890f00-0000-7000-8000-000000000209"
      })
      const oversizedEvidence = Array.from({ length: 101 }, (_, index) =>
        decodeEvidence({
          ...evidenceRaw,
          evidenceId: `01890f00-0000-7000-8000-${(index + 300).toString().padStart(12, "0")}`
        }))

      assert.isTrue(Result.isFailure(yield* Effect.result(digestGovernedActionEvidenceSet([secondEvidence, evidence]))))
      assert.isTrue(Result.isFailure(yield* Effect.result(digestGovernedActionEvidenceSet([evidence, evidence]))))
      assert.isTrue(Result.isFailure(yield* Effect.result(digestGovernedActionEvidenceSet(oversizedEvidence))))
      assert.isTrue(Result.isSuccess(yield* Effect.result(digestGovernedActionEvidenceSet([evidence, secondEvidence]))))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds envelope identity to payload, revision, evidence, policy, and actor context", () =>
    Effect.gen(function*() {
      const payloadDigest = yield* digestGovernedActionPayload(
        decodePayload({ fields: { resolution: null, status: "Done" }, notify: true })
      )
      const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([evidence])
      const original = decodeEnvelope(envelopeRaw(payloadDigest, evidenceSetDigest))
      const governedEnvelope = yield* makeGovernedActionEnvelope(original)
      const originalDigest = governedEnvelope.envelope.envelopeDigest
      const variants = [
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          proposal: {
            ...envelopeRaw(payloadDigest, evidenceSetDigest).proposal,
            request: {
              ...envelopeRaw(payloadDigest, evidenceSetDigest).proposal.request,
              expectedRevision: "8"
            }
          }
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          policy: {
            ...envelopeRaw(payloadDigest, evidenceSetDigest).policy,
            policyDigest: `sha256:${"d".repeat(64)}`
          }
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          idempotencyKey: "governed-action:PAY-42:done:8"
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          origin: {
            _tag: "human",
            actor: { _tag: "human", personId: "01890f00-0000-7000-8000-000000000209" },
            sessionId: "01890f00-0000-7000-8000-000000000208"
          }
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          pluginContractVersion: { major: 1, minor: 1, patch: 0 }
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          pluginAdapterVersion: { major: 1, minor: 2, patch: 4 }
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          pluginConnectionRevision: 8
        }),
        decodeEnvelope({
          ...envelopeRaw(payloadDigest, evidenceSetDigest),
          pluginConnectionAuthorityDigest: `sha256:${"b".repeat(64)}`
        })
      ]
      const variantDigests = yield* Effect.forEach(variants, digestGovernedActionEnvelope)

      assert.match(originalDigest, /^sha256:[0-9a-f]{64}$/u)
      assert.isTrue(variantDigests.every((digest) => digest !== originalDigest))
      assert.strictEqual(new Set(variantDigests).size, variantDigests.length)
      assert.deepStrictEqual(
        (yield* verifyGovernedActionEnvelope(governedEnvelope.envelope)).envelope,
        governedEnvelope.envelope
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects forged payload, evidence, and outer envelope digests", () =>
    Effect.gen(function*() {
      const payloadDigest = yield* digestGovernedActionPayload(
        decodePayload({ fields: { resolution: null, status: "Done" }, notify: true })
      )
      const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([evidence])
      const material = decodeEnvelope(envelopeRaw(payloadDigest, evidenceSetDigest))
      const envelope = yield* makeGovernedActionEnvelope(material)
      const encodedEnvelope = Schema.encodeSync(GovernedActionEnvelopeV1)(envelope.envelope)

      const changedPayload = decodeEnvelope({
        ...envelopeRaw(payloadDigest, evidenceSetDigest),
        proposal: {
          ...envelopeRaw(payloadDigest, evidenceSetDigest).proposal,
          request: {
            ...envelopeRaw(payloadDigest, evidenceSetDigest).proposal.request,
            payload: { fields: { resolution: "Fixed", status: "Done" }, notify: true }
          }
        }
      })
      const changedEvidence = decodeEnvelope({
        ...envelopeRaw(payloadDigest, evidenceSetDigest),
        evidence: [{ ...evidenceRaw, currentUntil: "2026-07-15T09:59:00.000Z", source: "stale" }]
      })
      const changedOuterEnvelope = Schema.decodeUnknownSync(GovernedActionEnvelopeV1)({
        ...encodedEnvelope,
        policy: { ...encodedEnvelope.policy, policyDigest: `sha256:${"e".repeat(64)}` }
      })

      assert.isTrue(Result.isFailure(yield* Effect.result(makeGovernedActionEnvelope(changedPayload))))
      assert.isTrue(Result.isFailure(yield* Effect.result(makeGovernedActionEnvelope(changedEvidence))))
      assert.isTrue(Result.isFailure(yield* Effect.result(verifyGovernedActionEnvelope(changedOuterEnvelope))))
    }).pipe(Effect.provide(NodeServices.layer)))
})
