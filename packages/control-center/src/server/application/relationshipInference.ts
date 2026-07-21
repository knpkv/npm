import type {
  DeliveryEntityKind,
  DeliveryEntityProjection,
  DeliveryRelationship,
  RelationshipEndpointKind,
  RelationshipKind
} from "../../domain/deliveryGraph.js"
import type { EntityId, GraphNodeId, ReleaseId } from "../../domain/identifiers.js"

/** One current canonical entity exposed to provider-neutral relationship rules. */
export interface RelationshipInferenceEntity {
  readonly nodeId: GraphNodeId
  readonly projection: DeliveryEntityProjection
  readonly releaseIds: ReadonlyArray<ReleaseId>
}

/** One canonical release exposed without provider-specific version objects. */
export interface RelationshipInferenceRelease {
  readonly nodeId: GraphNodeId
  readonly releaseId: ReleaseId
  readonly version: string
}

export type RelationshipInferenceEndpoint =
  | Readonly<{ readonly _tag: "resolved"; readonly kind: RelationshipEndpointKind; readonly nodeId: GraphNodeId }>
  | Readonly<{ readonly _tag: "missing"; readonly kind: DeliveryEntityKind; readonly missingKey: string }>

/** Explainable candidate ready for evidence and ledger materialization. */
export interface RelationshipInferenceCandidate {
  readonly confidence: Readonly<{ readonly score: number; readonly rationale: string }> | null
  readonly evidenceEntityId: EntityId | null
  readonly identityKey: string
  readonly kind: RelationshipKind
  readonly lifecycle: "inferred" | "missing"
  readonly observationKey: string
  readonly releaseId: ReleaseId
  readonly ruleId: string
  readonly source: RelationshipInferenceEndpoint
  readonly target: RelationshipInferenceEndpoint
}

export interface RelationshipInferenceResult {
  readonly candidates: ReadonlyArray<RelationshipInferenceCandidate>
  readonly obsoleteGapIdentityKeys: ReadonlyArray<string>
  readonly obsoleteRelationshipIds: ReadonlyArray<DeliveryRelationship["relationshipId"]>
  readonly truncated: boolean
}

const MAXIMUM_INFERENCE_CANDIDATES = 2_000

interface CandidateAccumulator {
  readonly candidates: Array<RelationshipInferenceCandidate>
  truncated: boolean
}

const addCandidate = (
  accumulator: CandidateAccumulator,
  candidate: RelationshipInferenceCandidate
): void => {
  if (accumulator.candidates.length >= MAXIMUM_INFERENCE_CANDIDATES) {
    accumulator.truncated = true
    return
  }
  accumulator.candidates.push(candidate)
}

const OWNED_RULE_IDS = new Set([
  "codepipeline-trigger-revision-v1",
  "confluence-jira-link-v1",
  "confluence-release-link-v1",
  "jira-key-in-clockify-description-v1",
  "jira-key-in-confluence-metadata-v1",
  "jira-key-in-pull-request-metadata-v1",
  "release-in-confluence-metadata-v1"
])

const present = (entity: RelationshipInferenceEntity): boolean => entity.projection.entityState === "present"

const resolved = (kind: RelationshipEndpointKind, nodeId: GraphNodeId): RelationshipInferenceEndpoint => ({
  _tag: "resolved",
  kind,
  nodeId
})

const missing = (kind: DeliveryEntityKind, missingKey: string): RelationshipInferenceEndpoint => ({
  _tag: "missing",
  kind,
  missingKey
})

const currentRelationship = (relationship: DeliveryRelationship): boolean =>
  relationship.lifecycle._tag !== "missing" &&
  relationship.lifecycle._tag !== "rejected" &&
  relationship.lifecycle._tag !== "superseded"

const currentExternalRelationship = (relationship: DeliveryRelationship): boolean =>
  currentRelationship(relationship) &&
  !(
    relationship.lifecycle._tag === "inferred" &&
    relationship.provenance._tag === "rule" &&
    OWNED_RULE_IDS.has(relationship.provenance.ruleId)
  )

const currentOwnedRelationship = (relationship: DeliveryRelationship): boolean =>
  currentRelationship(relationship) &&
  relationship.lifecycle._tag === "inferred" &&
  relationship.provenance._tag === "rule" &&
  OWNED_RULE_IDS.has(relationship.provenance.ruleId)

const currentInferenceRelationship = (relationship: DeliveryRelationship): boolean =>
  relationship.lifecycle._tag !== "rejected" &&
  relationship.lifecycle._tag !== "superseded" &&
  relationship.provenance._tag === "rule" &&
  (relationship.provenance.ruleId === "delivery-gap-v1" || OWNED_RULE_IDS.has(relationship.provenance.ruleId))

