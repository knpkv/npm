// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation, useNavigate } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ReleaseDeliveryGraphInspection,
  WorkspaceEntityInspection,
  type WorkspaceEntityInspection as Inspection
} from "../../src/api/deliveryGraph.js"
import { presentWorkspaceEntity } from "../../src/client/entities/presentWorkspaceEntity.js"
import { presentWorkspacePipelineExecution } from "../../src/client/entities/presentWorkspacePipelineExecution.js"
import { presentWorkspacePullRequest } from "../../src/client/entities/presentWorkspacePullRequest.js"
import { WorkspaceEntityView } from "../../src/client/entities/WorkspaceEntityRoute.js"
import type { WorkspaceEntityState } from "../../src/client/entities/useWorkspaceEntity.js"
import { workspaceEntityAgentPath } from "../../src/client/items/workspaceEntityRoutes.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const encodedWorkset = Schema.encodeSync(ReleaseDeliveryGraphInspection)(releaseWorksetFixture)
const projectionEntry = encodedWorkset.entityProjections[0]
if (projectionEntry === undefined) throw new Error("Expected an entity projection fixture")

const sourceRevision = {
  providerId: "jira",
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000081",
  vendorImmutableId: "jira-issue-ops-428",
  revision: "rev-8",
  sourceUrl: "https://jira.example.test/browse/OPS-428",
  firstObservedAt: "2026-07-14T10:00:00.000Z",
  lastObservedAt: "2026-07-14T10:00:00.000Z",
  synchronizedAt: "2026-07-14T10:01:00.000Z",
  normalizationSchemaVersion: 1
}

const inspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  entity: {
    ...projectionEntry,
    projection: {
      ...projectionEntry.projection,
      details: {
        _tag: "issue",
        key: "OPS-428",
        status: "In review",
        priority: "High",
        estimatePoints: 3,
        summary: "Review payment capture safeguards",
        description: "Customer impact\n\nCapture retries must never create a second charge.",
        acceptanceCriteria:
          "A repeated capture returns the original payment result.\nNo duplicate ledger entry is created.",
        environment: "Payments production in eu-west-1.",
        issueType: { sourceId: "10001", name: "Story" },
        project: { sourceId: "10000", key: "OPS", name: "Operations" },
        resolution: null,
        labels: ["payments", "release-blocker"],
        components: [{ sourceId: "20001", name: "Capture API" }],
        fixVersions: [{ sourceId: "30001", name: "Payments 2026.07", released: false, releaseDate: null }],
        createdAt: "2026-07-10T08:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z",
        dueDate: "2026-07-18",
        resolvedAt: null,
        parent: {
          sourceId: "jira-epic-payments",
          key: "OPS-400",
          summary: "Harden payment delivery",
          status: { sourceId: "3", name: "In progress" }
        },
        subtasks: [
          {
            sourceId: "jira-subtask-429",
            key: "OPS-429",
            summary: "Add duplicate capture contract test",
            status: { sourceId: "2", name: "Ready" }
          }
        ],
        assigneeSourcePersonId: "account-mina",
        reporterSourcePersonId: "account-ada",
        creatorSourcePersonId: "account-ada",
        collaborators: [
          {
            sourcePersonId: "account-mina",
            displayName: "Mina Ortiz",
            avatarUrl: "https://images.example.test/mina.png",
            active: true,
            roles: ["assignee", "commenter"]
          },
          {
            sourcePersonId: "01890f6f-6d6a-7cc0-98d2-000000000071",
            displayName: "Ada Kline",
            avatarUrl: null,
            active: true,
            roles: ["creator", "reporter"]
          }
        ],
        comments: [
          {
            sourceId: "comment-41",
            authorSourcePersonId: "account-mina",
            updateAuthorSourcePersonId: null,
            body: "Sandbox replay is green. I am waiting for the final reviewer.",
            createdAt: "2026-07-14T09:30:00.000Z",
            updatedAt: null
          }
        ],
        commentTotal: 4,
        commentsTruncated: true,
        history: [
          {
            sourceId: "history-9",
            authorSourcePersonId: "account-ada",
            createdAt: "2026-07-14T09:00:00.000Z",
            changes: [{ field: "Status", from: "In progress", to: "In review" }]
          }
        ],
        historyTotal: 1,
        historyTruncated: false,
        truncatedFields: ["comments"]
      }
    },
    canonicalReleaseId: encodedWorkset.releaseId,
    owners: [
      {
        avatarFallback: "AK",
        displayName: "Ada Kline",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000071",
        roles: ["issue-owner", "reviewer"]
      }
    ],
    ownersTruncated: false,
    releaseIds: [encodedWorkset.releaseId],
    releaseMembershipsTruncated: false
  },
  source: sourceRevision,
  isSourceCurrent: false,
  freshness: {
    _tag: "stale",
    evaluatedAt: "2026-07-14T10:20:00.000Z",
    pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:20:00.000Z" },
    provenance: {
      _tag: "cache",
      cachedAt: "2026-07-14T10:01:00.000Z",
      sourceRevision
    },
    sourceObservedAt: "2026-07-14T10:00:00.000Z",
    staleAfterSeconds: 300,
    synchronizedAt: "2026-07-14T10:01:00.000Z"
  },
  graph: {
    truncated: true,
    nodes: encodedWorkset.nodes,
    relatedEntityProjections: encodedWorkset.entityProjections.slice(1),
    relationships: encodedWorkset.relationships,
    evidenceClaims: encodedWorkset.evidenceClaims,
    evidenceItems: encodedWorkset.evidenceItems
  },
  activity: {
    truncated: true,
    events: [
      {
        eventKey: "plugin-sync:OPS-428:rev-8",
        occurredAt: "2026-07-14T10:01:00.000Z",
        actor: { kind: "plugin", label: "Jira synchronization" },
        sourceKind: "plugin-sync",
        service: "jira",
        eventType: "entity-synchronized",
        title: "Issue synchronized",
        href: "https://jira.example.test/browse/OPS-428"
      }
    ]
  }
})

