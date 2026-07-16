import * as Schema from "effect/Schema"

import { EnvironmentId, ReadinessAssessmentId, ReleaseId, WorkspaceId } from "../identifiers.js"
import {
  MAX_READINESS_EVIDENCE_REFERENCES,
  ReadinessArtifactRevision,
  ReadinessCandidateDigest,
  ReadinessFactDefinition,
  type ReadinessFactDefinition as ReadinessFactDefinitionType,
  ReadinessFactObservation,
  type ReadinessFactObservation as ReadinessFactObservationType,
  ReadinessReleaseRevision,
  ReadinessRuleId,
  ReadinessRuleVersion
} from "./model.js"
import { compareReadinessText, readinessDefinitionsShapeIsV1, readinessPolicyShapeIsV1 } from "./policy.js"

const unique = <Value>(values: ReadonlyArray<Value>): boolean => new Set(values).size === values.length

const CandidateMaterialBase = {
  workspaceId: WorkspaceId,
  releaseRevision: ReadinessReleaseRevision,
  artifactRevision: ReadinessArtifactRevision
}

const readinessFactsAreValid = (input: {
  readonly definitions: ReadonlyArray<ReadinessFactDefinitionType>
  readonly observations: ReadonlyArray<ReadinessFactObservationType>
}): boolean => {
  const definitionsById = new Map(input.definitions.map((definition) => [definition.factId, definition]))
  return unique(input.definitions.map(({ factId }) => factId)) &&
    unique(input.observations.map(({ factId }) => factId)) &&
    input.observations.every((observation) =>
      definitionsById.get(observation.factId)?.kind === observation.state._tag
    ) &&
    readinessPolicyShapeIsV1(input.definitions, input.observations) &&
    input.observations.reduce((total, observation) => total + observation.evidence.length, 0) <=
      MAX_READINESS_EVIDENCE_REFERENCES
}

/** Digest-free, complete material for one target-environment candidate. */
export const EnvironmentReadinessCandidateMaterial = Schema.Struct({
  ...CandidateMaterialBase,
  scope: Schema.TaggedStruct("environment", {
    releaseId: ReleaseId,
    environmentId: EnvironmentId
  }),
  complete: Schema.Boolean,
  definitions: Schema.Array(ReadinessFactDefinition).check(Schema.isMaxLength(512)),
  observations: Schema.Array(ReadinessFactObservation).check(Schema.isMaxLength(512))
}).check(
  Schema.makeFilter(readinessFactsAreValid, {
    expected: "complete, unique, evidence-bounded V1 readiness candidate material"
  })
)

/** Decoded environment candidate material before deterministic normalization. */
export type EnvironmentReadinessCandidateMaterial = typeof EnvironmentReadinessCandidateMaterial.Type

/** Exact child assessment bound into a release-scope candidate. */
export const ReleaseReadinessChildMaterial = Schema.Struct({
  assessmentId: ReadinessAssessmentId,
  environmentId: EnvironmentId,
  candidateDigest: ReadinessCandidateDigest
})

/** Decoded release child material. */
export type ReleaseReadinessChildMaterial = typeof ReleaseReadinessChildMaterial.Type

/** Digest-free material for one release candidate and its exact environment assessments. */
export const ReleaseReadinessCandidateMaterial = Schema.Struct({
  ...CandidateMaterialBase,
  scope: Schema.TaggedStruct("release", { releaseId: ReleaseId }),
  environments: Schema.NonEmptyArray(ReleaseReadinessChildMaterial).check(Schema.isMaxLength(512))
}).check(
  Schema.makeFilter(({ environments }) => unique(environments.map(({ environmentId }) => environmentId)), {
    expected: "release candidate environment identities to be unique"
  }),
  Schema.makeFilter(({ environments }) => unique(environments.map(({ assessmentId }) => assessmentId)), {
    expected: "release candidate assessment identities to be unique"
  })
)

/** Decoded release candidate material before deterministic normalization. */
export type ReleaseReadinessCandidateMaterial = typeof ReleaseReadinessCandidateMaterial.Type

/** Digest-free immutable readiness-rule snapshot. */
export const ReadinessRuleMaterial = Schema.Struct({
  ruleId: ReadinessRuleId,
  version: ReadinessRuleVersion,
  definitions: Schema.Array(ReadinessFactDefinition).check(Schema.isNonEmpty(), Schema.isMaxLength(512))
}).check(
  Schema.makeFilter(({ definitions }) => unique(definitions.map(({ factId }) => factId)), {
    expected: "readiness rule fact identities to be unique"
  }),
  Schema.makeFilter(({ definitions }) => readinessDefinitionsShapeIsV1(definitions), {
    expected: "readiness rule material to contain the complete V1 policy shape"
  })
)

/** Decoded rule material before deterministic normalization. */
export type ReadinessRuleMaterial = typeof ReadinessRuleMaterial.Type

const normalizeDefinitions = (
  definitions: ReadonlyArray<ReadinessFactDefinitionType>
): Array<ReadinessFactDefinitionType> =>
  [...definitions].sort((left, right) => compareReadinessText(left.factId, right.factId))

const normalizeObservations = (
  observations: ReadonlyArray<ReadinessFactObservationType>
): Array<ReadinessFactObservationType> =>
  observations
    .map((observation) => ({
      ...observation,
      evidence: [...observation.evidence].sort((left, right) => compareReadinessText(left.evidenceId, right.evidenceId))
    }))
    .sort((left, right) => compareReadinessText(left.factId, right.factId))

/** Return the only JSON ordering accepted for environment-candidate hashing. */
export const normalizeEnvironmentReadinessCandidateMaterial = (
  material: EnvironmentReadinessCandidateMaterial
): EnvironmentReadinessCandidateMaterial => ({
  ...material,
  definitions: normalizeDefinitions(material.definitions),
  observations: normalizeObservations(material.observations)
})

/** Return the only JSON ordering accepted for release-candidate hashing. */
export const normalizeReleaseReadinessCandidateMaterial = (
  material: ReleaseReadinessCandidateMaterial
): ReleaseReadinessCandidateMaterial => {
  const [first, ...remaining] = material.environments
  const environments: [ReleaseReadinessChildMaterial, ...Array<ReleaseReadinessChildMaterial>] = [
    first,
    ...remaining
  ]
  environments.sort((left, right) => compareReadinessText(left.environmentId, right.environmentId))
  return { ...material, environments }
}

/** Return the only JSON ordering accepted for rule hashing. */
export const normalizeReadinessRuleMaterial = (
  material: ReadinessRuleMaterial
): ReadinessRuleMaterial => ({
  ...material,
  definitions: normalizeDefinitions(material.definitions)
})