const relationshipInRelease = (relationship: DeliveryRelationship, releaseId: ReleaseId): boolean =>
  relationship.scope?._tag === "release" && relationship.scope.releaseId === releaseId

const containsToken = (text: string, token: string): boolean => {
  const normalizedText = text.toUpperCase()
  const normalizedToken = token.toUpperCase()
  let offset = normalizedText.indexOf(normalizedToken)
  while (offset >= 0) {
    const before = normalizedText[offset - 1]
    const after = normalizedText[offset + normalizedToken.length]
    const boundary = (character: string | undefined) => character === undefined || !/[A-Z0-9]/u.test(character)
    if (boundary(before) && boundary(after)) return true
    offset = normalizedText.indexOf(normalizedToken, offset + normalizedToken.length)
  }
  return false
}

const containsReleaseVersion = (text: string, version: string): boolean => {
  const normalizedText = text.toUpperCase()
  const normalizedVersion = version.toUpperCase()
  let offset = normalizedText.indexOf(normalizedVersion)
  while (offset >= 0) {
    const before = normalizedText[offset - 1]
    const after = normalizedText[offset + normalizedVersion.length]
    const boundary = (character: string | undefined) => character === undefined || !/[A-Z0-9._+-]/u.test(character)
    if (boundary(before) && boundary(after)) return true
    offset = normalizedText.indexOf(normalizedVersion, offset + normalizedVersion.length)
  }
  return false
}

const metadata = (entity: RelationshipInferenceEntity): string => {
  const details = entity.projection.details
  return details._tag === "pull-request"
    ? [entity.projection.title, entity.projection.displayKey, details.sourceBranch, details.targetBranch].join("\n")
    : [entity.projection.title, entity.projection.displayKey].join("\n")
}

const observationKey = (...entities: ReadonlyArray<RelationshipInferenceEntity>): string =>
  entities
    .map(({ projection }) => `${projection.entityId}@${String(projection.projectionRevision)}`)
    .sort()
    .join("+")

const inferred = (input: Omit<RelationshipInferenceCandidate, "lifecycle">): RelationshipInferenceCandidate => ({
  ...input,
  lifecycle: "inferred"
})

const gap = (input: {
  readonly identityKey: string
  readonly kind: RelationshipKind
  readonly releaseId: ReleaseId
  readonly source: RelationshipInferenceEndpoint
  readonly target: RelationshipInferenceEndpoint
}): RelationshipInferenceCandidate => ({
  ...input,
  confidence: null,
  evidenceEntityId: null,
  lifecycle: "missing",
  observationKey: input.identityKey,
  ruleId: "delivery-gap-v1"
})

const candidateIdentity = (
  kind: RelationshipKind,
  releaseId: ReleaseId,
  source: GraphNodeId,
  target: GraphNodeId
): string => `relationship:${kind}:${releaseId}:${source}:${target}`

const issueGapIdentity = (releaseId: ReleaseId, issueNodeId: GraphNodeId): string =>
  `gap:implements:${releaseId}:${issueNodeId}`

const pipelineGapIdentity = (releaseId: ReleaseId, pullRequestNodeId: GraphNodeId): string =>
  `gap:delivered-by:${releaseId}:${pullRequestNodeId}`

const candidateGapKey = (candidate: RelationshipInferenceCandidate): string | null => {
  if (candidate.lifecycle !== "missing") return null
  if (candidate.kind === "implements" && candidate.target._tag === "resolved") {
    return `${candidate.kind}:${candidate.releaseId}:${candidate.target.nodeId}`
  }
  if (candidate.kind === "delivered-by" && candidate.source._tag === "resolved") {
    return `${candidate.kind}:${candidate.releaseId}:${candidate.source.nodeId}`
  }
  return null
}

const relationshipGapKey = (relationship: DeliveryRelationship): string | null => {
  if (
    relationship.lifecycle._tag !== "missing" ||
    relationship.provenance._tag !== "rule" ||
    relationship.provenance.ruleId !== "delivery-gap-v1" ||
    relationship.scope?._tag !== "release"
  ) return null
  if (relationship.kind === "implements") {
    return `${relationship.kind}:${relationship.scope.releaseId}:${relationship.targetNodeId}`
  }
  if (relationship.kind === "delivered-by") {
    return `${relationship.kind}:${relationship.scope.releaseId}:${relationship.sourceNodeId}`
  }
  return null
}

