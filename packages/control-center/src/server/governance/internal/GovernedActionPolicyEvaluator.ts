import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  GovernedActionPolicyBinding,
  type GovernedActionPolicyBinding as GovernedActionPolicyBindingType,
  GovernedActionPolicyEvaluationV1
} from "../../../domain/governedAction/index.js"
import type { WorkspaceId } from "../../../domain/identifiers.js"
import { WorkspaceSettingsV1 } from "../../../domain/workspaceSettings.js"
import { RecordRevision } from "../../persistence/repositories/models.js"
import {
  type WorkspaceSettingsRecord,
  WorkspaceSettingsRepository
} from "../../persistence/repositories/workspaceSettingsRepository.js"
import type { VerifyGovernedActionDispatchAuthorityInput } from "../governedActionAuthority.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPolicyDefinition,
  type GovernedActionDigestError
} from "../governedActionDigests.js"
import { governedHumanMutationPolicyAllows } from "../GovernedHumanMutationPolicyEvaluator.js"

const PolicyRule = Schema.Literals(["permission-grants", "workspace-match"])
const canonicalRules = Schema.makeFilter(
  (rules: ReadonlyArray<string>) => rules.every((rule, index) => index === 0 || (rules[index - 1] ?? "") < rule),
  { expected: "policy rules in canonical order" }
)

const WorkspaceGovernedActionPolicy = Schema.Struct({
  policyRevision: RecordRevision,
  jiraCommentMode: WorkspaceSettingsV1.fields.jira.fields.commentMode,
  pipelineMaximumAttempts: WorkspaceSettingsV1.fields.pipeline.fields.maximumAttempts,
  pipelineRetryMode: WorkspaceSettingsV1.fields.pipeline.fields.retryMode,
  agent: WorkspaceSettingsV1.fields.agent
})

/** Canonical declarative policy material; executable source text is never hashed. */
export const GovernedActionPolicyMaterialV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyId: GovernedActionPolicyBinding.fields.policyId,
  policyVersion: GovernedActionPolicyBinding.fields.policyVersion,
  requiredPermission: GovernedActionPolicyBinding.fields.requiredPermission,
  evaluator: Schema.Literal("human-session-policy"),
  evaluatorVersion: Schema.Literal(1),
  rules: Schema.Array(PolicyRule).check(Schema.isNonEmpty(), Schema.isUnique(), canonicalRules),
  workspacePolicy: Schema.NullOr(WorkspaceGovernedActionPolicy)
})

/** Decoded version-one policy definition material. */
export type GovernedActionPolicyMaterialV1 = typeof GovernedActionPolicyMaterialV1.Type

/** Version-one rule implemented by the built-in governed-action policy catalog. */
export const BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL = Schema.decodeUnknownSync(
  GovernedActionPolicyMaterialV1
)({
  schemaVersion: 1,
  policyId: "plugin.action.execute.workspace-owner",
  policyVersion: 1,
  requiredPermission: "workspace-owner",
  evaluator: "human-session-policy",
  evaluatorVersion: 1,
  rules: ["permission-grants", "workspace-match"],
  workspacePolicy: null
})

/** Built-in policy for actions that an exact workspace approver or owner may authorize. */
export const BUILT_IN_GOVERNED_ACTION_APPROVER_POLICY_MATERIAL = Schema.decodeUnknownSync(
  GovernedActionPolicyMaterialV1
)({
  schemaVersion: 1,
  policyId: "plugin.action.execute.workspace-approver",
  policyVersion: 1,
  requiredPermission: "workspace-approver",
  evaluator: "human-session-policy",
  evaluatorVersion: 1,
  rules: ["permission-grants", "workspace-match"],
  workspacePolicy: null
})

export interface GovernedActionPolicyDefinition {
  readonly binding: GovernedActionPolicyBindingType
  readonly enabled: boolean
  readonly material: GovernedActionPolicyMaterialV1
}

/** The proposal's policy identity is absent from or differs from the current server catalog. */
export class GovernedActionPolicyBindingUnavailable extends Schema.TaggedErrorClass<
  GovernedActionPolicyBindingUnavailable
>()("GovernedActionPolicyBindingUnavailable", {}) {}

/** The server-owned policy catalog contains ambiguous current policy families. */
export class GovernedActionPolicyCatalogInvalid extends Schema.TaggedErrorClass<
  GovernedActionPolicyCatalogInvalid
