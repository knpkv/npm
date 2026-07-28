import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  GovernedActionAuthorizationV1,
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  GovernedActionEvidenceReference,
  GovernedActionTransitionCause
} from "../../../src/domain/governedAction/index.js"
import { EntityId, GraphNodeId, PluginConnectionId, WorkspaceId } from "../../../src/domain/identifiers.js"
import { PluginPayloadJson } from "../../../src/domain/plugins/bounds.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  makeGovernedActionEnvelope
} from "../../../src/server/governance/governedActionDigests.js"
import { makeBuiltInGovernedActionPolicyDefinition } from "../../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database } from "../../../src/server/persistence/Database.js"
import { DeliveryGraphRepository } from "../../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { GovernedActionCommitInput } from "../../../src/server/persistence/repositories/governed-action/contract.js"
import { GovernedActionRepository } from "../../../src/server/persistence/repositories/governedActionRepository.js"

export const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-440000000001"
export const CONNECTION_ID = "01890f6f-6d6a-7cc0-98d2-440000000002"
export const ENTITY_ID = "01890f6f-6d6a-7cc0-98d2-440000000003"
export const SESSION_ID = "01890f6f-6d6a-7cc0-98d2-440000000004"
export const PERSON_ID = "01890f6f-6d6a-7cc0-98d2-440000000005"
export const ACTION_ID = "01890f6f-6d6a-7cc0-98d2-440000000006"
export const AUTHORIZATION_ID = "01890f6f-6d6a-7cc0-98d2-440000000007"
export const PROPOSAL_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-440000000008"
export const AUTHORIZATION_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-440000000009"
const PROPOSAL_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-44000000000a"
const AUTHORIZATION_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-44000000000b"
const EVIDENCE_ID = "01890f6f-6d6a-7cc0-98d2-44000000000c"
const EVIDENCE_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-44000000000d"
const NODE_ID = "01890f6f-6d6a-7cc0-98d2-440000000011"
export const PROPOSED_AT = "2026-07-15T10:00:00.000Z"
export const AUTHORIZED_AT = "2026-07-15T10:01:00.000Z"

export type GovernedActionFixtureVariant = "jira" | "codecommit" | "codepipeline" | "confluence"

const defineFixture = <const Fixture>(fixture: Fixture): Fixture => fixture

const codeCommitFixture = defineFixture({
  providerId: "codecommit",
  connectionName: "Payments CodeCommit",
  entityType: "pull-request",
  vendorImmutableId: "17",
  sourceRevision: "revision-17",
  sourceUrl: "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/17",
  displayKey: "17",
  title: "Registry wiring",
  pluginId: "dev.knpkv.codecommit",
  pluginAdapterVersion: { major: 0, minor: 1, patch: 0 },
  idempotencyKey: "governed-action:codecommit:17:comment:1",
  proposalKey: "comment:codecommit:17",
  actionKind: "comment",
  payload: {
    _tag: "comment",
    sourceCommit: "head-commit-17",
    destinationCommit: "base-commit-17",
    destinationReference: "refs/heads/main",
    content: "Registry wiring check.",
    clientRequestToken: "1".repeat(64)
  },
  actionSummary: "Comment on CodeCommit pull request 17",
  impactSummary: "Posts one review comment",
  correlationId: "action:codecommit:17:comment",
  details: {
    _tag: "pull-request",
    repository: "payments-api",
    sourceBranch: "feature/registry",
    targetBranch: "main",
    headRevision: "head-commit-17",
    reviewState: "requested"
  }
})

