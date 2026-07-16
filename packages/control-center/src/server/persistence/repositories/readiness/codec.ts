import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"

import type { PluginConnectionId } from "../../../../domain/identifiers.js"
import {
  normalizeReadinessRuleMaterial,
  ReadinessAssessment,
  ReadinessRuleMaterial as ReadinessRuleMaterialSchema
} from "../../../../domain/readiness/index.js"
import type {
  EnvironmentReadinessAssessment,
  EnvironmentReadinessCandidateMaterial,
  ReadinessAssessment as ReadinessAssessmentType,
  ReadinessRuleMaterial,
  ReleaseReadinessAssessment,
  ReleaseReadinessCandidateMaterial
} from "../../../../domain/readiness/index.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import {
  digestEnvironmentReadinessCandidate,
  digestReadinessRule,
  digestReleaseReadinessCandidate
} from "../../../readinessDigests.js"
import { PersistedRecordError, PersistenceOperationError } from "../../errors.js"
import { ContentBlobDigest } from "../models.js"
import type { ReadinessAssessmentRow, ReadinessRuleRow } from "./rows.js"

const assessmentJson = Schema.fromJsonString(ReadinessAssessment)
const ruleJson = Schema.fromJsonString(ReadinessRuleMaterialSchema)
const encodeAssessment = Schema.encodeEffect(assessmentJson)
const encodeRule = Schema.encodeEffect(ruleJson)
const decodeAssessment = Schema.decodeUnknownEffect(assessmentJson)
const decodeRule = Schema.decodeUnknownEffect(ruleJson)
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

const environmentMaterial = (assessment: EnvironmentReadinessAssessment): EnvironmentReadinessCandidateMaterial => ({
  workspaceId: assessment.candidate.workspaceId,
  releaseRevision: assessment.candidate.releaseRevision,
  artifactRevision: assessment.candidate.artifactRevision,
  scope: assessment.candidate.scope,
  complete: assessment.inputComplete,
  definitions: assessment.facts.map(({ definition }) => definition),
  observations: assessment.facts.flatMap(({ observation }) => (observation === null ? [] : [observation]))
})

const releaseMaterial = (assessment: ReleaseReadinessAssessment): ReleaseReadinessCandidateMaterial => {
  const [first, ...remaining] = assessment.environments
  return {
    workspaceId: assessment.candidate.workspaceId,
    releaseRevision: assessment.candidate.releaseRevision,
    artifactRevision: assessment.candidate.artifactRevision,
    scope: assessment.candidate.scope,
    environments: [
      {
        assessmentId: first.assessmentId,
        environmentId: first.environmentId,
        candidateDigest: first.candidateDigest
      },
      ...remaining.map(({ assessmentId, candidateDigest, environmentId }) => ({
        assessmentId,
        environmentId,
        candidateDigest
      }))
    ]
  }
}

const sourceIds = (assessment: ReadinessAssessmentType): Array<PluginConnectionId> =>
  assessment.sourceFreshness.map(({ pluginConnectionId }) => pluginConnectionId)

const encodeBytes = (value: string) =>
  Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "readiness.encode-utf8" }))
  )

