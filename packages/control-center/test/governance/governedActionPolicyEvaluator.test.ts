import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEvidenceReference,
  GovernedActionPolicyBinding
} from "../../src/domain/governedAction/index.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { SessionSummary } from "../../src/server/auth/models.js"
import type { VerifyGovernedActionDispatchAuthorityInput } from "../../src/server/governance/governedActionAuthority.js"
import {
  digestGovernedActionEvidenceSet,
  makeGovernedActionEnvelope
} from "../../src/server/governance/governedActionDigests.js"
import {
  BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL,
  type GovernedActionPolicyDefinition,
  GovernedActionPolicyMaterialV1,
  makeBuiltInGovernedActionPolicyDefinition,
  makeGovernedActionPolicyDefinition,
  makeGovernedActionPolicyEvaluator
} from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import {
  makeAuthorizedGovernedActionEnvelope,
  PERSON_ID,
  SESSION_ID,
  WORKSPACE_ID
} from "./fixtures/authorizedGovernedAction.js"

const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeMaterial = Schema.decodeUnknownSync(GovernedActionPolicyMaterialV1)
const decodePolicyBinding = Schema.decodeUnknownSync(GovernedActionPolicyBinding)
const decodeSession = Schema.decodeUnknownSync(SessionSummary)
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp)

type EvaluationInput = Pick<
  VerifyGovernedActionDispatchAuthorityInput,
  "currentEvidence" | "envelope" | "evaluatedAt" | "session"
>

const makeInput = Effect.fn("GovernedActionPolicyEvaluatorTest.makeInput")(function*() {
  const envelope = yield* makeAuthorizedGovernedActionEnvelope()
  const definition = yield* makeBuiltInGovernedActionPolicyDefinition()
  const session = decodeSession({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    actor: { _tag: "human", personId: PERSON_ID },
    permission: "workspace-owner",
    createdAt: "2026-07-15T09:00:00.000Z",
    lastSeenAt: "2026-07-15T10:01:00.000Z",
    idleExpiresAt: "2026-07-15T11:00:00.000Z",
    absoluteExpiresAt: "2026-08-15T10:00:00.000Z",
    revokedAt: null
  })
  return {
    definition,
    input: {
      envelope,
      currentEvidence: envelope.evidence,
      session,
      evaluatedAt: decodeTimestamp("2026-07-15T10:02:00.000Z")
    } satisfies EvaluationInput
  }
})

const evaluatorFor = Effect.fn("GovernedActionPolicyEvaluatorTest.evaluatorFor")(function*(
  definition: GovernedActionPolicyDefinition
) {
  return yield* makeGovernedActionPolicyEvaluator([definition])
})

const replaceEvidence = Effect.fn("GovernedActionPolicyEvaluatorTest.replaceEvidence")(function*(
  input: EvaluationInput,
  currentEvidence: EvaluationInput["currentEvidence"]
) {
  const evidenceSetDigest = yield* digestGovernedActionEvidenceSet(currentEvidence)
  const encodedMaterial = Schema.encodeSync(GovernedActionEnvelopeMaterialV1)(input.envelope)
  const material = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)({
    ...encodedMaterial,
    evidence: currentEvidence.map((reference) => Schema.encodeSync(GovernedActionEvidenceReference)(reference)),
    evidenceSetDigest
  })
  return {
    ...input,
    currentEvidence,
    envelope: (yield* makeGovernedActionEnvelope(material)).envelope
  } satisfies EvaluationInput
})