const hasRelationship = (
  relationships: ReadonlyArray<DeliveryRelationship>,
  releaseId: ReleaseId,
  kind: RelationshipKind,
  sourceNodeId: GraphNodeId | null,
  targetNodeId: GraphNodeId | null
): boolean =>
  relationships.some(
    (relationship) =>
      currentExternalRelationship(relationship) &&
      relationshipInRelease(relationship, releaseId) &&
      relationship.kind === kind &&
      (sourceNodeId === null || relationship.sourceNodeId === sourceNodeId) &&
      (targetNodeId === null || relationship.targetNodeId === targetNodeId)
  )

const addIssueAndTimeCandidates = (
  entities: ReadonlyArray<RelationshipInferenceEntity>,
  accumulator: CandidateAccumulator
) => {
  const issues = entities.filter((entity) => entity.projection.details._tag === "issue")
  const timeEntries = entities.filter((entity) => entity.projection.details._tag === "time-entry")
  for (const timeEntry of timeEntries) {
    for (const issue of issues) {
      const details = issue.projection.details
      if (details._tag !== "issue" || !containsToken(metadata(timeEntry), details.key)) continue
      for (const releaseId of issue.releaseIds) {
        addCandidate(
          accumulator,
          inferred({
            confidence: { score: 0.95, rationale: `The Clockify description contains Jira key ${details.key}.` },
            evidenceEntityId: timeEntry.projection.entityId,
            identityKey: candidateIdentity("tracks-time-for", releaseId, timeEntry.nodeId, issue.nodeId),
            kind: "tracks-time-for",
            observationKey: observationKey(timeEntry, issue),
            releaseId,
            ruleId: "jira-key-in-clockify-description-v1",
            source: resolved("time-entry", timeEntry.nodeId),
            target: resolved("issue", issue.nodeId)
          })
        )
      }
    }
  }
}

const addDocumentationCandidates = (
  entities: ReadonlyArray<RelationshipInferenceEntity>,
  releases: ReadonlyArray<RelationshipInferenceRelease>,
  accumulator: CandidateAccumulator
) => {
  const issues = entities.filter((entity) => entity.projection.details._tag === "issue")
  const releaseVersionCounts = new Map<string, number>()
  for (const release of releases) {
    const version = release.version.toUpperCase()
    releaseVersionCounts.set(version, (releaseVersionCounts.get(version) ?? 0) + 1)
  }
  const pages = entities.filter(
    (entity) => entity.projection.details._tag === "page" && entity.projection.details.status === "current"
  )
  for (const page of pages) {
    const pageDetails = page.projection.details
    if (pageDetails._tag !== "page") continue
    const pageMetadata = metadata(page)
    for (const issue of issues) {
      const details = issue.projection.details
      if (details._tag !== "issue") continue
      const explicitLink = pageDetails.linkedIssueKeys?.some((key) =>
        key.toUpperCase() === details.key.toUpperCase()
      ) ?? false
      if (!explicitLink && !containsToken(pageMetadata, details.key)) continue
      for (const releaseId of issue.releaseIds) {
        addCandidate(
          accumulator,
          inferred({
            confidence: {
              score: explicitLink ? 0.97 : 0.9,
              rationale: explicitLink
                ? `Confluence metadata links Jira key ${details.key}.`
                : `Confluence page metadata contains Jira key ${details.key}.`
            },
            evidenceEntityId: page.projection.entityId,
            identityKey: candidateIdentity("documented-by", releaseId, issue.nodeId, page.nodeId),
            kind: "documented-by",
            observationKey: observationKey(page, issue),
            releaseId,
            ruleId: explicitLink ? "confluence-jira-link-v1" : "jira-key-in-confluence-metadata-v1",
            source: resolved("issue", issue.nodeId),
            target: resolved("page", page.nodeId)
          })
        )
      }
    }
    for (const release of releases) {
      if ((releaseVersionCounts.get(release.version.toUpperCase()) ?? 0) > 1) continue
      const explicitLink = pageDetails.linkedReleaseVersions?.some(
        (version) => version.toUpperCase() === release.version.toUpperCase()
      ) ?? false
      if (!explicitLink && !containsReleaseVersion(pageMetadata, release.version)) continue
      addCandidate(
        accumulator,
        inferred({
          confidence: {
            score: explicitLink ? 0.96 : 0.88,
            rationale: explicitLink
              ? `Confluence metadata links release ${release.version}.`
              : `Confluence page metadata contains release ${release.version}.`
          },
          evidenceEntityId: page.projection.entityId,
          identityKey: candidateIdentity("documented-by", release.releaseId, release.nodeId, page.nodeId),
          kind: "documented-by",
          observationKey: observationKey(page),
          releaseId: release.releaseId,
          ruleId: explicitLink ? "confluence-release-link-v1" : "release-in-confluence-metadata-v1",
          source: resolved("release", release.nodeId),
          target: resolved("page", page.nodeId)
        })
      )
    }
  }
}

