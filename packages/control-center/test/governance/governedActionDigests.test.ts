import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  GovernedActionEvidenceReference,
  GovernedActionTransitionCommand,
  GovernedActionTransitionMaterialV1,
  GovernedActionTransitionV1
} from "../../src/domain/governedAction/index.js"
import { PluginPayloadJson } from "../../src/domain/plugins/bounds.js"
import {
  canonicalizeGovernedActionJson,
  digestGovernedActionEnvelope,
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  digestGovernedActionTransitionCommand,
  makeGovernedActionEnvelope,
  makeGovernedActionTransition,
  verifyGovernedActionEnvelope,
  verifyGovernedActionTransition,
  verifyGovernedActionTransitionCommandDigest
} from "../../src/server/governance/governedActionDigests.js"

const proposedAt = "2026-07-15T10:00:00.000Z"
const evidenceId = "01890f00-0000-7000-8000-000000000201"
const evidenceClaimId = "01890f00-0000-7000-8000-000000000202"

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeEnvelope = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)

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

  it.effect("constructs and verifies transitions against the exact canonical command", () =>
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

      assert.deepStrictEqual((yield* verifyGovernedActionTransition(transition)).transition, transition)

      const encoded = Schema.encodeSync(GovernedActionTransitionV1)(transition)
      const changedCommand = Schema.decodeUnknownSync(GovernedActionTransitionV1)({
        ...encoded,
        command: {
          _tag: "deny",
          reason: "policy-denied",
          safeSummary: "Changed command under an existing identity"
        }
      })
      assert.isTrue(Result.isFailure(yield* Effect.result(verifyGovernedActionTransition(changedCommand))))
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