>()("GovernedActionPolicyCatalogInvalid", {}) {}

type GovernedActionPolicyEvaluationInput =
  & Pick<
    VerifyGovernedActionDispatchAuthorityInput,
    "currentEvidence" | "envelope" | "evaluatedAt" | "session"
  >
  & {
    readonly priorTargetAttempts: number
  }

/** Internal policy boundary evaluated from current policy and session inputs only. */
export interface GovernedActionPolicyEvaluatorV1 {
  readonly evaluate: (
    input: GovernedActionPolicyEvaluationInput
  ) => Effect.Effect<
    GovernedActionPolicyEvaluationV1,
    GovernedActionDigestError | GovernedActionPolicyBindingUnavailable
  >
}

const bindingsEqual = (
  left: GovernedActionPolicyBindingType,
  right: GovernedActionPolicyBindingType
): boolean =>
  left.policyId === right.policyId &&
  left.policyVersion === right.policyVersion &&
  left.policyDigest === right.policyDigest &&
  left.requiredPermission === right.requiredPermission

const ruleAllows = (
  rule: typeof PolicyRule.Type,
  input: GovernedActionPolicyEvaluationInput,
  definition: GovernedActionPolicyDefinition
): boolean => {
  switch (rule) {
    case "permission-grants":
      return governedHumanMutationPolicyAllows({
        requiredPermission: definition.binding.requiredPermission,
        session: input.session,
        workspaceId: input.envelope.workspaceId
      })
    case "workspace-match":
      return input.session.workspaceId === input.envelope.workspaceId
  }
}

const encodePolicyMaterial = Schema.encodeEffect(GovernedActionPolicyMaterialV1)

const evidenceAllows = Effect.fn("GovernedActionPolicyEvaluator.evidenceAllows")(function*(
  input: GovernedActionPolicyEvaluationInput
) {
  const digest = yield* digestGovernedActionEvidenceSet(input.currentEvidence)
  return digest === input.envelope.evidenceSetDigest &&
    input.currentEvidence.every((reference) =>
      reference.workspaceId === input.envelope.workspaceId &&
      reference.source === "current" &&
      reference.validity === "valid" &&
      (reference.currentUntil === null || DateTime.Order(input.evaluatedAt, reference.currentUntil) < 0) &&
      (reference.validUntil === null || DateTime.Order(input.evaluatedAt, reference.validUntil) < 0)
    )
})

const workspacePolicyAllows = (
  input: GovernedActionPolicyEvaluationInput,
  definition: GovernedActionPolicyDefinition
): boolean => {
  const policy = definition.material.workspacePolicy
  if (policy === null) return true
  if (
    input.envelope.pluginId === "dev.knpkv.jira.read" &&
    (
      input.envelope.proposal.request.actionKind === "add-comment" ||
      input.envelope.proposal.request.actionKind === "reply-comment"
    )
  ) {
    return policy.jiraCommentMode === "confirm-before-publish"
  }
  if (
    input.envelope.pluginId === "dev.knpkv.aws-codepipeline" &&
    input.envelope.proposal.request.actionKind === "pipeline.retry"
  ) {
    return policy.pipelineRetryMode === "confirm-before-retry" &&
      input.priorTargetAttempts < policy.pipelineMaximumAttempts
  }
  return true
}

/** Construct a catalog entry whose binding digest is derived from its complete declarative semantics. */
export const makeGovernedActionPolicyDefinition = Effect.fn(
  "GovernedActionPolicyEvaluator.makeDefinition"
)(function*(material: GovernedActionPolicyMaterialV1, enabled: boolean) {
  const encoded = yield* encodePolicyMaterial(material).pipe(
    Effect.mapError(() => new GovernedActionPolicyCatalogInvalid())
  )
  const canonical = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded).pipe(
    Effect.mapError(() => new GovernedActionPolicyCatalogInvalid())
  )
  const policyDigest = yield* digestGovernedActionPolicyDefinition(canonical).pipe(
    Effect.mapError(() => new GovernedActionPolicyCatalogInvalid())
  )
  return {
    material,
    enabled,
    binding: GovernedActionPolicyBinding.make({
      policyId: material.policyId,
      policyVersion: material.policyVersion,
      policyDigest,
      requiredPermission: material.requiredPermission
    })
  } satisfies GovernedActionPolicyDefinition
})