/**
 * Infer a deterministic relationship set from current canonical facts. Rules
 * only propose `inferred` or `missing`; confirmation remains governed.
 */
export const deriveRelationshipInference = (input: {
  readonly entities: ReadonlyArray<RelationshipInferenceEntity>
  readonly releases: ReadonlyArray<RelationshipInferenceRelease>
  readonly relationships: ReadonlyArray<DeliveryRelationship>
}): RelationshipInferenceResult => {
  const entities = input.entities.filter(present).map((entity) => ({
    ...entity,
    releaseIds: entity.releaseIds.filter((releaseId) => {
      const touchesEntity = (relationship: DeliveryRelationship) =>
        relationshipInRelease(relationship, releaseId) &&
        (relationship.sourceNodeId === entity.nodeId || relationship.targetNodeId === entity.nodeId)
      const inferenceMembership = input.relationships.some(
        (relationship) => currentInferenceRelationship(relationship) && touchesEntity(relationship)
      )
      return !inferenceMembership ||
        input.relationships.some((relationship) =>
          currentExternalRelationship(relationship) &&
          touchesEntity(relationship)
        )
    })
  }))
  const issues = entities.filter((entity) => entity.projection.details._tag === "issue")
  const pullRequests = entities.filter((entity) => entity.projection.details._tag === "pull-request")
  const pipelines = entities.filter((entity) => entity.projection.details._tag === "pipeline-execution")
  const accumulator: CandidateAccumulator = { candidates: [], truncated: false }
  const obsoleteGaps = new Set<string>()
  const inferredIssueLinks = new Set<string>()
  const pullRequestReleases = new Map<GraphNodeId, Set<ReleaseId>>()

  for (const pullRequest of pullRequests) {
    const details = pullRequest.projection.details
    if (details._tag !== "pull-request") continue
    const releaseIds = new Set(
      pullRequest.releaseIds.filter((releaseId) => {
        const touchesPullRequest = (relationship: DeliveryRelationship) =>
          relationshipInRelease(relationship, releaseId) &&
          (relationship.sourceNodeId === pullRequest.nodeId || relationship.targetNodeId === pullRequest.nodeId)
        const ownedMembership = input.relationships.some(
          (relationship) => currentOwnedRelationship(relationship) && touchesPullRequest(relationship)
        )
        return !ownedMembership || input.relationships.some(
          (relationship) => currentExternalRelationship(relationship) && touchesPullRequest(relationship)
        )
      })
    )
    for (const issue of issues) {
      const issueDetails = issue.projection.details
      if (issueDetails._tag !== "issue" || !containsToken(metadata(pullRequest), issueDetails.key)) continue
      for (const releaseId of issue.releaseIds) {
        releaseIds.add(releaseId)
        inferredIssueLinks.add(`${releaseId}:${issue.nodeId}`)
        obsoleteGaps.add(issueGapIdentity(releaseId, issue.nodeId))
        addCandidate(
          accumulator,
          inferred({
            confidence: {
              score: containsToken(pullRequest.projection.title, issueDetails.key) ? 0.98 : 0.94,
              rationale: `The immutable pull-request metadata contains Jira key ${issueDetails.key}.`
            },
            evidenceEntityId: pullRequest.projection.entityId,
            identityKey: candidateIdentity("implements", releaseId, pullRequest.nodeId, issue.nodeId),
            kind: "implements",
            observationKey: observationKey(pullRequest, issue),
            releaseId,
            ruleId: "jira-key-in-pull-request-metadata-v1",
            source: resolved("pull-request", pullRequest.nodeId),
            target: resolved("issue", issue.nodeId)
          })
        )
      }
    }
    for (const relationship of input.relationships) {
      if (
        currentExternalRelationship(relationship) &&
        relationship.kind === "implements" &&
        relationship.sourceNodeId === pullRequest.nodeId &&
        relationship.scope?._tag === "release"
      ) {
        releaseIds.add(relationship.scope.releaseId)
      }
    }
    pullRequestReleases.set(pullRequest.nodeId, releaseIds)
  }

  for (const issue of issues) {
    for (const releaseId of issue.releaseIds) {
      const identityKey = issueGapIdentity(releaseId, issue.nodeId)
      if (
        inferredIssueLinks.has(`${releaseId}:${issue.nodeId}`) ||
        hasRelationship(input.relationships, releaseId, "implements", null, issue.nodeId)
      ) {
        obsoleteGaps.add(identityKey)
      } else {
        const details = issue.projection.details
        if (details._tag !== "issue") continue
        addCandidate(
          accumulator,
          gap({
            identityKey,
            kind: "implements",
            releaseId,
            source: missing("pull-request", `${details.key}:pull-request`),
            target: resolved("issue", issue.nodeId)
          })
        )
      }
    }
  }

  const inferredPipelineLinks = new Set<string>()
  for (const pullRequest of pullRequests) {
    const pullRequestDetails = pullRequest.projection.details
    if (pullRequestDetails._tag !== "pull-request") continue
    for (const pipeline of pipelines) {
      const pipelineDetails = pipeline.projection.details
      if (
        pipelineDetails._tag !== "pipeline-execution" ||
        pipelineDetails.triggerRevision !== pullRequestDetails.headRevision
      ) {
        continue
      }
      for (const releaseId of pullRequestReleases.get(pullRequest.nodeId) ?? []) {
        inferredPipelineLinks.add(`${releaseId}:${pullRequest.nodeId}`)
        obsoleteGaps.add(pipelineGapIdentity(releaseId, pullRequest.nodeId))
        addCandidate(
          accumulator,
          inferred({
            confidence: {
              score: 0.99,
              rationale:
                `The pipeline trigger revision exactly matches pull-request head ${pullRequestDetails.headRevision}.`
            },
            evidenceEntityId: pipeline.projection.entityId,
            identityKey: candidateIdentity("delivered-by", releaseId, pullRequest.nodeId, pipeline.nodeId),
            kind: "delivered-by",
            observationKey: observationKey(pullRequest, pipeline),
            releaseId,
            ruleId: "codepipeline-trigger-revision-v1",
            source: resolved("pull-request", pullRequest.nodeId),
            target: resolved("pipeline-execution", pipeline.nodeId)
          })
        )
      }
    }
  }

  for (const pullRequest of pullRequests) {
    for (const releaseId of pullRequestReleases.get(pullRequest.nodeId) ?? []) {
      const identityKey = pipelineGapIdentity(releaseId, pullRequest.nodeId)
      if (
        inferredPipelineLinks.has(`${releaseId}:${pullRequest.nodeId}`) ||
        hasRelationship(input.relationships, releaseId, "delivered-by", pullRequest.nodeId, null) ||
        hasRelationship(input.relationships, releaseId, "verified-by", pullRequest.nodeId, null)
      ) {
        obsoleteGaps.add(identityKey)
      } else {
        addCandidate(
          accumulator,
          gap({
            identityKey,
            kind: "delivered-by",
            releaseId,
            source: resolved("pull-request", pullRequest.nodeId),
            target: missing("pipeline-execution", `${pullRequest.projection.displayKey}:pipeline-execution`)
          })
        )
      }
    }
  }

  addIssueAndTimeCandidates(entities, accumulator)
  addDocumentationCandidates(entities, input.releases, accumulator)
  const unique = new Map(accumulator.candidates.map((candidate) => [candidate.identityKey, candidate]))
  const candidateEdges = new Set(
    [...unique.values()].flatMap((candidate) =>
      candidate.lifecycle === "inferred" && candidate.source._tag === "resolved" && candidate.target._tag === "resolved"
        ? [`${candidate.kind}:${candidate.releaseId}:${candidate.source.nodeId}:${candidate.target.nodeId}`]
        : []
    )
  )
  const candidateGaps = new Set(
    [...unique.values()].flatMap((candidate) => {
      const key = candidateGapKey(candidate)
      return key === null ? [] : [key]
    })
  )
  const obsoleteRelationshipIds = input.relationships.flatMap((relationship) => {
    const gapKey = relationshipGapKey(relationship)
    const obsoleteInference = relationship.lifecycle._tag === "inferred" &&
      relationship.provenance._tag === "rule" &&
      OWNED_RULE_IDS.has(relationship.provenance.ruleId) &&
      relationship.scope?._tag === "release" &&
      !candidateEdges.has(
        `${relationship.kind}:${relationship.scope.releaseId}:${relationship.sourceNodeId}:${relationship.targetNodeId}`
      )
    const obsoleteGap = gapKey !== null && !candidateGaps.has(gapKey)
    return obsoleteInference || obsoleteGap ? [relationship.relationshipId] : []
  })
  return {
    candidates: [...unique.values()].sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
    obsoleteGapIdentityKeys: [...obsoleteGaps].sort(),
    obsoleteRelationshipIds: [...new Set(obsoleteRelationshipIds)].sort(),
    truncated: accumulator.truncated
  }
}
