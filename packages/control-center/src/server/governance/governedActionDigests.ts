import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"

import {
  GovernedActionAttemptDigest,
  GovernedActionAttemptV1,
  type GovernedActionAttemptV1 as GovernedActionAttempt,
  GovernedActionAuthorizationDigest,
  GovernedActionAuthorizationV1,
  type GovernedActionAuthorizationV1 as GovernedActionAuthorization,
  GovernedActionEnvelopeDigest,
  GovernedActionEnvelopeMaterialV1,
  type GovernedActionEnvelopeMaterialV1 as GovernedActionEnvelopeMaterial,
  type GovernedActionEnvelopeV1 as GovernedActionEnvelope,
  type GovernedActionEvidenceReference as GovernedActionEvidence,
  GovernedActionEvidenceSet,
  GovernedActionEvidenceSetDigest,
  GovernedActionPolicyDigest,
  GovernedActionPolicyEvaluationDigest,
  GovernedActionPolicyEvaluationV1,
  type GovernedActionPolicyEvaluationV1 as GovernedActionPolicyEvaluation
} from "../../domain/governedAction/model.js"
import {
  GovernedActionCommandDigest,
  GovernedActionTransitionCommand,
  type GovernedActionTransitionCommand as GovernedActionCommand,
  GovernedActionTransitionDigest,
  type GovernedActionTransitionMaterialV1 as GovernedActionTransitionMaterial,
  GovernedActionTransitionV1,
  type GovernedActionTransitionV1 as GovernedActionTransition
} from "../../domain/governedAction/stateMachine.js"
import { PluginActionPayloadDigest } from "../../domain/plugins/actions.js"
import type { PluginPayloadJson } from "../../domain/plugins/bounds.js"

/** Bounded failure while encoding or hashing governed-action authority. */
export class GovernedActionDigestError extends Schema.TaggedErrorClass<GovernedActionDigestError>()(
  "GovernedActionDigestError",
  {
    operation: Schema.Literals(["encode", "encode-utf8", "digest"])
  }
) {}

/** Exact immutable action binding that failed canonical verification. */
export class GovernedActionBindingMismatch extends Schema.TaggedErrorClass<GovernedActionBindingMismatch>()(
  "GovernedActionBindingMismatch",
  {
    reason: Schema.Literals([
      "payload-digest-mismatch",
      "evidence-set-digest-mismatch",
      "envelope-digest-mismatch",
      "command-digest-mismatch",
      "policy-evaluation-digest-mismatch",
      "authorization-digest-mismatch",
      "attempt-digest-mismatch",
      "transition-digest-mismatch"
    ]),
    expectedDigest: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
    actualDigest: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80))
  }
) {}

class VerifiedEnvelope {
  readonly #envelope: GovernedActionEnvelope

  constructor(envelope: GovernedActionEnvelope) {
    this.#envelope = envelope
  }

  /** Structurally decoded envelope whose canonical bindings were recomputed successfully. */
  get envelope(): GovernedActionEnvelope {
    return this.#envelope
  }
}

/** Nominal server-only proof that an action envelope passed canonical verification. */
export type VerifiedGovernedActionEnvelope = VerifiedEnvelope

class VerifiedTransition {
  readonly #transition: GovernedActionTransition

  constructor(transition: GovernedActionTransition) {
    this.#transition = transition
  }

  /** Structurally valid transition whose canonical command binding was recomputed successfully. */
  get transition(): GovernedActionTransition {
    return this.#transition
  }
}

/** Nominal server-only proof that a transition command digest was verified. */
export type VerifiedGovernedActionTransition = VerifiedTransition

class VerifiedPolicyEvaluation {
  readonly #evaluation: GovernedActionPolicyEvaluation
  readonly #digest: GovernedActionPolicyEvaluationDigest

  constructor(
    evaluation: GovernedActionPolicyEvaluation,
    digest: GovernedActionPolicyEvaluationDigest
  ) {
    this.#evaluation = evaluation
    this.#digest = digest
  }

  /** Structurally valid policy evaluation whose complete canonical digest was verified. */
  get evaluation(): GovernedActionPolicyEvaluation {
    return this.#evaluation
  }

  /** Recomputed canonical digest that matched the persisted policy-evaluation digest. */
  get digest(): GovernedActionPolicyEvaluationDigest {
    return this.#digest
  }
}