export const makeReadinessCodec = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto

  const digestJson = Effect.fn("ReadinessCodec.digestJson")(function*(value: string) {
    const bytes = yield* encodeBytes(value)
    const digest = yield* cryptoService
      .digest("SHA-256", bytes)
      .pipe(Effect.mapError(() => new PersistenceOperationError({ operation: "readiness.digest-json" })))
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const candidateDigest = Effect.fn("ReadinessCodec.candidateDigest")(function*(assessment: ReadinessAssessmentType) {
    return assessment._tag === "environment"
      ? yield* digestEnvironmentReadinessCandidate(environmentMaterial(assessment))
      : yield* digestReleaseReadinessCandidate(releaseMaterial(assessment))
  })

  const prepareRule = Effect.fn("ReadinessCodec.prepareRule")(function*(material: ReadinessRuleMaterial) {
    const canonicalMaterial = normalizeReadinessRuleMaterial(material)
    const materialJson = yield* encodeRule(canonicalMaterial).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "readiness.encode-rule" }))
    )
    const ruleDigest = yield* digestReadinessRule(material)
    return { material: canonicalMaterial, materialJson, ruleDigest }
  })

  const prepareAssessment = Effect.fn("ReadinessCodec.prepareAssessment")(function*(
    assessment: ReadinessAssessmentType
  ) {
    const encoded = yield* encodeAssessment(assessment).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "readiness.encode-assessment" }))
    )
    const computedCandidateDigest = yield* candidateDigest(assessment)
    const assessmentDigest = yield* digestJson(encoded)
    return {
      assessmentJson: encoded,
      assessmentDigest,
      computedCandidateDigest,
      evidenceIds: assessment.evidenceIds,
      sourcePluginConnectionIds: sourceIds(assessment),
      releaseChildren: assessment._tag === "release"
        ? assessment.environments.map(({ assessmentId, candidateDigest, environmentId }) => ({
          environmentId,
          environmentAssessmentId: assessmentId,
          environmentCandidateDigest: candidateDigest
        }))
        : []
    }
  })

  const malformedAssessment = (row: typeof ReadinessAssessmentRow.Type, diagnosticCode: string) =>
    new PersistedRecordError({
      workspaceId: row.workspaceId,
      recordKind: "readiness-assessment",
      recordKey: row.assessmentId,
      diagnosticCode
    })

  const decodeAssessmentRow = Effect.fn("ReadinessCodec.decodeAssessmentRow")(function*(
    row: typeof ReadinessAssessmentRow.Type
  ) {
    const storedDigest = yield* digestJson(row.assessmentJson)
    if (storedDigest !== row.assessmentDigest) {
      return yield* malformedAssessment(row, "readiness-assessment-digest-mismatch")
    }
    const assessment = yield* decodeAssessment(row.assessmentJson).pipe(
      Effect.mapError(() => malformedAssessment(row, "readiness-assessment-schema-invalid"))
    )
    const scopeMatches = assessment._tag === row.scopeKind &&
      assessment.assessmentId === row.assessmentId &&
      assessment.candidate.workspaceId === row.workspaceId &&
      assessment.candidate.scope.releaseId === row.releaseId &&
      assessment.candidate.releaseRevision === row.releaseRevision &&
      assessment.candidate.artifactRevision === row.artifactRevision &&
      assessment.candidate.digest === row.candidateDigest &&
      assessment.rule.ruleId === row.ruleId &&
      assessment.rule.version === row.ruleVersion &&
      assessment.rule.digest === row.ruleDigest &&
      assessment.derivationVersion === row.derivationVersion &&
      assessment.previousAssessmentId === row.previousAssessmentId &&
      assessment.verdict === row.verdict &&
      encodeTimestamp(assessment.evaluatedAt) === row.evaluatedAt &&
      (assessment.nextEvaluationAt === null
        ? row.nextEvaluationAt === null
        : encodeTimestamp(assessment.nextEvaluationAt) === row.nextEvaluationAt) &&
      (assessment._tag === "release"
        ? row.environmentId === null
        : assessment.candidate.scope.environmentId === row.environmentId)
    if (!scopeMatches) {
      return yield* malformedAssessment(row, "readiness-assessment-identity-mismatch")
    }
    const computedCandidateDigest = yield* candidateDigest(assessment).pipe(
      Effect.mapError(() => malformedAssessment(row, "readiness-candidate-digest-mismatch"))
    )
    if (computedCandidateDigest !== assessment.candidate.digest) {
      return yield* malformedAssessment(row, "readiness-candidate-digest-mismatch")
    }
    return assessment
  })

  const decodeRuleRow = Effect.fn("ReadinessCodec.decodeRuleRow")(function*(row: typeof ReadinessRuleRow.Type) {
    const malformed = (diagnosticCode: string) =>
      new PersistedRecordError({
        workspaceId: row.workspaceId,
        recordKind: "readiness-rule",
        recordKey: row.ruleDigest.slice(7),
        diagnosticCode
      })
    const material = yield* decodeRule(row.materialJson).pipe(
      Effect.mapError(() => malformed("readiness-rule-schema-invalid"))
    )
    if (material.ruleId !== row.ruleId || material.version !== row.ruleVersion) {
      return yield* malformed("readiness-rule-identity-mismatch")
    }
    const digest = yield* digestReadinessRule(material).pipe(
      Effect.mapError(() => malformed("readiness-rule-digest-mismatch"))
    )
    if (digest !== row.ruleDigest) return yield* malformed("readiness-rule-digest-mismatch")
    return material
  })

  return {
    candidateDigest,
    decodeAssessmentRow,
    decodeRuleRow,
    digestJson,
    prepareAssessment,
    prepareRule
  }
})
