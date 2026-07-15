import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  governedActionPermissionGrants,
  GovernedActionPolicyBinding,
  type GovernedActionPolicyBinding as GovernedActionPolicyBindingType,
  GovernedActionPolicyEvaluationV1
} from "../../../domain/governedAction/index.js"
import type { VerifyGovernedActionDispatchAuthorityInput } from "../governedActionAuthority.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPolicyDefinition,
  type GovernedActionDigestError
} from "../governedActionDigests.js"

const PolicyRule = Schema.Literals(["permission-grants", "workspace-match"])
const canonicalRules = Schema.makeFilter(
  (rules: ReadonlyArray<string>) => rules.every((rule, index) => index === 0 || (rules[index - 1] ?? "") < rule),
  { expected: "policy rules in canonical order" }
)

/** Canonical declarative policy material; executable source text is never hashed. */
export const GovernedActionPolicyMaterialV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyId: GovernedActionPolicyBinding.fields.policyId,
  policyVersion: GovernedActionPolicyBinding.fields.policyVersion,
  requiredPermission: GovernedActionPolicyBinding.fields.requiredPermission,
  evaluator: Schema.Literal("human-session-policy"),
  evaluatorVersion: Schema.Literal(1),
  rules: Schema.Array(PolicyRule).check(Schema.isNonEmpty(), Schema.isUnique(), canonicalRules)
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
  rules: ["permission-grants", "workspace-match"]
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

type GovernedActionPolicyEvaluationInput = Pick<
  VerifyGovernedActionDispatchAuthorityInput,
  "currentEvidence" | "envelope" | "evaluatedAt" | "session"
>

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
      return governedActionPermissionGrants(input.session.permission, definition.binding.requiredPermission)
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
  const definition = yield* makeBuiltInGovernedActionPolicyDefinition()
  return yield* makeGovernedActionPolicyEvaluator([definition])
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
}
