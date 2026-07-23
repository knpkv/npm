import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"

import { WorkspaceEntityInspection } from "../../src/api/deliveryGraph.js"
import { DeliveryRelationship, LedgerRevision } from "../../src/domain/deliveryGraph.js"
import {
  AgentId,
  EntityId,
  EnvironmentId,
  PluginConnectionId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { MaximumPluginPayloadBytes } from "../../src/domain/plugins/bounds.js"
import { NormalizedPluginEventV1, PluginCheckpointV1, PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { Release } from "../../src/domain/release.js"
import { SourceRevision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeDeliveryGraphInspection } from "../../src/server/application/deliveryGraphInspection.js"
import { firstPartyManualPluginSyncDrivers } from "../../src/server/application/manualPluginSynchronization.js"
import {
  materializeNormalizedPluginPage,
  type NormalizedPluginPageMaterializationScope
} from "../../src/server/application/normalizedPluginPageMaterialization.js"
import { pipelineStatus } from "../../src/server/application/pipelineExecutionProjection.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { ConfluencePageAttributesV1 } from "../../src/server/plugins/confluence/ConfluencePageSchemas.js"
import { normalizeJiraIssueEvents } from "../../src/server/plugins/jira/JiraIssueNormalization.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000193")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000194")
const OTHER_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000195")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000196")
const AGENT_ID = Schema.decodeSync(AgentId)("01890f6f-6d6a-7cc0-98d2-000000000197")
const ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000198")
const CODECOMMIT_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000199")
const CODEPIPELINE_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000200")
const CLOCKIFY_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000201")
const CONFLUENCE_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000202")
const CACHE_STREAM = Schema.decodeSync(PluginStreamKey)("cache-only")
const MATERIALIZED_STREAM = Schema.decodeSync(PluginStreamKey)("delivery-items")
const firstPartyStream = (
  providerId: "clockify" | "codecommit" | "codepipeline" | "confluence" | "jira"
) => Schema.decodeSync(PluginStreamKey)(Option.getOrThrow(firstPartyManualPluginSyncDrivers.get(providerId)).streamKey)
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:03:00.000Z")
const T4 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:06:00.000Z")
const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: "Jira",
  configurationFields: [],
  capabilities: [{
    capabilityId: "sync.incremental",
    supportedVersions: [1],
    requirement: "required"
  }]
}

const descriptorFor = (providerId: "clockify" | "codecommit" | "codepipeline" | "confluence" | "jira") => ({
  ...descriptor,
  pluginId: `dev.knpkv.${providerId}`,
  displayName: providerId
})

const cacheOnlyPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "cache-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "cache-only-issue-1",
    observedAt: "2026-07-19T09:00:30.000Z",
    revision: "cache-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "cache-issue-1",
    sourceUrl: null,
    title: "Cached but not materialized",
    attributes: { key: "CACHE-1", status: { name: "Open" } }
  }]
})

const materializedPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "materialized-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertPerson",
    eventId: "person-ada-1",
    observedAt: "2026-07-19T09:01:10.000Z",
    revision: "person-revision-1",
    vendorPersonId: "ada",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    active: true
  }, {
    _tag: "UpsertEntity",
    eventId: "issue-pay-42-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "issue-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    sourceUrl: "https://jira.example/browse/PAY-42",
    title: "PAY-42 · Ship guarded refunds",
    attributes: { key: "PAY-42", status: { name: "Ready" }, priority: { name: "High" } }
  }, {
    _tag: "UpsertEntity",
    eventId: "pull-request-17-1",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "pull-request-revision-1",
    entityType: "pull-request",
    vendorImmutableId: "17",
    sourceUrl: "https://console.aws.example/pull-requests/17",
    title: "Guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/guard-refunds",
      targetBranch: "main",
      headRevision: "abc123",
      baseRevision: "base456",
      mergeBase: "merge789",
      description: "Guard every refund write.",
      authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/ada",
      creationDate: "2026-07-18T08:00:00.000Z",
      lastActivityDate: "2026-07-19T09:01:30.000Z",
      status: "OPEN",
      reviewState: "requested"
    }
  }, {
    _tag: "AppendEvidence",
    eventId: "evidence-review-1",
    observedAt: "2026-07-19T09:01:40.000Z",
    revision: "evidence-revision-1",
    evidenceId: "review-ready",
    subject: { entityType: "pull-request", vendorImmutableId: "17" },
    evidenceType: "status-observed",
    summary: "Review requested",
    capturedAt: "2026-07-19T09:01:40.000Z",
    data: {
      predicate: "status-observed",
      value: { _tag: "state", value: "review-requested" }
    }
  }, {
    _tag: "ProposeRelationship",
    eventId: "relationship-pr-implements-issue-1",
    observedAt: "2026-07-19T09:01:50.000Z",
    revision: "relationship-revision-1",
    relationshipId: "pr-17-implements-issue-42",
    from: { entityType: "pull-request", vendorImmutableId: "17" },
    to: { entityType: "jira.issue", vendorImmutableId: "issue-42" },
    relationshipType: "implements",
    confidence: 0.9,
    evidenceIds: ["review-ready"]
  }]
})

const richIssueAttributes = {
  key: "PAY-42",
  status: "In Review",
  priority: "High",
  estimatePoints: 5,
  summary: "Protect payment retries",
  description: "Persist retry state.\n\n## Acceptance Criteria\n\n- Restart-safe\n- Timeout-safe",
  acceptanceCriteria: "- Restart-safe\n- Timeout-safe",
  environment: "Production and staging",
  issueType: { sourceId: "10001", name: "Story" },
  project: { sourceId: "10", key: "PAY", name: "Payments" },
  resolution: null,
  labels: ["payments", "release-candidate"],
  components: [{ sourceId: "7", name: "Checkout" }],
  fixVersions: [{ sourceId: "2026.29", name: "2026.29", released: false, releaseDate: null }],
  createdAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-17T09:30:00.000Z",
  dueDate: "2026-07-21",
  resolvedAt: null,
  parent: {
    sourceId: "10000",
    key: "PAY-1",
    summary: "Payments hardening",
    status: { sourceId: "3", name: "In Progress" }
  },
  subtasks: [
    {
      sourceId: "10043",
      key: "PAY-43",
      summary: "Cover timeout path",
      status: { sourceId: "1", name: "Open" }
    }
  ],
  assigneeSourcePersonId: "ari",
  reporterSourcePersonId: "sam",
  creatorSourcePersonId: "sam",
  collaborators: [
    {
      sourcePersonId: "ari",
      displayName: "Ari Chen",
      avatarUrl: "https://avatar.example/ari.png",
      active: true,
      roles: ["assignee", "commenter"]
    },
    {
      sourcePersonId: "sam",
      displayName: "Sam Rivera",
      avatarUrl: null,
      active: true,
      roles: ["change-author", "creator", "reporter"]
    }
  ],
  comments: [
    {
      sourceId: "c1",
      authorSourcePersonId: "ari",
      updateAuthorSourcePersonId: null,
      body: "Ready for review.",
      createdAt: "2026-07-16T10:00:00.000Z",
      updatedAt: "2026-07-16T10:00:00.000Z"
    }
  ],
  commentTotal: 2,
  commentsTruncated: true,
  history: [
    {
      sourceId: "h1",
      authorSourcePersonId: "sam",
      createdAt: "2026-07-16T09:00:00.000Z",
      changes: [{ field: "status", from: "In Progress", to: "In Review" }]
    }
  ],
  historyTotal: 1,
  historyTruncated: false,
  truncatedFields: ["comments"]
}

const richIssuePage = (revision: 1 | 2) =>
  Schema.decodeSync(PluginSyncPageV1)({
    checkpointAfterPage: `rich-issue-${revision}`,
    hasMore: false,
    events: [
      {
        _tag: "UpsertEntity",
        eventId: `rich-issue-pay-42-${revision}`,
        observedAt: revision === 1 ? "2026-07-19T09:01:20.000Z" : "2026-07-19T09:02:20.000Z",
        revision: `issue-revision-${revision}`,
        entityType: "jira.issue",
        vendorImmutableId: "rich-issue-42",
        sourceUrl: "https://jira.example/browse/PAY-42",
        title: revision === 1 ? "PAY-42 · Protect payment retries" : "PAY-42 · Payment retries protected",
        attributes: revision === 1
          ? richIssueAttributes
          : {
            ...richIssueAttributes,
            status: "Done",
            summary: "Payment retries protected",
            description: "Retry state is durable in production.",
            acceptanceCriteria: "- Restart-safe\n- Timeout-safe\n- Verified in production",
            resolution: { sourceId: "10000", name: "Done" },
            updatedAt: "2026-07-19T09:02:00.000Z",
            resolvedAt: "2026-07-19T09:02:00.000Z",
            comments: [
              {
                sourceId: "c2",
                authorSourcePersonId: "sam",
                updateAuthorSourcePersonId: "sam",
                body: "Verified in production.",
                createdAt: "2026-07-19T09:01:00.000Z",
                updatedAt: "2026-07-19T09:01:30.000Z"
              }
            ],
            commentTotal: 2,
            commentsTruncated: false,
            truncatedFields: []
          }
      }
    ]
  })

const tombstonePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "tombstone-complete",
  hasMore: false,
  events: [{
    _tag: "TombstoneEntity",
    eventId: "issue-pay-42-deleted",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "issue-revision-2",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    reason: "Deleted upstream"
  }]
})

const repeatedEntityEventPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "event-replay-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "issue-pay-42-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "issue-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    sourceUrl: "https://jira.example/browse/PAY-42",
    title: "PAY-42 · Ship guarded refunds",
    attributes: { key: "PAY-42", status: { name: "Ready" }, priority: { name: "High" } }
  }]
})

const jiraReleasePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-candidate",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "candidate:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments",
      version: "2026.29",
      lifecycle: "candidate"
    }
  }]
})

const jiraReleaseUpdatePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-updated",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-released",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "released:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments API · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments API",
      version: "2026.29",
      lifecycle: "released"
    }
  }]
})

const jiraReleaseRepeatedObservationPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-observed-again",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-candidate-observed-again",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "candidate:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments",
      version: "2026.29",
      lifecycle: "candidate"
    }
  }]
})

const inferenceJiraReleasePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-inference-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-inference-issue-pay-42",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "issue-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    sourceUrl: "https://jira.example/browse/PAY-42",
    title: "PAY-42 · Ship guarded refunds",
    attributes: { key: "PAY-42", status: { name: "Ready" } }
  }, {
    _tag: "UpsertEntity",
    eventId: "jira-inference-version-2026-29",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "candidate:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments · 2026.29",
    attributes: { serviceName: "Payments", version: "2026.29", lifecycle: "candidate" }
  }, {
    _tag: "AppendEvidence",
    eventId: "jira-inference-fix-version-evidence",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "issue-revision-1",
    evidenceId: "jira:issue:issue-42:fix-version:2026.29",
    subject: { entityType: "jira.issue", vendorImmutableId: "issue-42" },
    evidenceType: "relationship-observed",
    summary: "Jira fix version 2026.29",
    capturedAt: "2026-07-19T09:01:30.000Z",
    data: { predicate: "relationship-observed", value: { _tag: "state", value: "2026.29" } }
  }, {
    _tag: "ProposeRelationship",
    eventId: "jira-inference-release-contains-pay-42",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "issue-revision-1",
    relationshipId: "jira-version:2026.29:contains:issue-42",
    from: { entityType: "release", vendorImmutableId: "jira-version:2026.29" },
    to: { entityType: "jira.issue", vendorImmutableId: "issue-42" },
    relationshipType: "contains",
    confidence: 1,
    evidenceIds: ["jira:issue:issue-42:fix-version:2026.29"]
  }]
})

const codeCommitRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "codecommit-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "codecommit-pr-17-abc123",
    observedAt: "2026-07-19T09:02:10.000Z",
    revision: "abc123",
    entityType: "pull-request",
    vendorImmutableId: "17",
    sourceUrl: "https://console.aws.example/codecommit/pull-requests/17",
    title: "PAY-42 guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/PAY-42-refund-guard",
      targetBranch: "main",
      headRevision: "abc123",
      reviewState: "requested"
    }
  }]
})

const codeCommitUnlinkedPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "codecommit-unlinked-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "codecommit-pr-17-def456",
    observedAt: "2026-07-19T09:02:50.000Z",
    revision: "def456",
    entityType: "pull-request",
    vendorImmutableId: "17",
    sourceUrl: "https://console.aws.example/codecommit/pull-requests/17",
    title: "Guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/refund-guard",
      targetBranch: "main",
      headRevision: "abc123",
      reviewState: "requested"
    }
  }]
})

const codePipelineRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "codepipeline-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "codepipeline-payments-9001",
    observedAt: "2026-07-19T09:02:20.000Z",
    revision: "execution-9001",
    entityType: "aws.codepipeline.execution",
    vendorImmutableId: "payments:9001",
    sourceUrl: "https://console.aws.example/codepipeline/payments/9001",
    title: "Payments deploy 9001",
    attributes: {
      pipelineName: "payments",
      executionId: "9001",
      status: "InProgress",
      sourceRevisions: [{ revisionId: "abc123" }]
    }
  }]
})

const richCodePipelinePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "codepipeline-rich-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "payments-pipeline-declaration",
    observedAt: "2026-07-19T09:02:00.000Z",
    revision: "pipeline-v7",
    entityType: "aws.codepipeline.pipeline",
    vendorImmutableId: "payments",
    sourceUrl: null,
    title: "Payments pipeline",
    attributes: {
      pipelineName: "payments",
      stages: [
        { name: "Source", actions: [{ name: "Checkout" }] },
        { name: "Build", actions: [{ name: "Compile" }] },
        { name: "Approval", actions: [{ name: "Release gate" }] },
        { name: "Production", actions: [{ name: "Deploy" }] }
      ]
    }
  }, {
    _tag: "UpsertEntity",
    eventId: "payments-execution-9002",
    observedAt: "2026-07-19T09:05:00.000Z",
    revision: "7:InProgress:2026-07-19T09:05:00.000Z",
    entityType: "aws.codepipeline.execution",
    vendorImmutableId: "9002",
    sourceUrl: "https://console.aws.example/codepipeline/payments/9002",
    title: "Payments deploy 9002",
    attributes: {
      pipelineName: "payments",
      pipelineVersion: 7,
      executionId: "9002",
      status: "InProgress",
      statusSummary: "Waiting for the production release gate",
      startedAt: "2026-07-19T09:00:00.000Z",
      updatedAt: "2026-07-19T09:05:00.000Z",
      sourceRevisions: [{ actionName: "Checkout", revisionId: "abc123", revisionSummary: "main" }],
      triggerType: "StartPipelineExecution",
      triggerDetail: "arn:aws:sts::123456789012:assumed-role/Release/operator",
      executionMode: "SUPERSEDED",
      executionType: "STANDARD",
      artifactRevisions: [{
        name: "Source",
        revisionId: "abc123",
        revisionSummary: "main",
        createdAt: "2026-07-19T08:59:00.000Z"
      }],
      actionCount: 2,
      actionsTruncated: true,
      actionPagesRead: 3
    }
  }, {
    _tag: "UpsertEntity",
    eventId: "9002-stage-Build",
    observedAt: "2026-07-19T09:04:00.000Z",
    revision: "Succeeded:2026-07-19T09:04:00.000Z",
    entityType: "aws.codepipeline.stage",
    vendorImmutableId: "9002#Build",
    sourceUrl: null,
    title: "payments · Build",
    attributes: {
      pipelineName: "payments",
      executionId: "9002",
      stageName: "Build",
      status: "Succeeded",
      actionCount: 1,
      actionsTruncated: true
    }
  }, {
    _tag: "UpsertEntity",
    eventId: "9002-action-compile",
    observedAt: "2026-07-19T09:04:00.000Z",
    revision: "Succeeded:2026-07-19T09:04:00.000Z",
    entityType: "aws.codepipeline.action",
    vendorImmutableId: "9002#compile-1",
    sourceUrl: null,
    title: "payments · Build · Compile",
    attributes: {
      pipelineName: "payments",
      executionId: "9002",
      actionExecutionId: "compile-1",
      stageName: "Build",
      actionName: "Compile",
      status: "Succeeded",
      startedAt: "2026-07-19T09:01:00.000Z",
      updatedAt: "2026-07-19T09:04:00.000Z",
      updatedBy: "arn:aws:sts::123456789012:assumed-role/Release/operator",
      actionType: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
      actionRegion: "eu-west-1",
      inputArtifacts: [{ name: "Source", bucket: "must-not-persist", key: "secret/source.zip" }],
      outputArtifacts: [{ name: "BuildOutput", bucket: "must-not-persist", key: "secret/build.zip" }],
      externalExecutionSummary: "Build completed",
      logStreamArn: "arn:aws:logs:must-not-persist"
    }
  }, {
    _tag: "UpsertEntity",
    eventId: "9002-action-gate",
    observedAt: "2026-07-19T09:05:00.000Z",
    revision: "InProgress:2026-07-19T09:05:00.000Z",
    entityType: "aws.codepipeline.action",
    vendorImmutableId: "9002#gate-1",
    sourceUrl: null,
    title: "payments · Approval · Release gate",
    attributes: {
      pipelineName: "payments",
      executionId: "9002",
      actionExecutionId: "gate-1",
      stageName: "Approval",
      actionName: "Release gate",
      status: "InProgress",
      startedAt: "2026-07-19T09:05:00.000Z",
      updatedAt: "2026-07-19T09:05:00.000Z",
      updatedBy: "release-approver@example.test",
      actionType: { category: "Approval", owner: "AWS", provider: "Manual", version: "1" },
      actionRegion: "eu-west-1",
      inputArtifacts: [{ name: "BuildOutput" }],
      outputArtifacts: []
    }
  }]
})

const clockifyRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "clockify-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "clockify-time-1",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "time-1-revision",
    entityType: "clockify.time-entry",
    vendorImmutableId: "time-1",
    sourceUrl: "https://app.clockify.me/tracker",
    title: "PAY-42 review and rollout",
    attributes: {
      billable: true,
      approvalState: "approved",
      description: "PAY-42 review and rollout",
      projectId: "project-payments",
      taskId: "task-review",
      userId: "clockify-user-mina",
      locked: true,
      entryType: "REGULAR",
      tagIds: ["release", "review"],
      interval: {
        start: "2026-07-19T08:17:30.000Z",
        end: "2026-07-19T09:02:30.000Z",
        duration: "PT45M",
        state: "completed"
      }
    }
  }]
})

const confluenceRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "confluence-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "confluence-page-991-v8",
    observedAt: "2026-07-19T09:02:40.000Z",
    revision: "8",
    entityType: "confluence-page",
    vendorImmutableId: "991",
    sourceUrl: "https://acme.atlassian.net/wiki/spaces/PAY/pages/991",
    title: "Payments 2026.29 runbook",
    attributes: {
      schemaVersion: 1,
      status: "current",
      spaceId: "PAY",
      parentId: null,
      createdAt: "2026-07-19T09:00:00.000Z",
      updatedAt: "2026-07-19T09:02:40.000Z",
      currentVersion: 8,
      content: {
        representation: "safe-markdown",
        markdown: "## Release recovery\n\nKeep this exact page body out of graph cards."
      },
      versions: [{
        number: 8,
        createdAt: "2026-07-19T09:02:40.000Z",
        message: "Document release recovery",
        minorEdit: false,
        authorId: null
      }],
      versionHistory: { complete: true, pagesFetched: 1 },
      contributors: [],
      linkedIssueKeys: ["PAY-42"],
      linkedReleaseVersions: ["2026.29"]
    }
  }]
})

const invalidRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "invalid-relationship-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "rollback-issue-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "rollback-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "rollback-issue",
    sourceUrl: null,
    title: "Must roll back",
    attributes: { key: "ROLLBACK-1", status: { name: "Open" } }
  }, {
    _tag: "ProposeRelationship",
    eventId: "rollback-invalid-relationship-1",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "rollback-relationship-revision-1",
    relationshipId: "rollback-invalid-relationship",
    from: { entityType: "jira.issue", vendorImmutableId: "rollback-issue" },
    to: { entityType: "jira.issue", vendorImmutableId: "rollback-issue" },
    relationshipType: "not-a-canonical-relationship",
    confidence: 0.5,
    evidenceIds: []
  }]
})

const withMaterializer = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database | Persistence>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-normalized-materialization-")
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide(persistence))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    PLUGIN_ID,
    "jira",
    descriptor,
    0,
    T0
  )
})

const setupConnection = Effect.fn("NormalizedPluginPageMaterializationTest.setupConnection")(function*(
  pluginConnectionId: PluginConnectionId,
  providerId: "clockify" | "codecommit" | "codepipeline" | "confluence"
) {
  const persistence = yield* Persistence
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId,
    providerId,
    displayName: PluginConnectionDisplayName.make(providerId),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    pluginConnectionId,
    providerId,
    descriptorFor(providerId),
    0,
    T0
  )
})

const items = Effect.fn("NormalizedPluginPageMaterializationTest.items")(function*() {
  const persistence = yield* Persistence
  const result = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
    _tag: "workspaceEntityProjections",
    owner: null,
    query: null,
    service: null,
    status: null,
    type: null,
    limit: 100
  })
  if (result._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
  return result.value
})

const exactFirstProjection = Effect.fn(
  "NormalizedPluginPageMaterializationTest.exactFirstProjection"
)(function*() {
  const persistence = yield* Persistence
  const entityId = (yield* items()).items[0]?.projection.entityId
  if (entityId === undefined) return yield* Effect.die("expected one entity projection")
  const result = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
    _tag: "entityProjection",
    entityId,
    revision: null
  })
  if (result._tag !== "entityProjection") return yield* Effect.die("expected an exact entity projection")
  return result.value.projection
})