const encodedInspection = Schema.encodeSync(WorkspaceEntityInspection)(inspection)
const pullRequestInspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  ...encodedInspection,
  entity: {
    ...encodedInspection.entity,
    projection: {
      ...encodedInspection.entity.projection,
      entityType: "pull-request",
      displayKey: "184",
      title: "Checkout and capture",
      details: {
        _tag: "pull-request",
        repository: "payments-api",
        sourceBranch: "feature/capture",
        targetBranch: "main",
        headRevision: "a5d8c9e4f013bdf17c2e6765579e2770f63e7b19",
        baseRevision: "91c3627b4ce7447e38c906529a4af4be6bc6812d",
        mergeBaseRevision: "6a2621c69c57b428e2a83f415c23ad37a875c87d",
        reviewState: "requested",
        lifecycle: "open",
        description: "Protect capture retries and preserve the original payment result.",
        authorReference: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
        createdAt: "2026-07-12T08:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z"
      }
    },
    owners: [
      {
        avatarFallback: "AK",
        displayName: "Ada Kline",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000071",
        roles: ["reviewer"]
      },
      {
        avatarFallback: "MO",
        displayName: "Mina Ortiz",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000072",
        roles: ["release-approver"]
      }
    ]
  },
  source: {
    ...sourceRevision,
    providerId: "codecommit",
    vendorImmutableId: "184",
    revision: "revision-9",
    sourceUrl:
      "https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/184"
  },
  isSourceCurrent: true,
  freshness: null,
  activity: { truncated: false, events: [] }
})

const pipelineInspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  ...encodedInspection,
  entity: {
    ...encodedInspection.entity,
    projection: {
      ...encodedInspection.entity.projection,
      entityType: "pipeline-execution",
      displayKey: "payments/9002",
      title: "Payments deploy 9002",
      details: {
        _tag: "pipeline-execution",
        pipelineName: "payments",
        pipelineVersion: 7,
        executionId: "9002",
        status: "running",
        statusSummary: "Waiting for the production release gate",
        triggerRevision: "abc123",
        startedAt: "2026-07-14T09:00:00.000Z",
        updatedAt: "2026-07-14T09:05:42.000Z",
        triggerType: "StartPipelineExecution",
        triggerDetail: "arn:aws:sts::123456789012:assumed-role/Release/operator",
        executionMode: "SUPERSEDED",
        executionType: "STANDARD",
        sourceRevisions: [{ actionName: "Checkout", revisionId: "abc123", revisionSummary: "main" }],
        stages: [
          { name: "Source", status: "succeeded", actionCount: 1, actionsTruncated: false },
          { name: "Build", status: "succeeded", actionCount: 1, actionsTruncated: false },
          { name: "Approval", status: "running", actionCount: 1, actionsTruncated: false },
          { name: "Production", status: "queued", actionCount: 1, actionsTruncated: false }
        ],
        actions: [
          {
            actionExecutionId: "build-1",
            stageName: "Build",
            actionName: "Compile",
            status: "succeeded",
            startedAt: "2026-07-14T09:01:00.000Z",
            updatedAt: "2026-07-14T09:04:00.000Z",
            updatedBy: "arn:aws:sts::123456789012:assumed-role/Release/operator",
            category: "Build",
            provider: "CodeBuild",
            owner: "AWS",
            version: "1",
            region: "eu-west-1",
            externalExecutionSummary: "Build completed",
            errorCode: null,
            errorMessage: null,
            artifacts: [
              { name: "Source", direction: "input", access: "proxy-required" },
              { name: "BuildOutput", direction: "output", access: "proxy-required" }
            ]
          },
          {
            actionExecutionId: "approval-1",
            stageName: "Approval",
            actionName: "Release gate",
            status: "running",
            startedAt: "2026-07-14T09:05:00.000Z",
            updatedAt: "2026-07-14T09:05:42.000Z",
            updatedBy: "release-approver@example.test",
            category: "Approval",
            provider: "Manual",
            owner: "AWS",
            version: "1",
            region: "eu-west-1",
            externalExecutionSummary: null,
            errorCode: null,
            errorMessage: null,
            artifacts: [{ name: "BuildOutput", direction: "input", access: "proxy-required" }]
          },
          {
            actionExecutionId: "deploy-1",
            stageName: "Production",
            actionName: "Deploy",
            status: "queued",
            startedAt: null,
            updatedAt: null,
            updatedBy: null,
            category: "Deploy",
            provider: "CodeDeploy",
            owner: "AWS",
            version: "1",
            region: "eu-west-1",
            externalExecutionSummary: null,
            errorCode: null,
            errorMessage: null,
            artifacts: []
          }
        ],
        actionCount: 4,
        actionsTruncated: true,
        actionPagesRead: 3,
        sourceArtifacts: [
          {
            name: "Source",
            revisionId: "abc123",
            revisionSummary: "main",
            createdAt: "2026-07-14T08:59:00.000Z",
            access: "proxy-required"
          }
        ]
      }
    },
    owners: [
      {
        avatarFallback: "MO",
        displayName: "Mina Ortiz",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000072",
        roles: ["operator"]
      }
    ]
  },
  source: {
    ...sourceRevision,
    providerId: "codepipeline",
    vendorImmutableId: "9002",
    revision: "7:InProgress",
    sourceUrl: "https://console.aws.example/codepipeline/payments/9002"
  },
  isSourceCurrent: true,
  freshness: null,
  activity: { truncated: false, events: [] }
})

const confluenceInspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  ...encodedInspection,
  entity: {
    ...encodedInspection.entity,
    projection: {
      ...encodedInspection.entity.projection,
      entityType: "page",
      displayKey: "991",
      title: "Payments release runbook",
      details: {
        _tag: "page",
        spaceKey: "PAY",
        revision: "12",
        status: "current",
        sourceSpaceId: "space-payments",
        parentSourceId: "parent-88",
        createdAt: "2026-07-10T08:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z",
        contentState: "loaded",
        content: {
          representation: "safe-markdown",
          markdown: [
            "## Production recovery",
            "",
            "Follow the [safe checklist](https://wiki.example.test/checklist).",
            "[Unsafe](javascript:alert(1)) ![tracker](https://evil.example.test/pixel.png)",
            '<script>window.evil = true</script><iframe src="https://evil.example.test"></iframe>'
          ].join("\n")
        },
        contributors: [
          {
            sourcePersonId: "account-ada",
            displayName: "Ada Kline",
            active: true,
            external: false,
            resolved: true,
            roles: ["owner", "author"]
          },
          {
            sourcePersonId: "account-mina",
            displayName: "Mina Ortiz",
            active: true,
            external: false,
            resolved: true,
            roles: ["watcher"]
          },
          {
            sourcePersonId: "account-mina",
            displayName: "Confluence user",
            active: false,
            external: false,
            resolved: false,
            roles: ["contributor"]
          },
          {
            sourcePersonId: "account-alex-one",
            displayName: "Alex Lee",
            active: true,
            external: false,
            resolved: true,
            roles: ["contributor"]
          },
          {
            sourcePersonId: "account-alex-two",
            displayName: "Alex Lee",
            active: true,
            external: true,
            resolved: true,
            roles: ["watcher"]
          }
        ],
        versions: [
          {
            number: 12,
            createdAt: "2026-07-14T10:00:00.000Z",
            message: "Add rollback verification",
            minorEdit: false,
            authorSourcePersonId: "01890f6f-6d6a-7cc0-98d2-000000000071"
          },
          {
            number: 11,
            createdAt: "2026-07-13T10:00:00.000Z",
            message: null,
            minorEdit: true,
            authorSourcePersonId: null
          }
        ],
        versionHistory: { complete: false, pagesFetched: 2 },
        attachments: [
          {
            id: "attachment-1",
            title: "rollback-evidence.pdf",
            createdAt: "2026-07-14T09:00:00.000Z",
            mediaType: "application/pdf",
            fileSize: 4096,
            version: 3
          }
        ],
        attachmentInventory: { complete: true, pagesFetched: 1 },
        watcherInventory: { complete: false, pagesFetched: 2 }
      }
    },
    owners: [
      {
        avatarFallback: "AK",
        displayName: "Ada Kline",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000071",
        roles: ["page-owner"],
        sourceIdentities: [
          {
            pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000081",
            providerId: "confluence",
            vendorPersonId: "account-ada"
          }
        ]
      }
    ]
  },
  source: {
    ...sourceRevision,
    providerId: "confluence",
    vendorImmutableId: "991",
    revision: "12",
    sourceUrl: "https://wiki.example.test/pages/991"
  },
  isSourceCurrent: true,
  freshness: null,
  activity: { truncated: false, events: [] }
})

const relatedClockifyIssue = encodedWorkset.entityProjections[1]
if (relatedClockifyIssue === undefined) throw new Error("Expected a related issue fixture")
const clockifyInspection: Inspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
  ...encodedInspection,
  entity: {
    ...encodedInspection.entity,
    projection: {
      ...encodedInspection.entity.projection,
      entityType: "time-entry",
      displayKey: "time-entry-901",
      title: "Review payment safeguards",
      details: {
        _tag: "time-entry",
        durationMinutes: 135,
        billable: true,
        approvalState: "approved",
        projectId: "project-payments",
        userId: "clockify-user-mina",
        startedAt: "2026-07-14T07:45:00.000Z",
        endedAt: "2026-07-14T10:00:00.000Z"
      }
    },
    owners: [
      {
        avatarFallback: "MO",
        displayName: "Mina Ortiz",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000072",
        roles: ["author"],
        sourceIdentities: [
          {
            pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000081",
            providerId: "clockify",
            vendorPersonId: "clockify-user-mina"
          }
        ]
      },
      {
        avatarFallback: "AK",
        displayName: "Ada Kline",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000071",
        roles: ["release-approver"]
      }
    ]
  },
  source: {
    ...sourceRevision,
    providerId: "clockify",
    vendorImmutableId: "time-entry-901",
    revision: "clockify-revision-4",
    sourceUrl: "https://app.clockify.me/tracker"
  },
  isSourceCurrent: true,
  freshness: null,
  graph: {
    truncated: false,
    nodes: [
      {
        workspaceId: WORKSET_WORKSPACE_ID,
        nodeId: "01890f6f-6d6a-7cc0-98d2-000000000091",
        endpointKind: "time-entry",
        resolution: {
          _tag: "resolved",
          target: {
            _tag: "entity",
            entityId: encodedInspection.entity.projection.entityId,
            entityKind: "time-entry"
          }
        },
        createdAt: "2026-07-14T10:02:00.000Z"
      },
      {
        workspaceId: WORKSET_WORKSPACE_ID,
        nodeId: "01890f6f-6d6a-7cc0-98d2-000000000092",
        endpointKind: "issue",
        resolution: {
          _tag: "resolved",
          target: {
            _tag: "entity",
            entityId: relatedClockifyIssue.projection.entityId,
            entityKind: "issue"
          }
        },
        createdAt: "2026-07-14T10:02:00.000Z"
      }
    ],
    relatedEntityProjections: [relatedClockifyIssue],
    relationships: [
      {
        workspaceId: WORKSET_WORKSPACE_ID,
        relationshipId: "01890f6f-6d6a-7cc0-98d2-000000000093",
        relationshipSchemaVersion: 1,
        revision: 1,
        supersedesRevision: null,
        kind: "tracks-time-for",
        sourceNodeId: "01890f6f-6d6a-7cc0-98d2-000000000091",
        sourceNodeKind: "time-entry",
        targetNodeId: "01890f6f-6d6a-7cc0-98d2-000000000092",
        targetNodeKind: "issue",
        scope: null,
        lifecycle: { _tag: "inferred", effectiveAt: "2026-07-14T10:02:00.000Z" },
        confidence: { _tag: "inferred", score: 0.94, rationale: "Jira key in the Clockify description." },
        provenance: {
          _tag: "rule",
          ruleId: "clockify-description-jira-key",
          ruleVersion: 1,
          rationale: "Jira key in the Clockify description."
        },
        recordedBy: { _tag: "system", component: "relationship-inference" },
        evidenceClaimIds: [],
        recordedAt: "2026-07-14T10:02:00.000Z"
      }
    ],
    evidenceClaims: [],
    evidenceItems: []
  },
  activity: {
    truncated: false,
    events: [
      {
        eventKey: "plugin-sync:time-entry-901:clockify-revision-4",
        occurredAt: "2026-07-14T10:01:00.000Z",
        actor: { kind: "plugin", label: "Clockify synchronization" },
        sourceKind: "plugin-sync",
        service: "clockify",
        eventType: "entity-synchronized",
        title: "Time entry synchronized",
        href: "https://app.clockify.me/tracker"
      }
    ]
  }
})