/** Nominal server-only proof that a complete policy-evaluation digest was verified. */
export type VerifiedGovernedActionPolicyEvaluation = VerifiedPolicyEvaluation

class VerifiedAuthorization {
  readonly #authorization: GovernedActionAuthorization
  readonly #digest: GovernedActionAuthorizationDigest

  constructor(authorization: GovernedActionAuthorization, digest: GovernedActionAuthorizationDigest) {
    this.#authorization = authorization
    this.#digest = digest
  }

  /** Structurally valid authorization whose complete canonical digest was verified. */
  get authorization(): GovernedActionAuthorization {
    return this.#authorization
  }

  /** Recomputed canonical digest that matched the persisted authorization digest. */
  get digest(): GovernedActionAuthorizationDigest {
    return this.#digest
  }
}

/** Nominal server-only proof that a complete authorization digest was verified. */
export type VerifiedGovernedActionAuthorization = VerifiedAuthorization

class VerifiedAttempt {
  readonly #attempt: GovernedActionAttempt
  readonly #digest: GovernedActionAttemptDigest

  constructor(attempt: GovernedActionAttempt, digest: GovernedActionAttemptDigest) {
    this.#attempt = attempt
    this.#digest = digest
  }

  /** Structurally valid dispatch attempt whose complete canonical digest was verified. */
  get attempt(): GovernedActionAttempt {
    return this.#attempt
  }

  /** Recomputed canonical digest that matched the persisted attempt digest. */
  get digest(): GovernedActionAttemptDigest {
    return this.#digest
  }
}

/** Nominal server-only proof that a complete dispatch-attempt digest was verified. */
export type VerifiedGovernedActionAttempt = VerifiedAttempt

class VerifiedTransitionRecord {
  readonly #transition: GovernedActionTransition
  readonly #digest: GovernedActionTransitionDigest

  constructor(transition: GovernedActionTransition, digest: GovernedActionTransitionDigest) {
    this.#transition = transition
    this.#digest = digest
  }

  /** Structurally valid transition whose command and complete canonical digest were verified. */
  get transition(): GovernedActionTransition {
    return this.#transition
  }

  /** Recomputed canonical digest that matched the persisted transition digest. */
  get digest(): GovernedActionTransitionDigest {
    return this.#digest
  }
}

/** Nominal server-only proof that a complete transition record and its command were verified. */
export type VerifiedGovernedActionTransitionRecord = VerifiedTransitionRecord

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Canonical JSON text with recursively sorted object keys and order-preserving arrays. */
export const canonicalizeGovernedActionJson = (value: Schema.Json): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalizeGovernedActionJson).join(",")}]`

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      return JSON.stringify(value) ?? "null"
    case "string":
      return JSON.stringify(value)
    case "object":
      return `{${
        Object.entries(value)
          .sort(([leftKey], [rightKey]) => compareText(leftKey, rightKey))
          .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalizeGovernedActionJson(nestedValue)}`)
          .join(",")
      }}`
  }
}

const digestCanonicalJson = Effect.fn("GovernedActionDigests.digestCanonicalJson")(function*(value: Schema.Json) {
  const cryptoService = yield* Crypto.Crypto
  const canonicalJson = canonicalizeGovernedActionJson(value)
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(canonicalJson))).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode-utf8" }))
  )
  const digest = yield* cryptoService
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => new GovernedActionDigestError({ operation: "digest" })))
  return Encoding.encodeHex(digest)
})

const encodeCommand = Schema.encodeEffect(GovernedActionTransitionCommand)
const encodeEvidence = Schema.encodeEffect(GovernedActionEvidenceSet)
const encodeEnvelope = Schema.encodeEffect(GovernedActionEnvelopeMaterialV1)
const encodePolicyEvaluation = Schema.encodeEffect(GovernedActionPolicyEvaluationV1)
const encodeAuthorization = Schema.encodeEffect(GovernedActionAuthorizationV1)
const encodeAttempt = Schema.encodeEffect(GovernedActionAttemptV1)
const encodeTransition = Schema.encodeEffect(GovernedActionTransitionV1)

const decodeJson = Effect.fn("GovernedActionDigests.decodeJson")(function*(value: unknown) {
  return yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
})

/** Hash one bounded provider payload independently of object insertion order. */
export const digestGovernedActionPayload = Effect.fn("GovernedActionDigests.payload")(function*(
  payload: typeof PluginPayloadJson.Type
) {
  const digest = yield* digestCanonicalJson(payload)
  return PluginActionPayloadDigest.make(digest)
})

