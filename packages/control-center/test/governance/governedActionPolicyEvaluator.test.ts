import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEvidenceReference,
  GovernedActionPolicyBinding
} from "../../src/domain/governedAction/index.js"
import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"
import { SessionSummary } from "../../src/server/auth/models.js"
import type { VerifyGovernedActionDispatchAuthorityInput } from "../../src/server/governance/governedActionAuthority.js"
import {
  digestGovernedActionEvidenceSet,
  makeGovernedActionEnvelope
} from "../../src/server/governance/governedActionDigests.js"
import {
  BUILT_IN_GOVERNED_ACTION_APPROVER_POLICY_MATERIAL,
  BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL,
  type GovernedActionPolicyDefinition,
  GovernedActionPolicyMaterialV1,
  makeBuiltInGovernedActionPolicyDefinition,
  makeBuiltInGovernedActionPolicyDefinitions,
  makeGovernedActionPolicyDefinition,
  makeGovernedActionPolicyEvaluator,
  makeWorkspaceGovernedActionPolicyDefinitions
} from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { ContentBlobDigest, RecordRevision } from "../../src/server/persistence/repositories/models.js"
import { WorkspaceSettingsRecord } from "../../src/server/persistence/repositories/workspaceSettingsRepository.js"
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

type EvaluationInput =
  & Pick<
    VerifyGovernedActionDispatchAuthorityInput,
    "currentEvidence" | "envelope" | "evaluatedAt" | "session"
  >
  & {
    readonly priorTargetAttempts: number
  }

