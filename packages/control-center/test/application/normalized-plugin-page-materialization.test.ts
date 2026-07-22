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
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
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
      triggerRevision: "abc123"
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
    attributes: { durationMinutes: 45, billable: true, approvalState: "approved" }
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
      spaceKey: "PAY",
      currentVersion: 8,
      status: "current",
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

describe("normalized plugin page materialization", () => {
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

        const legacy = yield* materializeNormalizedPluginPage(
          scope,
          page("compact-legacy-issue", {
            schemaVersion: 1,
            key: "LEGACY-42",
            summary: "Historical compact issue",
            status: { name: "Open" },
            priority: { name: "High" }
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
      assert.strictEqual(receipt.entityProjectionCount, 4)

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

      assert.deepStrictEqual(done.value.items.map(({ projection }) => projection.displayKey), ["17"])
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
      const page = (eventId: string, checkpointAfterPage: string) =>
        Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage,
          hasMore: false,
          events: [{
            _tag: "UpsertEntity",
            eventId,
            observedAt: "2026-07-19T09:01:30.000Z",
            revision: "pull-request-20-revision-1",
            entityType: "pull-request",
            vendorImmutableId: "20",
            sourceUrl: "https://console.aws.example/pull-requests/20",
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

      const backfill = yield* materializeNormalizedPluginPage(scope, page("pull-request-20-backfill", "backfilled"))
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
      assert.strictEqual(
        refreshedEntity.sourceRevision.sourceUrl?.href,
        "https://console.aws.example/pull-requests/20"
      )
      assert.strictEqual(
        DateTime.formatIso(refreshedEntity.sourceRevision.lastObservedAt),
        "2026-07-19T09:01:30.000Z"
      )
      assert.strictEqual(DateTime.formatIso(refreshedEntity.sourceRevision.synchronizedAt), DateTime.formatIso(T2))

      const current = yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T3 },
        page("pull-request-20-current", "already-current")
      )
      assert.strictEqual(current.entityProjectionCount, 0)
      const unchanged = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "entityProjection",
        entityId,
        revision: null
      })
      if (unchanged._tag !== "entityProjection") return yield* Effect.die("expected current projection")
      assert.strictEqual(unchanged.value.projection.projectionRevision, 2)
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