/** Hash one closed transition command for exact caller-command replay checks. */
export const digestGovernedActionTransitionCommand = Effect.fn("GovernedActionDigests.command")(function*(
  command: GovernedActionCommand
) {
  const encoded = yield* encodeCommand(command).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionCommandDigest.make(`sha256:${digest}`)
})

/** Reject a retried command whose canonical content changed under the same identity. */
export const verifyGovernedActionTransitionCommandDigest = Effect.fn(
  "GovernedActionDigests.verifyCommand"
)(function*(command: GovernedActionCommand, expectedDigest: GovernedActionCommandDigest) {
  const actualDigest = yield* digestGovernedActionTransitionCommand(command)
  if (actualDigest !== expectedDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "command-digest-mismatch",
      expectedDigest,
      actualDigest
    })
  }
  return command
})

/** Construct an append-only transition with a digest of its exact canonical command. */
export const makeGovernedActionTransition = Effect.fn(
  "GovernedActionDigests.makeTransition"
)(function*(material: GovernedActionTransitionMaterial) {
  return new VerifiedTransition({
    ...material,
    commandDigest: yield* digestGovernedActionTransitionCommand(material.command)
  })
})

/** Reject a decoded transition when its persisted command digest is stale or forged. */
export const verifyGovernedActionTransition = Effect.fn(
  "GovernedActionDigests.verifyTransition"
)(function*(transition: GovernedActionTransition) {
  yield* verifyGovernedActionTransitionCommandDigest(transition.command, transition.commandDigest)
  return new VerifiedTransition(transition)
})

/** Hash the exact canonical evidence set bound to policy and authorization. */
export const digestGovernedActionEvidenceSet = Effect.fn("GovernedActionDigests.evidenceSet")(function*(
  evidence: ReadonlyArray<GovernedActionEvidence>
) {
  const encoded = yield* encodeEvidence(evidence).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionEvidenceSetDigest.make(`sha256:${digest}`)
})

/** Hash one canonical declarative policy definition independently of object insertion order. */
export const digestGovernedActionPolicyDefinition = Effect.fn(
  "GovernedActionDigests.policyDefinition"
)(function*(definition: Schema.Json) {
  const digest = yield* digestCanonicalJson(definition)
  return GovernedActionPolicyDigest.make(`sha256:${digest}`)
})

/** Hash a fresh policy decision so the exact evaluation can be retained with dispatch intent. */
export const digestGovernedActionPolicyEvaluation = Effect.fn(
  "GovernedActionDigests.policyEvaluation"
)(function*(evaluation: GovernedActionPolicyEvaluation) {
  const encoded = yield* encodePolicyEvaluation(evaluation).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionPolicyEvaluationDigest.make(`sha256:${digest}`)
})

/** Hash the complete immutable human authorization retained by the ledger. */
export const digestGovernedActionAuthorization = Effect.fn(
  "GovernedActionDigests.authorization"
)(function*(authorization: GovernedActionAuthorization) {
  const encoded = yield* encodeAuthorization(authorization).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionAuthorizationDigest.make(`sha256:${digest}`)
})

/** Hash the complete immutable durable dispatch intent retained by the ledger. */
export const digestGovernedActionAttempt = Effect.fn(
  "GovernedActionDigests.attempt"
)(function*(attempt: GovernedActionAttempt) {
  const encoded = yield* encodeAttempt(attempt).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionAttemptDigest.make(`sha256:${digest}`)
})

/** Hash a complete immutable transition for audit-event binding. */
export const digestGovernedActionTransition = Effect.fn(
  "GovernedActionDigests.transition"
)(function*(transition: GovernedActionTransition) {
  const encoded = yield* encodeTransition(transition).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionTransitionDigest.make(`sha256:${digest}`)
})

/** Verify the persisted digest of a complete immutable policy evaluation. */
export const verifyGovernedActionPolicyEvaluation = Effect.fn(
  "GovernedActionDigests.verifyPolicyEvaluation"
)(function*(
  evaluation: GovernedActionPolicyEvaluation,
  expectedDigest: GovernedActionPolicyEvaluationDigest
) {
  const actualDigest = yield* digestGovernedActionPolicyEvaluation(evaluation)
  if (actualDigest !== expectedDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "policy-evaluation-digest-mismatch",
      expectedDigest,
      actualDigest
    })
  }
  return new VerifiedPolicyEvaluation(evaluation, actualDigest)
})