/** Construct the built-in policy entry from its canonical declarative material. */
export const makeBuiltInGovernedActionPolicyDefinition = Effect.fn(
  "GovernedActionPolicyEvaluator.makeBuiltInDefinition"
)(function*() {
  return yield* makeGovernedActionPolicyDefinition(BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL, true)
})

/** Construct every built-in policy entry used by the live evaluator and proposal source. */
export const makeBuiltInGovernedActionPolicyDefinitions = Effect.fn(
  "GovernedActionPolicyEvaluator.makeBuiltInDefinitions"
)(function*() {
  return yield* Effect.all([
    makeBuiltInGovernedActionPolicyDefinition(),
    makeGovernedActionPolicyDefinition(BUILT_IN_GOVERNED_ACTION_APPROVER_POLICY_MATERIAL, true)
  ])
})

/** Derive the D03 binding catalog from one exact persisted settings revision. */
export const makeWorkspaceGovernedActionPolicyDefinitions = Effect.fn(
  "GovernedActionPolicyEvaluator.makeWorkspaceDefinitions"
)(function*(record: WorkspaceSettingsRecord) {
  const workspacePolicy = {
    policyRevision: record.policyRevision,
    jiraCommentMode: record.settings.jira.commentMode,
    pipelineMaximumAttempts: record.settings.pipeline.maximumAttempts,
    pipelineRetryMode: record.settings.pipeline.retryMode,
    agent: record.settings.agent
  }
  return yield* Effect.all([
    makeGovernedActionPolicyDefinition(
      { ...BUILT_IN_GOVERNED_ACTION_POLICY_MATERIAL, workspacePolicy },
      true
    ),
    makeGovernedActionPolicyDefinition(
      { ...BUILT_IN_GOVERNED_ACTION_APPROVER_POLICY_MATERIAL, workspacePolicy },
      true
    )
  ])
})

class WorkspacePolicyRevisionKey extends Data.Class<{
  readonly workspaceId: WorkspaceId
  readonly policyRevision: RecordRevision
}> {}

/** One cached policy catalog derived from an exact durable settings revision. */
export interface WorkspaceGovernedActionPolicyCatalog {
  readonly definitions: ReadonlyArray<GovernedActionPolicyDefinition>
  readonly evaluator: GovernedActionPolicyEvaluatorV1
}

/** Revision-aware source that avoids repeating policy derivation and digest work. */
export interface WorkspaceGovernedActionPolicyCatalogSource {
  readonly get: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<
    WorkspaceGovernedActionPolicyCatalog,
    GovernedActionPolicyBindingUnavailable
  >
}

/** Build a bounded cache while retaining a durable current-revision read on every decision. */
export const makeWorkspaceGovernedActionPolicyCatalogSource = Effect.fn(
  "GovernedActionPolicyEvaluator.makeWorkspacePolicyCatalogSource"
)(function*(
  read: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<WorkspaceSettingsRecord, unknown>
) {
  const cryptoService = yield* Crypto.Crypto
  const cache = yield* Cache.makeWith(
    (key: WorkspacePolicyRevisionKey) =>
      read(key.workspaceId).pipe(
        Effect.mapError(() => new GovernedActionPolicyBindingUnavailable()),
        Effect.flatMap((record) =>
          record.policyRevision !== key.policyRevision
            ? Effect.fail(new GovernedActionPolicyBindingUnavailable())
            : Effect.gen(function*() {
              const definitions = yield* makeWorkspaceGovernedActionPolicyDefinitions(record)
              const evaluator = yield* makeGovernedActionPolicyEvaluator(definitions)
              return { definitions, evaluator } satisfies WorkspaceGovernedActionPolicyCatalog
            }).pipe(
              Effect.provideService(Crypto.Crypto, cryptoService),
              Effect.mapError(() => new GovernedActionPolicyBindingUnavailable())
            )
        )
      ),
    {
      capacity: 256,
      timeToLive: (exit) => Exit.isFailure(exit) ? "0 millis" : "1 hour"
    }
  )
  return {
    get: Effect.fn("WorkspaceGovernedActionPolicyCatalogSource.get")(function*(workspaceId) {
      const record = yield* read(workspaceId).pipe(
        Effect.mapError(() => new GovernedActionPolicyBindingUnavailable())
      )
      return yield* Cache.get(
        cache,
        new WorkspacePolicyRevisionKey({
          workspaceId,
          policyRevision: record.policyRevision
        })
      )
    })
  } satisfies WorkspaceGovernedActionPolicyCatalogSource
})