const makeInput = Effect.fn("GovernedActionPolicyEvaluatorTest.makeInput")(function*() {
  const envelope = yield* makeAuthorizedGovernedActionEnvelope()
  const definition = yield* makeBuiltInGovernedActionPolicyDefinition()
  const session = decodeSession({
    sessionId: SESSION_ID,
    workspaceId: WorkspaceId.make(WORKSPACE_ID),
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
      evaluatedAt: decodeTimestamp("2026-07-15T10:02:00.000Z"),
      priorTargetAttempts: 0
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

const workspaceSettingsRecord = (
  policyRevision: number,
  settings: WorkspaceSettingsV1
) =>
  WorkspaceSettingsRecord.make({
    workspaceId: WorkspaceId.make(WORKSPACE_ID),
    revision: RecordRevision.make(policyRevision),
    policyRevision: RecordRevision.make(policyRevision),
    settings,
    settingsDigest: ContentBlobDigest.make("a".repeat(64)),
    createdAt: decodeTimestamp("2026-07-15T09:00:00.000Z"),
    updatedAt: decodeTimestamp("2026-07-15T10:00:00.000Z"),
    updatedByPersonId: PersonId.make(PERSON_ID)
  })

const replacePolicyAction = Effect.fn(
  "GovernedActionPolicyEvaluatorTest.replacePolicyAction"
)(function*(
  input: EvaluationInput,
  definition: GovernedActionPolicyDefinition,
  actionKind: string,
  pluginId: string
) {
  const encoded = Schema.encodeSync(GovernedActionEnvelopeMaterialV1)(
    input.envelope
  )
  const material = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)({
    ...encoded,
    pluginId,
    policy: definition.binding,
    proposal: {
      ...encoded.proposal,
      request: { ...encoded.proposal.request, actionKind }
    }
  })
  return {
    ...input,
    envelope: (yield* makeGovernedActionEnvelope(material)).envelope
  } satisfies EvaluationInput
})

describe("governed action policy evaluator", () => {
  it.effect(
    "binds Jira decisions to the exact governed settings policy revision",
    () =>
      Effect.gen(function*() {
        const { input } = yield* makeInput()
        const manualDefinitions = yield* makeWorkspaceGovernedActionPolicyDefinitions(
          workspaceSettingsRecord(1, DEFAULT_WORKSPACE_SETTINGS)
        )
        const manualDefinition = manualDefinitions.find(
          ({ binding }) => binding.requiredPermission === "workspace-owner"
        )
        if (manualDefinition === undefined) {
          return yield* Effect.die("expected owner settings policy")
        }
        const manualEvaluator = yield* makeGovernedActionPolicyEvaluator(manualDefinitions)
        assert.strictEqual(
          (
            yield* manualEvaluator
              .evaluate(input)
              .pipe(Effect.flip)
          )._tag,
          "GovernedActionPolicyBindingUnavailable"
        )
        const manualInputs = yield* Effect.all(
          ["add-comment", "reply-comment"].map((actionKind) =>
            replacePolicyAction(input, manualDefinition, actionKind, "dev.knpkv.jira.read")
          )
        )
        for (const manualInput of manualInputs) {
          assert.strictEqual(
            (yield* manualEvaluator.evaluate(manualInput)).decision,
            "denied"
          )
        }
        const unrelatedJiraInput = yield* replacePolicyAction(
          input,
          manualDefinition,
          "set-fix-versions",
          "dev.knpkv.jira.read"
        )
        assert.strictEqual(
          (yield* manualEvaluator.evaluate(unrelatedJiraInput)).decision,
          "allowed"
        )

        const confirmedSettings: WorkspaceSettingsV1 = {
          ...DEFAULT_WORKSPACE_SETTINGS,
          jira: {
            ...DEFAULT_WORKSPACE_SETTINGS.jira,
            commentMode: "confirm-before-publish"
          }
        }
        const confirmedDefinitions = yield* makeWorkspaceGovernedActionPolicyDefinitions(
          workspaceSettingsRecord(2, confirmedSettings)
        )
        const confirmedDefinition = confirmedDefinitions.find(
          ({ binding }) => binding.requiredPermission === "workspace-owner"
        )
        if (confirmedDefinition === undefined) {
          return yield* Effect.die("expected confirmed settings policy")
        }
        const confirmedEvaluator = yield* makeGovernedActionPolicyEvaluator(confirmedDefinitions)
        for (const actionKind of ["add-comment", "reply-comment"]) {
          const confirmedInput = yield* replacePolicyAction(
            input,
            confirmedDefinition,
            actionKind,
            "dev.knpkv.jira.read"
          )
          assert.strictEqual(
            (yield* confirmedEvaluator.evaluate(confirmedInput)).decision,
            "allowed"
          )
        }
        for (const manualInput of manualInputs) {
          assert.strictEqual(
            (
              yield* confirmedEvaluator
                .evaluate(manualInput)
                .pipe(Effect.flip)
            )._tag,
            "GovernedActionPolicyBindingUnavailable"
          )
        }

        const presentationOnlyDefinitions = yield* makeWorkspaceGovernedActionPolicyDefinitions(
          workspaceSettingsRecord(2, {
            ...confirmedSettings,
            presentation: {
              ...confirmedSettings.presentation,
              density: "compact"
            }
          })
        )
        assert.deepStrictEqual(
          presentationOnlyDefinitions.map(({ binding }) => binding),
          confirmedDefinitions.map(({ binding }) => binding)
        )
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("enforces the durable pipeline retry attempt ceiling", () =>
    Effect.gen(function*() {
      const { input } = yield* makeInput()
      const settings: WorkspaceSettingsV1 = {
        ...DEFAULT_WORKSPACE_SETTINGS,
        pipeline: {
          retryMode: "confirm-before-retry",
          maximumAttempts: 1
        }
      }
      const definitions = yield* makeWorkspaceGovernedActionPolicyDefinitions(
        workspaceSettingsRecord(2, settings)
      )
      const definition = definitions.find(
        ({ binding }) => binding.requiredPermission === "workspace-owner"
      )
      if (definition === undefined) {
        return yield* Effect.die("expected owner settings policy")
      }
      const evaluator = yield* makeGovernedActionPolicyEvaluator(definitions)
      const retryInput = yield* replacePolicyAction(
        input,
        definition,
        "pipeline.retry",
        "dev.knpkv.aws-codepipeline"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate(retryInput)).decision,
        "allowed"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({ ...retryInput, priorTargetAttempts: 1 })).decision,
        "denied"
      )
      const unrelatedInput = yield* replacePolicyAction(
        { ...input, priorTargetAttempts: 100 },
        definition,
        "pipeline.stop",
        "dev.knpkv.aws-codepipeline"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate(unrelatedInput)).decision,
        "allowed"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds approval actions to a policy granted to approvers and owners", () =>
    Effect.gen(function*() {
      const { input } = yield* makeInput()
      const definitions = yield* makeBuiltInGovernedActionPolicyDefinitions()
      const approverDefinition = definitions.find(
        ({ binding }) => binding.requiredPermission === "workspace-approver"
      )
      if (approverDefinition === undefined) {
        return yield* Effect.die("expected the built-in approver policy")
      }
      assert.deepStrictEqual(
        approverDefinition.material,
        BUILT_IN_GOVERNED_ACTION_APPROVER_POLICY_MATERIAL
      )
      const material = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)({
        ...Schema.encodeSync(GovernedActionEnvelopeMaterialV1)(input.envelope),
        policy: approverDefinition.binding
      })
      const envelope = (yield* makeGovernedActionEnvelope(material)).envelope
      const evaluator = yield* makeGovernedActionPolicyEvaluator(definitions)
      const approverSession = decodeSession({
        ...Schema.encodeSync(SessionSummary)(input.session),
        permission: "workspace-approver"
      })

      assert.strictEqual(
        (yield* evaluator.evaluate({
          ...input,
          envelope,
          session: approverSession
        })).decision,
        "allowed"
      )
      assert.strictEqual(
        (yield* evaluator.evaluate({ ...input, envelope })).decision,
        "allowed"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

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