describe("governed action policy evaluator", () => {
  it.effect("allows the exact immutable evidence set at a later trusted instant", () =>
    Effect.gen(function*() {
      const { definition, input } = yield* makeInput()
      const evaluator = yield* evaluatorFor(definition)
      const evaluation = yield* evaluator.evaluate(input)

      assert.strictEqual(evaluation.decision, "allowed")
      assert.deepStrictEqual(evaluation.policy, definition.binding)
      assert.strictEqual(evaluation.evaluatedAt, input.evaluatedAt)
      assert.strictEqual(evaluation.evidenceSetDigest, input.envelope.evidenceSetDigest)
      assert.strictEqual(
        input.currentEvidence[0]?.evaluatedAt,
        input.envelope.evidence[0]?.evaluatedAt
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("derives policy identity from canonical rules while excluding enablement", () =>
    Effect.gen(function*() {
      const original = yield* makeBuiltInGovernedActionPolicyDefinition()
      const changedRules = yield* makeGovernedActionPolicyDefinition(
        decodeMaterial({
          ...Schema.encodeSync(GovernedActionPolicyMaterialV1)(BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL),
          rules: ["permission-grants"]
        }),
        true
      )
      const changedPermission = yield* makeGovernedActionPolicyDefinition(
        decodeMaterial({
          ...Schema.encodeSync(GovernedActionPolicyMaterialV1)(BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL),
          requiredPermission: "release-owner"
        }),
        true
      )
      const disabled = yield* makeGovernedActionPolicyDefinition(
        BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL,
        false
      )

      assert.notStrictEqual(changedRules.binding.policyDigest, original.binding.policyDigest)
      assert.notStrictEqual(changedPermission.binding.policyDigest, original.binding.policyDigest)
      assert.deepStrictEqual(disabled.binding, original.binding)

      const forgedMaterial = { ...original, material: changedRules.material }
      const forgedBinding = {
        ...original,
        binding: decodePolicyBinding({
          ...Schema.encodeSync(GovernedActionPolicyBinding)(original.binding),
          requiredPermission: "release-owner"
        })
      }
      assert.strictEqual(
        (yield* makeGovernedActionPolicyEvaluator([forgedMaterial]).pipe(Effect.flip))._tag,
        "GovernedActionPolicyCatalogInvalid"
      )
      assert.strictEqual(
        (yield* makeGovernedActionPolicyEvaluator([forgedBinding]).pipe(Effect.flip))._tag,
        "GovernedActionPolicyCatalogInvalid"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects ambiguous, missing, and changed current policy bindings", () =>
    Effect.gen(function*() {
      const { definition, input } = yield* makeInput()
      const duplicate = yield* makeGovernedActionPolicyDefinition(
        decodeMaterial({
          ...Schema.encodeSync(GovernedActionPolicyMaterialV1)(BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL),
          policyVersion: 2
        }),
        true
      )
      for (const catalog of [[definition, duplicate], [duplicate, definition]]) {
        const failure = yield* makeGovernedActionPolicyEvaluator(catalog).pipe(Effect.flip)
        assert.strictEqual(failure._tag, "GovernedActionPolicyCatalogInvalid")
      }

      const missingEvaluator = yield* makeGovernedActionPolicyEvaluator([])
      assert.strictEqual(
        (yield* missingEvaluator.evaluate(input).pipe(Effect.flip))._tag,
        "GovernedActionPolicyBindingUnavailable"
      )
      const changedEvaluator = yield* evaluatorFor(duplicate)
      assert.strictEqual(
        (yield* changedEvaluator.evaluate(input).pipe(Effect.flip))._tag,
        "GovernedActionPolicyBindingUnavailable"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("denies a matching disabled policy, unusable evidence, or an agent actor", () =>
    Effect.gen(function*() {
      const { definition, input } = yield* makeInput()
      const disabledEvaluator = yield* evaluatorFor({ ...definition, enabled: false })
      assert.strictEqual((yield* disabledEvaluator.evaluate(input)).decision, "denied")

      const beforeFreshnessBoundary = { ...input, evaluatedAt: decodeTimestamp("2026-07-15T10:29:59.999Z") }
      const freshnessBoundary = { ...input, evaluatedAt: decodeTimestamp("2026-07-15T10:30:00.000Z") }
      const afterFreshnessBoundary = { ...input, evaluatedAt: decodeTimestamp("2026-07-15T10:30:00.001Z") }
      const evaluator = yield* evaluatorFor(definition)
      assert.strictEqual((yield* evaluator.evaluate(beforeFreshnessBoundary)).decision, "allowed")
      assert.strictEqual((yield* evaluator.evaluate(freshnessBoundary)).decision, "denied")
      assert.strictEqual((yield* evaluator.evaluate(afterFreshnessBoundary)).decision, "denied")

      const withoutFreshnessDeadline = input.currentEvidence.map((reference) =>
        decodeEvidence({
          ...Schema.encodeSync(GovernedActionEvidenceReference)(reference),
          currentUntil: null
        })
      )
      const validityInput = yield* replaceEvidence(input, withoutFreshnessDeadline)
      assert.strictEqual(
        (yield* evaluator.evaluate({
          ...validityInput,
          evaluatedAt: decodeTimestamp("2026-07-15T10:59:59.999Z")
        })).decision,
        "allowed"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({
          ...validityInput,
          evaluatedAt: decodeTimestamp("2026-07-15T11:00:00.000Z")
        })).decision,
        "denied"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({
          ...validityInput,
          evaluatedAt: decodeTimestamp("2026-07-15T11:00:00.001Z")
        })).decision,
        "denied"
      )

      const agentSession = decodeSession({
        ...Schema.encodeSync(SessionSummary)(input.session),
        actor: { _tag: "agent", agentId: "01890f6f-6d6a-7cc0-98d2-44000000000e" }
      })
      assert.strictEqual(
        (yield* evaluator.evaluate({ ...input, session: agentSession })).decision,
        "denied"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({ ...input, currentEvidence: [] })).decision,
        "denied"
      )
      const changedEvidence = input.currentEvidence.map((reference) =>
        decodeEvidence({
          ...Schema.encodeSync(GovernedActionEvidenceReference)(reference),
          evidenceClaimIds: ["01890f6f-6d6a-7cc0-98d2-44000000000e"]
        })
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({ ...input, currentEvidence: changedEvidence })).decision,
        "denied"
      )

      const missingEvidence = input.currentEvidence.map((reference) =>
        decodeEvidence({
          ...Schema.encodeSync(GovernedActionEvidenceReference)(reference),
          currentUntil: null,
          source: "missing"
        })
      )
      assert.strictEqual(
        (yield* evaluator.evaluate(yield* replaceEvidence(input, missingEvidence))).decision,
        "denied"
      )

      const expiredEvidence = input.currentEvidence.map((reference) =>
        decodeEvidence({
          ...Schema.encodeSync(GovernedActionEvidenceReference)(reference),
          validUntil: "2026-07-15T09:55:00.000Z",
          validity: "expired"
        })
      )
      assert.strictEqual(
        (yield* evaluator.evaluate(yield* replaceEvidence(input, expiredEvidence))).decision,
        "denied"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects each changed policy binding field independently", () =>
    Effect.gen(function*() {
      const { definition, input } = yield* makeInput()
      const evaluator = yield* evaluatorFor(definition)
      const encoded = Schema.encodeSync(GovernedActionPolicyBinding)(input.envelope.policy)
      const changedBindings = [
        decodePolicyBinding({ ...encoded, policyId: "plugin.action.execute.changed" }),
        decodePolicyBinding({ ...encoded, policyVersion: encoded.policyVersion + 1 }),
        decodePolicyBinding({ ...encoded, policyDigest: `sha256:${"b".repeat(64)}` }),
        decodePolicyBinding({ ...encoded, requiredPermission: "release-owner" })
      ]
      for (const policy of changedBindings) {
        const failure = yield* evaluator.evaluate({
          ...input,
          envelope: { ...input.envelope, policy }
        }).pipe(Effect.flip)
        assert.strictEqual(failure._tag, "GovernedActionPolicyBindingUnavailable")
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