/** Verify the persisted digest of a complete immutable human authorization. */
export const verifyGovernedActionAuthorization = Effect.fn(
  "GovernedActionDigests.verifyAuthorization"
)(function*(authorization: GovernedActionAuthorization, expectedDigest: GovernedActionAuthorizationDigest) {
  const actualDigest = yield* digestGovernedActionAuthorization(authorization)
  if (actualDigest !== expectedDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "authorization-digest-mismatch",
      expectedDigest,
      actualDigest
    })
  }
  return new VerifiedAuthorization(authorization, actualDigest)
})

/** Verify the persisted digest of a complete immutable dispatch attempt. */
export const verifyGovernedActionAttempt = Effect.fn(
  "GovernedActionDigests.verifyAttempt"
)(function*(attempt: GovernedActionAttempt, expectedDigest: GovernedActionAttemptDigest) {
  const actualDigest = yield* digestGovernedActionAttempt(attempt)
  if (actualDigest !== expectedDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "attempt-digest-mismatch",
      expectedDigest,
      actualDigest
    })
  }
  return new VerifiedAttempt(attempt, actualDigest)
})

/** Verify both the embedded command digest and persisted digest of a complete transition. */
export const verifyGovernedActionTransitionDigest = Effect.fn(
  "GovernedActionDigests.verifyTransitionDigest"
)(function*(transition: GovernedActionTransition, expectedDigest: GovernedActionTransitionDigest) {
  yield* verifyGovernedActionTransitionCommandDigest(transition.command, transition.commandDigest)
  const actualDigest = yield* digestGovernedActionTransition(transition)
  if (actualDigest !== expectedDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "transition-digest-mismatch",
      expectedDigest,
      actualDigest
    })
  }
  return new VerifiedTransitionRecord(transition, actualDigest)
})

/** Hash every digest-free field in a complete immutable V1 action envelope. */
export const digestGovernedActionEnvelope = Effect.fn("GovernedActionDigests.envelope")(function*(
  material: GovernedActionEnvelopeMaterial
) {
  const encoded = yield* encodeEnvelope(material).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const digest = yield* digestCanonicalJson(yield* decodeJson(encoded))
  return GovernedActionEnvelopeDigest.make(`sha256:${digest}`)
})

const verifyMaterialBindings = Effect.fn("GovernedActionDigests.verifyMaterialBindings")(function*(
  material: GovernedActionEnvelopeMaterial
) {
  const actualPayloadDigest = yield* digestGovernedActionPayload(material.proposal.request.payload)
  if (actualPayloadDigest !== material.proposal.payloadDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "payload-digest-mismatch",
      expectedDigest: material.proposal.payloadDigest,
      actualDigest: actualPayloadDigest
    })
  }

  const actualEvidenceSetDigest = yield* digestGovernedActionEvidenceSet(material.evidence)
  if (actualEvidenceSetDigest !== material.evidenceSetDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "evidence-set-digest-mismatch",
      expectedDigest: material.evidenceSetDigest,
      actualDigest: actualEvidenceSetDigest
    })
  }
})

/** Construct an envelope only after its payload and evidence bindings verify exactly. */
export const makeGovernedActionEnvelope = Effect.fn("GovernedActionDigests.makeEnvelope")(function*(
  material: GovernedActionEnvelopeMaterial
) {
  yield* verifyMaterialBindings(material)
  return new VerifiedEnvelope({
    ...material,
    envelopeDigest: yield* digestGovernedActionEnvelope(material)
  })
})

/** Recompute every canonical binding before trusting a decoded persisted envelope. */
export const verifyGovernedActionEnvelope = Effect.fn("GovernedActionDigests.verifyEnvelope")(function*(
  envelope: GovernedActionEnvelope
) {
  const { envelopeDigest, ...material } = envelope
  yield* verifyMaterialBindings(material)
  const actualEnvelopeDigest = yield* digestGovernedActionEnvelope(material)
  if (actualEnvelopeDigest !== envelopeDigest) {
    return yield* new GovernedActionBindingMismatch({
      reason: "envelope-digest-mismatch",
      expectedDigest: envelopeDigest,
      actualDigest: actualEnvelopeDigest
    })
  }
  return new VerifiedEnvelope(envelope)
})