const jiraFixture = defineFixture({
  providerId: "jira",
  connectionName: "Payments Jira",
  entityType: "issue",
  vendorImmutableId: "PAY-42",
  sourceRevision: "1",
  sourceUrl: "https://jira.example/browse/PAY-42",
  displayKey: "PAY-42",
  title: "Ship guarded refunds",
  pluginId: "dev.knpkv.jira",
  pluginAdapterVersion: { major: 1, minor: 2, patch: 3 },
  idempotencyKey: "governed-action:PAY-42:done:1",
  proposalKey: "transition:PAY-42:done",
  actionKind: "transition",
  payload: { fields: { resolution: null, status: "Done" }, notify: true },
  actionSummary: "Move PAY-42 to Done",
  impactSummary: "Changes the issue workflow state",
  correlationId: "action:PAY-42:done",
  details: {
    _tag: "issue",
    key: "PAY-42",
    status: "In review",
    priority: "High",
    estimatePoints: 5
  }
})

const confluenceFixture = defineFixture({
  providerId: "confluence",
  connectionName: "Payments Confluence",
  entityType: "page",
  vendorImmutableId: "42",
  sourceRevision: "3",
  sourceUrl: "https://acme.atlassian.net/wiki/spaces/PAY/pages/42",
  displayKey: "42",
  title: "Payments release runbook",
  pluginId: "dev.knpkv.confluence",
  pluginAdapterVersion: { major: 0, minor: 2, patch: 0 },
  idempotencyKey: "governed-action:confluence:42:update-page:1",
  proposalKey: "cfpg:42:3:authorized",
  actionKind: "update-page",
  payload: {
    _tag: "update-page",
    pageId: "42",
    spaceId: "space-payments",
    title: "Payments release runbook v2",
    adf: "{\"content\":[],\"type\":\"doc\",\"version\":1}",
    expectedVersion: 3,
    targetVersion: 4,
    versionMessage: "Publish the approved rollout"
  },
  actionSummary: "Publish Confluence page 42 as version 4",
  impactSummary: "Replaces the published page title and body at the authorized revision",
  correlationId: "action:confluence:42:update-page",
  details: {
    _tag: "page",
    spaceKey: "PAY",
    revision: "3",
    status: "current"
  }
})

const codePipelineFixture = defineFixture({
  providerId: "codepipeline",
  connectionName: "Payments CodePipeline",
  entityType: "pipeline-execution",
  vendorImmutableId: "execution-failed-1",
  sourceRevision: "7:Failed:2026-07-15T09:50:00.000Z",
  sourceUrl:
    "https://eu-west-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/release/view?region=eu-west-1&pipeline-execution=execution-failed-1",
  displayKey: "execution-failed-1",
  title: "release · execution-failed-1",
  pluginId: "dev.knpkv.aws-codepipeline",
  pluginAdapterVersion: { major: 0, minor: 1, patch: 0 },
  idempotencyKey: "governed-action:codepipeline:execution-failed-1:retry:1",
  proposalKey: "pipeline.retry:execution-failed-1:7:Failed:2026-07-15T09:50:00.000Z",
  actionKind: "pipeline.retry",
  payload: {
    retryOf: "execution-failed-1",
    sourceRevisions: [{
      actionName: "Checkout",
      revisionType: "COMMIT_ID",
      revisionValue: "commit-abc"
    }]
  },
  actionSummary: "Retry CodePipeline execution execution-failed-1",
  impactSummary: "Starts one new execution with the failed execution's pinned source revisions",
  correlationId: "action:codepipeline:execution-failed-1:retry",
  details: {
    _tag: "pipeline-execution",
    pipelineName: "release",
    executionId: "execution-failed-1",
    status: "failed",
    triggerRevision: "commit-abc",
    pipelineVersion: 7,
    statusSummary: "Build failed",
    startedAt: "2026-07-15T09:45:00.000Z",
    updatedAt: "2026-07-15T09:50:00.000Z",
    triggerType: "StartPipelineExecution",
    triggerDetail: "release-operator",
    executionMode: "SUPERSEDED",
    executionType: "STANDARD",
    rollbackTargetExecutionId: null,
    sourceRevisions: [{
      actionName: "Checkout",
      revisionId: "commit-abc",
      revisionSummary: "main"
    }]
  }
})