/** Build the policy evaluator from a versioned server-owned catalog. */
export const makeGovernedActionPolicyEvaluator = Effect.fn(
  "GovernedActionPolicyEvaluator.make"
)(function*(definitions: ReadonlyArray<GovernedActionPolicyDefinition>) {
  const cryptoService = yield* Crypto.Crypto
  if (new Set(definitions.map(({ binding }) => binding.policyId)).size !== definitions.length) {
    return yield* new GovernedActionPolicyCatalogInvalid()
  }
  const verifiedDefinitions = yield* Effect.forEach(
    definitions,
    (definition) =>
      makeGovernedActionPolicyDefinition(definition.material, definition.enabled).pipe(
        Effect.flatMap((verified) =>
          bindingsEqual(verified.binding, definition.binding)
            ? Effect.succeed(verified)
            : Effect.fail(new GovernedActionPolicyCatalogInvalid())
        )
      )
  )
  const evaluate = Effect.fn("GovernedActionPolicyEvaluator.evaluate")(function*(
    input: GovernedActionPolicyEvaluationInput
  ) {
    const definition = verifiedDefinitions.find(
      ({ binding }) => binding.policyId === input.envelope.policy.policyId
    )
    if (definition === undefined || !bindingsEqual(definition.binding, input.envelope.policy)) {
      return yield* new GovernedActionPolicyBindingUnavailable()
    }
    const allowed = definition.enabled &&
      input.session.actor._tag === "human" &&
      definition.material.rules.every((rule) => ruleAllows(rule, input, definition)) &&
      workspacePolicyAllows(input, definition) &&
      (yield* evidenceAllows(input).pipe(Effect.provideService(Crypto.Crypto, cryptoService)))

    return GovernedActionPolicyEvaluationV1.make({
      schemaVersion: 1,
      actionId: input.envelope.actionId,
      workspaceId: input.envelope.workspaceId,
      policy: definition.binding,
      payloadDigest: input.envelope.proposal.payloadDigest,
      evidenceSetDigest: input.envelope.evidenceSetDigest,
      expectedRevision: input.envelope.proposal.request.expectedRevision,
      decision: allowed ? "allowed" : "denied",
      evaluatedAt: input.evaluatedAt
    })
  })

  return { evaluate }
})

const makeLiveEvaluator = Effect.gen(function*() {
  const definitions = yield* makeBuiltInGovernedActionPolicyDefinitions()
  return yield* makeGovernedActionPolicyEvaluator(definitions)
})

const makeWorkspaceSettingsEvaluator = Effect.gen(function*() {
  const repository = yield* WorkspaceSettingsRepository
  const catalogs = yield* makeWorkspaceGovernedActionPolicyCatalogSource(
    repository.get
  )
  return {
    evaluate: (input: GovernedActionPolicyEvaluationInput) =>
      catalogs.get(input.envelope.workspaceId).pipe(
        Effect.flatMap(({ evaluator }) => evaluator.evaluate(input))
      )
  } satisfies GovernedActionPolicyEvaluatorV1
})

/** Server-only fresh policy evaluator; persisted workspace-policy adapters replace this at I12. */
export class GovernedActionPolicyEvaluator extends Context.Service<
  GovernedActionPolicyEvaluator,
  GovernedActionPolicyEvaluatorV1
>()("@knpkv/control-center/internal/GovernedActionPolicyEvaluator") {
  static readonly layer: Layer.Layer<
    GovernedActionPolicyEvaluator,
    GovernedActionPolicyCatalogInvalid,
    Crypto.Crypto
  > = Layer.effect(
    GovernedActionPolicyEvaluator,
    makeLiveEvaluator
  )

  /** Live I12 adapter that binds every policy decision to persisted settings. */
  static readonly workspaceSettingsLayer: Layer.Layer<
    GovernedActionPolicyEvaluator,
    never,
    Crypto.Crypto | WorkspaceSettingsRepository
  > = Layer.effect(
    GovernedActionPolicyEvaluator,
    makeWorkspaceSettingsEvaluator
  )
}