describe("normalized plugin page materialization", () => {
  it("maps terminal and active CodePipeline statuses", () => {
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof pipelineStatus>]> = [
      ["Cancelled", "stopped"],
      ["InProgress", "running"]
    ]
    for (const [status, expected] of cases) assert.strictEqual(pipelineStatus(status), expected)
  })

  it.effect("materializes one bounded, credential-free CodePipeline execution document", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const receipt = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T4,
        successfulHealth: { _tag: "healthy", checkedAt: T4 }
      }, richCodePipelinePage)
      assert.strictEqual(receipt.entityProjectionCount, 1)
      assert.strictEqual(receipt.skippedEntityCount, 4)

      const index = yield* items()
      const projection = index.items[0]?.projection
      if (projection?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected rich pipeline execution")
      }
      const details = projection.details
      assert.strictEqual(details.pipelineVersion, 7)
      assert.strictEqual(details.statusSummary, "Waiting for the production release gate")
      assert.strictEqual(details.triggerType, "StartPipelineExecution")
      assert.strictEqual(details.triggerDetail, "arn:aws:sts::123456789012:assumed-role/Release/operator")
      assert.strictEqual(details.actionCount, 2)
      assert.isTrue(details.actionsTruncated)
      assert.strictEqual(details.actionPagesRead, 3)
      assert.deepStrictEqual(details.stages?.map(({ name, status }) => [name, status]), [
        ["Source", "queued"],
        ["Build", "succeeded"],
        ["Approval", "running"],
        ["Production", "queued"]
      ])
      assert.deepStrictEqual(details.actions?.map(({ actionName, updatedBy }) => [actionName, updatedBy]), [
        ["Compile", "arn:aws:sts::123456789012:assumed-role/Release/operator"],
        ["Release gate", "release-approver@example.test"]
      ])
      assert.deepStrictEqual(details.actions?.[0]?.artifacts, [
        { name: "Source", direction: "input", access: "proxy-required" },
        { name: "BuildOutput", direction: "output", access: "proxy-required" }
      ])
      const serialized = JSON.stringify(
        yield* Schema.encodeEffect(WorkspaceEntityInspection)(
          yield* (yield* makeDeliveryGraphInspection).workspaceEntity({
            workspaceId: WORKSPACE_ID,
            entityId: projection.entityId
          })
        )
      )
      assert.notInclude(serialized, "must-not-persist")
      assert.notInclude(serialized, "secret/source.zip")
      assert.notInclude(serialized, "arn:aws:logs")
    })))

  it.effect("uses a revision-only legacy pipeline source as the trigger fallback", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, codePipelineRelationshipPage)

      const projection = (yield* items()).items[0]?.projection
      if (projection?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected legacy pipeline execution")
      }
      assert.strictEqual(projection.details.triggerRevision, "abc123")
      assert.deepStrictEqual(projection.details.sourceRevisions, [])
    })))

  it.effect("falls through blank trigger revisions while preserving explicit ones", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
          providerId: "codepipeline",
          streamKey: firstPartyStream("codepipeline"),
          expectedRevision: 0,
          committedAt: T3,
          successfulHealth: { _tag: "healthy", checkedAt: T3 }
        },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-trigger-revision-fallbacks",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "pipeline-blank-trigger",
            observedAt: "2026-07-19T09:02:20.000Z",
            revision: "blank-trigger-event-revision",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: "blank-trigger",
            sourceUrl: null,
            title: "Blank trigger execution",
            attributes: {
              pipelineName: "payments",
              executionId: "blank-trigger",
              status: "Succeeded",
              triggerRevision: "   ",
              sourceRevisions: [{ revisionId: "abc123" }]
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "pipeline-explicit-trigger",
            observedAt: "2026-07-19T09:02:20.000Z",
            revision: "explicit-trigger-event-revision",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: "explicit-trigger",
            sourceUrl: null,
            title: "Explicit trigger execution",
            attributes: {
              pipelineName: "payments",
              executionId: "explicit-trigger",
              status: "Succeeded",
              triggerRevision: "explicit456",
              sourceRevisions: [{ revisionId: "abc123" }]
            }
          }]
        })
      )

      const projections = (yield* items()).items.map(({ projection }) => projection)
      const triggerRevisionFor = (executionId: string) => {
        const projection = projections.find(
          ({ details }) => details._tag === "pipeline-execution" && details.executionId === executionId
        )
        return projection?.details._tag === "pipeline-execution" ? projection.details.triggerRevision : null
      }
      assert.strictEqual(triggerRevisionFor("blank-trigger"), "abc123")
      assert.strictEqual(triggerRevisionFor("explicit-trigger"), "explicit456")
    })))

  it.effect("rebuilds an advanced execution with current cached action siblings", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const buildAction = Schema.encodeSync(NormalizedPluginEventV1)(
        Schema.decodeSync(NormalizedPluginEventV1)({
          _tag: "UpsertEntity",
          eventId: "cache-build-action",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "Succeeded:2026-07-19T09:02:00.000Z",
          entityType: "aws.codepipeline.action",
          vendorImmutableId: "cache-execution#build",
          sourceUrl: null,
          title: "payments · Build",
          attributes: {
            pipelineName: "payments",
            executionId: "cache-execution",
            actionExecutionId: "build-1",
            stageName: "Build",
            actionName: "Compile",
            status: "Succeeded"
          }
        })
      )
      const first = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "pipeline-cache-first",
        hasMore: true,
        events: [{
          _tag: "UpsertEntity",
          eventId: "cache-pipeline-declaration",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "pipeline-v1",
          entityType: "aws.codepipeline.pipeline",
          vendorImmutableId: "payments",
          sourceUrl: null,
          title: "Payments pipeline",
          attributes: {
            pipelineName: "payments",
            stages: [{ name: "Build", actions: [{ name: "Compile" }] }, {
              name: "Approval",
              actions: [{ name: "Release gate" }]
            }]
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "cache-execution-v1",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "execution-v1",
          entityType: "aws.codepipeline.execution",
          vendorImmutableId: "cache-execution",
          sourceUrl: null,
          title: "Payments execution",
          attributes: {
            pipelineName: "payments",
            executionId: "cache-execution",
            status: "InProgress",
            triggerRevision: "abc123"
          }
        }, buildAction]
      })
      const second = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "pipeline-cache-second",
        hasMore: false,
        events: [
          {
            _tag: "UpsertEntity",
            eventId: "cache-execution-v2",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "execution-v2",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: "cache-execution",
            sourceUrl: null,
            title: "Payments execution",
            attributes: {
              pipelineName: "payments",
              executionId: "cache-execution",
              status: "InProgress",
              triggerRevision: "abc123"
            }
          },
          buildAction,
          {
            _tag: "UpsertEntity",
            eventId: "cache-approval-action",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "InProgress:2026-07-19T09:03:00.000Z",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "cache-execution#approval",
            sourceUrl: null,
            title: "payments · Approval",
            attributes: {
              pipelineName: "payments",
              executionId: "cache-execution",
              actionExecutionId: "approval-1",
              stageName: "Approval",
              actionName: "Release gate",
              status: "InProgress"
            }
          }
        ]
      })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(scope, first)
      const advanced = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        second
      )
      assert.strictEqual(advanced.acceptedEventCount, 2)

      const projection = (yield* items()).items[0]?.projection
      if (projection?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected advanced pipeline execution")
      }
      assert.deepStrictEqual(projection.details.actions?.map(({ actionName }) => actionName), [
        "Compile",
        "Release gate"
      ])
      assert.deepStrictEqual(projection.details.stages?.map(({ name }) => name), ["Build", "Approval"])

      const actionOnly = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-cache-action-only",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "cache-approval-action-complete",
            observedAt: "2026-07-19T09:06:00.000Z",
            revision: "Succeeded:2026-07-19T09:06:00.000Z",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "cache-execution#approval",
            sourceUrl: null,
            title: "payments · Approval",
            attributes: {
              pipelineName: "payments",
              executionId: "cache-execution",
              actionExecutionId: "approval-1",
              stageName: "Approval",
              actionName: "Release gate",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "unrelated-provider-action",
            observedAt: "2026-07-19T09:06:00.000Z",
            revision: "unrelated-v1",
            entityType: "vendor.action",
            vendorImmutableId: "unrelated-action",
            sourceUrl: null,
            title: "Unrelated provider action",
            attributes: { actionCount: "provider-owned" }
          }]
        })
      )
      assert.strictEqual(actionOnly.acceptedEventCount, 2)
      assert.strictEqual(actionOnly.entityProjectionCount, 1)
      assert.strictEqual(actionOnly.skippedEntityCount, 2)
      const refreshed = (yield* items()).items[0]?.projection
      if (refreshed?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected action-refreshed pipeline execution")
      }
      assert.strictEqual(
        refreshed.details.actions?.find(({ actionName }) => actionName === "Release gate")?.status,
        "succeeded"
      )

      const duplicateAction = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 3, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-cache-duplicate-action",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "cache-approval-action-complete",
            observedAt: "2026-07-19T09:06:00.000Z",
            revision: "Succeeded:2026-07-19T09:06:00.000Z",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "cache-execution#approval",
            sourceUrl: null,
            title: "payments · Approval",
            attributes: {
              pipelineName: "payments",
              executionId: "cache-execution",
              actionExecutionId: "approval-1",
              stageName: "Approval",
              actionName: "Release gate",
              status: "Succeeded"
            }
          }]
        })
      )
      assert.strictEqual(duplicateAction.acceptedEventCount, 0)
      assert.strictEqual(duplicateAction.entityProjectionCount, 0)

      const declarationOnly = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 4, committedAt: T4, successfulHealth: { _tag: "healthy", checkedAt: T4 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-cache-declaration-only",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "cache-payments-declaration",
            observedAt: "2026-07-19T09:07:00.000Z",
            revision: "pipeline-v1",
            entityType: "aws.codepipeline.pipeline",
            vendorImmutableId: "payments-pipeline",
            sourceUrl: null,
            title: "Payments pipeline",
            attributes: {
              pipelineName: "payments",
              stages: [{
                name: "Build",
                actions: [{ name: "Compile", runOrder: 1 }]
              }, {
                name: "Approval",
                actions: [{ name: "Release gate", runOrder: 1 }]
              }, {
                name: "Deploy",
                actions: []
              }]
            }
          }]
        })
      )
      assert.strictEqual(declarationOnly.entityProjectionCount, 1)
      assert.strictEqual(declarationOnly.skippedEntityCount, 1)
      const declared = (yield* items()).items[0]?.projection
      if (declared?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected declaration-refreshed pipeline execution")
      }
      assert.deepStrictEqual(declared.details.stages?.map(({ name }) => name), ["Build", "Approval", "Deploy"])

      const unrelatedDeclaration = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 5, committedAt: T4, successfulHealth: { _tag: "healthy", checkedAt: T4 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-cache-unrelated-declaration",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "cache-inventory-declaration",
            observedAt: "2026-07-19T09:08:00.000Z",
            revision: "pipeline-v2",
            entityType: "aws.codepipeline.pipeline",
            vendorImmutableId: "inventory-pipeline",
            sourceUrl: null,
            title: "Inventory pipeline",
            attributes: {
              pipelineName: "inventory",
              pipelineVersion: 2,
              stages: [{ name: "Inventory", actions: [] }]
            }
          }]
        })
      )
      assert.strictEqual(unrelatedDeclaration.entityProjectionCount, 0)
      assert.strictEqual(unrelatedDeclaration.skippedEntityCount, 1)

      const deletedActionPage = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "pipeline-cache-action-deleted",
        hasMore: false,
        events: [{
          _tag: "TombstoneEntity",
          eventId: "cache-approval-action-deleted",
          observedAt: "2026-07-19T09:09:00.000Z",
          revision: "approval-deleted-v1",
          entityType: "aws.codepipeline.action",
          vendorImmutableId: "cache-execution#approval",
          reason: "Action execution no longer returned"
        }]
      })
      const actionTombstone = deletedActionPage.events[0]
      if (actionTombstone?._tag !== "TombstoneEntity") return yield* Effect.die("expected action tombstone")
      const beforeDelete = yield* persistence.pluginRuntime.getCodePipelineCacheBeforeTombstones(
        WORKSPACE_ID,
        CODEPIPELINE_PLUGIN_ID,
        firstPartyStream("codepipeline"),
        [actionTombstone]
      )
      assert.strictEqual(beforeDelete.length, 1)
      const deletedAction = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 6, committedAt: T4, successfulHealth: { _tag: "healthy", checkedAt: T4 } },
        deletedActionPage
      )
      assert.strictEqual(deletedAction.acceptedEventCount, 1)
      assert.strictEqual(deletedAction.entityProjectionCount, 1)
      const afterDelete = (yield* items()).items[0]?.projection
      if (afterDelete?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected tombstone-refreshed pipeline execution")
      }
      assert.deepStrictEqual(afterDelete.details.actions?.map(({ actionName }) => actionName), ["Compile"])

      const unknownDelete = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 7, committedAt: T4, successfulHealth: { _tag: "healthy", checkedAt: T4 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-cache-unknown-action-deleted",
          hasMore: false,
          events: [{
            _tag: "TombstoneEntity",
            eventId: "cache-unknown-action-deleted",
            observedAt: "2026-07-19T09:10:00.000Z",
            revision: "unknown-deleted-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "unknown-execution#unknown-action",
            reason: "Unknown action cleanup"
          }]
        })
      )
      assert.strictEqual(unknownDelete.entityProjectionCount, 0)
    })))

  it.effect("bounds correlated pipeline actions while preserving total counts", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const execution = (
        executionId: string,
        actionCount: number
      ): ReadonlyArray<typeof NormalizedPluginEventV1.Encoded> => {
        const events: Array<typeof NormalizedPluginEventV1.Encoded> = [{
          _tag: "UpsertEntity",
          eventId: `${executionId}-execution`,
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "execution-v1",
          entityType: "aws.codepipeline.execution",
          vendorImmutableId: executionId,
          sourceUrl: null,
          title: `${executionId} execution`,
          attributes: {
            pipelineName: "bounded-actions",
            executionId,
            status: "Succeeded",
            triggerRevision: "abc123"
          }
        }]
        for (let index = 0; index < actionCount; index++) {
          events.push({
            _tag: "UpsertEntity",
            eventId: `${executionId}-action-${String(index + 1)}`,
            observedAt: "2026-07-19T09:02:00.000Z",
            revision: `Succeeded:${String(index + 1)}`,
            entityType: "aws.codepipeline.action",
            vendorImmutableId: `${executionId}#action-${String(index + 1)}`,
            sourceUrl: null,
            title: `${executionId} · Action ${String(index + 1)}`,
            attributes: {
              pipelineName: "bounded-actions",
              executionId,
              actionExecutionId: `${executionId}-action-${String(index + 1)}`,
              stageName: "Build",
              actionName: `Action ${String(index + 1).padStart(3, "0")}`,
              status: "Succeeded"
            }
          })
        }
        return events
      }
      const receipt = yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
          providerId: "codepipeline",
          streamKey: firstPartyStream("codepipeline"),
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-bounded-actions",
          hasMore: false,
          events: [...execution("bounded-201", 201), ...execution("bounded-200", 200)]
        })
      )
      assert.strictEqual(receipt.entityProjectionCount, 2)
      const projections = (yield* items()).items.map(({ projection }) => projection)
      const bounded201 = projections.find(
        ({ details }) => details._tag === "pipeline-execution" && details.executionId === "bounded-201"
      )
      const bounded200 = projections.find(
        ({ details }) => details._tag === "pipeline-execution" && details.executionId === "bounded-200"
      )
      if (bounded201?.details._tag !== "pipeline-execution" || bounded200?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected both bounded pipeline projections")
      }
      assert.strictEqual(bounded201.details.actions?.length, 200)
      assert.strictEqual(bounded201.details.actionCount, 201)
      assert.strictEqual(bounded201.details.actionsTruncated, true)
      assert.deepStrictEqual(bounded201.details.stages, [{
        name: "Build",
        status: "succeeded",
        actionCount: 201,
        actionsTruncated: true
      }])
      assert.strictEqual(bounded200.details.actions?.length, 200)
      assert.strictEqual(bounded200.details.actionCount, 200)
      assert.strictEqual(bounded200.details.actionsTruncated, false)
      assert.deepStrictEqual(bounded200.details.stages, [{
        name: "Build",
        status: "succeeded",
        actionCount: 200,
        actionsTruncated: false
      }])
    })))

  it.effect("reads only indexed cache records for the affected pipeline execution", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const pipelineEvent = (
        executionId: string,
        suffix: string,
        status: string
      ): typeof NormalizedPluginEventV1.Encoded => ({
        _tag: "UpsertEntity",
        eventId: `${executionId}-action-${suffix}`,
        observedAt: "2026-07-19T09:02:00.000Z",
        revision: `${status}:${suffix}`,
        entityType: "aws.codepipeline.action",
        vendorImmutableId: `${executionId}#action`,
        sourceUrl: null,
        title: `${executionId} action`,
        attributes: {
          pipelineName: executionId,
          executionId,
          actionExecutionId: `${executionId}-action`,
          stageName: "Build",
          actionName: "Compile",
          status
        }
      })
      const executionEvent = (executionId: string): typeof NormalizedPluginEventV1.Encoded => ({
        _tag: "UpsertEntity",
        eventId: `${executionId}-execution`,
        observedAt: "2026-07-19T09:02:00.000Z",
        revision: "execution-v1",
        entityType: "aws.codepipeline.execution",
        vendorImmutableId: executionId,
        sourceUrl: null,
        title: `${executionId} execution`,
        attributes: {
          pipelineName: executionId,
          executionId,
          status: "InProgress",
          triggerRevision: "abc123"
        }
      })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(
        scope,
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-indexed-cache-first",
          hasMore: false,
          events: [
            executionEvent("target"),
            pipelineEvent("target", "initial", "InProgress"),
            ...Array.from({ length: 20 }, (_, index) => {
              const executionId = `unrelated-${String(index + 1)}`
              return [executionEvent(executionId), pipelineEvent(executionId, "initial", "Succeeded")]
            }).flat()
          ]
        })
      )
      const collisionPage = (offset: number) =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: `pipeline-indexed-cache-collisions-${String(offset)}`,
          hasMore: false,
          events: Array.from({ length: 300 }, (_, index) => {
            const sequence = offset + index
            return {
              _tag: "UpsertEntity",
              eventId: `collision-${String(sequence)}`,
              observedAt: "2026-07-19T09:02:30.000Z",
              revision: `collision-v${String(sequence)}`,
              entityType: "vendor.action",
              vendorImmutableId: `collision-${String(sequence)}`,
              sourceUrl: null,
              title: `Colliding action ${String(sequence)}`,
              attributes: {
                pipelineName: "target",
                executionId: "target"
              }
            }
          })
        })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1 },
        collisionPage(1)
      )
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2 },
        collisionPage(301)
      )
      const database = yield* Database
      yield* database.sql`UPDATE plugin_cache_entries SET payload_json = '{}'
        WHERE workspace_id = ${WORKSPACE_ID}
          AND plugin_connection_id = ${CODEPIPELINE_PLUGIN_ID}
          AND stream_key = ${scope.streamKey}
          AND CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.attributes.executionId') END LIKE 'unrelated-%'
          AND CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.entityType') END = 'aws.codepipeline.action'`

      const receipt = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 3, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-indexed-cache-target-update",
          hasMore: false,
          events: [pipelineEvent("target", "failed", "Failed")]
        })
      )
      assert.strictEqual(receipt.entityProjectionCount, 1)
      const target = (yield* items()).items.map(({ projection }) => projection).find(
        ({ details }) => details._tag === "pipeline-execution" && details.executionId === "target"
      )
      if (target?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected targeted pipeline projection")
      }
      assert.strictEqual(target.details.actions?.[0]?.status, "failed")
    })))

  it.effect("rejects plugin pages with unbounded pipeline correlation scopes", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const failure = yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
          providerId: "codepipeline",
          streamKey: firstPartyStream("codepipeline"),
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-correlation-scope-overflow",
          hasMore: false,
          events: Array.from({ length: 33 }, (_, index) => ({
            _tag: "UpsertEntity",
            eventId: `overflow-execution-${String(index + 1)}`,
            observedAt: "2026-07-19T09:02:00.000Z",
            revision: "execution-v1",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: `overflow-${String(index + 1)}`,
            sourceUrl: null,
            title: `Overflow execution ${String(index + 1)}`,
            attributes: {
              pipelineName: "overflow",
              executionId: `overflow-${String(index + 1)}`,
              status: "Succeeded",
              triggerRevision: "abc123"
            }
          }))
        })
      ).pipe(Effect.flip)
      if (failure._tag !== "NormalizedPluginPageMaterializationError") {
        return yield* Effect.die("expected bounded pipeline correlation failure")
      }
      assert.strictEqual(failure.diagnosticCode, "normalized-pipeline-correlation-scope-exceeded")
    })))

  it.effect("matches declaration versions and preserves declared action order", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(
        scope,
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-version-mismatch",
          hasMore: true,
          events: [{
            _tag: "UpsertEntity",
            eventId: "versioned-pipeline-v8",
            observedAt: "2026-07-19T09:02:00.000Z",
            revision: "pipeline-v8",
            entityType: "aws.codepipeline.pipeline",
            vendorImmutableId: "versioned-payments",
            sourceUrl: null,
            title: "Versioned payments pipeline",
            attributes: {
              pipelineName: "versioned-payments",
              pipelineVersion: 8,
              stages: [{ name: "FutureOnly", actions: [] }, { name: "EmptyOnly", actions: [] }, {
                name: "Production",
                actions: [{ name: "Zeta", runOrder: 1 }, { name: "Alpha", runOrder: 2 }]
              }]
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-execution-v7",
            observedAt: "2026-07-19T09:02:00.000Z",
            revision: "execution-v7",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: "versioned-execution-v7",
            sourceUrl: null,
            title: "Version 7 execution",
            attributes: {
              pipelineName: "versioned-payments",
              pipelineVersion: 7,
              executionId: "versioned-execution-v7",
              triggerRevision: "v7-head",
              status: "Succeeded"
            }
          }]
        })
      )
      const mismatched = (yield* items()).items.find(({ projection }) =>
        projection.details._tag === "pipeline-execution" &&
        projection.details.executionId === "versioned-execution-v7"
      )?.projection
      if (mismatched?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected version 7 execution")
      }
      assert.deepStrictEqual(mismatched.details.stages, [])

      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "pipeline-version-match",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "versioned-execution-v8",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "execution-v8",
            entityType: "aws.codepipeline.execution",
            vendorImmutableId: "versioned-execution-v8",
            sourceUrl: null,
            title: "Version 8 execution",
            attributes: {
              pipelineName: "versioned-payments",
              pipelineVersion: 8,
              executionId: "versioned-execution-v8",
              triggerRevision: "v8-head",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-future-observed",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "future-observed-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "versioned-execution-v8#future-observed",
            sourceUrl: null,
            title: "Future observed action",
            attributes: {
              pipelineName: "versioned-payments",
              executionId: "versioned-execution-v8",
              actionExecutionId: "future-observed-1",
              stageName: "FutureOnly",
              actionName: "Observed",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-zeta",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "zeta-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "versioned-execution-v8#zeta",
            sourceUrl: null,
            title: "Production Zeta",
            attributes: {
              pipelineName: "versioned-payments",
              executionId: "versioned-execution-v8",
              actionExecutionId: "zeta-1",
              stageName: "Production",
              actionName: "Zeta",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-alpha",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "alpha-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "versioned-execution-v8#alpha",
            sourceUrl: null,
            title: "Production Alpha",
            attributes: {
              pipelineName: "versioned-payments",
              executionId: "versioned-execution-v8",
              actionExecutionId: "alpha-1",
              stageName: "Production",
              actionName: "Alpha",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-ad-hoc-zeta",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "ad-hoc-zeta-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "versioned-execution-v8#ad-hoc-zeta",
            sourceUrl: null,
            title: "Ad hoc Zeta",
            attributes: {
              pipelineName: "versioned-payments",
              executionId: "versioned-execution-v8",
              actionExecutionId: "ad-hoc-zeta-1",
              stageName: "AdHoc",
              actionName: "Zeta",
              status: "Succeeded"
            }
          }, {
            _tag: "UpsertEntity",
            eventId: "versioned-ad-hoc-alpha",
            observedAt: "2026-07-19T09:03:00.000Z",
            revision: "ad-hoc-alpha-v1",
            entityType: "aws.codepipeline.action",
            vendorImmutableId: "versioned-execution-v8#ad-hoc-alpha",
            sourceUrl: null,
            title: "Ad hoc Alpha",
            attributes: {
              pipelineName: "versioned-payments",
              executionId: "versioned-execution-v8",
              actionExecutionId: "ad-hoc-alpha-1",
              stageName: "AdHoc",
              actionName: "Alpha",
              status: "Succeeded"
            }
          }]
        })
      )
      const matching = (yield* items()).items.find(({ projection }) =>
        projection.details._tag === "pipeline-execution" &&
        projection.details.executionId === "versioned-execution-v8"
      )?.projection
      if (matching?.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected version 8 execution")
      }
      assert.deepStrictEqual(matching.details.stages?.map(({ name }) => name), [
        "FutureOnly",
        "EmptyOnly",
        "Production",
        "AdHoc"
      ])
      assert.deepStrictEqual(
        matching.details.stages?.slice(0, 2).map(({ actionCount, name }) => [name, actionCount]),
        [["FutureOnly", 1], ["EmptyOnly", 0]]
      )
      assert.deepStrictEqual(
        matching.details.actions?.map(({ actionName, stageName }) => `${stageName}:${actionName}`),
        ["FutureOnly:Observed", "Production:Zeta", "Production:Alpha", "AdHoc:Alpha", "AdHoc:Zeta"]
      )
    })))

  it.effect("backfills stale pipeline and Clockify schemas without changing the current issue schema", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      yield* setupConnection(CLOCKIFY_PLUGIN_ID, "clockify")
      const entityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000256")
      const sourceRevision = Schema.decodeSync(SourceRevision)({
        providerId: "codepipeline",
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        vendorImmutableId: "pipeline-backfill",
        revision: "pipeline-same-revision",
        sourceUrl: null,
        firstObservedAt: "2026-07-19T09:02:00.000Z",
        lastObservedAt: "2026-07-19T09:02:00.000Z",
        synchronizedAt: "2026-07-19T09:02:00.000Z",
        normalizationSchemaVersion: 1
      })
      yield* persistence.entities.create(WORKSPACE_ID, {
        entityId,
        entityType: "pipeline-execution",
        sourceRevision,
        createdAt: T2
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [{
          projection: {
            workspaceId: WORKSPACE_ID,
            entityId,
            projectionRevision: 1,
            sourceEntityRevision: 1,
            supersedesProjectionRevision: null,
            projectionSchemaVersion: 1,
            entityState: "present",
            entityType: "pipeline-execution",
            displayKey: "payments/pipeline-backfill",
            title: "Payments execution",
            details: {
              _tag: "pipeline-execution",
              pipelineName: "payments",
              executionId: "pipeline-backfill",
              status: "running",
              triggerRevision: "abc123"
            }
          },
          recordedAt: "2026-07-19T09:02:00.000Z"
        }],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: []
      })
      const page = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "pipeline-schema-backfill",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "pipeline-schema-backfill-execution",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "pipeline-same-revision",
          entityType: "aws.codepipeline.execution",
          vendorImmutableId: "pipeline-backfill",
          sourceUrl: null,
          title: "Payments execution",
          attributes: {
            pipelineName: "payments",
            executionId: "pipeline-backfill",
            status: "InProgress",
            triggerRevision: "abc123"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pipeline-schema-backfill-action",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "Succeeded:2026-07-19T09:02:00.000Z",
          entityType: "aws.codepipeline.action",
          vendorImmutableId: "pipeline-backfill#build",
          sourceUrl: null,
          title: "payments · Build",
          attributes: {
            pipelineName: "payments",
            executionId: "pipeline-backfill",
            actionExecutionId: "build-1",
            stageName: "Build",
            actionName: "Compile",
            status: "Succeeded"
          }
        }]
      })
      const receipt = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: Schema.decodeSync(PluginStreamKey)("pipeline-schema-backfill"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, page)
      assert.strictEqual(receipt.entityProjectionCount, 1)
      const projection = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId,
        revision: null
      })
      if (projection._tag !== "entityProjection") return yield* Effect.die("expected backfilled pipeline")
      assert.strictEqual(projection.value.projection.projectionRevision, 2)
      assert.strictEqual(projection.value.projection.projectionSchemaVersion, 2)
      if (projection.value.projection.details._tag !== "pipeline-execution") {
        return yield* Effect.die("expected pipeline backfill details")
      }
      assert.deepStrictEqual(
        projection.value.projection.details.actions?.map(({ actionName }) => actionName),
        ["Compile"]
      )

      const timeEntryEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000258")
      const timeEntrySourceRevision = Schema.decodeSync(SourceRevision)({
        providerId: "clockify",
        pluginConnectionId: CLOCKIFY_PLUGIN_ID,
        vendorImmutableId: "time-entry-backfill",
        revision: "time-entry-same-revision",
        sourceUrl: "https://app.clockify.me/tracker",
        firstObservedAt: "2026-07-19T09:02:00.000Z",
        lastObservedAt: "2026-07-19T09:02:00.000Z",
        synchronizedAt: "2026-07-19T09:02:00.000Z",
        normalizationSchemaVersion: 1
      })
      yield* persistence.entities.create(WORKSPACE_ID, {
        entityId: timeEntryEntityId,
        entityType: "time-entry",
        sourceRevision: timeEntrySourceRevision,
        createdAt: T2
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [{
          projection: {
            workspaceId: WORKSPACE_ID,
            entityId: timeEntryEntityId,
            projectionRevision: 1,
            sourceEntityRevision: 1,
            supersedesProjectionRevision: null,
            projectionSchemaVersion: 1,
            entityState: "present",
            entityType: "time-entry",
            displayKey: "time-entry-backfill",
            title: "PAY-258 release review",
            details: {
              _tag: "time-entry",
              durationMinutes: 45,
              billable: true,
              approvalState: "approved"
            }
          },
          recordedAt: "2026-07-19T09:02:00.000Z"
        }],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: []
      })
      const timeEntryStreamKey = Schema.decodeSync(PluginStreamKey)("time-entry-schema-backfill")
      const timeEntryPage = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "time-entry-schema-backfill",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "time-entry-schema-backfill",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "time-entry-same-revision",
          entityType: "clockify.time-entry",
          vendorImmutableId: "time-entry-backfill",
          sourceUrl: "https://app.clockify.me/tracker",
          title: "PAY-258 release review",
          attributes: {
            billable: true,
            approvalState: "approved",
            projectId: "payments",
            userId: "clockify-user-avery",
            interval: {
              start: "2026-07-19T08:17:00.000Z",
              end: "2026-07-19T09:02:00.000Z"
            }
          }
        }]
      })
      yield* persistence.pluginRuntime.commitNormalizedPageReceipt(
        WORKSPACE_ID,
        CLOCKIFY_PLUGIN_ID,
        "clockify",
        timeEntryStreamKey,
        0,
        timeEntryPage,
        T2,
        { _tag: "healthy", checkedAt: T2 }
      )
      const timeEntryScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CLOCKIFY_PLUGIN_ID,
        providerId: "clockify",
        streamKey: timeEntryStreamKey,
        expectedRevision: 1,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      } satisfies NormalizedPluginPageMaterializationScope
      const timeEntryReceipt = yield* materializeNormalizedPluginPage(timeEntryScope, timeEntryPage)
      assert.strictEqual(timeEntryReceipt.entityProjectionCount, 1)
      assert.strictEqual(timeEntryReceipt.acceptedEventCount, 0)
      const timeEntryProjection = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId: timeEntryEntityId,
        revision: null
      })
      if (timeEntryProjection._tag !== "entityProjection") {
        return yield* Effect.die("expected backfilled time entry")
      }
      assert.strictEqual(timeEntryProjection.value.projection.projectionRevision, 2)
      assert.strictEqual(timeEntryProjection.value.projection.projectionSchemaVersion, 2)
      if (timeEntryProjection.value.projection.details._tag !== "time-entry") {
        return yield* Effect.die("expected time-entry backfill details")
      }
      assert.deepInclude(timeEntryProjection.value.projection.details, {
        durationMinutes: 45,
        projectId: "payments",
        userId: "clockify-user-avery"
      })
      const currentTimeEntry = yield* materializeNormalizedPluginPage(timeEntryScope, timeEntryPage)
      assert.strictEqual(currentTimeEntry.acceptedEventCount, 0)
      assert.strictEqual(currentTimeEntry.entityProjectionCount, 0)

      const issueEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000257")
      const issueSourceRevision = Schema.decodeSync(SourceRevision)({
        providerId: "jira",
        pluginConnectionId: PLUGIN_ID,
        vendorImmutableId: "PAY-257",
        revision: "issue-same-revision",
        sourceUrl: null,
        firstObservedAt: "2026-07-19T09:02:00.000Z",
        lastObservedAt: "2026-07-19T09:02:00.000Z",
        synchronizedAt: "2026-07-19T09:02:00.000Z",
        normalizationSchemaVersion: 1
      })
      yield* persistence.entities.create(WORKSPACE_ID, {
        entityId: issueEntityId,
        entityType: "issue",
        sourceRevision: issueSourceRevision,
        createdAt: T2
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [{
          projection: {
            workspaceId: WORKSPACE_ID,
            entityId: issueEntityId,
            projectionRevision: 1,
            sourceEntityRevision: 1,
            supersedesProjectionRevision: null,
            projectionSchemaVersion: 1,
            entityState: "present",
            entityType: "issue",
            displayKey: "PAY-257",
            title: "Unchanged issue",
            details: { _tag: "issue", key: "PAY-257", status: "Open", priority: null, estimatePoints: null }
          },
          recordedAt: "2026-07-19T09:02:00.000Z"
        }],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: []
      })
      const unchangedIssue = yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: Schema.decodeSync(PluginStreamKey)("issue-schema-current"),
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        },
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "issue-schema-current",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "issue-schema-current",
            observedAt: "2026-07-19T09:02:00.000Z",
            revision: "issue-same-revision",
            entityType: "jira.issue",
            vendorImmutableId: "PAY-257",
            sourceUrl: null,
            title: "Unchanged issue",
            attributes: { key: "PAY-257", status: "Open", priority: null, estimatePoints: null }
          }]
        })
      )
      assert.strictEqual(unchangedIssue.entityProjectionCount, 0)
      const currentIssue = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId: issueEntityId,
        revision: null
      })
      if (currentIssue._tag !== "entityProjection") return yield* Effect.die("expected current issue projection")
      assert.strictEqual(currentIssue.value.projection.projectionRevision, 1)
    })))

  it.effect("retains complete bounded Jira detail across two inspection revisions", () =>
    withMaterializer(
      Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* setup
        const scope: NormalizedPluginPageMaterializationScope = {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        }

        yield* materializeNormalizedPluginPage(scope, richIssuePage(1))
        const firstIndex = yield* items()
        const entityId = firstIndex.items[0]?.projection.entityId
        if (entityId === undefined) return yield* Effect.die("expected rich Jira entity")

        yield* materializeNormalizedPluginPage(
          {
            ...scope,
            expectedRevision: 1,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          },
          richIssuePage(2)
        )

        const first = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "entityProjection",
          entityId,
          revision: 1
        })
        if (first._tag !== "entityProjection") return yield* Effect.die("expected first projection revision")
        assert.strictEqual(first.value.projection.details._tag, "issue")
        if (first.value.projection.details._tag !== "issue") return yield* Effect.die("expected issue detail")
        assert.strictEqual(first.value.projection.details.description, richIssueAttributes.description)
        assert.strictEqual(first.value.projection.details.acceptanceCriteria, richIssueAttributes.acceptanceCriteria)
        assert.strictEqual(first.value.projection.details.comments?.[0]?.sourceId, "c1")
        assert.strictEqual(first.value.projection.details.history?.[0]?.changes[0]?.to, "In Review")
        assert.strictEqual(first.value.projection.details.fixVersions?.[0]?.name, "2026.29")
        assert.deepStrictEqual(first.value.projection.details.truncatedFields, ["comments"])

        const inspectionService = yield* makeDeliveryGraphInspection
        const inspection = yield* inspectionService.workspaceEntity({ workspaceId: WORKSPACE_ID, entityId })
        assert.strictEqual(inspection.entity.projection.projectionRevision, 2)
        assert.strictEqual(inspection.entity.projection.sourceEntityRevision, 2)
        assert.strictEqual(inspection.entity.projection.details._tag, "issue")
        if (inspection.entity.projection.details._tag !== "issue") return yield* Effect.die("expected issue detail")
        const details = inspection.entity.projection.details
        assert.strictEqual(details.status, "Done")
        assert.strictEqual(details.description, "Retry state is durable in production.")
        assert.strictEqual(details.acceptanceCriteria, "- Restart-safe\n- Timeout-safe\n- Verified in production")
        assert.strictEqual(details.comments?.[0]?.sourceId, "c2")
        assert.strictEqual(details.comments?.[0]?.updateAuthorSourcePersonId, "sam")
        assert.strictEqual(details.history?.[0]?.sourceId, "h1")
        assert.strictEqual(details.collaborators?.[0]?.sourcePersonId, "ari")
        assert.strictEqual(details.collaborators?.[0]?.avatarUrl, "https://avatar.example/ari.png")
        assert.strictEqual(details.fixVersions?.[0]?.sourceId, "2026.29")
        assert.isFalse(details.commentsTruncated)
        assert.deepStrictEqual(details.truncatedFields, [])
        assert.isTrue(inspection.isSourceCurrent)
      })
    ))

  it.effect("produces presentation-ready inspection from a provider-normalized Jira issue", () =>
    withMaterializer(
      Effect.gen(function*() {
        yield* setup
        const events = yield* normalizeJiraIssueEvents({
          issue: {
            id: "10042",
            key: "PAY-42",
            fields: {
              summary: "Protect payment retries",
              updated: "2026-07-19T09:01:00.000Z",
              description: {
                type: "doc",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Persist retry state." }] },
                  {
                    type: "heading",
                    attrs: { level: 2 },
                    content: [{ type: "text", text: "Acceptance Criteria" }]
                  },
                  {
                    type: "bulletList",
                    content: [{
                      type: "listItem",
                      content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: "Retry survives restart." }]
                      }]
                    }]
                  }
                ]
              },
              environment: "Payments production",
              status: { id: "3", name: "In Review" },
              assignee: {
                accountId: "ari",
                displayName: "Ari Chen",
                avatarUrls: { "48x48": "https://avatar.example/ari.png" },
                active: true
              }
            }
          },
          comments: {
            values: [{
              id: "c1",
              author: { accountId: "ari", displayName: "Ari Chen", active: true },
              body: "Ready for review.",
              created: "2026-07-18T10:00:00.000Z",
              updated: "2026-07-18T10:00:00.000Z"
            }],
            total: 1,
            truncated: false
          },
          changelogs: {
            values: [],
            total: 0,
            truncated: false
          },
          observedAt: T1,
          webBaseUrl: new URL("https://jira.example/")
        })
        const page = Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "provider-normalized-issue",
          hasMore: false,
          events: events.map((event) => Schema.encodeSync(NormalizedPluginEventV1)(event))
        })
        yield* materializeNormalizedPluginPage(
          {
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: PLUGIN_ID,
            providerId: "jira",
            streamKey: MATERIALIZED_STREAM,
            expectedRevision: 0,
            committedAt: T2,
            successfulHealth: { _tag: "healthy", checkedAt: T2 }
          },
          page
        )

        const index = yield* items()
        const entityId = index.items[0]?.projection.entityId
        if (entityId === undefined) return yield* Effect.die("expected normalized Jira issue")
        const inspectionService = yield* makeDeliveryGraphInspection
        const inspection = yield* inspectionService.workspaceEntity({ workspaceId: WORKSPACE_ID, entityId })
        const presentationInput = Schema.encodeSync(WorkspaceEntityInspection)(inspection)
        assert.strictEqual(presentationInput.entity.projection.displayKey, "PAY-42")
        assert.strictEqual(presentationInput.entity.projection.title, "PAY-42 · Protect payment retries")
        assert.strictEqual(presentationInput.source.sourceUrl, "https://jira.example/browse/PAY-42")
        const details = presentationInput.entity.projection.details
        if (details._tag !== "issue") return yield* Effect.die("expected presentation-ready Jira issue details")
        assert.strictEqual(
          details.description,
          "Persist retry state\\.\n\n## Acceptance Criteria\n\n- Retry survives restart\\."
        )
        assert.strictEqual(details.acceptanceCriteria, "- Retry survives restart\\.")
        assert.strictEqual(details.environment, "Payments production")
        assert.strictEqual(details.collaborators?.[0]?.displayName, "Ari Chen")
        assert.strictEqual(details.comments?.[0]?.body, "Ready for review\\.")
      })
    ))

  it.effect("persists a rich issue whose valid attributes leave only projection-wrapper headroom", () =>
    withMaterializer(
      Effect.gen(function*() {
        yield* setup
        const comment = (sourceId: string, body: string) => ({
          sourceId,
          authorSourcePersonId: null,
          updateAuthorSourcePersonId: null,
          body,
          createdAt: null,
          updatedAt: null
        })
        const fixedComments = Array.from(
          { length: 16 },
          (_, index) => comment(`fixed-${String(index)}`, "x".repeat(16_000))
        )
        const attributes = {
          key: "PAY-NEAR-LIMIT",
          status: "Open",
          priority: null,
          estimatePoints: null,
          comments: [...fixedComments, comment("remainder", "")],
          commentTotal: 17,
          commentsTruncated: false,
          truncatedFields: []
        }
        const targetBytes = MaximumPluginPayloadBytes - 1
        const remainderLength = targetBytes - jsonBytes(attributes)
        assert.isAtLeast(remainderLength, 1)
        assert.isAtMost(remainderLength, 16_000)
        attributes.comments[attributes.comments.length - 1] = comment("remainder", "x".repeat(remainderLength))
        assert.strictEqual(jsonBytes(attributes), targetBytes)
        assert.isAbove(jsonBytes({ _tag: "issue", ...attributes }), MaximumPluginPayloadBytes)

        const page = Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "near-limit-rich-issue",
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: "near-limit-rich-issue",
            observedAt: "2026-07-19T09:01:00.000Z",
            revision: "near-limit-rich-issue-1",
            entityType: "jira.issue",
            vendorImmutableId: "near-limit-rich-issue",
            sourceUrl: "https://jira.example/browse/PAY-NEAR-LIMIT",
            title: "PAY-NEAR-LIMIT · Exercise projection headroom",
            attributes
          }]
        })
        const receipt = yield* materializeNormalizedPluginPage({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        }, page)

        assert.strictEqual(receipt.entityProjectionCount, 1)
      })
    ))

  it.effect("rejects malformed rich issue fields without breaking compact legacy issues", () =>
    withMaterializer(
      Effect.gen(function*() {
        yield* setup
        const scope: NormalizedPluginPageMaterializationScope = {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        }
        const page = (checkpointAfterPage: string, attributes: Readonly<Record<string, Schema.Json>>) =>
          Schema.decodeSync(PluginSyncPageV1)({
            checkpointAfterPage,
            hasMore: false,
            events: [{
              _tag: "UpsertEntity",
              eventId: checkpointAfterPage,
              observedAt: "2026-07-19T09:01:00.000Z",
              revision: `${checkpointAfterPage}-1`,
              entityType: "jira.issue",
              vendorImmutableId: checkpointAfterPage,
              sourceUrl: null,
              title: checkpointAfterPage,
              attributes
            }]
          })

        const failure = yield* materializeNormalizedPluginPage(
          scope,
          page("malformed-rich-issue", {
            key: "PAY-42",
            status: "Open",
            priority: null,
            estimatePoints: null,
            collaborators: [{
              sourcePersonId: "ari",
              displayName: "Ari Chen",
              avatarUrl: "javascript:alert(1)",
              active: true,
              roles: ["assignee"]
            }]
          })
        ).pipe(Effect.flip)
        if (failure._tag !== "NormalizedPluginPageMaterializationError") {
          return yield* Effect.die("expected malformed rich issue failure")
        }
        assert.strictEqual(failure.diagnosticCode, "normalized-issue-attributes-invalid")

        const overlappingFailure = yield* materializeNormalizedPluginPage(
          scope,
          page("malformed-overlapping-issue-field", {
            key: "PAY-43",
            status: { name: "Open" },
            priority: { name: "High" },
            estimatePoints: null,
            updatedAt: ""
          })
        ).pipe(Effect.flip)
        if (overlappingFailure._tag !== "NormalizedPluginPageMaterializationError") {
          return yield* Effect.die("expected malformed overlapping issue failure")
        }
        assert.strictEqual(overlappingFailure.diagnosticCode, "normalized-issue-attributes-invalid")

        const legacy = yield* materializeNormalizedPluginPage(
          scope,
          page("compact-legacy-issue", {
            schemaVersion: 1,
            key: "LEGACY-42",
            summary: "Historical compact issue",
            status: { name: "Open" },
            priority: { name: "High" },
            stages: "GA",
            actionCount: "provider-owned"
          })
        )
        assert.strictEqual(legacy.entityProjectionCount, 1)
      })
    ))
  it.effect("materializes inferred relationships across synchronized provider evidence", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      yield* setupConnection(CLOCKIFY_PLUGIN_ID, "clockify")
      yield* setupConnection(CONFLUENCE_PLUGIN_ID, "confluence")

      const synchronize = (
        pluginConnectionId: PluginConnectionId,
        providerId: "clockify" | "codecommit" | "codepipeline" | "confluence" | "jira",
        page: typeof PluginSyncPageV1.Type,
        successfulHealth: NormalizedPluginPageMaterializationScope["successfulHealth"] = {
          _tag: "healthy",
          checkedAt: T3
        }
      ) =>
        materializeNormalizedPluginPage({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId,
          providerId,
          streamKey: firstPartyStream(providerId),
          expectedRevision: 0,
          committedAt: T3,
          successfulHealth
        }, page)

      yield* synchronize(PLUGIN_ID, "jira", inferenceJiraReleasePage)
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", codeCommitRelationshipPage)
      yield* synchronize(CODEPIPELINE_PLUGIN_ID, "codepipeline", codePipelineRelationshipPage)
      yield* synchronize(CLOCKIFY_PLUGIN_ID, "clockify", clockifyRelationshipPage)
      yield* synchronize(CONFLUENCE_PLUGIN_ID, "confluence", confluenceRelationshipPage, {
        _tag: "degraded",
        checkedAt: T3,
        failureClass: "rate-limit",
        retryAt: null,
        safeMessage: "Confluence returned a partial successful response."
      })

      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const slice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      const inspectionService = yield* makeDeliveryGraphInspection
      const boundedSlice = yield* inspectionService.releaseSlice({
        workspaceId: WORKSPACE_ID,
        releaseId: release.id,
        environmentId: null
      })
      const indexedPage = boundedSlice.entityProjections.find(({ projection }) => projection.details._tag === "page")
        ?.projection
      if (indexedPage?.details._tag !== "page") return yield* Effect.die("expected a bounded page projection")
      assert.strictEqual(indexedPage.details.contentState, "lazy")
      assert.isNull(indexedPage.details.content)
      const indexedTimeEntry = boundedSlice.entityProjections.find(
        ({ projection }) => projection.details._tag === "time-entry"
      )?.projection
      if (indexedTimeEntry?.details._tag !== "time-entry") {
        return yield* Effect.die("expected a bounded time-entry projection")
      }
      assert.deepInclude(indexedTimeEntry.details, {
        durationMinutes: 45,
        billable: true,
        approvalState: "approved",
        projectId: "project-payments",
        userId: "clockify-user-mina"
      })
      if (
        indexedTimeEntry.details.startedAt === undefined ||
        indexedTimeEntry.details.endedAt === undefined ||
        indexedTimeEntry.details.endedAt === null
      ) {
        return yield* Effect.die("expected a complete Clockify interval")
      }
      assert.strictEqual(DateTime.formatIso(indexedTimeEntry.details.startedAt), "2026-07-19T08:17:30.000Z")
      assert.strictEqual(DateTime.formatIso(indexedTimeEntry.details.endedAt), "2026-07-19T09:02:30.000Z")
      const current = slice.value.relationships.filter(
        ({ lifecycle }) => lifecycle._tag !== "rejected" && lifecycle._tag !== "superseded"
      )
      assert.sameMembers(
        current.map(({ kind, lifecycle }) => `${kind}:${lifecycle._tag}`),
        [
          "contains:proposed",
          "implements:inferred",
          "delivered-by:inferred",
          "tracks-time-for:inferred",
          "documented-by:inferred",
          "documented-by:inferred"
        ]
      )
      assert.isFalse(current.some(({ lifecycle }) => lifecycle._tag === "missing"))
      assert.lengthOf(
        slice.value.relationships.filter(({ lifecycle }) => lifecycle._tag === "superseded"),
        0
      )
      assert.isTrue(
        current
          .filter(({ lifecycle }) => lifecycle._tag === "inferred")
          .every(
            ({ confidence, evidenceClaimIds, provenance }) =>
              confidence._tag === "inferred" && evidenceClaimIds.length === 1 && provenance._tag === "rule"
          )
      )
      assert.lengthOf(slice.value.entityProjections, 5)
      assert.lengthOf(slice.value.evidenceClaims, 6)
      const confluenceInferenceEvidence = slice.value.evidenceItems.filter(
        ({ attribution, freshness }) =>
          attribution._tag === "system" &&
          attribution.component === "relationship-inference" &&
          freshness.provenance._tag === "provider" &&
          freshness.provenance.sourceRevision.providerId === "confluence"
      )
      assert.lengthOf(confluenceInferenceEvidence, 2)
      assert.isTrue(confluenceInferenceEvidence.every(({ freshness }) => freshness.pluginHealth._tag === "degraded"))
      assert.isTrue(
        slice.value.evidenceItems.some(
          ({ attribution, freshness }) =>
            attribution._tag === "system" &&
            attribution.component === "relationship-inference" &&
            freshness.provenance._tag === "provider" &&
            freshness.provenance.sourceRevision.providerId === "codepipeline" &&
            freshness.pluginHealth._tag === "healthy"
        )
      )
      const deliveredRelationship = current.find(({ kind }) => kind === "delivered-by")
      if (deliveredRelationship === undefined) return yield* Effect.die("expected inferred delivery relationship")

      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: firstPartyStream("codecommit"),
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, codeCommitUnlinkedPage)
      const changed = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (changed._tag !== "releaseSlice") return yield* Effect.die("expected updated release slice")
      const changedCurrent = changed.value.relationships.filter(
        ({ lifecycle }) => lifecycle._tag !== "rejected" && lifecycle._tag !== "superseded"
      )
      assert.isTrue(
        changedCurrent.some(({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "missing")
      )
      assert.isFalse(
        changedCurrent.some(({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred")
      )
      assert.isFalse(
        changedCurrent.some(({ kind, lifecycle }) => kind === "delivered-by" && lifecycle._tag === "inferred")
      )
      const deliveredHistory = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: deliveredRelationship.relationshipId,
        limit: 10
      })
      if (deliveredHistory._tag !== "relationshipHistory") return yield* Effect.die("expected delivery history")
      assert.strictEqual(deliveredHistory.value[0]?.lifecycle._tag, "superseded")
    })))

  it.effect("uses the evidence provider stream and health when another provider triggers inference", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")

      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: firstPartyStream("jira"),
        expectedRevision: 0,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, inferenceJiraReleasePage)
      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: firstPartyStream("codecommit"),
        expectedRevision: 0,
        committedAt: T3,
        successfulHealth: {
          _tag: "degraded",
          checkedAt: T3,
          failureClass: "rate-limit",
          retryAt: null,
          safeMessage: "CodeCommit returned a partial successful response."
        }
      }, codeCommitRelationshipPage)
      const repeatedPullRequest = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "codecommit-source-stream-repeat",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "codecommit-pr-17-source-stream-repeat",
          observedAt: "2026-07-19T09:03:00.000Z",
          revision: "abc123-source-stream-repeat",
          entityType: "pull-request",
          vendorImmutableId: "17",
          sourceUrl: "https://console.aws.example/codecommit/pull-requests/17",
          title: "PAY-42 guard refund writes",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/PAY-42-refund-guard",
            targetBranch: "main",
            headRevision: "abc123",
            reviewState: "requested"
          }
        }]
      })
      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: firstPartyStream("codecommit"),
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: {
          _tag: "degraded",
          checkedAt: T3,
          failureClass: "rate-limit",
          retryAt: null,
          safeMessage: "CodeCommit returned a partial successful response."
        }
      }, repeatedPullRequest)
      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        streamKey: firstPartyStream("codepipeline"),
        expectedRevision: 0,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, codePipelineRelationshipPage)

      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const slice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      const evidence = slice.value.evidenceItems.find(
        ({ attribution, freshness }) =>
          attribution._tag === "system" &&
          attribution.component === "relationship-inference" &&
          freshness.provenance._tag === "provider" &&
          freshness.provenance.sourceRevision.providerId === "codecommit"
      )
      if (evidence === undefined) return yield* Effect.die("expected CodeCommit inference evidence")
      assert.deepStrictEqual(evidence.freshness.pluginHealth, {
        _tag: "degraded",
        checkedAt: T3,
        failureClass: "rate-limit",
        retryAt: null,
        safeMessage: "CodeCommit returned a partial successful response."
      })
    })))

  it.effect("surfaces a missing gap after a user rejects the inferred implementation", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      const synchronize = (
        pluginConnectionId: PluginConnectionId,
        providerId: "codecommit" | "jira",
        expectedRevision: number,
        page: typeof PluginSyncPageV1.Type
      ) =>
        materializeNormalizedPluginPage({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId,
          providerId,
          streamKey: firstPartyStream(providerId),
          expectedRevision,
          committedAt: T3,
          successfulHealth: { _tag: "healthy", checkedAt: T3 }
        }, page)

      yield* synchronize(PLUGIN_ID, "jira", 0, inferenceJiraReleasePage)
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 0, codeCommitRelationshipPage)
      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const inferredSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (inferredSlice._tag !== "releaseSlice") return yield* Effect.die("expected inferred release slice")
      const inferred = inferredSlice.value.relationships.find(
        ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
      )
      if (inferred === undefined) return yield* Effect.die("expected inferred implementation")
      const rejected = DeliveryRelationship.make({
        ...inferred,
        revision: LedgerRevision.make(inferred.revision + 1),
        supersedesRevision: inferred.revision,
        lifecycle: { _tag: "rejected", effectiveAt: T3, reason: "The inferred implementation is incorrect." },
        recordedAt: T3
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [yield* Schema.encodeEffect(DeliveryRelationship)(rejected).pipe(Effect.orDie)]
      })

      const repeatedPullRequest = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "codecommit-rejected-link-rerun",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "codecommit-pr-17-abc123-observed-again",
          observedAt: "2026-07-19T09:03:00.000Z",
          revision: "abc123-observed-again",
          entityType: "pull-request",
          vendorImmutableId: "17",
          sourceUrl: "https://console.aws.example/codecommit/pull-requests/17",
          title: "PAY-42 guard refund writes",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/PAY-42-refund-guard",
            targetBranch: "main",
            headRevision: "abc123",
            reviewState: "requested"
          }
        }]
      })
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 1, repeatedPullRequest)

      const repairedSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (repairedSlice._tag !== "releaseSlice") return yield* Effect.die("expected repaired release slice")
      assert.isTrue(
        repairedSlice.value.relationships.some(
          ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "missing"
        )
      )
      assert.isFalse(
        repairedSlice.value.relationships.some(
          ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
        )
      )
    })))

  it.effect("supersedes rule-owned inference when the workspace entity snapshot exceeds its bound", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      yield* setupConnection(CODEPIPELINE_PLUGIN_ID, "codepipeline")
      const synchronize = (
        pluginConnectionId: PluginConnectionId,
        providerId: "codecommit" | "codepipeline" | "jira",
        expectedRevision: number,
        page: typeof PluginSyncPageV1.Type
      ) =>
        materializeNormalizedPluginPage({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId,
          providerId,
          streamKey: firstPartyStream(providerId),
          expectedRevision,
          committedAt: T3,
          successfulHealth: { _tag: "healthy", checkedAt: T3 }
        }, page)

      yield* synchronize(PLUGIN_ID, "jira", 0, inferenceJiraReleasePage)
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 0, codeCommitRelationshipPage)
      yield* synchronize(CODEPIPELINE_PLUGIN_ID, "codepipeline", 0, codePipelineRelationshipPage)

      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      const delivered = initialSlice.value.relationships.find(
        ({ kind, lifecycle }) => kind === "delivered-by" && lifecycle._tag === "inferred"
      )
      if (delivered === undefined) return yield* Effect.die("expected inferred delivery relationship")

      const unrelated = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "codecommit-workspace-bound",
        hasMore: false,
        events: Array.from({ length: 500 }, (_, index): typeof NormalizedPluginEventV1.Encoded => ({
          _tag: "UpsertEntity",
          eventId: `codecommit-unrelated-${String(index)}`,
          observedAt: "2026-07-19T09:02:40.000Z",
          revision: `unrelated-${String(index)}`,
          entityType: "pull-request",
          vendorImmutableId: `unrelated-${String(index)}`,
          sourceUrl: null,
          title: `Unrelated pull request ${String(index)}`,
          attributes: {
            repository: "unrelated",
            sourceBranch: `feat/unrelated-${String(index)}`,
            targetBranch: "main",
            headRevision: `unrelated-${String(index)}`,
            reviewState: "requested"
          }
        }))
      })
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 1, unrelated)
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 2, codeCommitUnlinkedPage)

      const history = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: delivered.relationshipId,
        limit: 10
      })
      if (history._tag !== "relationshipHistory") return yield* Effect.die("expected delivery history")
      assert.strictEqual(history.value[0]?.lifecycle._tag, "superseded")
    })))

  it.effect(
    "supersedes rule-owned inference only after the candidate snapshot exceeds its bound",
    () =>
      withMaterializer(Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* setup
        yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
        yield* setupConnection(CONFLUENCE_PLUGIN_ID, "confluence")
        const synchronize = (
          pluginConnectionId: PluginConnectionId,
          providerId: "codecommit" | "confluence" | "jira",
          expectedRevision: number,
          page: typeof PluginSyncPageV1.Type
        ) =>
          materializeNormalizedPluginPage({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId,
            providerId,
            streamKey: firstPartyStream(providerId),
            expectedRevision,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          }, page)
        const versions = ["2026.29", ...Array.from({ length: 36 }, (_, index) => `cap-${String(index + 1)}`)]
        const additionalReleases = Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "jira-candidate-cap-releases",
          hasMore: false,
          events: versions.slice(1).map((version): typeof NormalizedPluginEventV1.Encoded => ({
            _tag: "UpsertEntity",
            eventId: `jira-candidate-cap-release-${version}`,
            observedAt: "2026-07-19T09:02:40.000Z",
            revision: `candidate:${version}`,
            entityType: "release",
            vendorImmutableId: `jira-version:${version}`,
            sourceUrl: null,
            title: `Payments ${version}`,
            attributes: { serviceName: "Payments", version, lifecycle: "candidate" }
          }))
        })
        const documentationPage = (start: number, count: number, checkpointAfterPage: string) =>
          Schema.decodeSync(PluginSyncPageV1)({
            checkpointAfterPage,
            hasMore: false,
            events: Array.from({ length: count }, (_, offset): typeof NormalizedPluginEventV1.Encoded => {
              const index = start + offset
              return {
                _tag: "UpsertEntity",
                eventId: `confluence-candidate-cap-${String(index)}`,
                observedAt: "2026-07-19T09:02:50.000Z",
                revision: "1",
                entityType: "confluence-page",
                vendorImmutableId: `candidate-cap-${String(index)}`,
                sourceUrl: null,
                title: `Candidate cap page ${String(index)}`,
                attributes: {
                  spaceKey: "PAY",
                  currentVersion: 1,
                  status: "current",
                  linkedReleaseVersions: versions
                }
              }
            })
          })

        yield* synchronize(PLUGIN_ID, "jira", 0, inferenceJiraReleasePage)
        yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 0, codeCommitRelationshipPage)
        const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))
          .find(({ release }) => release.version === "2026.29")?.release
        if (release === undefined) return yield* Effect.die("expected synchronized release")
        const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "releaseSlice",
          releaseId: release.id,
          environmentId: null,
          limit: 100
        })
        if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
        const inferred = initialSlice.value.relationships.find(
          ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
        )
        if (inferred === undefined) return yield* Effect.die("expected inferred implementation relationship")

        yield* synchronize(PLUGIN_ID, "jira", 1, additionalReleases)
        yield* synchronize(CONFLUENCE_PLUGIN_ID, "confluence", 0, documentationPage(1, 54, "candidate-cap-2000"))
        const atBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "relationship",
          relationshipId: inferred.relationshipId,
          revision: null
        })
        if (atBound._tag !== "relationship") return yield* Effect.die("expected relationship at candidate bound")
        assert.strictEqual(atBound.value.lifecycle._tag, "inferred")

        yield* synchronize(CONFLUENCE_PLUGIN_ID, "confluence", 1, documentationPage(55, 1, "candidate-cap-2001"))
        const beyondBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "relationship",
          relationshipId: inferred.relationshipId,
          revision: null
        })
        if (beyondBound._tag !== "relationship") {
          return yield* Effect.die("expected relationship beyond candidate bound")
        }
        assert.strictEqual(beyondBound.value.lifecycle._tag, "superseded")
      })),
    60_000
  )

  it.effect(
    "supersedes rule-owned inference only after a release slice exceeds its bound",
    () =>
      withMaterializer(Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* setup
        yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
        const synchronize = (
          pluginConnectionId: PluginConnectionId,
          providerId: "codecommit" | "jira",
          expectedRevision: number,
          page: typeof PluginSyncPageV1.Type
        ) =>
          materializeNormalizedPluginPage({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId,
            providerId,
            streamKey: firstPartyStream(providerId),
            expectedRevision,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          }, page)
        const documentationRelationships = (
          start: number,
          count: number,
          checkpointAfterPage: string,
          includeExistingNodeRelationship = false
        ) => {
          const existingNodeRelationships: ReadonlyArray<typeof NormalizedPluginEventV1.Encoded> =
            includeExistingNodeRelationship
              ? [{
                _tag: "ProposeRelationship",
                eventId: "release-slice-bound-existing-node-relationship",
                observedAt: "2026-07-19T09:02:50.000Z",
                revision: "1",
                relationshipId: "release-slice-bound-existing-node-relationship",
                from: { entityType: "release", vendorImmutableId: "jira-version:2026.29" },
                to: { entityType: "jira.issue", vendorImmutableId: "issue-42" },
                relationshipType: "depends-on",
                confidence: 1,
                evidenceIds: []
              }]
              : []
          return Schema.decodeSync(PluginSyncPageV1)({
            checkpointAfterPage,
            hasMore: false,
            events: [
              ...existingNodeRelationships,
              ...Array.from({ length: count }, (_, offset) => start + offset).flatMap(
                (index): ReadonlyArray<typeof NormalizedPluginEventV1.Encoded> => {
                  const pageId = `release-slice-bound-page-${String(index)}`
                  return [{
                    _tag: "UpsertEntity",
                    eventId: `release-slice-bound-page-${String(index)}`,
                    observedAt: "2026-07-19T09:02:40.000Z",
                    revision: "1",
                    entityType: "confluence-page",
                    vendorImmutableId: pageId,
                    sourceUrl: null,
                    title: `Release slice bound target ${String(index)}`,
                    attributes: { spaceKey: "PAY", currentVersion: 1, status: "current" }
                  }, {
                    _tag: "ProposeRelationship",
                    eventId: `release-slice-bound-relationship-${String(index)}`,
                    observedAt: "2026-07-19T09:02:50.000Z",
                    revision: "1",
                    relationshipId: `release-slice-bound-relationship-${String(index)}`,
                    from: { entityType: "release", vendorImmutableId: "jira-version:2026.29" },
                    to: { entityType: "confluence-page", vendorImmutableId: pageId },
                    relationshipType: "documented-by",
                    confidence: 1,
                    evidenceIds: []
                  }]
                }
              )
            ]
          })
        }

        yield* synchronize(PLUGIN_ID, "jira", 0, inferenceJiraReleasePage)
        yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 0, codeCommitRelationshipPage)
        const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
        if (release === undefined) return yield* Effect.die("expected synchronized release")
        const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "releaseSlice",
          releaseId: release.id,
          environmentId: null,
          limit: 100
        })
        if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
        const inferred = initialSlice.value.relationships.find(
          ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
        )
        if (inferred === undefined) return yield* Effect.die("expected inferred implementation relationship")

        yield* synchronize(PLUGIN_ID, "jira", 1, documentationRelationships(0, 248, "release-slice-bound-fill-1", true))
        yield* synchronize(PLUGIN_ID, "jira", 2, documentationRelationships(248, 248, "release-slice-bound-500"))
        const atBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "relationship",
          relationshipId: inferred.relationshipId,
          revision: null
        })
        if (atBound._tag !== "relationship") return yield* Effect.die("expected relationship at release slice bound")
        assert.strictEqual(atBound.value.lifecycle._tag, "inferred")

        yield* synchronize(PLUGIN_ID, "jira", 3, documentationRelationships(496, 1, "release-slice-bound-501"))
        const beyondBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "relationship",
          relationshipId: inferred.relationshipId,
          revision: null
        })
        if (beyondBound._tag !== "relationship") {
          return yield* Effect.die("expected relationship beyond release slice bound")
        }
        assert.strictEqual(beyondBound.value.lifecycle._tag, "superseded")
      })),
    30_000
  )

  it.effect("supersedes rule-owned inference only after the release snapshot exceeds its bound", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      const synchronize = (
        pluginConnectionId: PluginConnectionId,
        providerId: "codecommit" | "jira",
        expectedRevision: number,
        page: typeof PluginSyncPageV1.Type
      ) =>
        materializeNormalizedPluginPage({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId,
          providerId,
          streamKey: firstPartyStream(providerId),
          expectedRevision,
          committedAt: T3,
          successfulHealth: { _tag: "healthy", checkedAt: T3 }
        }, page)
      const releasePage = (start: number, count: number, checkpointAfterPage: string) =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage,
          hasMore: false,
          events: Array.from({ length: count }, (_, offset): typeof NormalizedPluginEventV1.Encoded => {
            const index = start + offset
            return {
              _tag: "UpsertEntity",
              eventId: `jira-release-bound-${String(index)}`,
              observedAt: "2026-07-19T09:02:40.000Z",
              revision: `candidate:release-${String(index)}`,
              entityType: "release",
              vendorImmutableId: `jira-version:release-${String(index)}`,
              sourceUrl: null,
              title: `Payments release ${String(index)}`,
              attributes: {
                serviceName: "Payments",
                version: `release-${String(index)}`,
                lifecycle: "candidate"
              }
            }
          })
        })

      yield* synchronize(PLUGIN_ID, "jira", 0, inferenceJiraReleasePage)
      yield* synchronize(CODECOMMIT_PLUGIN_ID, "codecommit", 0, codeCommitRelationshipPage)
      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))
        .find(({ release }) => release.version === "2026.29")?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      const inferred = initialSlice.value.relationships.find(
        ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
      )
      if (inferred === undefined) return yield* Effect.die("expected inferred implementation relationship")

      yield* synchronize(PLUGIN_ID, "jira", 1, releasePage(1, 49, "jira-release-bound-50"))
      const atBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationship",
        relationshipId: inferred.relationshipId,
        revision: null
      })
      if (atBound._tag !== "relationship") return yield* Effect.die("expected relationship at release bound")
      assert.strictEqual(atBound.value.lifecycle._tag, "inferred")

      yield* synchronize(PLUGIN_ID, "jira", 2, releasePage(50, 1, "jira-release-bound-51"))
      const beyondBound = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationship",
        relationshipId: inferred.relationshipId,
        revision: null
      })
      if (beyondBound._tag !== "relationship") return yield* Effect.die("expected relationship beyond release bound")
      assert.strictEqual(beyondBound.value.lifecycle._tag, "superseded")
    })))

  it.effect("keeps a missing implementation endpoint stable when the Jira issue key changes", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      const issueUpdate = (revision: string, key: string, title: string, checkpointAfterPage: string) =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage,
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId: `jira-issue-key-update-${revision}`,
            observedAt: "2026-07-19T09:02:00.000Z",
            revision,
            entityType: "jira.issue",
            vendorImmutableId: "issue-42",
            sourceUrl: "https://jira.example/browse/PAY-99",
            title,
            attributes: { key, status: { name: "Ready" } }
          }]
        })

      yield* materializeNormalizedPluginPage(scope, inferenceJiraReleasePage)
      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected synchronized release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      const missing = initialSlice.value.relationships.find(
        ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "missing"
      )
      if (missing === undefined) return yield* Effect.die("expected missing implementation relationship")

      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        issueUpdate("issue-revision-2", "PAY-99", "PAY-99 · Ship guarded refunds", "jira-issue-key-renamed")
      )
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        issueUpdate("issue-revision-3", "PAY-99", "PAY-99 · Ship guarded refunds safely", "jira-issue-title-updated")
      )

      const current = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationship",
        relationshipId: missing.relationshipId,
        revision: null
      })
      if (current._tag !== "relationship") return yield* Effect.die("expected stable missing relationship")
      assert.strictEqual(current.value.sourceNodeId, missing.sourceNodeId)
      assert.strictEqual(current.value.revision, missing.revision)
      assert.strictEqual(current.value.lifecycle._tag, "missing")
    })))

  it.effect("projects a normalized Jira fix version into the canonical release repository", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      const receipt = yield* materializeNormalizedPluginPage(scope, jiraReleasePage)
      assert.strictEqual(receipt.acceptedEventCount, 1)
      assert.strictEqual(receipt.entityProjectionCount, 0)
      assert.strictEqual(receipt.nodeCount, 1)
      assert.strictEqual((yield* items()).totalCount, 0)

      const releases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      assert.lengthOf(releases, 1)
      const initial = releases[0]
      if (initial === undefined) return yield* Effect.die("expected materialized release")
      assert.strictEqual(initial.release.serviceName, "Payments")
      assert.strictEqual(initial.release.version, "2026.29")
      assert.strictEqual(initial.release.lifecycle, "candidate")
      assert.deepStrictEqual(initial.release.roleAssignments, [])
      assert.deepStrictEqual(initial.release.targetEnvironmentIds, [])
      assert.strictEqual(initial.release.sourceRevisions[0]?.vendorImmutableId, "jira-version:2026.29")

      const replay = yield* materializeNormalizedPluginPage(scope, jiraReleasePage)
      assert.isFalse(replay.pageCommitted)
      assert.lengthOf(yield* persistence.releases.list(WORKSPACE_ID, 10), 1)

      const nonJiraSource = Schema.decodeSync(SourceRevision)({
        pluginConnectionId: OTHER_PLUGIN_ID,
        providerId: "confluence",
        vendorImmutableId: "release-page-2026-29",
        revision: "page-revision-7",
        sourceUrl: "https://wiki.example/releases/2026.29",
        firstObservedAt: "2026-07-19T09:01:00.000Z",
        lastObservedAt: "2026-07-19T09:01:00.000Z",
        synchronizedAt: "2026-07-19T09:02:00.000Z",
        normalizationSchemaVersion: 1
      })
      const enriched = Schema.decodeSync(Schema.toType(Release))({
        ...initial.release,
        roleAssignments: [{
          assignmentId: ASSIGNMENT_ID,
          actor: { _tag: "agent", agentId: AGENT_ID },
          role: "release-owner",
          scope: { _tag: "release", workspaceId: WORKSPACE_ID, releaseId: initial.release.id },
          lifecycle: { _tag: "active", assignedAt: T2 }
        }],
        sourceRevisions: [...initial.release.sourceRevisions, nonJiraSource],
        targetEnvironmentIds: [ENVIRONMENT_ID],
        updatedAt: T2
      })
      yield* persistence.releases.append(WORKSPACE_ID, enriched, initial.revision)

      yield* materializeNormalizedPluginPage({
        ...scope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, jiraReleaseUpdatePage)
      const updated = yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)
      assert.strictEqual(updated.release.serviceName, "Payments API")
      assert.strictEqual(updated.release.lifecycle, "released")
      assert.deepStrictEqual(updated.release.roleAssignments, enriched.roleAssignments)
      assert.deepStrictEqual(updated.release.targetEnvironmentIds, [ENVIRONMENT_ID])
      assert.deepStrictEqual(
        updated.release.sourceRevisions.filter(({ providerId }) => providerId !== "jira"),
        [nonJiraSource]
      )
      assert.strictEqual(
        updated.release.sourceRevisions.find(({ providerId }) => providerId === "jira")?.revision,
        "released:2026-07-29:2026.29"
      )
    })))

  it.effect("scopes a release-authored documentation proposal to its release slice", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const page = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "release-authored-documentation",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "release-authored-documentation-release",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "candidate:2026.31",
          entityType: "release",
          vendorImmutableId: "jira-version:2026.31",
          sourceUrl: null,
          title: "Payments candidate",
          attributes: { serviceName: "Payments", version: "2026.31", lifecycle: "candidate" }
        }, {
          _tag: "UpsertEntity",
          eventId: "release-authored-documentation-page",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "1",
          entityType: "confluence-page",
          vendorImmutableId: "release-notes",
          sourceUrl: null,
          title: "Payments release notes",
          attributes: { spaceKey: "PAY", currentVersion: 1, status: "current" }
        }, {
          _tag: "ProposeRelationship",
          eventId: "release-authored-documentation-link",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "1",
          relationshipId: "jira-version:2026.31:documented-by:release-notes",
          from: { entityType: "release", vendorImmutableId: "jira-version:2026.31" },
          to: { entityType: "confluence-page", vendorImmutableId: "release-notes" },
          relationshipType: "documented-by",
          confidence: 1,
          evidenceIds: []
        }]
      })

      yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, page)

      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected release")
      const slice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      const relationship = slice.value.relationships.find(
        ({ kind, lifecycle, provenance }) =>
          kind === "documented-by" && lifecycle._tag === "proposed" && provenance._tag === "plugin"
      )
      assert.deepStrictEqual(relationship?.scope, { _tag: "release", releaseId: release.id })
    })))

  it.effect("refreshes a repeated Jira release observation while exact page replay stays a no-op", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const initialScope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      yield* materializeNormalizedPluginPage(initialScope, jiraReleasePage)
      const initial = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]
      if (initial === undefined) return yield* Effect.die("expected materialized release")

      const repeatedScope: NormalizedPluginPageMaterializationScope = {
        ...initialScope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }
      const repeated = yield* materializeNormalizedPluginPage(
        repeatedScope,
        jiraReleaseRepeatedObservationPage
      )
      assert.isTrue(repeated.pageCommitted)
      assert.strictEqual(repeated.acceptedEventCount, 1)

      const refreshed = yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)
      assert.strictEqual(refreshed.revision, initial.revision + 1)
      const jiraSource = refreshed.release.sourceRevisions.find(({ providerId }) => providerId === "jira")
      if (jiraSource === undefined) return yield* Effect.die("expected Jira release source")
      assert.strictEqual(jiraSource.revision, "candidate:2026-07-29:2026.29")
      assert.strictEqual(DateTime.formatIso(jiraSource.firstObservedAt), "2026-07-19T09:01:30.000Z")
      assert.strictEqual(DateTime.formatIso(jiraSource.lastObservedAt), "2026-07-19T09:02:30.000Z")
      assert.strictEqual(DateTime.formatIso(jiraSource.synchronizedAt), "2026-07-19T09:03:00.000Z")
      assert.strictEqual(refreshed.release.freshness._tag, "current")
      if (refreshed.release.freshness._tag !== "current") {
        return yield* Effect.die("expected current release freshness")
      }
      assert.strictEqual(
        DateTime.formatIso(refreshed.release.freshness.sourceObservedAt),
        "2026-07-19T09:02:30.000Z"
      )
      assert.strictEqual(
        DateTime.formatIso(refreshed.release.freshness.synchronizedAt),
        "2026-07-19T09:03:00.000Z"
      )

      const replay = yield* materializeNormalizedPluginPage(
        repeatedScope,
        jiraReleaseRepeatedObservationPage
      )
      assert.isFalse(replay.pageCommitted)
      assert.strictEqual(replay.acceptedEventCount, 0)
      assert.strictEqual(
        (yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)).revision,
        refreshed.revision
      )
    })))

  it.effect("materializes Jira fix versions into the release workset only for linked issues", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const common = {
        comments: { values: [], total: 0, truncated: false },
        changelogs: { values: [], total: 0, truncated: false },
        observedAt: T1,
        webBaseUrl: new URL("https://jira.example")
      }
      const linkedEvents = yield* normalizeJiraIssueEvents({
        ...common,
        issue: {
          id: "10042",
          key: "PAY-42",
          fields: {
            summary: "Ship guarded refunds",
            updated: "2026-07-19T09:01:00.000Z",
            project: { id: "10000", key: "PAY", name: "Payments" },
            fixVersions: [{ id: "2026.29", name: "2026.29", released: false }]
          }
        }
      })
      const unlinkedEvents = yield* normalizeJiraIssueEvents({
        ...common,
        issue: {
          id: "10043",
          key: "PAY-43",
          fields: {
            summary: "Keep investigating retries",
            updated: "2026-07-19T09:01:00.000Z",
            project: { id: "10000", key: "PAY", name: "Payments" }
          }
        }
      })
      const page = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-workset"),
        hasMore: false,
        events: [...linkedEvents, ...unlinkedEvents]
      })

      const receipt = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, page)
      assert.strictEqual(receipt.relationshipCount, 2)
      assert.strictEqual((yield* items()).totalCount, 2)

      const releases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      const release = releases[0]
      if (release === undefined) return yield* Effect.die("expected fix-version release")
      const result = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.release.id,
        environmentId: null,
        limit: 100
      })
      if (result._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      assert.deepStrictEqual(
        result.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-42"]
      )
      assert.lengthOf(result.value.relationships, 2)
      const containment = result.value.relationships.find(({ kind }) => kind === "contains")
      assert.deepStrictEqual(containment?.scope, {
        _tag: "release",
        releaseId: release.release.id
      })
    })))

  it.effect("reconciles one Jira issue without decoding unrelated stream cache entries", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      const persistence = yield* Persistence
      yield* setup
      const unrelatedPage = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "jira-unrelated-cache",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "jira-unrelated-cache-event",
          observedAt: DateTime.formatIso(T1),
          revision: "unrelated-revision",
          entityType: "jira.issue",
          vendorImmutableId: "unrelated-issue",
          sourceUrl: null,
          title: "Unrelated cached issue",
          attributes: { key: "OTHER-1", fixVersions: [], truncatedFields: [] }
        }]
      })
      yield* persistence.pluginRuntime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        MATERIALIZED_STREAM,
        0,
        unrelatedPage,
        T1,
        { _tag: "healthy", checkedAt: T1 }
      )
      yield* database.sql`UPDATE plugin_cache_entries SET payload_json = '{}'
        WHERE workspace_id = ${WORKSPACE_ID}
          AND plugin_connection_id = ${PLUGIN_ID}
          AND stream_key = ${MATERIALIZED_STREAM}`

      const events = yield* normalizeJiraIssueEvents({
        comments: { values: [], total: 0, truncated: false },
        changelogs: { values: [], total: 0, truncated: false },
        observedAt: T2,
        webBaseUrl: new URL("https://jira.example"),
        issue: {
          id: "10042",
          key: "PAY-42",
          fields: {
            summary: "Reconcile only this issue",
            updated: DateTime.formatIso(T2),
            project: { id: "10000", key: "PAY", name: "Payments" },
            fixVersions: []
          }
        }
      })
      const receipt = yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 1,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        },
        Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
          checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-targeted-reconciliation"),
          hasMore: false,
          events
        })
      )

      assert.isTrue(receipt.pageCommitted)
      assert.deepStrictEqual((yield* items()).items.map(({ projection }) => projection.displayKey), ["PAY-42"])
    })))

  it.effect(
    "fails closed when authoritative Jira containment reconciliation exceeds its neighborhood bound",
    () =>
      withMaterializer(Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* setup
        const normalizeIssue = (fixVersions: ReadonlyArray<{ readonly id: string; readonly name: string }>) =>
          normalizeJiraIssueEvents({
            comments: { values: [], total: 0, truncated: false },
            changelogs: { values: [], total: 0, truncated: false },
            observedAt: fixVersions.length === 0 ? T3 : T1,
            webBaseUrl: new URL("https://jira.example"),
            issue: {
              id: "10042",
              key: "PAY-42",
              fields: {
                summary: "Bound containment reconciliation",
                updated: DateTime.formatIso(fixVersions.length === 0 ? T3 : T1),
                project: { id: "10000", key: "PAY", name: "Payments" },
                fixVersions
              }
            }
          })
        const initialEvents = yield* normalizeIssue([{ id: "2026.29", name: "2026.29" }])
        const scope: NormalizedPluginPageMaterializationScope = {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        }
        yield* materializeNormalizedPluginPage(
          scope,
          Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
            checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-containment-bound-initial"),
            hasMore: false,
            events: initialEvents
          })
        )

        const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
        if (release === undefined) return yield* Effect.die("expected release")
        const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "releaseSlice",
          releaseId: release.id,
          environmentId: null,
          limit: 100
        })
        if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
        const containment = initialSlice.value.relationships.find(({ kind }) => kind === "contains")
        if (containment === undefined) return yield* Effect.die("expected containment")

        const boundedEvents = (start: number): ReadonlyArray<typeof NormalizedPluginEventV1.Encoded> =>
          Array.from({ length: 250 }, (_, offset) => start + offset).flatMap(
            (index): ReadonlyArray<typeof NormalizedPluginEventV1.Encoded> => {
              const pageId = `bounded-page-${String(index)}`
              return [{
                _tag: "UpsertEntity",
                eventId: `jira-containment-bound-page-${String(index)}`,
                observedAt: DateTime.formatIso(T3),
                revision: "1",
                entityType: "confluence-page",
                vendorImmutableId: pageId,
                sourceUrl: null,
                title: `Bounded relationship target ${String(index)}`,
                attributes: { spaceKey: "PAY", currentVersion: 1, status: "current" }
              }, {
                _tag: "ProposeRelationship",
                eventId: `jira-containment-bound-relationship-${String(index)}`,
                observedAt: DateTime.formatIso(T3),
                revision: "1",
                relationshipId: `jira-containment-bound-relationship-${String(index)}`,
                from: { entityType: "jira.issue", vendorImmutableId: "10042" },
                to: { entityType: "confluence-page", vendorImmutableId: pageId },
                relationshipType: "documented-by",
                confidence: 1,
                evidenceIds: []
              }]
            }
          )
        const boundedPage = (start: number, checkpointAfterPage: string) =>
          Schema.decodeSync(PluginSyncPageV1)({
            checkpointAfterPage,
            hasMore: false,
            events: boundedEvents(start)
          })
        yield* materializeNormalizedPluginPage(
          {
            ...scope,
            expectedRevision: 1,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          },
          boundedPage(0, "jira-containment-bound-fill-1")
        )
        yield* materializeNormalizedPluginPage(
          {
            ...scope,
            expectedRevision: 2,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          },
          boundedPage(250, "jira-containment-bound-fill-2")
        )

        const failure = yield* materializeNormalizedPluginPage(
          {
            ...scope,
            expectedRevision: 3,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          },
          Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
            checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)(
              "jira-containment-bound-authoritative-removal"
            ),
            hasMore: false,
            events: yield* normalizeIssue([])
          })
        ).pipe(Effect.flip)
        if (failure._tag !== "NormalizedPluginPageMaterializationError") {
          return yield* Effect.die("expected bounded materialization failure")
        }
        assert.strictEqual(failure.diagnosticCode, "normalized-jira-containment-neighborhood-truncated")
        const history = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "relationshipHistory",
          relationshipId: containment.relationshipId,
          limit: 10
        })
        if (history._tag !== "relationshipHistory") return yield* Effect.die("expected containment history")
        assert.strictEqual(history.value[0]?.lifecycle._tag, "proposed")
      })),
    { timeout: 30_000 }
  )

  it.effect("retires a Jira release containment when an issue moves to another fix version", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const normalizeIssue = (input: {
        readonly id: string
        readonly key: string
        readonly summary: string
        readonly updated: string
        readonly versionId: string
      }) =>
        normalizeJiraIssueEvents({
          comments: { values: [], total: 0, truncated: false },
          changelogs: { values: [], total: 0, truncated: false },
          observedAt: input.updated === "2026-07-19T09:01:00.000Z" ? T1 : T2,
          webBaseUrl: new URL("https://jira.example"),
          issue: {
            id: input.id,
            key: input.key,
            fields: {
              summary: input.summary,
              updated: input.updated,
              project: { id: "10000", key: "PAY", name: "Payments" },
              fixVersions: [{ id: input.versionId, name: input.versionId, released: false }]
            }
          }
        })
      const issueA = yield* normalizeIssue({
        id: "10042",
        key: "PAY-42",
        summary: "Ship guarded refunds",
        updated: "2026-07-19T09:01:00.000Z",
        versionId: "2026.29"
      })
      const issueB = yield* normalizeIssue({
        id: "10043",
        key: "PAY-43",
        summary: "Ship retry telemetry",
        updated: "2026-07-19T09:01:00.000Z",
        versionId: "2026.29"
      })
      const initialPage = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-initial-membership"),
        hasMore: false,
        events: [...issueA, ...issueB]
      })
      const initialScope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(initialScope, initialPage)

      const initialReleases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      const oldRelease = initialReleases.find(({ release }) => release.version === "2026.29")
      if (oldRelease === undefined) return yield* Effect.die("expected original Jira release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: oldRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      assert.deepStrictEqual(
        initialSlice.value.entityProjections.map(({ projection }) => projection.displayKey).sort(),
        ["PAY-42", "PAY-43"]
      )
      const issueBProjection = initialSlice.value.entityProjections.find(
        ({ projection }) => projection.displayKey === "PAY-43"
      )
      if (issueBProjection === undefined) return yield* Effect.die("expected PAY-43 projection")
      const issueBNode = initialSlice.value.nodes.find((node) =>
        node.resolution._tag === "resolved" &&
        node.resolution.target._tag === "entity" &&
        node.resolution.target.entityId === issueBProjection.projection.entityId
      )
      if (issueBNode === undefined) return yield* Effect.die("expected PAY-43 delivery node")
      const oldContainment = initialSlice.value.relationships.find(
        ({ kind, targetNodeId }) => kind === "contains" && targetNodeId === issueBNode.nodeId
      )
      if (oldContainment === undefined) return yield* Effect.die("expected PAY-43 release containment")

      const movedIssueB = yield* normalizeIssue({
        id: "10043",
        key: "PAY-43",
        summary: "Ship retry telemetry",
        updated: "2026-07-19T09:02:00.000Z",
        versionId: "2026.30"
      })
      const movedPage = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-moved-membership"),
        hasMore: false,
        events: movedIssueB
      })
      yield* materializeNormalizedPluginPage({
        ...initialScope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, movedPage)

      const oldSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: oldRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (oldSlice._tag !== "releaseSlice") return yield* Effect.die("expected updated old release slice")
      assert.deepStrictEqual(
        oldSlice.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-42"]
      )
      assert.lengthOf(oldSlice.value.relationships, 2)
      assert.lengthOf(oldSlice.value.relationships.filter(({ kind }) => kind === "contains"), 1)
      const history = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: oldContainment.relationshipId,
        limit: 10
      })
      if (history._tag !== "relationshipHistory") return yield* Effect.die("expected containment history")
      assert.lengthOf(history.value, 2)
      assert.strictEqual(history.value[0]?.lifecycle._tag, "superseded")

      const newRelease = (yield* persistence.releases.list(WORKSPACE_ID, 10))
        .find(({ release }) => release.version === "2026.30")
      if (newRelease === undefined) return yield* Effect.die("expected destination Jira release")
      const newSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: newRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (newSlice._tag !== "releaseSlice") return yield* Effect.die("expected destination release slice")
      assert.deepStrictEqual(
        newSlice.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-43"]
      )
    })))

  it.effect("preserves capped Jira memberships until a complete fix-version snapshot removes them", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const version = (id: string) => ({ id, name: id, released: false })
      const normalize = (updated: string, fixVersions: ReadonlyArray<ReturnType<typeof version>>) =>
        normalizeJiraIssueEvents({
          comments: { values: [], total: 0, truncated: false },
          changelogs: { values: [], total: 0, truncated: false },
          observedAt: Schema.decodeSync(UtcTimestamp)(updated),
          webBaseUrl: new URL("https://jira.example"),
          issue: {
            id: "10099",
            key: "PAY-99",
            fields: {
              summary: "Keep every Jira release membership",
              updated,
              project: { id: "10000", key: "PAY", name: "Payments" },
              fixVersions
            }
          }
        })
      const page = (checkpoint: string, events: ReadonlyArray<NormalizedPluginEventV1>) =>
        Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
          checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)(checkpoint),
          hasMore: false,
          events
        })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T1,
        successfulHealth: { _tag: "healthy", checkedAt: T1 }
      }

      yield* materializeNormalizedPluginPage(
        scope,
        page("jira-fix-version-cap-initial", yield* normalize(DateTime.formatIso(T1), [version("protected")]))
      )
      const protectedRelease = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]
      if (protectedRelease === undefined) return yield* Effect.die("expected protected Jira release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: protectedRelease.release.id,
        environmentId: null,
        limit: 10
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected protected release slice")
      const protectedRelationship = initialSlice.value.relationships[0]
      if (protectedRelationship === undefined) return yield* Effect.die("expected protected membership")

      const retainedVersions = [
        ...Array.from({ length: 99 }, (_, index) => version(`candidate-${String(index)}`)),
        version("protected")
      ]
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T2, successfulHealth: { _tag: "healthy", checkedAt: T2 } },
        page("jira-fix-version-cap-bounded", yield* normalize(DateTime.formatIso(T2), retainedVersions))
      )
      const retainedHistory = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: protectedRelationship.relationshipId,
        limit: 10
      })
      if (retainedHistory._tag !== "relationshipHistory") return yield* Effect.die("expected retained history")
      assert.lengthOf(retainedHistory.value, 1)
      assert.strictEqual(retainedHistory.value[0]?.lifecycle._tag, "proposed")

      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        page("jira-fix-version-cap-complete", yield* normalize(DateTime.formatIso(T3), retainedVersions.slice(0, 99)))
      )
      const removedHistory = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: protectedRelationship.relationshipId,
        limit: 10
      })
      if (removedHistory._tag !== "relationshipHistory") return yield* Effect.die("expected removed history")
      assert.lengthOf(removedHistory.value, 2)
      assert.strictEqual(removedHistory.value[0]?.lifecycle._tag, "superseded")
    })))

  it.effect("backfills a legacy release node before materializing a release containment endpoint", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      const persistence = yield* Persistence
      yield* setup
      const encoded = Schema.encodeSync(PluginSyncPageV1)(inferenceJiraReleasePage)
      const releaseOnly = Schema.decodeSync(PluginSyncPageV1)({
        ...encoded,
        checkpointAfterPage: "legacy-release-only",
        events: encoded.events.filter((event) => event._tag === "UpsertEntity" && event.entityType === "release")
      })
      const containmentOnly = Schema.decodeSync(PluginSyncPageV1)({
        ...encoded,
        checkpointAfterPage: "legacy-release-containment",
        events: encoded.events.filter((event) => !(event._tag === "UpsertEntity" && event.entityType === "release"))
      })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      yield* materializeNormalizedPluginPage(scope, releaseOnly)
      yield* database.sql`DROP TRIGGER delivery_nodes_no_delete`
      yield* database.sql`DELETE FROM delivery_nodes WHERE workspace_id = ${WORKSPACE_ID} AND release_id IS NOT NULL`

      const receipt = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        containmentOnly
      )
      assert.strictEqual(receipt.nodeCount, 3)
      assert.strictEqual(receipt.relationshipCount, 2)
      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected legacy release")
      const slice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      assert.isTrue(
        slice.value.nodes.some(
          ({ endpointKind, resolution }) =>
            endpointKind === "release" &&
            resolution._tag === "resolved" &&
            resolution.target._tag === "release" &&
            resolution.target.releaseId === release.id
        )
      )
    })))

  it.effect("supersedes rule-owned relationships after every endpoint is tombstoned", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const initial = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "tombstone-all-initial",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "tombstone-all-release",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "candidate:2026.30",
          entityType: "release",
          vendorImmutableId: "jira-version:2026.30",
          sourceUrl: null,
          title: "Payments · 2026.30",
          attributes: { serviceName: "Payments", version: "2026.30", lifecycle: "candidate" }
        }, {
          _tag: "UpsertEntity",
          eventId: "tombstone-all-issue",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "issue-1",
          entityType: "jira.issue",
          vendorImmutableId: "tombstone-issue",
          sourceUrl: null,
          title: "PAY-99 · Remove obsolete path",
          attributes: { key: "PAY-99", status: { name: "Ready" } }
        }, {
          _tag: "UpsertEntity",
          eventId: "tombstone-all-pr",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "pr-1",
          entityType: "pull-request",
          vendorImmutableId: "tombstone-pr",
          sourceUrl: null,
          title: "PAY-99 remove obsolete path",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/PAY-99",
            targetBranch: "main",
            headRevision: "deadbeef",
            reviewState: "requested"
          }
        }, {
          _tag: "ProposeRelationship",
          eventId: "tombstone-all-containment",
          observedAt: "2026-07-19T09:01:00.000Z",
          revision: "containment-1",
          relationshipId: "jira-version:2026.30:contains:tombstone-issue",
          from: { entityType: "release", vendorImmutableId: "jira-version:2026.30" },
          to: { entityType: "jira.issue", vendorImmutableId: "tombstone-issue" },
          relationshipType: "contains",
          confidence: 1,
          evidenceIds: []
        }]
      })
      const deleted = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "tombstone-all-deleted",
        hasMore: false,
        events: [{
          _tag: "TombstoneEntity",
          eventId: "tombstone-all-issue-deleted",
          observedAt: "2026-07-19T09:03:00.000Z",
          revision: "issue-2",
          entityType: "jira.issue",
          vendorImmutableId: "tombstone-issue",
          reason: "Deleted upstream"
        }, {
          _tag: "TombstoneEntity",
          eventId: "tombstone-all-pr-deleted",
          observedAt: "2026-07-19T09:03:00.000Z",
          revision: "pr-2",
          entityType: "pull-request",
          vendorImmutableId: "tombstone-pr",
          reason: "Deleted upstream"
        }]
      })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: firstPartyStream("jira"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(scope, initial)

      const release = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]?.release
      if (release === undefined) return yield* Effect.die("expected release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      const inferred = initialSlice.value.relationships.find(
        ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
      )
      if (inferred === undefined) return yield* Effect.die("expected inferred implementation")
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        deleted
      )

      const slice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.id,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      assert.isFalse(
        slice.value.relationships.some(
          ({ kind, lifecycle }) => kind === "implements" && lifecycle._tag === "inferred"
        )
      )
      const history = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: inferred.relationshipId,
        limit: 10
      })
      if (history._tag !== "relationshipHistory") return yield* Effect.die("expected implementation history")
      assert.strictEqual(history.value[0]?.lifecycle._tag, "superseded")
    })))

  it.effect("atomically applies all five operations and makes replay a canonical no-op", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      const persistence = yield* Persistence
      yield* setup

      yield* persistence.pluginRuntime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        CACHE_STREAM,
        0,
        cacheOnlyPage,
        T1,
        { _tag: "healthy", checkedAt: T1 }
      )
      const cacheOnlyItems = yield* items()
      assert.strictEqual(cacheOnlyItems.totalCount, 0)

      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      const first = yield* materializeNormalizedPluginPage(scope, materializedPage)
      assert.deepStrictEqual(first, {
        pageCommitted: true,
        acceptedEventCount: 5,
        entityProjectionCount: 2,
        evidenceClaimCount: 1,
        evidenceItemCount: 1,
        nodeCount: 2,
        personCount: 1,
        relationshipCount: 1,
        skippedEntityCount: 0
      })
      const currentItems = yield* items()
      assert.strictEqual(currentItems.totalCount, 2)
      assert.deepStrictEqual(
        currentItems.items.map(({ projection }) => [projection.entityType, projection.displayKey]),
        [["pull-request", "17"], ["issue", "PAY-42"]]
      )
      const pullRequest = currentItems.items.find(({ projection }) => projection.entityType === "pull-request")
        ?.projection.details
      if (pullRequest?._tag !== "pull-request") return yield* Effect.die("expected pull-request details")
      assert.deepStrictEqual(pullRequest, {
        _tag: "pull-request",
        repository: "payments-api",
        sourceBranch: "feat/guard-refunds",
        targetBranch: "main",
        headRevision: "abc123",
        reviewState: "requested",
        lifecycle: "open",
        description: "Guard every refund write.",
        authorReference: "arn:aws:sts::123456789012:assumed-role/Developer/ada",
        baseRevision: "base456",
        mergeBaseRevision: "merge789",
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-19T09:01:30.000Z"
      })
      assert.strictEqual(
        (yield* persistence.people.findPersonBySourceIdentity(WORKSPACE_ID, {
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorPersonId: VendorImmutableId.make("ada")
        })).person.displayName,
        "Ada Lovelace"
      )

      const eventReplay = yield* materializeNormalizedPluginPage({
        ...scope,
        expectedRevision: 1
      }, repeatedEntityEventPage)
      assert.deepStrictEqual(eventReplay, {
        pageCommitted: true,
        acceptedEventCount: 0,
        entityProjectionCount: 0,
        evidenceClaimCount: 0,
        evidenceItemCount: 0,
        nodeCount: 0,
        personCount: 0,
        relationshipCount: 0,
        skippedEntityCount: 0
      })

      const deletedScope: NormalizedPluginPageMaterializationScope = {
        ...scope,
        expectedRevision: 2,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }
      const deleted = yield* materializeNormalizedPluginPage(deletedScope, tombstonePage)
      assert.strictEqual(deleted.entityProjectionCount, 1)
      const remainingItems = yield* items()
      assert.strictEqual(remainingItems.totalCount, 1)

      const beforeReplay = yield* database.sql<Record<string, unknown>>`SELECT
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections,
        (SELECT COUNT(*) FROM persons) AS people,
        (SELECT COUNT(*) FROM evidence_items) AS evidence,
        (SELECT COUNT(*) FROM evidence_claims) AS claims,
        (SELECT COUNT(*) FROM relationship_revisions) AS relationships`
      assert.deepStrictEqual(beforeReplay, [{
        entities: 2,
        projections: 3,
        people: 1,
        evidence: 1,
        claims: 1,
        relationships: 1
      }])
      const replay = yield* materializeNormalizedPluginPage(deletedScope, tombstonePage)
      assert.deepStrictEqual(replay, {
        pageCommitted: false,
        acceptedEventCount: 0,
        entityProjectionCount: 0,
        evidenceClaimCount: 0,
        evidenceItemCount: 0,
        nodeCount: 0,
        personCount: 0,
        relationshipCount: 0,
        skippedEntityCount: 0
      })
      const afterReplay = yield* database.sql<Record<string, unknown>>`SELECT
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections,
        (SELECT COUNT(*) FROM persons) AS people,
        (SELECT COUNT(*) FROM evidence_items) AS evidence,
        (SELECT COUNT(*) FROM evidence_claims) AS claims,
        (SELECT COUNT(*) FROM relationship_revisions) AS relationships`
      assert.deepStrictEqual(afterReplay, beforeReplay)
    })))

  it.effect("normalizes provider PR metadata and filters lifecycle separately from review judgment", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      const page = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "pull-request-states-complete",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "pull-request-closed-1",
          observedAt: "2026-07-19T09:01:30.000Z",
          revision: "pull-request-closed-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "17",
          sourceUrl: "https://console.aws.example/pull-requests/closed-17",
          title: "Payment cleanup",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/closed",
            targetBranch: "main",
            headRevision: "closed-head",
            description: "x".repeat(50_001),
            authorArn: "   ",
            baseRevision: "b".repeat(513),
            mergeBase: "   ",
            status: "CLOSED"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pull-request-changes-requested-1",
          observedAt: "2026-07-19T09:01:40.000Z",
          revision: "pull-request-changes-requested-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "18",
          sourceUrl: "https://console.aws.example/pull-requests/open-18",
          title: "Open pull request needing changes",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/open",
            targetBranch: "main",
            headRevision: "open-head",
            status: "OPEN",
            reviewState: "changes-requested"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pull-request-review-requested-1",
          observedAt: "2026-07-19T09:01:50.000Z",
          revision: "pull-request-review-requested-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "19",
          sourceUrl: "https://console.aws.example/pull-requests/19",
          title: "Payment verification",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/verification",
            targetBranch: "main",
            headRevision: "verification-head",
            reviewState: "requested"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pull-request-codecommit-open-1",
          observedAt: "2026-07-19T09:01:55.000Z",
          revision: "pull-request-codecommit-open-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "20",
          sourceUrl: "https://console.aws.example/pull-requests/20",
          title: "Production-shaped CodeCommit pull request",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/production-shape",
            targetBranch: "main",
            headRevision: "production-head",
            status: "OPEN"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pull-request-legacy-approved-1",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "pull-request-legacy-approved-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "21",
          sourceUrl: "https://console.aws.example/pull-requests/21",
          title: "Legacy approved pull request",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/legacy-approved",
            targetBranch: "main",
            headRevision: "legacy-approved-head",
            status: "approved"
          }
        }, {
          _tag: "UpsertEntity",
          eventId: "pull-request-codecommit-merged-1",
          observedAt: "2026-07-19T09:02:00.000Z",
          revision: "pull-request-codecommit-merged-revision-1",
          entityType: "pull-request",
          vendorImmutableId: "22",
          sourceUrl: "https://console.aws.example/pull-requests/22",
          title: "CodeCommit merged pull request",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/merged",
            targetBranch: "main",
            headRevision: "merged-head",
            status: "MERGED"
          }
        }]
      })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: Schema.decodeSync(PluginStreamKey)("pull-request-states"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      const receipt = yield* materializeNormalizedPluginPage(scope, page)
      assert.strictEqual(receipt.entityProjectionCount, 6)

      const readStatus = (status: "active" | "done" | "failed") =>
        persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: "codecommit",
          status,
          type: "pull-request",
          limit: 100
        })
      const done = yield* readStatus("done")
      const active = yield* readStatus("active")
      const failed = yield* readStatus("failed")
      if (
        done._tag !== "workspaceEntityProjections" ||
        active._tag !== "workspaceEntityProjections" ||
        failed._tag !== "workspaceEntityProjections"
      ) return yield* Effect.die("expected workspace entity projections")

      assert.deepStrictEqual(done.value.items.map(({ projection }) => projection.displayKey).sort(), ["17", "21", "22"])
      assert.deepStrictEqual(active.value.items.map(({ projection }) => projection.displayKey), ["19", "20"])
      assert.deepStrictEqual(failed.value.items.map(({ projection }) => projection.displayKey), ["18"])
      const openDetails = active.value.items.find(({ projection }) => projection.displayKey === "20")?.projection
        .details
      if (openDetails?._tag !== "pull-request") return yield* Effect.die("expected open pull-request details")
      assert.strictEqual(openDetails.lifecycle, "open")
      assert.strictEqual(openDetails.reviewState, "not-requested")
      const requestedDetails = active.value.items.find(({ projection }) => projection.displayKey === "19")
        ?.projection.details
      if (requestedDetails?._tag !== "pull-request") {
        return yield* Effect.die("expected review-requested pull-request details")
      }
      assert.strictEqual(requestedDetails.reviewState, "requested")
      const approvedDetails = done.value.items.find(({ projection }) => projection.displayKey === "21")
        ?.projection.details
      if (approvedDetails?._tag !== "pull-request") {
        return yield* Effect.die("expected legacy approved pull-request details")
      }
      assert.strictEqual(approvedDetails.reviewState, "approved")
      const mergedDetails = done.value.items.find(({ projection }) => projection.displayKey === "22")
        ?.projection.details
      if (mergedDetails?._tag !== "pull-request") {
        return yield* Effect.die("expected CodeCommit merged pull-request details")
      }
      assert.strictEqual(mergedDetails.lifecycle, "merged")
      assert.strictEqual(mergedDetails.reviewState, "not-requested")
      const details = done.value.items[0]?.projection.details
      if (details?._tag !== "pull-request") return yield* Effect.die("expected pull-request details")
      assert.lengthOf(details.description ?? "", 50_000)
      assert.lengthOf(details.baseRevision ?? "", 512)
      assert.isNull(details.authorReference)
      assert.isNull(details.mergeBaseRevision)

      const readSearch = (query: string) =>
        persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query,
          service: "codecommit",
          status: null,
          type: "pull-request",
          limit: 100
        })
      const lifecycleSearch = yield* readSearch("closed")
      const reviewSearch = yield* readSearch("review requested")
      if (
        lifecycleSearch._tag !== "workspaceEntityProjections" ||
        reviewSearch._tag !== "workspaceEntityProjections"
      ) return yield* Effect.die("expected searchable workspace entity projections")
      assert.deepStrictEqual(lifecycleSearch.value.items.map(({ projection }) => projection.displayKey), ["17"])
      assert.deepStrictEqual(reviewSearch.value.items.map(({ projection }) => projection.displayKey), ["19"])
    })))

  it.effect("backfills the current pull-request projection when its schema version is stale", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      const entityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000254")
      const sourceRevision = Schema.decodeSync(SourceRevision)({
        providerId: "codecommit",
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        vendorImmutableId: "20",
        revision: "pull-request-20-revision-1",
        sourceUrl: null,
        firstObservedAt: "2026-07-19T09:01:00.000Z",
        lastObservedAt: "2026-07-19T09:01:00.000Z",
        synchronizedAt: "2026-07-19T09:01:00.000Z",
        normalizationSchemaVersion: 1
      })
      yield* persistence.entities.create(WORKSPACE_ID, {
        entityId,
        entityType: "pull-request",
        sourceRevision,
        createdAt: T1
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [{
          projection: {
            workspaceId: WORKSPACE_ID,
            entityId,
            projectionRevision: 1,
            sourceEntityRevision: 1,
            supersedesProjectionRevision: null,
            projectionSchemaVersion: 1,
            entityState: "present",
            entityType: "pull-request",
            displayKey: "20",
            title: "Protect payment retries",
            details: {
              _tag: "pull-request",
              repository: "payments-api",
              sourceBranch: "feat/retries",
              targetBranch: "main",
              headRevision: "head-20",
              reviewState: "requested"
            }
          },
          recordedAt: "2026-07-19T09:01:00.000Z"
        }],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: []
      })
      const page = (
        eventId: string,
        checkpointAfterPage: string,
        sourceUrl: string | null,
        revision = "pull-request-20-revision-1"
      ) =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage,
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId,
            observedAt: "2026-07-19T09:01:30.000Z",
            revision,
            entityType: "pull-request",
            vendorImmutableId: "20",
            sourceUrl,
            title: "Protect payment retries",
            attributes: {
              repository: "payments-api",
              sourceBranch: "feat/retries",
              targetBranch: "main",
              headRevision: "head-20",
              baseRevision: "base-20",
              mergeBase: "merge-base-20",
              description: "Keep retry writes idempotent.",
              authorArn: "arn:aws:iam::123456789012:user/ada",
              creationDate: "2026-07-18T08:00:00.000Z",
              lastActivityDate: "2026-07-19T09:01:30.000Z",
              status: "OPEN",
              reviewState: "requested"
            }
          }]
        })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: Schema.decodeSync(PluginStreamKey)("pull-request-schema-backfill"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      const backfill = yield* materializeNormalizedPluginPage(
        scope,
        page("pull-request-20-backfill", "backfilled", null)
      )
      assert.strictEqual(backfill.entityProjectionCount, 1)
      const projection = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId,
        revision: null
      })
      if (projection._tag !== "entityProjection") return yield* Effect.die("expected backfilled projection")
      assert.strictEqual(projection.value.projection.projectionRevision, 2)
      assert.strictEqual(projection.value.projection.projectionSchemaVersion, 2)
      const details = projection.value.projection.details
      if (details._tag !== "pull-request") return yield* Effect.die("expected pull-request details")
      assert.strictEqual(details.baseRevision, "base-20")
      assert.strictEqual(details.description, "Keep retry writes idempotent.")
      const refreshedEntity = yield* persistence.entities.get(WORKSPACE_ID, entityId)
      assert.isNull(refreshedEntity.sourceRevision.sourceUrl)
      assert.strictEqual(
        DateTime.formatIso(refreshedEntity.sourceRevision.lastObservedAt),
        "2026-07-19T09:01:30.000Z"
      )
      assert.strictEqual(DateTime.formatIso(refreshedEntity.sourceRevision.synchronizedAt), DateTime.formatIso(T2))

      const current = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3 },
        page(
          "pull-request-20-current",
          "already-current",
          "https://console.aws.example/pull-requests/20"
        )
      )
      assert.strictEqual(current.entityProjectionCount, 1)
      const metadataRefreshed = yield* persistence.entities.get(WORKSPACE_ID, entityId)
      assert.strictEqual(
        metadataRefreshed.sourceRevision.sourceUrl?.href,
        "https://console.aws.example/pull-requests/20"
      )
      assert.strictEqual(DateTime.formatIso(metadataRefreshed.sourceRevision.synchronizedAt), DateTime.formatIso(T3))
      const unchanged = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId,
        revision: null
      })
      if (unchanged._tag !== "entityProjection") return yield* Effect.die("expected current projection")
      assert.strictEqual(unchanged.value.projection.projectionRevision, 3)
      const visibleAfterRefresh = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "workspaceEntityProjections",
        owner: null,
        query: null,
        service: "codecommit",
        status: null,
        type: "pull-request",
        limit: 100
      })
      if (visibleAfterRefresh._tag !== "workspaceEntityProjections") {
        return yield* Effect.die("expected current workspace pull requests")
      }
      assert.deepStrictEqual(
        visibleAfterRefresh.value.items.map(({ projection }) => projection.displayKey),
        ["20"]
      )

      const exactReplay = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3 },
        page(
          "pull-request-20-exact-replay",
          "exact-replay",
          "https://console.aws.example/pull-requests/20"
        )
      )
      assert.strictEqual(exactReplay.entityProjectionCount, 0)
      const afterExactReplay = yield* persistence.entities.get(WORKSPACE_ID, entityId)
      assert.strictEqual(afterExactReplay.revision, metadataRefreshed.revision)

      const changedRevision = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 3, committedAt: T3 },
        page(
          "pull-request-20-changed-revision",
          "changed-revision",
          "https://console.aws.example/pull-requests/20",
          "pull-request-20-revision-2"
        )
      )
      assert.strictEqual(changedRevision.entityProjectionCount, 1)

      const clearedSourceUrl = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 4, committedAt: T3 },
        page("pull-request-20-cleared-url", "cleared-url", null, "pull-request-20-revision-3")
      )
      assert.strictEqual(clearedSourceUrl.entityProjectionCount, 1)
      const afterClearedSourceUrl = yield* persistence.entities.get(WORKSPACE_ID, entityId)
      assert.isNull(afterClearedSourceUrl.sourceRevision.sourceUrl)
    })))

  it.effect("decodes provider-specific timestamps only for pull requests", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CONFLUENCE_PLUGIN_ID, "confluence")
      yield* setupConnection(CODECOMMIT_PLUGIN_ID, "codecommit")
      const page = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "confluence-provider-fields-complete",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "confluence-page-provider-fields",
          observedAt: "2026-07-19T09:01:30.000Z",
          revision: "page-revision-1",
          entityType: "confluence-page",
          vendorImmutableId: "page-provider-fields",
          sourceUrl: "https://confluence.example/pages/provider-fields",
          title: "Provider field isolation",
          attributes: {
            spaceKey: "OPS",
            currentVersion: 1,
            creationDate: "July 2026",
            lastActivityDate: { providerSpecific: true }
          }
        }]
      })
      const receipt = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CONFLUENCE_PLUGIN_ID,
        providerId: "confluence",
        streamKey: Schema.decodeSync(PluginStreamKey)("confluence-provider-fields"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, page)
      assert.strictEqual(receipt.entityProjectionCount, 1)

      const invalidPullRequest = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "invalid-pull-request-timestamp",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "pull-request-invalid-timestamp",
          observedAt: "2026-07-19T09:01:30.000Z",
          revision: "pull-request-invalid-timestamp-1",
          entityType: "pull-request",
          vendorImmutableId: "21",
          sourceUrl: null,
          title: "Invalid timestamp",
          attributes: {
            repository: "payments-api",
            sourceBranch: "feat/timestamp",
            targetBranch: "main",
            headRevision: "head-21",
            creationDate: { invalid: true }
          }
        }]
      })
      const failure = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODECOMMIT_PLUGIN_ID,
        providerId: "codecommit",
        streamKey: Schema.decodeSync(PluginStreamKey)("invalid-pull-request-timestamp"),
        expectedRevision: 0,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, invalidPullRequest).pipe(Effect.flip)
      if (failure._tag !== "NormalizedPluginPageMaterializationError") {
        return yield* Effect.die("expected pull-request timestamp failure")
      }
      assert.strictEqual(failure.diagnosticCode, "normalized-pull-request-timestamp-invalid")
    })))

  it.effect("materializes rich Confluence state and enriches lazy content at the same source revision", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CONFLUENCE_PLUGIN_ID, "confluence")
      const attributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        schemaVersion: 1,
        status: "current",
        spaceId: "space-payments",
        parentId: "parent-88",
        createdAt: "2026-07-19T09:00:00.000Z",
        updatedAt: "2026-07-19T09:02:00.000Z",
        currentVersion: 12,
        content: null,
        contentState: "lazy",
        versions: [{
          number: 12,
          createdAt: "2026-07-19T09:02:00.000Z",
          message: "Add rollback verification",
          minorEdit: false,
          authorId: "account-ada"
        }],
        versionHistory: { complete: false, pagesFetched: 2 },
        contributors: [{
          accountId: "account-ada",
          displayName: "Ada Kline",
          active: true,
          external: false,
          resolved: true,
          roles: ["owner", "author"]
        }],
        attachments: [{
          id: "attachment-1",
          title: "rollback-evidence.pdf",
          createdAt: "2026-07-19T09:01:00.000Z",
          mediaType: "application/pdf",
          fileSize: 4096,
          version: 3
        }],
        attachmentInventory: { complete: true, pagesFetched: 1 },
        watcherInventory: { complete: false, pagesFetched: 2 }
      })
      const normalizedPage = (eventId: string, pageAttributes: Schema.JsonObject, revision = "12") =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: eventId,
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId,
            observedAt: "2026-07-19T09:02:00.000Z",
            revision,
            entityType: "confluence-page",
            vendorImmutableId: "991",
            sourceUrl: "https://wiki.example.test/pages/991",
            title: "Payments release runbook",
            attributes: pageAttributes
          }]
        })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CONFLUENCE_PLUGIN_ID,
        providerId: "confluence",
        streamKey: Schema.decodeSync(PluginStreamKey)("confluence-rich-page"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(
        scope,
        normalizedPage("confluence-page-991-lazy", {
          ...attributes,
          linkedIssueKeys: ["PAY-42"],
          linkedReleaseVersions: ["2026.29"]
        })
      )

      const lazy = yield* exactFirstProjection()
      if (lazy?.details._tag !== "page") return yield* Effect.die("expected a canonical page")
      assert.strictEqual(lazy.projectionSchemaVersion, 2)
      assert.strictEqual(lazy.details.contentState, "lazy")
      assert.deepStrictEqual(lazy.details.linkedIssueKeys, ["PAY-42"])
      assert.deepStrictEqual(lazy.details.linkedReleaseVersions, ["2026.29"])
      assert.deepStrictEqual(lazy.details.contributors?.[0], {
        sourcePersonId: "account-ada",
        displayName: "Ada Kline",
        active: true,
        external: false,
        resolved: true,
        roles: ["owner", "author"]
      })
      assert.strictEqual(lazy.details.attachments?.[0]?.title, "rollback-evidence.pdf")

      const loadedAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        schemaVersion: attributes.schemaVersion,
        status: attributes.status,
        spaceId: attributes.spaceId,
        parentId: attributes.parentId,
        createdAt: attributes.createdAt,
        updatedAt: attributes.updatedAt,
        currentVersion: attributes.currentVersion,
        content: null,
        versions: attributes.versions,
        versionHistory: attributes.versionHistory,
        contributors: attributes.contributors
      })
      const receipt = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3 },
        normalizedPage("confluence-page-991-loaded", loadedAttributes)
      )
      assert.strictEqual(receipt.entityProjectionCount, 1)

      const loaded = yield* exactFirstProjection()
      if (loaded?.details._tag !== "page") return yield* Effect.die("expected an enriched canonical page")
      assert.strictEqual(loaded.projectionRevision, 2)
      assert.strictEqual(loaded.details.contentState, "loaded")
      assert.isNull(loaded.details.content)
      assert.strictEqual(loaded.details.attachments?.[0]?.title, "rollback-evidence.pdf")
      assert.deepStrictEqual(loaded.details.watcherInventory, { complete: false, pagesFetched: 2 })
      assert.deepStrictEqual(loaded.details.linkedIssueKeys, ["PAY-42"])
      assert.deepStrictEqual(loaded.details.linkedReleaseVersions, ["2026.29"])

      const nextRevisionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...loadedAttributes,
        currentVersion: 13,
        updatedAt: "2026-07-19T09:03:00.000Z",
        versions: [{
          number: 13,
          createdAt: "2026-07-19T09:03:00.000Z",
          message: "Remove superseded delivery links",
          minorEdit: false,
          authorId: "account-ada"
        }, ...loadedAttributes.versions]
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T4 },
        normalizedPage("confluence-page-991-v13", nextRevisionAttributes, "13")
      )
      const absent = yield* exactFirstProjection()
      if (absent?.details._tag !== "page") return yield* Effect.die("expected a next-revision page")
      assert.isUndefined(absent.details.linkedIssueKeys)
      assert.isUndefined(absent.details.linkedReleaseVersions)

      const revisionFourteenAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...nextRevisionAttributes,
        currentVersion: 14,
        updatedAt: "2026-07-19T09:04:00.000Z",
        versions: [{
          number: 14,
          createdAt: "2026-07-19T09:04:00.000Z",
          message: "Confirm explicit empty delivery links",
          minorEdit: false,
          authorId: "account-ada"
        }, ...nextRevisionAttributes.versions]
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 3, committedAt: T4 },
        normalizedPage("confluence-page-991-v14", {
          ...revisionFourteenAttributes,
          linkedIssueKeys: [],
          linkedReleaseVersions: []
        }, "14")
      )
      const explicitlyCleared = yield* exactFirstProjection()
      if (explicitlyCleared?.details._tag !== "page") return yield* Effect.die("expected an explicitly cleared page")
      assert.deepStrictEqual(explicitlyCleared.details.linkedIssueKeys, [])
      assert.deepStrictEqual(explicitlyCleared.details.linkedReleaseVersions, [])
    })))

  it.effect("merges same-revision Confluence reads without losing richer canonical state", () =>
    withMaterializer(Effect.gen(function*() {
      yield* setup
      yield* setupConnection(CONFLUENCE_PLUGIN_ID, "confluence")
      const contributor = (
        accountId: string,
        displayName: string,
        roles: ReadonlyArray<"author" | "contributor" | "owner" | "watcher">,
        resolved = true
      ) => ({ accountId, displayName, active: resolved, external: false, resolved, roles })
      const owner = contributor("account-ada", "Ada Kline", ["owner", "author"])
      const watcher = contributor("account-mina", "Mina Ortiz", ["watcher"])
      const unresolvedOwner = contributor("account-ada", "Confluence user", ["contributor"], false)
      const observer = contributor("account-tariq", "Tariq Bell", ["watcher"])
      const schemaVersion: 1 = 1
      const status: "current" = "current"
      const common = {
        schemaVersion,
        status,
        spaceId: "space-payments",
        parentId: null,
        createdAt: "2026-07-19T09:00:00.000Z",
        updatedAt: "2026-07-19T09:02:00.000Z",
        currentVersion: 12,
        versions: [{
          number: 12,
          createdAt: "2026-07-19T09:02:00.000Z",
          message: null,
          minorEdit: false,
          authorId: "account-ada"
        }, {
          number: 11,
          createdAt: "2026-07-18T09:02:00.000Z",
          message: "Previous complete revision",
          minorEdit: false,
          authorId: "account-ada"
        }],
        versionHistory: { complete: true, pagesFetched: 1 }
      }
      const loadedAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...common,
        content: { representation: "safe-markdown", markdown: "## Recovery\n\nKeep this body." },
        contributors: [owner]
      })
      const attachment = {
        id: "attachment-1",
        title: "recovery.pdf",
        createdAt: "2026-07-19T09:01:00.000Z",
        mediaType: "application/pdf",
        fileSize: 4096,
        version: 1
      }
      const lazyAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...common,
        content: null,
        contentState: "lazy",
        contributors: [owner, watcher],
        attachments: [attachment],
        attachmentInventory: { complete: true, pagesFetched: 1 },
        watcherInventory: { complete: true, pagesFetched: 1 }
      })
      const normalizedPage = (eventId: string, attributes: Schema.JsonObject, revision = "12") =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: eventId,
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId,
            observedAt: "2026-07-19T09:02:00.000Z",
            revision,
            entityType: "confluence-page",
            vendorImmutableId: "loaded-before-sync",
            sourceUrl: "https://wiki.example.test/pages/loaded-before-sync",
            title: "Loaded before sync",
            attributes
          }]
        })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CONFLUENCE_PLUGIN_ID,
        providerId: "confluence",
        streamKey: Schema.decodeSync(PluginStreamKey)("confluence-loaded-before-sync"),
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(scope, normalizedPage("loaded-page", loadedAttributes))
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3 },
        normalizedPage("lazy-sync", lazyAttributes)
      )

      const projection = yield* exactFirstProjection()
      if (projection?.details._tag !== "page") return yield* Effect.die("expected a merged page")
      assert.strictEqual(projection.details.contentState, "loaded")
      assert.strictEqual(projection.details.content?.markdown, "## Recovery\n\nKeep this body.")
      assert.strictEqual(projection.details.attachments?.[0]?.title, "recovery.pdf")
      assert.sameMembers(
        projection.details.contributors?.map(({ sourcePersonId }) => sourcePersonId) ?? [],
        ["account-ada", "account-mina"]
      )

      const partialInventoryAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...lazyAttributes,
        attachments: [{
          ...attachment,
          id: "attachment-2",
          title: "new-partial-evidence.pdf"
        }],
        attachmentInventory: { complete: false, pagesFetched: 1 },
        versions: [{
          number: 10,
          createdAt: "2026-07-17T09:02:00.000Z",
          message: "Newly observed partial history",
          minorEdit: false,
          authorId: "account-ada"
        }],
        versionHistory: { complete: false, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3 },
        normalizedPage("partial-inventories", partialInventoryAttributes)
      )
      const afterPartialInventories = yield* exactFirstProjection()
      if (afterPartialInventories?.details._tag !== "page") {
        return yield* Effect.die("expected a page after partial inventories")
      }
      assert.deepStrictEqual(
        afterPartialInventories.details.attachments?.map(({ id }) => id),
        ["attachment-2", "attachment-1"]
      )
      assert.deepStrictEqual(
        afterPartialInventories.details.versions?.map(({ number }) => number),
        [12, 11, 10]
      )

      const emptyPartialInventoryAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...partialInventoryAttributes,
        attachments: [],
        versions: []
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 3, committedAt: T3 },
        normalizedPage("empty-partial-inventories", emptyPartialInventoryAttributes)
      )
      const afterEmptyPartialInventories = yield* exactFirstProjection()
      if (afterEmptyPartialInventories?.details._tag !== "page") {
        return yield* Effect.die("expected a page after empty partial inventories")
      }
      assert.deepStrictEqual(
        afterEmptyPartialInventories.details.attachments?.map(({ id }) => id),
        ["attachment-2", "attachment-1"]
      )
      assert.deepStrictEqual(
        afterEmptyPartialInventories.details.versions?.map(({ number }) => number),
        [12, 11, 10]
      )

      const completeHistoryMissingCurrentAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...partialInventoryAttributes,
        attachments: [],
        attachmentInventory: { complete: true, pagesFetched: 1 },
        versions: common.versions.filter(({ number }) => number === 11),
        versionHistory: { complete: true, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 4, committedAt: T3 },
        normalizedPage("complete-history-missing-current", completeHistoryMissingCurrentAttributes)
      )
      const afterCompleteHistoryMissingCurrent = yield* exactFirstProjection()
      if (afterCompleteHistoryMissingCurrent?.details._tag !== "page") {
        return yield* Effect.die("expected a page after a complete history missing the current version")
      }
      assert.deepStrictEqual(afterCompleteHistoryMissingCurrent.details.attachments, [])
      assert.deepStrictEqual(
        afterCompleteHistoryMissingCurrent.details.versions?.map(({ number }) => number),
        [12, 11]
      )

      const completeCurrentVersionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...completeHistoryMissingCurrentAttributes,
        versions: common.versions.filter(({ number }) => number === 12)
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 5, committedAt: T3 },
        normalizedPage("complete-current-version", completeCurrentVersionAttributes)
      )
      const afterCompleteCurrentVersion = yield* exactFirstProjection()
      if (afterCompleteCurrentVersion?.details._tag !== "page") {
        return yield* Effect.die("expected a page after a complete current-version history")
      }
      assert.deepStrictEqual(
        afterCompleteCurrentVersion.details.versions?.map(({ number }) => number),
        [12]
      )

      const inspectionService = yield* makeDeliveryGraphInspection
      const indexed = yield* inspectionService.workspaceEntityProjections({
        workspaceId: WORKSPACE_ID,
        owner: null,
        query: null,
        service: null,
        status: null,
        type: null
      })
      const indexedDetails = indexed.items[0]?.projection.details
      if (indexedDetails?._tag !== "page") return yield* Effect.die("expected an indexed page")
      assert.strictEqual(indexedDetails.contentState, "lazy")
      assert.isNull(indexedDetails.content)
      const exact = yield* inspectionService.workspaceEntity({
        workspaceId: WORKSPACE_ID,
        entityId: projection.entityId
      })
      if (exact.entity.projection.details._tag !== "page") return yield* Effect.die("expected an exact page")
      assert.strictEqual(exact.entity.projection.details.content?.markdown, "## Recovery\n\nKeep this body.")

      const loadedNullAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...common,
        content: null,
        contributors: [unresolvedOwner, watcher],
        attachments: [attachment],
        attachmentInventory: { complete: true, pagesFetched: 1 },
        watcherInventory: { complete: true, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 6, committedAt: T3 },
        normalizedPage("partial-loaded-read", loadedNullAttributes)
      )
      const afterNullRead = yield* exactFirstProjection()
      if (afterNullRead?.details._tag !== "page") return yield* Effect.die("expected a page after a null read")
      assert.strictEqual(afterNullRead.details.content?.markdown, "## Recovery\n\nKeep this body.")
      assert.deepStrictEqual(
        afterNullRead.details.contributors?.find(({ sourcePersonId }) => sourcePersonId === "account-ada"),
        {
          sourcePersonId: "account-ada",
          displayName: "Ada Kline",
          active: true,
          external: false,
          resolved: true,
          roles: ["owner", "author", "contributor"]
        }
      )

      const metadataOnlyAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...loadedNullAttributes,
        contributors: [unresolvedOwner, watcher, observer]
      })
      const metadataReceipt = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 7, committedAt: T3 },
        normalizedPage("metadata-only-sync", metadataOnlyAttributes)
      )
      assert.strictEqual(metadataReceipt.entityProjectionCount, 1)
      const afterMetadata = yield* exactFirstProjection()
      if (afterMetadata?.details._tag !== "page") return yield* Effect.die("expected a metadata-enriched page")
      assert.include(
        afterMetadata.details.contributors?.map(({ sourcePersonId }) => sourcePersonId) ?? [],
        "account-tariq"
      )

      const incompleteOmissionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...metadataOnlyAttributes,
        contributors: [unresolvedOwner, watcher],
        watcherInventory: { complete: false, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 8, committedAt: T3 },
        normalizedPage("incomplete-watcher-omission", incompleteOmissionAttributes)
      )
      const afterIncompleteOmission = yield* exactFirstProjection()
      if (afterIncompleteOmission?.details._tag !== "page") {
        return yield* Effect.die("expected a page after an incomplete watcher read")
      }
      assert.include(
        afterIncompleteOmission.details.contributors?.map(({ sourcePersonId }) => sourcePersonId) ?? [],
        "account-tariq"
      )

      const completeOmissionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...incompleteOmissionAttributes,
        watcherInventory: { complete: true, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 9, committedAt: T3 },
        normalizedPage("complete-watcher-omission", completeOmissionAttributes)
      )
      const afterCompleteOmission = yield* exactFirstProjection()
      if (afterCompleteOmission?.details._tag !== "page") {
        return yield* Effect.die("expected a page after a complete watcher read")
      }
      assert.notInclude(
        afterCompleteOmission.details.contributors?.map(({ sourcePersonId }) => sourcePersonId) ?? [],
        "account-tariq"
      )

      const replay = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 10, committedAt: T3 },
        normalizedPage("identical-metadata-sync", completeOmissionAttributes)
      )
      assert.strictEqual(replay.entityProjectionCount, 0)

      const nextRevisionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...common,
        currentVersion: 13,
        updatedAt: "2026-07-19T09:06:00.000Z",
        content: null,
        contributors: [owner],
        versions: [{
          number: 13,
          createdAt: "2026-07-19T09:06:00.000Z",
          message: "Clear obsolete body",
          minorEdit: false,
          authorId: "account-ada"
        }, ...common.versions]
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 11, committedAt: T4 },
        normalizedPage("next-revision-empty", nextRevisionAttributes, "13")
      )
      const nextRevision = yield* exactFirstProjection()
      if (nextRevision?.details._tag !== "page") return yield* Effect.die("expected the next page revision")
      assert.strictEqual(nextRevision.details.contentState, "loaded")
      assert.isNull(nextRevision.details.content)
      assert.isTrue(nextRevision.details.versionHistory?.complete)

      const historyVersion = (number: number) => ({
        number,
        createdAt: "2026-07-19T09:06:00.000Z",
        message: null,
        minorEdit: false,
        authorId: "account-ada"
      })
      const maximumRevisionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...nextRevisionAttributes,
        currentVersion: 501,
        updatedAt: "2026-07-19T09:07:00.000Z",
        versions: [historyVersion(501)]
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 12, committedAt: T4 },
        normalizedPage("maximum-revision", maximumRevisionAttributes, "501")
      )
      const boundedCompleteHistoryAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...maximumRevisionAttributes,
        versions: Array.from({ length: 499 }, (_, index) => historyVersion(index + 1)),
        versionHistory: { complete: true, pagesFetched: 5 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 13, committedAt: T4 },
        normalizedPage("bounded-complete-history", boundedCompleteHistoryAttributes, "501")
      )
      const boundedCompleteHistory = yield* exactFirstProjection()
      if (boundedCompleteHistory?.details._tag !== "page") {
        return yield* Effect.die("expected a bounded complete page history")
      }
      assert.lengthOf(boundedCompleteHistory.details.versions ?? [], 500)
      assert.include(boundedCompleteHistory.details.versions?.map(({ number }) => number) ?? [], 501)
      assert.isTrue(boundedCompleteHistory.details.versionHistory?.complete)

      const overflowingHistoryAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...boundedCompleteHistoryAttributes,
        versions: Array.from({ length: 500 }, (_, index) => historyVersion(index + 1))
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 14, committedAt: T4 },
        normalizedPage("overflowing-complete-history", overflowingHistoryAttributes, "501")
      )
      const overflowingHistory = yield* exactFirstProjection()
      if (overflowingHistory?.details._tag !== "page") {
        return yield* Effect.die("expected an overflowed page history")
      }
      assert.lengthOf(overflowingHistory.details.versions ?? [], 500)
      assert.include(overflowingHistory.details.versions?.map(({ number }) => number) ?? [], 501)
      assert.isFalse(overflowingHistory.details.versionHistory?.complete)

      const boundedContributors = [
        owner,
        ...Array.from(
          { length: 501 },
          (_, index) =>
            contributor(`account-owner-${String(index).padStart(3, "0")}`, `Owner ${String(index)}`, ["owner"])
        )
      ]
      const boundedContributorAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...overflowingHistoryAttributes,
        contributors: boundedContributors,
        watcherInventory: { complete: false, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 15, committedAt: T4 },
        normalizedPage("bounded-contributors", boundedContributorAttributes, "501")
      )
      const overflowContributor = contributor("account-overflow-watcher", "Overflow Watcher", ["watcher"])
      const overflowingContributorAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...overflowingHistoryAttributes,
        contributors: [overflowContributor],
        watcherInventory: { complete: true, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 16, committedAt: T4 },
        normalizedPage("overflowing-contributors", overflowingContributorAttributes, "501")
      )
      const afterContributorOverflow = yield* exactFirstProjection()
      if (afterContributorOverflow?.details._tag !== "page") {
        return yield* Effect.die("expected bounded contributors after same-revision enrichment")
      }
      assert.lengthOf(afterContributorOverflow.details.contributors ?? [], 502)
      assert.notInclude(
        afterContributorOverflow.details.contributors?.map(({ sourcePersonId }) => sourcePersonId) ?? [],
        "account-overflow-watcher"
      )
      assert.isFalse(afterContributorOverflow.details.watcherInventory?.complete)

      const currentlessNewRevisionAttributes = Schema.decodeSync(ConfluencePageAttributesV1)({
        ...maximumRevisionAttributes,
        currentVersion: 502,
        updatedAt: "2026-07-19T09:08:00.000Z",
        versions: [historyVersion(501)],
        versionHistory: { complete: true, pagesFetched: 1 }
      })
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 17, committedAt: T4 },
        normalizedPage("currentless-new-revision", currentlessNewRevisionAttributes, "502")
      )
      const currentlessNewRevision = yield* exactFirstProjection()
      if (currentlessNewRevision?.details._tag !== "page") {
        return yield* Effect.die("expected a current-less new page revision")
      }
      assert.isFalse(currentlessNewRevision.details.versionHistory?.complete)
    })))

  it.effect("rolls back the checkpoint and canonical writes when materialization fails", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      yield* setup

      const failure = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, invalidRelationshipPage).pipe(Effect.flip)
      if (failure._tag !== "NormalizedPluginPageMaterializationError") {
        return yield* Effect.die("expected normalized materialization failure")
      }
      assert.strictEqual(failure.diagnosticCode, "normalized-relationship-kind-invalid")

      const counts = yield* database.sql<{
        readonly entities: number
        readonly pages: number
        readonly projections: number
        readonly streams: number
      }>`SELECT
        (SELECT COUNT(*) FROM plugin_sync_streams) AS streams,
        (SELECT COUNT(*) FROM plugin_sync_pages) AS pages,
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections`
      assert.deepStrictEqual(counts, [{ streams: 0, pages: 0, entities: 0, projections: 0 }])
    })))
})