const fixtureVariant = (variant: GovernedActionFixtureVariant = "jira") =>
  variant === "codecommit"
    ? codeCommitFixture
    : variant === "codepipeline"
    ? codePipelineFixture
    : variant === "confluence"
    ? confluenceFixture
    : jiraFixture

const fixtureProjectionEntityType = (fixture: ReturnType<typeof fixtureVariant>): string => fixture.entityType

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEnvelopeMaterial = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeCommit = Schema.decodeUnknownSync(GovernedActionCommitInput)
const decodeCause = Schema.decodeUnknownSync(GovernedActionTransitionCause)
const decodeAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)

const humanCause = decodeCause({
  _tag: "human",
  actor: { _tag: "human", personId: PERSON_ID },
  sessionId: SESSION_ID
})

export const seedGovernedActionAuthorityRoots = Effect.fn(
  "AuthorizedGovernedActionFixture.seedRoots"
)(function*(variant: GovernedActionFixtureVariant = "jira") {
  const fixture = fixtureVariant(variant)
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${WORKSPACE_ID}, 'Governance', 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${CONNECTION_ID}, ${fixture.providerId}, ${fixture.connectionName},
    1, 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT}
  )`
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${ENTITY_ID}, ${CONNECTION_ID}, ${fixture.providerId}, ${fixture.vendorImmutableId},
    ${fixture.entityType}, 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT}
  )`
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
    permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${SESSION_ID}, ${"1".repeat(64)}, ${"2".repeat(64)},
    'human', ${PERSON_ID}, NULL, 'workspace-owner', '2026-07-15T09:00:00.000Z',
    '2026-07-15T09:30:00.000Z', '2026-07-15T11:00:00.000Z',
    '2026-08-15T10:00:00.000Z', NULL
  )`
})

/** Seed the current target revision and evidence required by the final dispatch authority check. */
export const seedGovernedActionCurrentInputs = Effect.fn(
  "AuthorizedGovernedActionFixture.seedCurrentInputs"
)(function*(variant: GovernedActionFixtureVariant = "jira") {
  const fixture = fixtureVariant(variant)
  const workspaceId = Schema.decodeSync(WorkspaceId)(WORKSPACE_ID)
  const connectionId = Schema.decodeSync(PluginConnectionId)(CONNECTION_ID)
  const entityId = Schema.decodeSync(EntityId)(ENTITY_ID)
  const nodeId = Schema.decodeSync(GraphNodeId)(NODE_ID)
  const { sql } = yield* Database
  yield* sql`INSERT INTO entity_revisions (
    workspace_id, entity_id, revision, source_revision, normalization_schema_version,
    source_url, first_observed_at, last_observed_at, synchronized_at, created_at
  ) VALUES (
    ${workspaceId}, ${entityId}, 1, ${fixture.sourceRevision}, 1,
    ${fixture.sourceUrl}, '2026-07-15T09:45:00.000Z',
    '2026-07-15T09:50:00.000Z', '2026-07-15T09:55:00.000Z', '2026-07-15T09:55:00.000Z'
  )`
  const graph = yield* DeliveryGraphRepository
  yield* graph.write(workspaceId, {
    entityProjections: [{
      projection: {
        workspaceId,
        entityId,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: fixtureProjectionEntityType(fixture),
        displayKey: fixture.displayKey,
        title: fixture.title,
        details: fixture.details
      },
      recordedAt: "2026-07-15T09:55:00.000Z"
    }],
    nodes: [{
      workspaceId,
      nodeId,
      endpointKind: fixtureProjectionEntityType(fixture),
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId, entityKind: fixtureProjectionEntityType(fixture) }
      },
      createdAt: "2026-07-15T09:55:00.000Z"
    }],
    evidenceItems: [{
      workspaceId,
      evidenceId: EVIDENCE_ID,
      schemaVersion: 1,
      attribution: {
        _tag: "plugin",
        pluginConnectionId: connectionId,
        sourceEntityId: entityId,
        sourceEntityRevision: 1
      },
      verifier: { _tag: "system", component: "plugin-sync/v1" },
      observedAt: "2026-07-15T09:50:00.000Z",
      recordedAt: "2026-07-15T09:55:00.000Z",
      validUntil: "2026-07-15T11:00:00.000Z",
      freshness: {
        _tag: "current",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-15T09:59:00.000Z" },
        provenance: {
          _tag: "provider",
          sourceRevision: {
            providerId: fixture.providerId,
            pluginConnectionId: connectionId,
            vendorImmutableId: fixture.vendorImmutableId,
            revision: fixture.sourceRevision,
            sourceUrl: fixture.sourceUrl,
            firstObservedAt: "2026-07-15T09:45:00.000Z",
            lastObservedAt: "2026-07-15T09:50:00.000Z",
            synchronizedAt: "2026-07-15T09:55:00.000Z",
            normalizationSchemaVersion: 1
          }
        },
        sourceObservedAt: "2026-07-15T09:50:00.000Z",
        staleAfterSeconds: 2_400,
        synchronizedAt: "2026-07-15T09:55:00.000Z"
      },
      retention: {
        classification: "evidence",
        retainUntil: "2026-08-15T09:55:00.000Z",
        legalHold: false
      }
    }],
    evidenceClaims: [{
      workspaceId,
      evidenceClaimId: EVIDENCE_CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      subjectNodeId: nodeId,
      predicate: "status-observed",
      value: { _tag: "state", value: "In review" },
      recordedAt: "2026-07-15T09:56:00.000Z",
      supersedesEvidenceClaimId: null
    }],
    relationships: []
  })
})

export const makeAuthorizedGovernedActionEnvelope = Effect.fn(
  "AuthorizedGovernedActionFixture.makeEnvelope"
)(function*(options?: {
  readonly pluginConnectionAuthorityDigest?: string | undefined
  readonly variant?: GovernedActionFixtureVariant | undefined
}) {
  const variant = options?.variant ?? "jira"
  const fixture = fixtureVariant(variant)
  const payload = decodePayload(fixture.payload)
  const payloadDigest = yield* digestGovernedActionPayload(payload)
  const evidence = decodeEvidence({
    workspaceId: WORKSPACE_ID,
    evidenceId: EVIDENCE_ID,
    evidenceClaimIds: [EVIDENCE_CLAIM_ID],
    observedAt: "2026-07-15T09:50:00.000Z",
    validUntil: "2026-07-15T11:00:00.000Z",
    currentUntil: "2026-07-15T10:30:00.000Z",
    evaluatedAt: PROPOSED_AT,
    source: "current",
    validity: "valid"
  })
  const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([evidence])
  const policy = (yield* makeBuiltInGovernedActionPolicyDefinition()).binding
  const material = decodeEnvelopeMaterial({
    schemaVersion: 1,
    actionId: ACTION_ID,
    idempotencyKey: fixture.idempotencyKey,
    workspaceId: WORKSPACE_ID,
    pluginConnectionId: CONNECTION_ID,
    pluginConnectionRevision: 1,
    pluginConnectionAuthorityDigest: options?.pluginConnectionAuthorityDigest ?? `sha256:${"a".repeat(64)}`,
    pluginId: fixture.pluginId,
    pluginContractVersion: { major: 1, minor: 0, patch: 0 },
    pluginAdapterVersion: fixture.pluginAdapterVersion,
    providerId: fixture.providerId,
    capability: { capabilityId: "action.execute", version: 1 },
    targetEntityId: ENTITY_ID,
    proposal: {
      proposalKey: fixture.proposalKey,
      capabilityVersion: 1,
      request: {
        actionKind: fixture.actionKind,
        target: {
          entityType: fixture.entityType,
          vendorImmutableId: fixture.vendorImmutableId
        },
        expectedRevision: fixture.sourceRevision,
        payload,
        evidenceIds: ["provider-evidence-1"]
      },
      payloadDigest,
      summary: fixture.actionSummary,
      impact: {
        level: "medium",
        summary: fixture.impactSummary
      },
      proposedAt: PROPOSED_AT
    },
    evidence: [Schema.encodeSync(GovernedActionEvidenceReference)(evidence)],
    evidenceSetDigest,
    policy,
    origin: {
      _tag: "human",
      actor: { _tag: "human", personId: PERSON_ID },
      sessionId: SESSION_ID
    },
    proposalExpiresAt: "2026-07-15T10:10:00.000Z",
    causationId: null,
    correlationId: fixture.correlationId
  })
  return (yield* makeGovernedActionEnvelope(material)).envelope
})

/** Seed a verified proposed action and optionally commit its exact human authorization. */
export const seedGovernedAction = Effect.fn("AuthorizedGovernedActionFixture.seed")(function*(options?: {
  readonly authorizationExpiresAt?: string
  readonly authorized?: boolean
  readonly pluginConnectionAuthorityDigest?: string
  readonly seedAuthorityRoots?: boolean
  readonly variant?: GovernedActionFixtureVariant
}) {
  if (options?.seedAuthorityRoots !== false) yield* seedGovernedActionAuthorityRoots(options?.variant)
  const repository = yield* GovernedActionRepository
  const envelope = yield* makeAuthorizedGovernedActionEnvelope({
    pluginConnectionAuthorityDigest: options?.pluginConnectionAuthorityDigest,
    variant: options?.variant
  })
  const proposal = decodeCommit({
    envelope: Schema.encodeSync(GovernedActionEnvelopeV1)(envelope),
    expectedHeadTransitionId: null,
    transitionId: PROPOSAL_TRANSITION_ID,
    commandId: "command:PAY-42:propose",
    command: { _tag: "propose" },
    cause: humanCause,
    occurredAt: PROPOSED_AT,
    causationId: null,
    correlationId: envelope.correlationId,
    companion: { _tag: "none" },
    auditEventId: PROPOSAL_AUDIT_ID
  })
  yield* repository.commit(proposal)

  if (options?.authorized === false) return { envelope, authorization: null }

  const authorization = decodeAuthorization({
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    actionId: envelope.actionId,
    workspaceId: envelope.workspaceId,
    pluginConnectionId: envelope.pluginConnectionId,
    pluginConnectionRevision: envelope.pluginConnectionRevision,
    pluginConnectionAuthorityDigest: envelope.pluginConnectionAuthorityDigest,
    actionEnvelopeDigest: envelope.envelopeDigest,
    idempotencyKey: envelope.idempotencyKey,
    payloadDigest: envelope.proposal.payloadDigest,
    evidenceSetDigest: envelope.evidenceSetDigest,
    policyDigest: envelope.policy.policyDigest,
    expectedRevision: envelope.proposal.request.expectedRevision,
    capabilityVersion: envelope.capability.version,
    actor: { _tag: "human", personId: PERSON_ID },
    sessionId: SESSION_ID,
    sessionPermission: "workspace-owner",
    sessionExpiresAt: "2026-07-15T11:00:00.000Z",
    requiredPermission: envelope.policy.requiredPermission,
    authorizedAt: AUTHORIZED_AT,
    expiresAt: options?.authorizationExpiresAt ?? "2026-07-15T10:05:00.000Z"
  })
  yield* repository.commit(decodeCommit({
    ...Schema.encodeSync(GovernedActionCommitInput)(proposal),
    expectedHeadTransitionId: PROPOSAL_TRANSITION_ID,
    transitionId: AUTHORIZATION_TRANSITION_ID,
    commandId: "command:PAY-42:authorize",
    command: { _tag: "authorize", authorizationId: AUTHORIZATION_ID },
    cause: humanCause,
    occurredAt: AUTHORIZED_AT,
    companion: {
      _tag: "authorization",
      authorization: Schema.encodeSync(GovernedActionAuthorizationV1)(authorization)
    },
    auditEventId: AUTHORIZATION_AUDIT_ID
  }))
  return { envelope, authorization }
})