const state = {
  _tag: "stale",
  entityId: inspection.entity.projection.entityId,
  inspection,
  reason: "source-stale",
  refreshKey: "snapshot-a",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

const pullRequestState = {
  _tag: "ready",
  entityId: pullRequestInspection.entity.projection.entityId,
  inspection: pullRequestInspection,
  refreshKey: "snapshot-pr",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

const pipelineState = {
  _tag: "ready",
  entityId: pipelineInspection.entity.projection.entityId,
  inspection: pipelineInspection,
  refreshKey: "snapshot-pipeline",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

const confluenceState = {
  _tag: "ready",
  entityId: confluenceInspection.entity.projection.entityId,
  inspection: confluenceInspection,
  refreshKey: "snapshot-confluence",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

const clockifyState = {
  _tag: "ready",
  entityId: clockifyInspection.entity.projection.entityId,
  inspection: clockifyInspection,
  refreshKey: "snapshot-clockify",
  sessionKey: "session-a",
  workspaceId: WORKSET_WORKSPACE_ID
} satisfies WorkspaceEntityState

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const renderView = async (onAskAgent: () => void, viewState: WorkspaceEntityState = state): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const view: ReactElement = (
    <MemoryRouter>
      <WorkspaceEntityView
        onAskAgent={onAskAgent}
        originHref={`/w/${WORKSET_WORKSPACE_ID}/items?q=payments#results`}
        originLabel="Back to items"
        originState={null}
        retry={() => undefined}
        state={viewState}
        workspaceId={WORKSET_WORKSPACE_ID}
      />
    </MemoryRouter>
  )
  await act(async () => mountedRoot?.render(view))
  return host
}

const LocationProbe = (): ReactElement => {
  const location = useLocation()
  return <output data-location>{`${location.pathname}${location.search}${location.hash}`}</output>
}

describe("canonical workspace entity", () => {
  it("presents human-first next work, ownership, graph, provenance, and activity", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, inspection)

    expect(presentation).toMatchObject({
      displayKey: "OPS-428",
      freshness: "stale",
      kindLabel: "Issue",
      primaryAction: {
        external: true,
        href: "https://jira.example.test/browse/OPS-428",
        label: "Open in Jira"
      },
      service: "jira",
      title: "Review payment capture safeguards",
      verdict: "In review"
    })
    expect(presentation.collaborators.reviewers).toEqual([
      expect.objectContaining({ name: "Ada Kline", role: "Issue Owner · Reviewer" })
    ])
    expect(presentation.collaborators.owners).toEqual([
      expect.objectContaining({
        avatarSrc: "https://images.example.test/mina.png",
        name: "Mina Ortiz",
        role: "Assignee · Commenter"
      })
    ])
    expect(presentation.agentContext).toContain("1 release · 4 synchronized comments")
    expect(presentation.relationships.length).toBeGreaterThan(0)
    expect(presentation.activity).toEqual([
      expect.objectContaining({ actorKind: "plugin", detail: "Plugin Sync", title: "Issue synchronized" })
    ])
    expect(presentation.partialMessages).toEqual([
      "The relationship graph is partial; additional delivery links exist.",
      "The activity list is partial; older events are not shown."
    ])
  })

  it("presents one exact pull-request head without treating agent advice as approval", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, pullRequestInspection)

    expect(presentation).toMatchObject({
      displayKey: "184",
      service: "codecommit",
      verdict: "Open",
      pullRequest: {
        agentReviewLabel: "Agent review not run",
        author: { name: "Alice", role: "Pull request author" },
        baseRevision: "91c3627b4ce7447e38c906529a4af4be6bc6812d",
        createdAt: {
          dateTime: "2026-07-12T08:00:00.000Z"
        },
        headRevision: "a5d8c9e4f013bdf17c2e6765579e2770f63e7b19",
        releaseCountLabel: "1",
        reviewLabel: "Human review requested"
      }
    })
    expect(presentation.facts).toContainEqual({
      label: "Head revision",
      value: presentation.pullRequest?.headRevision
    })
    expect(presentation.collaborators.reviewers).toEqual([
      expect.objectContaining({ name: "Ada Kline", role: "Reviewer" })
    ])
    expect(presentation.collaborators.approvers).toEqual([
      expect.objectContaining({ name: "Mina Ortiz", role: "Release Approver" })
    ])
    if (presentation.pullRequest === null) throw new Error("Expected a pull-request presentation")
    expect(presentation.pullRequest.issueCountLabel).toBe(`${String(presentation.pullRequest.issueCount)}+`)
    expect(presentation.pullRequest.pipelineCountLabel).toBe(`${String(presentation.pullRequest.pipelineCount)}+`)

    const complete = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, {
      ...pullRequestInspection,
      graph: { ...pullRequestInspection.graph, truncated: false }
    })
    if (complete.pullRequest === null) throw new Error("Expected a complete pull-request presentation")
    expect(complete.pullRequest.issueCountLabel).toBe(String(complete.pullRequest.issueCount))
    expect(complete.pullRequest.pipelineCountLabel).toBe(String(complete.pullRequest.pipelineCount))
  })

  it("presents one exact pipeline run as a bounded operator flight recorder", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, pipelineInspection)

    expect(presentation).toMatchObject({
      displayKey: "payments/9002",
      service: "codepipeline",
      verdict: "Running",
      pipelineExecution: {
        actionCountLabel: "4+",
        duration: "5m 42s",
        executionId: "9002",
        executionMode: "SUPERSEDED · STANDARD",
        operators: ["Operator"],
        approvers: ["release-approver@example.test"],
        pipelineVersion: "v7",
        statusSummary: "Waiting for the production release gate",
        targetEnvironment: "Production · eu-west-1",
        triggerRevision: "abc123"
      }
    })
    expect(presentation.pipelineExecution?.stages.map(({ name }) => name)).toEqual([
      "Source",
      "Build",
      "Approval",
      "Production"
    ])
    expect(presentation.pipelineExecution?.actions[0]).toMatchObject({
      actor: "Operator",
      duration: "3m",
      name: "Compile",
      provider: "AWS · CodeBuild · 1"
    })
  })

  it("presents one exact Clockify entry with a deterministic rollup and inferred Jira attribution", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, clockifyInspection)

    expect(presentation).toMatchObject({
      displayKey: "time-entry-901",
      service: "clockify",
      verdict: "Approved",
      clockifyTimeEntry: {
        approvalLabel: "Approved",
        approvers: ["Ada Kline"],
        associationLabel: "Attributed",
        billableLabel: "Billable",
        contributorLabel: "Mina Ortiz",
        durationLabel: "2h 15m",
        projectLabel: "project-payments",
        rollupLabel: "1 visible entry · 135 exact minutes",
        totalMinutes: 135
      }
    })
    expect(presentation.clockifyTimeEntry?.jiraAssociations).toEqual([
      expect.objectContaining({ key: "OPS-429", state: "inferred" })
    ])

    const unattributed = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, {
      ...clockifyInspection,
      graph: { ...clockifyInspection.graph, relationships: [] }
    })
    expect(unattributed.clockifyTimeEntry).toMatchObject({
      associationLabel: "Unattributed",
      durationLabel: "2h 15m",
      rollupLabel: "1 visible entry · 135 exact minutes"
    })
  })

  it("counts only accepted pipeline relationships as delivery evidence", () => {
    const root = encodedWorkset.entityProjections.find(
      ({ projection }) => projection.details._tag === "pipeline-execution"
    )
    if (root?.projection.details._tag !== "pipeline-execution") {
      throw new Error("Expected a pipeline projection fixture")
    }
    const graphInspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
      ...encodedInspection,
      entity: {
        ...encodedInspection.entity,
        canonicalReleaseId: encodedWorkset.releaseId,
        projection: root.projection,
        recordedAt: root.recordedAt,
        releaseIds: [encodedWorkset.releaseId]
      },
      source: {
        ...sourceRevision,
        providerId: "codepipeline",
        vendorImmutableId: root.projection.details.executionId,
        revision: root.projection.details.triggerRevision,
        sourceUrl: null
      },
      graph: {
        ...encodedInspection.graph,
        evidenceClaims: encodedWorkset.evidenceClaims,
        evidenceItems: encodedWorkset.evidenceItems,
        nodes: encodedWorkset.nodes,
        relatedEntityProjections: encodedWorkset.entityProjections.filter(
          ({ projection }) => projection.entityId !== root.projection.entityId
        ),
        relationships: encodedWorkset.relationships,
        truncated: false
      }
    })
    const missingInspection: Inspection = {
      ...graphInspection,
      graph: {
        ...graphInspection.graph,
        relationships: graphInspection.graph.relationships.map((relationship) =>
          relationship.kind === "delivered-by" && relationship.targetNodeKind === "pipeline-execution"
            ? {
                ...relationship,
                lifecycle: {
                  _tag: "missing",
                  effectiveAt: relationship.lifecycle.effectiveAt,
                  reason: "Delivery evidence is not currently linked."
                }
              }
            : relationship
        )
      }
    }

    if (graphInspection.entity.projection.details._tag !== "pipeline-execution") {
      throw new Error("Expected a decoded pipeline projection fixture")
    }
    const accepted = presentWorkspacePipelineExecution(graphInspection.entity.projection.details, graphInspection)
    const missing = presentWorkspacePipelineExecution(graphInspection.entity.projection.details, missingInspection)

    expect(accepted).toMatchObject({ pullRequestCountLabel: "2", runbookCountLabel: "0" })
    expect(missing).toMatchObject({ pullRequestCountLabel: "0", runbookCountLabel: "0" })
  })

  it("counts only currently accepted issue and pipeline relationships as PR evidence", () => {
    const root = encodedWorkset.entityProjections.find(({ projection }) => projection.details._tag === "pull-request")
    if (root?.projection.details._tag !== "pull-request") {
      throw new Error("Expected a pull-request projection fixture")
    }
    const graphInspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
      ...encodedInspection,
      entity: {
        ...encodedInspection.entity,
        canonicalReleaseId: encodedWorkset.releaseId,
        projection: root.projection,
        recordedAt: root.recordedAt,
        releaseIds: [encodedWorkset.releaseId]
      },
      graph: {
        ...encodedInspection.graph,
        evidenceClaims: encodedWorkset.evidenceClaims,
        evidenceItems: encodedWorkset.evidenceItems,
        nodes: encodedWorkset.nodes,
        relatedEntityProjections: encodedWorkset.entityProjections.filter(
          ({ projection }) => projection.entityId !== root.projection.entityId
        ),
        relationships: encodedWorkset.relationships
      }
    })
    const implementation = graphInspection.graph.relationships.find(
      (relationship) => relationship.kind === "implements" && relationship.sourceNodeKind === "pull-request"
    )
    if (implementation === undefined || implementation.lifecycle._tag !== "verified") {
      throw new Error("Expected a verified PR implementation relationship")
    }
    const relatedIssueId = graphInspection.graph.nodes.find(
      ({ nodeId }) => nodeId === implementation.targetNodeId
    )?.resolution
    if (
      relatedIssueId?._tag !== "resolved" ||
      relatedIssueId.target._tag !== "entity" ||
      relatedIssueId.target.entityKind !== "issue"
    ) {
      throw new Error("Expected the implementation target to resolve to an issue")
    }
    const relatedIssueEntityId = relatedIssueId.target.entityId
    const rejectedInspection: Inspection = {
      ...graphInspection,
      graph: {
        ...graphInspection.graph,
        relationships: graphInspection.graph.relationships.map((relationship) =>
          relationship.relationshipId === implementation.relationshipId
            ? {
                ...relationship,
                lifecycle: {
                  _tag: "rejected",
                  effectiveAt: implementation.lifecycle.effectiveAt,
                  reason: "Rejected during graph review."
                }
              }
            : relationship
        )
      }
    }
    const details = graphInspection.entity.projection.details
    if (details._tag !== "pull-request") throw new Error("Expected pull-request details")
    const deletedInspection: Inspection = {
      ...graphInspection,
      graph: {
        ...graphInspection.graph,
        relatedEntityProjections: graphInspection.graph.relatedEntityProjections.map((entry) =>
          entry.projection.entityId === relatedIssueEntityId
            ? { ...entry, projection: { ...entry.projection, entityState: "deleted" } }
            : entry
        )
      }
    }

    const accepted = presentWorkspacePullRequest(details, graphInspection.source.sourceUrl, graphInspection)
    const rejected = presentWorkspacePullRequest(details, rejectedInspection.source.sourceUrl, rejectedInspection)
    const deleted = presentWorkspacePullRequest(details, deletedInspection.source.sourceUrl, deletedInspection)

    expect(accepted).toMatchObject({ issueCount: 3, pipelineCount: 1 })
    expect(rejected).toMatchObject({ issueCount: 2, pipelineCount: 1 })
    expect(deleted).toMatchObject({ issueCount: 2, pipelineCount: 1 })
  })

  it("renders malformed persisted pull-request timestamps as unavailable", () => {
    const encoded = Schema.encodeSync(WorkspaceEntityInspection)(pullRequestInspection)
    const details = encoded.entity.projection.details
    if (details._tag !== "pull-request") throw new Error("Expected a pull-request projection fixture")

    const malformed = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
      ...encoded,
      entity: {
        ...encoded.entity,
        projection: {
          ...encoded.entity.projection,
          details: { ...details, createdAt: "not-a-date" }
        }
      }
    })

    expect(presentWorkspaceEntity(WORKSET_WORKSPACE_ID, malformed).pullRequest?.createdAt).toBeNull()
  })

  it("keeps distinct Jira accounts with the same display name in the working circle", () => {
    const details = inspection.entity.projection.details
    if (details._tag !== "issue") throw new Error("Expected an issue projection fixture")
    const duplicateNameInspection = {
      ...inspection,
      entity: {
        ...inspection.entity,
        projection: {
          ...inspection.entity.projection,
          details: {
            ...details,
            collaborators: [
              ...(details.collaborators ?? []),
              {
                sourcePersonId: "account-alex-assignee",
                displayName: "Alex Lee",
                avatarUrl: null,
                active: true,
                roles: ["assignee"]
              },
              {
                sourcePersonId: "account-alex-commenter",
                displayName: "Alex Lee",
                avatarUrl: null,
                active: true,
                roles: ["commenter"]
              }
            ]
          }
        }
      }
    } satisfies Inspection

    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, duplicateNameInspection)

    expect(presentation.collaborators.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "account-alex-assignee", name: "Alex Lee", role: "Assignee" })
      ])
    )
    expect(presentation.collaborators.authors).toEqual([
      expect.objectContaining({ id: "account-alex-commenter", name: "Alex Lee", role: "Commenter" })
    ])
    expect(
      [
        ...presentation.collaborators.approvers,
        ...presentation.collaborators.authors,
        ...presentation.collaborators.operators,
        ...presentation.collaborators.owners,
        ...presentation.collaborators.reviewers
      ].filter(({ name }) => name === "Ada Kline")
    ).toHaveLength(1)
  })

  it("presents deleted related entities as unavailable", () => {
    const related = inspection.graph.relatedEntityProjections[0]
    if (related === undefined) throw new Error("Expected a related entity projection fixture")
    const deletedRelated = {
      ...related,
      projection: { ...related.projection, entityState: "deleted" }
    } satisfies typeof related
    const withDeletedRelated = {
      ...inspection,
      graph: {
        ...inspection.graph,
        relatedEntityProjections: inspection.graph.relatedEntityProjections.map((entry) =>
          entry.projection.entityId === related.projection.entityId ? deletedRelated : entry
        )
      }
    }
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, withDeletedRelated)
    const endpoints = presentation.relationships.flatMap(({ source, target }) => [source, target])

    expect(endpoints).toContainEqual({
      state: "missing",
      label: `${related.projection.title} · Deleted`,
      reason: "The related object was deleted.",
      service: "jira"
    })
  })

  it("returns a chained entity directly to its stored origin", async () => {
    const originHref = `/w/${WORKSET_WORKSPACE_ID}/releases/${encodedWorkset.releaseId}/preview?filter=attention`
    const firstEntityHref = `/w/${WORKSET_WORKSPACE_ID}/items/01890f6f-6d6a-7cc0-98d3-000000000002`
    const currentEntityHref = `/w/${WORKSET_WORKSPACE_ID}/items/${inspection.entity.projection.entityId}`
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () =>
      mountedRoot?.render(
        <MemoryRouter initialEntries={[originHref, firstEntityHref, currentEntityHref]} initialIndex={2}>
          <LocationProbe />
          <WorkspaceEntityView
            onAskAgent={() => undefined}
            originHref={originHref}
            originLabel="Back to release"
            originState={null}
            retry={() => undefined}
            state={state}
            workspaceId={WORKSET_WORKSPACE_ID}
          />
        </MemoryRouter>
      )
    )
    const backLink = [...host.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Back to release"
    )
    if (backLink === undefined) throw new Error("Expected the stored-origin Back link")

    await act(async () => backLink.click())

    expect(host.querySelector("[data-location]")?.textContent).toBe(originHref)
  })

  it("renders the complete stale partial state and launches the contextual agent", async () => {
    const onAskAgent = vi.fn()
    const host = await renderView(onAskAgent)

    expect(host.textContent).toContain("Review payment capture safeguards")
    expect(host.textContent).toContain("In review")
    expect(host.textContent).toContain("Open in Jira")
    expect(host.textContent).toContain("Working circle")
    expect(host.textContent).toContain("Ada Kline")
    expect(host.textContent).toContain("Issue Owner · Reviewer")
    expect(host.textContent).toContain("Delivery relationships")
    expect(host.textContent).toContain("Partial canonical view")
    expect(host.textContent).toContain("Issue synchronized")
    expect(host.textContent).toContain("Provenance")
    expect(host.textContent).toContain("Showing retained source data")
    expect(host.querySelector("article[data-workspace-entity-id]")).toBe(document.activeElement)

    const agentButton = host.querySelector<HTMLButtonElement>("[data-rly-agent-context-button]")
    if (agentButton === null) throw new Error("Expected the contextual agent button")
    await act(async () => agentButton.click())
    expect(onAskAgent).toHaveBeenCalledOnce()
  })

  it("renders a synchronized Jira issue as a complete read-only working document", async () => {
    const host = await renderView(() => undefined)

    expect(host.textContent).toContain("Customer impact")
    expect(host.textContent).toContain("Capture retries must never create a second charge.")
    expect(host.textContent).toContain("Acceptance criteria")
    expect(host.textContent).toContain("A repeated capture returns the original payment result.")
    expect(host.textContent).toContain("Mina Ortiz")
    expect(host.textContent).toContain("Assignee · Commenter")
    expect(host.textContent).toContain("Sandbox replay is green. I am waiting for the final reviewer.")
    expect(host.textContent).toContain("4 comments")
    expect(host.textContent).toContain("Only the newest synchronized comments are shown.")
    expect(host.textContent).toContain("Status")
    expect(host.textContent).toContain("In progress → In review")
    expect(host.textContent).toContain("Payments 2026.07")
    expect(host.textContent).toContain("OPS-400")
    expect(host.textContent).toContain("OPS-429")
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://jira.example.test/browse/OPS-400"]')).not.toBeNull()
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://jira.example.test/browse/OPS-429"]')).not.toBeNull()
    expect(host.querySelector("textarea")).toBeNull()
    expect(host.textContent).not.toContain("Edit issue")
  })

  it("renders the CodeCommit revision, human review, delivery evidence, and agent entry point", async () => {
    const onAskAgent = vi.fn()
    const host = await renderView(onAskAgent, pullRequestState)

    expect(host.textContent).toContain("feature/capture")
    expect(host.textContent).toContain("a5d8c9e4f013bdf17c2e6765579e2770f63e7b19")
    expect(host.textContent).toContain("91c3627b4ce7447e38c906529a4af4be6bc6812d")
    expect(host.textContent).toContain("Protect capture retries")
    expect(host.textContent).toContain("Alice")
    expect(host.textContent).toContain("Ada Kline")
    expect(host.textContent).toContain("Mina Ortiz")
    expect(host.textContent).toContain("Human review requested")
    expect(host.textContent).toContain("Agent review not run")
    expect(host.textContent).toContain("Open files and diff in CodeCommit")
    expect(host.querySelector("[data-workspace-pull-request-detail]")).not.toBeNull()
    const deliveryCounts = new Map(
      [...host.querySelectorAll("dt")].map((term) => [
        term.textContent,
        term.parentElement?.querySelector("dd")?.textContent
      ])
    )
    expect(deliveryCounts.get("Jira items")).toMatch(/\+$/u)
    expect(deliveryCounts.get("Pipeline runs")).toMatch(/\+$/u)

    const reviewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Ask Relay to review"
    )
    if (reviewButton === undefined) throw new Error("Expected the pull-request agent review button")
    await act(async () => reviewButton.click())
    expect(onAskAgent).toHaveBeenCalledOnce()
  })

  it("renders the complete CodePipeline execution without exposing provider artifact locations", async () => {
    const host = await renderView(() => undefined, pipelineState)

    expect(host.querySelector("[data-workspace-pipeline-execution-detail]")).not.toBeNull()
    expect(host.textContent).toContain("Payments deploy 9002")
    expect(host.textContent).toContain("Waiting for the production release gate")
    expect(host.textContent).toContain("Start Pipeline Execution")
    expect(host.textContent).toContain("Production · eu-west-1")
    expect(host.textContent).toContain("5m 42s")
    expect(host.textContent).toContain("Operator")
    expect(host.textContent).toContain("release-approver@example.test")
    expect(host.textContent).toContain("Execution path")
    expect(host.textContent).toContain("Release gate")
    expect(host.textContent).toContain("This is a bounded view")
    expect(host.textContent).toContain("BuildOutput")
    expect(host.textContent).toContain("Proxy required")
    expect(host.textContent).toContain("Pull requests")
    expect(host.textContent).toContain("Runbooks")
    expect(host.querySelectorAll("a[href*='bucket'], a[href*='artifact'], a[href*='logs']")).toHaveLength(0)
  })

  it("renders a read-only Clockify ledger and keeps an unattributed entry visible", async () => {
    const unattributedState = {
      ...clockifyState,
      inspection: {
        ...clockifyInspection,
        graph: { ...clockifyInspection.graph, relationships: [] }
      }
    } satisfies WorkspaceEntityState
    const host = await renderView(() => undefined, unattributedState)

    expect(host.querySelector("[data-workspace-clockify-time-entry-detail]")).not.toBeNull()
    expect(host.textContent).toContain("2h 15m")
    expect(host.textContent).toContain("1 visible entry · 135 exact minutes")
    expect(host.textContent).toContain("Review payment safeguards")
    expect(host.textContent).toContain("project-payments")
    expect(host.textContent).toContain("Mina Ortiz")
    expect(host.textContent).toContain("Unattributed")
    expect(host.textContent).toContain("The entry remains visible")
    expect(host.textContent).toContain("Corrections and approval remain read-only")
    expect(host.querySelector("input, textarea, select")).toBeNull()
  })

  it("renders a human-first Confluence document without executing content or exposing attachment media", async () => {
    const host = await renderView(() => undefined, confluenceState)

    expect(host.querySelector("[data-workspace-confluence-page-detail]")).not.toBeNull()
    expect(host.textContent).toContain("Payments release runbook")
    expect(host.textContent).toContain("Production recovery")
    expect(host.textContent).toContain("Revision12")
    expect(host.textContent).toContain("Ada Kline")
    expect(host.textContent).toContain("Owner · Author")
    expect(host.textContent).toContain("Mina Ortiz")
    expect(host.textContent).toContain("Watcher")
    expect(host.textContent).toContain("Add rollback verification")
    expect(host.textContent).toContain("rollback-evidence.pdf")
    expect(host.textContent).toContain("authenticated proxy required")
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://wiki.example.test/checklist"]')).not.toBeNull()
    expect(host.querySelector('a[href^="javascript:"], img, script, iframe')).toBeNull()
    expect(host.querySelector('a[href*="attachment"], a[href*="pixel.png"]')).toBeNull()
    expect(host.querySelector("textarea, input")).toBeNull()
    expect(host.textContent).not.toContain("Publish")
  })

  it("keeps same-name Confluence accounts distinct while collapsing an exact collaborator identity", () => {
    const presentation = presentWorkspaceEntity(WORKSET_WORKSPACE_ID, confluenceInspection)
    const collaborators = [
      ...presentation.collaborators.authors,
      ...presentation.collaborators.owners,
      ...presentation.collaborators.reviewers
    ]

    expect(collaborators.filter(({ name }) => name === "Alex Lee")).toHaveLength(2)
    expect(collaborators.filter(({ name }) => name === "Ada Kline")).toHaveLength(1)
    expect(collaborators.filter(({ id }) => id === "01890f6f-6d6a-7cc0-98d2-000000000071")).toHaveLength(1)
    expect(presentation.confluencePage?.contributors.filter(({ id }) => id === "account-mina")).toHaveLength(1)
    expect(presentation.confluencePage?.contributors.find(({ id }) => id === "account-mina")?.name).toBe("Mina Ortiz")
    expect(presentation.confluencePage?.contributors.find(({ id }) => id === "account-mina")?.role).toContain(
      "Watcher · Contributor"
    )
  })

  it("states the lazy Confluence content boundary without inventing a document body", async () => {
    const encoded = Schema.encodeSync(WorkspaceEntityInspection)(confluenceInspection)
    const lazyInspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
      ...encoded,
      entity: {
        ...encoded.entity,
        projection: {
          ...encoded.entity.projection,
          details: { ...encoded.entity.projection.details, content: null, contentState: "lazy" }
        }
      }
    })
    const host = await renderView(() => undefined, { ...confluenceState, inspection: lazyInspection })

    expect(host.textContent).toContain("Content has not been loaded")
    expect(host.textContent).toContain("Open the authenticated Confluence source")
    expect(host.querySelector("[data-workspace-rich-text]")).toBeNull()
  })

  it("renders a bounded release-membership count as a lower bound", async () => {
    const encoded = Schema.encodeSync(WorkspaceEntityInspection)(pullRequestInspection)
    const releaseIds = Array.from(
      { length: 500 },
      (_, index) => `01890f6f-6d6a-7cc0-98d4-${String(index + 11).padStart(12, "0")}`
    )
    const truncatedInspection = Schema.decodeUnknownSync(WorkspaceEntityInspection)({
      ...encoded,
      entity: {
        ...encoded.entity,
        canonicalReleaseId: releaseIds[0],
        releaseIds,
        releaseMembershipsTruncated: true
      }
    })
    const truncatedState = {
      ...pullRequestState,
      inspection: truncatedInspection
    } satisfies WorkspaceEntityState
    const host = await renderView(() => undefined, truncatedState)
    const releaseCount = [...host.querySelectorAll("dt")]
      .find((term) => term.textContent === "Releases")
      ?.parentElement?.querySelector("dd")

    expect(releaseCount?.textContent).toBe("500+")
  })

  it.each([
    [
      "a release",
      {
        hash: "#work",
        pathname: `/w/${WORKSET_WORKSPACE_ID}/releases/${encodedWorkset.releaseId}/preview`,
        search: "?filter=attention",
        state: null
      },
      {
        canonicalReleaseId: pullRequestInspection.entity.canonicalReleaseId,
        releaseIds: pullRequestInspection.entity.releaseIds,
        releaseMembershipsTruncated: pullRequestInspection.entity.releaseMembershipsTruncated
      },
      new Set([releaseWorksetFixture.releaseId]),
      `/w/${WORKSET_WORKSPACE_ID}/releases/${encodedWorkset.releaseId}/agent`
    ],
    [
      "a direct Items route with a portfolio release",
      {
        hash: "#review",
        pathname: `/w/${WORKSET_WORKSPACE_ID}/items`,
        search: "?q=payments",
        state: null
      },
      {
        canonicalReleaseId: pullRequestInspection.entity.canonicalReleaseId,
        releaseIds: pullRequestInspection.entity.releaseIds,
        releaseMembershipsTruncated: pullRequestInspection.entity.releaseMembershipsTruncated
      },
      new Set([releaseWorksetFixture.releaseId]),
      `/w/${WORKSET_WORKSPACE_ID}/releases/${encodedWorkset.releaseId}/agent`
    ],
    [
      "a direct Items route with an out-of-portfolio release",
      {
        hash: "#review",
        pathname: `/w/${WORKSET_WORKSPACE_ID}/items`,
        search: "?q=payments",
        state: null
      },
      {
        canonicalReleaseId: pullRequestInspection.entity.canonicalReleaseId,
        releaseIds: pullRequestInspection.entity.releaseIds,
        releaseMembershipsTruncated: pullRequestInspection.entity.releaseMembershipsTruncated
      },
      new Set<typeof releaseWorksetFixture.releaseId>(),
      `/agent?from=${encodeURIComponent(
        `/w/${WORKSET_WORKSPACE_ID}/items?q=payments&object=${encodeURIComponent(
          pullRequestInspection.entity.projection.entityId
        )}#item-details`
      )}`
    ]
  ])(
    "routes the agent safely from a pull request reached through %s",
    async (_label, origin, releaseContext, routableReleaseIds, expected) => {
      const entityHref = `/w/${WORKSET_WORKSPACE_ID}/items/${pullRequestInspection.entity.projection.entityId}`
      const RoutedPullRequest = (): ReactElement => {
        const location = useLocation()
        const navigate = useNavigate()
        const agentPath = workspaceEntityAgentPath(
          origin,
          WORKSET_WORKSPACE_ID,
          location,
          releaseContext,
          routableReleaseIds
        )
        return (
          <WorkspaceEntityView
            onAskAgent={() => navigate(agentPath)}
            originHref={`${origin.pathname}${origin.search}${origin.hash}`}
            originLabel="Back to context"
            originState={null}
            retry={() => undefined}
            state={pullRequestState}
            workspaceId={WORKSET_WORKSPACE_ID}
          />
        )
      }
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)
      await act(async () =>
        mountedRoot?.render(
          <MemoryRouter initialEntries={[entityHref]}>
            <LocationProbe />
            <RoutedPullRequest />
          </MemoryRouter>
        )
      )
      const reviewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Ask Relay to review"
      )
      if (reviewButton === undefined) throw new Error("Expected the pull-request agent review button")

      await act(async () => reviewButton.click())

      expect(host.querySelector("[data-location]")?.textContent).toBe(expected)
    }
  )

  it("distinguishes a shortened comment body from an omitted-comments collection", async () => {
    const details = inspection.entity.projection.details
    if (details._tag !== "issue") throw new Error("Expected an issue projection fixture")
    const clippedInspection = {
      ...inspection,
      entity: {
        ...inspection.entity,
        projection: {
          ...inspection.entity.projection,
          details: {
            ...details,
            comments: [
              {
                sourceId: "comment-41",
                authorSourcePersonId: "account-mina",
                updateAuthorSourcePersonId: null,
                body: "m".repeat(16_000),
                createdAt: "2026-07-14T09:30:00.000Z",
                updatedAt: null
              }
            ],
            commentTotal: 1,
            commentsTruncated: false,
            commentBodiesTruncated: true,
            truncatedFields: ["comments"]
          }
        }
      }
    } satisfies Inspection
    const clippedState = { ...state, inspection: clippedInspection } satisfies WorkspaceEntityState
    const host = await renderView(() => undefined, clippedState)

    expect(host.textContent).toContain("Jira shortened comment bodies to keep this synchronized view bounded.")
    expect(host.textContent).not.toContain("Only the newest synchronized comments are shown.")
  })

  it("distinguishes clipped history values from omitted history entries", async () => {
    const details = inspection.entity.projection.details
    if (details._tag !== "issue") throw new Error("Expected an issue projection fixture")
    const clippedInspection = {
      ...inspection,
      entity: {
        ...inspection.entity,
        projection: {
          ...inspection.entity.projection,
          details: {
            ...details,
            historyTotal: details.history?.length ?? 0,
            historyTruncated: false,
            truncatedFields: ["history"]
          }
        }
      }
    } satisfies Inspection
    const clippedState = { ...state, inspection: clippedInspection } satisfies WorkspaceEntityState
    const host = await renderView(() => undefined, clippedState)

    expect(host.textContent).toContain("Jira shortened History to keep this synchronized view bounded.")
    expect(host.textContent).not.toContain("Only the newest synchronized history is shown.")
  })
})
