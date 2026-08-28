import { NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as CodeCommitDomain from "@knpkv/codecommit-core/Domain.js"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Redacted, Ref, Result, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"

import {
  AgentModelId,
  type AgentProviderCatalog,
  DurableAgentProviderId,
  PublishedReviewComment,
  PullRequestReviewNotStarted,
  PullRequestReviewPending,
  PullRequestReviewThreadPage,
  ReleaseAgentThreadCursor,
  type ReviewAgentProfile,
  ReviewAgentProfileId,
  ReviewSuggestionPublicationAuthorityBinding,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationPreview
} from "../../src/api/agent.js"
import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import { WorkspaceEntityInspection } from "../../src/api/deliveryGraph.js"
import type { ControlCenterLiveEvent } from "../../src/api/liveEvents.js"
import {
  type AtlassianOAuthGrantStartResponse,
  type AtlassianProfileDiscoveryResponse,
  type AwsResourceDiscoveryResponse,
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  PluginConfiguration,
  PluginConfigurationKey,
  PluginConnectionAdministration,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginSynchronizationState,
  ProviderAccountSummary
} from "../../src/api/plugins.js"
import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import {
  CurrentSession,
  CurrentSessionResponse,
  SessionCookieAuth,
  SessionMutationAuth,
  SessionSummary
} from "../../src/api/session.js"
import {
  workspaceSettingsEtag,
  WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision
} from "../../src/api/workspaceSettings.js"
import { DeliveryEntityProjection, LedgerRevision } from "../../src/domain/deliveryGraph.js"
import type { GovernedActionState } from "../../src/domain/governedAction/index.js"
import {
  AgentId,
  EntityId,
  EventCursor,
  FollowedResourceId,
  GovernedActionId,
  JobId,
  PluginConnectionId,
  ProviderAccountId,
  PrReviewSuggestionRevisionId,
  RelationshipId,
  RelationshipRepairProposalId,
  RelationshipRepairReviewId,
  ReleaseId,
  ShareId,
  WorkspaceId,
  WorkspaceSettingsMutationId
} from "../../src/domain/identifiers.js"
import { PluginProviderOperationId, PluginProviderReceiptV1 } from "../../src/domain/plugins/actions.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestion, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import {
  PrReviewSuggestionEdit,
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPageSize,
  PrReviewSuggestionRevisionSequence,
  PrReviewSuggestionValidated
} from "../../src/domain/prReviewRevision.js"
import { RelationshipRepairProposal } from "../../src/domain/relationshipRepair.js"
import { Revision } from "../../src/domain/sourceRevision.js"
import { TimelineEventDetail } from "../../src/domain/timeline.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"
import { ApiBindConfiguration } from "../../src/server/api/ApiConfiguration.js"
import {
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  AuthorizedShares,
  CodePipelineReads,
  DeliveryGraphInspection,
  LiveEvents,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  PullRequestReviews,
  RelationshipRepairProposals,
  ReleaseAgentJobs,
  ReleaseAgentTurns,
  TimelineExportAudits,
  TimelineReads,
  WorkspaceSettingsAdministration
} from "../../src/server/api/ApplicationServices.js"
import { controlCenterApiLayer } from "../../src/server/api/ControlCenterApiServer.js"
import {
  agentHandlersLayer,
  deliveryGraphHandlersLayer,
  liveEventHandlersLayer,
  pluginHandlersLayer,
  portfolioHandlersLayer,
  shareHandlersLayer,
  timelineHandlersLayer,
  workspaceSettingsHandlersLayer
} from "../../src/server/api/Handlers.js"
import {
  DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION,
  LiveStreamAdmission
} from "../../src/server/api/LiveStreamAdmission.js"
import {
  ClockifyActionSubmissionError,
  ClockifyActionSubmissions
} from "../../src/server/application/clockifyActionSubmissions.js"
import {
  ReleasePublicationSubmissionError,
  ReleasePublicationSubmissions
} from "../../src/server/application/releasePublicationSubmissions.js"
import { Auth } from "../../src/server/auth/Auth.js"
import { CredentialRejectedError } from "../../src/server/auth/errors.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import { makeNodePortfolioSnapshot } from "../fixtures/portfolio.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"

const session = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
  workspaceId,
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})
if (session.actor._tag !== "human") throw new Error("Expected a human handler fixture")
const sessionPersonId = session.actor.personId

const snapshot = Schema.decodeSync(PortfolioSnapshot)({
  workspaceId,
  eventCursor: 0,
  generatedAt: "2026-07-14T10:02:00.000Z",
  releases: [],
  plugins: []
})
const timelineDetail = Schema.decodeSync(TimelineEventDetail)({
  event: {
    eventKey: "domain:event-42",
    occurredAt: "2026-07-14T10:02:00.000Z",
    actor: { kind: "agent", label: "Release agent" },
    sourceKind: "system",
    service: null,
    eventType: "agent-reviewed",
    title: "Agent reviewed",
    href: null
  },
  identifiers: {
    actorId: "agent-7",
    actionId: null,
    relationshipId: null,
    pluginConnectionId: null,
    releaseId: null,
    entityId: null
  },
  agentJob: { jobId: "job-9" }
})
const inspectedReleaseId = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000004")
const pluginConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000010")
const confluencePluginConnectionId = Schema.decodeSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000011"
)
const codeCommitPluginConnectionId = Schema.decodeSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000012"
)
const providerAccountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000013")
const followedResourceId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000014")
const inspectedRelationshipId = Schema.decodeSync(RelationshipId)(
  "01890f6f-6d6a-7cc0-98d2-000000000005"
)
const repairProposalId = Schema.decodeSync(RelationshipRepairProposalId)(
  "01890f6f-6d6a-7cc0-98d2-000000000006"
)
const repairReviewId = Schema.decodeSync(RelationshipRepairReviewId)(
  "01890f6f-6d6a-7cc0-98d2-000000000007"
)
const inspectedRelationshipRevision = Schema.decodeSync(LedgerRevision)(1)
const sharedEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-00000000000a")
const missingEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-00000000000e")
const authorizedShareId = Schema.decodeSync(ShareId)("01890f6f-6d6a-7cc0-98d2-00000000000b")
const otherShareWorkspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-00000000000c")
const sharedProjection = Schema.decodeSync(DeliveryEntityProjection)({
  workspaceId,
  entityId: sharedEntityId,
  projectionRevision: 1,
  sourceEntityRevision: 1,
  supersedesProjectionRevision: null,
  projectionSchemaVersion: 1,
  entityState: "present",
  entityType: "issue",
  displayKey: "PAY-42",
  title: "Ship guarded refunds",
  details: {
    _tag: "issue",
    key: "PAY-42",
    status: "Ready",
    priority: "High",
    estimatePoints: 5
  }
})
const workspaceEntityInspection = Schema.decodeSync(WorkspaceEntityInspection)({
  clockifyApproval: null,
  entity: {
    canonicalReleaseId: null,
    owners: [],
    ownersTruncated: false,
    releaseIds: [],
    releaseMembershipsTruncated: false,
    projection: Schema.encodeSync(DeliveryEntityProjection)(sharedProjection),
    recordedAt: "2026-07-14T10:02:00.000Z"
  },
  source: {
    providerId: "jira",
    pluginConnectionId,
    vendorImmutableId: "PAY-42",
    revision: "source-1",
    sourceUrl: "https://jira.example/browse/PAY-42",
    firstObservedAt: "2026-07-14T09:58:00.000Z",
    lastObservedAt: "2026-07-14T10:00:00.000Z",
    synchronizedAt: "2026-07-14T10:01:00.000Z",
    normalizationSchemaVersion: 1
  },
  isSourceCurrent: true,
  freshness: null,
  graph: {
    truncated: false,
    nodes: [],
    relatedEntityProjections: [],
    relationships: [],
    evidenceClaims: [],
    evidenceItems: []
  },
  activity: { truncated: false, events: [] }
})
const codeCommitPullRequestEntityId = Schema.decodeSync(EntityId)(
  "01890f6f-6d6a-7cc0-98d2-00000000006a"
)
const codeCommitPullRequestInspectionForRegion = (region: string) =>
  Schema.decodeSync(WorkspaceEntityInspection)({
    ...Schema.encodeSync(WorkspaceEntityInspection)(workspaceEntityInspection),
    entity: {
      ...Schema.encodeSync(WorkspaceEntityInspection)(workspaceEntityInspection).entity,
      projection: {
        ...Schema.encodeSync(DeliveryEntityProjection)(sharedProjection),
        entityId: codeCommitPullRequestEntityId,
        entityType: "pull-request",
        displayKey: "42",
        title: "Protect payment retries",
        details: {
          _tag: "pull-request",
          repository: "payments",
          sourceBranch: "feature/retries",
          targetBranch: "main",
          headRevision: "a".repeat(40),
          baseRevision: "b".repeat(40),
          mergeBaseRevision: "c".repeat(40),
          reviewState: "requested",
          lifecycle: "open",
          description: "Keep retries idempotent.",
          authorReference: "arn:aws:iam::123456789012:user/alice",
          createdAt: "2026-07-14T09:00:00.000Z",
          updatedAt: "2026-07-14T10:00:00.000Z"
        }
      }
    },
    source: {
      providerId: "codecommit",
      pluginConnectionId: codeCommitPluginConnectionId,
      vendorImmutableId: "42",
      revision: "a".repeat(40),
      sourceUrl:
        `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=${region}`,
      firstObservedAt: "2026-07-14T09:58:00.000Z",
      lastObservedAt: "2026-07-14T10:00:00.000Z",
      synchronizedAt: "2026-07-14T10:01:00.000Z",
      normalizationSchemaVersion: 1
    }
  })
const watcherSession = SessionSummary.make({ ...session, permission: "watcher" })
const reviewerSession = SessionSummary.make({ ...session, permission: "reviewer" })
const agentOwnerSession = SessionSummary.make({
  ...session,
  actor: {
    _tag: "agent",
    agentId: AgentId.make("01890f6f-6d6a-7cc0-98d2-00000000000d")
  }
})

const assertForbidden = <A, E extends { readonly _tag: string }>(attempted: Result.Result<A, E>) => {
  assert.isTrue(Result.isFailure(attempted))
  if (Result.isFailure(attempted)) assert.strictEqual(attempted.failure._tag, "ForbiddenApiError")
}

const approverSession = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000008",
  workspaceId,
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000009" },
  permission: "workspace-approver",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})

const sessionMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
  sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, session)
})

const mutationMiddlewareLayer = Layer.succeed(SessionMutationAuth, {
  csrfToken: (effect) => effect
})

const portfolioLayer = Layer.succeed(PortfolioSnapshots, {
  snapshot: (requestedWorkspaceId) =>
    requestedWorkspaceId === session.workspaceId
      ? Effect.succeed(snapshot)
      : Effect.die("portfolio handler crossed a workspace boundary")
})

const timelineLayer = Layer.succeed(TimelineReads, {
  detail: ({ eventKey, workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId && eventKey === timelineDetail.event.eventKey
      ? Effect.succeed(timelineDetail)
      : Effect.die("timeline detail handler crossed a workspace or event boundary"),
  page: ({ workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId
      ? Effect.succeed({ events: [], nextCursor: null })
      : Effect.die("timeline handler crossed a workspace boundary")
})

const timelineExportAuditsLayer = Layer.succeed(TimelineExportAudits, {
  record: () => Effect.void
})

const timelineApplicationLayer = Layer.merge(timelineLayer, timelineExportAuditsLayer)

const deliveryGraphLayer = Layer.succeed(DeliveryGraphInspection, {
  workspaceEntity: ({ entityId, workspaceId: requestedWorkspaceId }) => {
    if (requestedWorkspaceId !== session.workspaceId) {
      return Effect.die("workspace entity handler crossed its workspace boundary")
    }
    return entityId === sharedEntityId
      ? Effect.succeed(workspaceEntityInspection)
      : Effect.fail(new ApplicationResourceNotFound())
  },
  workspaceEntityProjections: ({
    owner,
    query,
    service,
    status,
    type,
    workspaceId: requestedWorkspaceId
  }) =>
    requestedWorkspaceId === session.workspaceId
      ? Effect.succeed({
        matchedCount: query === "refunds" &&
            owner === sessionPersonId &&
            service === "jira" &&
            status === "active" &&
            type === "issue"
          ? 1
          : 0,
        ownerOptions: [],
        ownerOptionsTruncated: false,
        totalCount: 1,
        truncated: false,
        items: []
      })
      : Effect.die("delivery graph handler crossed its workspace boundary"),
  releaseSlice: ({ environmentId, releaseId, workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId && releaseId === inspectedReleaseId
      ? Effect.succeed({
        releaseId,
        environmentId,
        truncated: false,
        nodes: [],
        entityProjections: [],
        relationships: [],
        evidenceClaims: [],
        evidenceItems: []
      })
      : Effect.die("delivery graph handler crossed its workspace or release boundary"),
  repairCandidates: ({ environmentId, releaseId, workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId && releaseId === inspectedReleaseId
      ? Effect.succeed({ releaseId, environmentId, truncated: false, candidates: [] })
      : Effect.die("repair candidate handler crossed its workspace or release boundary"),
  repairProposalDraft: () => Effect.die("not used"),
  relationship: () => Effect.die("not used"),
  relationshipHistory: () => Effect.die("not used"),
  evidence: () => Effect.die("not used")
})

const relationshipRepairProposalsLayer = Layer.succeed(RelationshipRepairProposals, {
  apply: () => Effect.die("not used"),
  create: () => Effect.die("not used"),
  get: () => Effect.die("not used"),
  list: () => Effect.die("not used"),
  review: () => Effect.die("not used")
})

const deliveryGraphApplicationLayer = Layer.merge(
  deliveryGraphLayer,
  relationshipRepairProposalsLayer
)

const authorizedSharesLayer = Layer.succeed(AuthorizedShares, {
  create: () => Effect.die("not used"),
  resolve: () =>
    Effect.succeed({
      share: {
        shareId: authorizedShareId,
        entityId: sharedEntityId,
        granteePersonId: sessionPersonId,
        createdAt: session.createdAt,
        expiresAt: session.absoluteExpiresAt,
        revokedAt: null
      },
      item: { projection: sharedProjection, recordedAt: session.lastSeenAt }
    }),
  revoke: () => Effect.die("not used")
})

const releaseAgentJobsLayer = Layer.succeed(ReleaseAgentJobs, {
  enqueue: () => Effect.die("not used"),
  providers: () => Effect.succeed({ providers: [] }),
  replay: () => Effect.die("not used")
})

const pullRequestReviewsLayer = Layer.succeed(PullRequestReviews, {
  thread: () => Effect.die("not used"),
  current: () => Effect.die("not used"),
  enqueue: () => Effect.die("not used"),
  cancel: () => Effect.die("not used"),
  extendBudget: () => Effect.die("not used"),
  revisions: () => Effect.die("not used"),
  editSuggestion: () => Effect.die("not used"),
  targetSuggestion: () => Effect.die("not used"),
  dismissSuggestion: () => Effect.die("not used"),
  previewPublication: () => Effect.die("not used"),
  publishSuggestion: () => Effect.die("not used")
})

const agentLayer = Layer.mergeAll(
  Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }),
  releaseAgentJobsLayer,
  pullRequestReviewsLayer
)

const liveEvents = LiveEvents.of({ open: () => Effect.succeed(Stream.never) })
const liveEventsLayer = Layer.succeed(LiveEvents, liveEvents)

const streamAuthentication = Auth.of({
  authenticate: () => Effect.succeed(session),
  authorizeMutation: () => Effect.die("not used"),
  bootstrapOwnerPairing: () => Effect.die("not used"),
  consumePairingCode: () => Effect.die("not used"),
  issuePairingCode: () => Effect.die("not used"),
  listPairingCodes: () => Effect.die("not used"),
  listSessions: () => Effect.die("not used"),
  logout: () => Effect.die("not used"),
  recoverCsrfToken: () => Effect.die("not used"),
  revokePairingCode: () => Effect.die("not used"),
  revokeSession: () => Effect.die("not used")
})

const liveEventHandlerTestLayer = liveEventHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(Layer.succeed(Auth, streamAuthentication)),
  Layer.provide(LiveStreamAdmission.layer),
  Layer.provide(ServerLifecycle.layer),
  Layer.provide(Layer.succeed(LiveEvents, {
    open: ({ after }) => {
      const heartbeat: ControlCenterLiveEvent = {
        event: "stream.heartbeat",
        data: { eventCursor: after ?? EventCursor.make(0), sentAt: session.lastSeenAt }
      }
      return Effect.succeed(Stream.make(heartbeat))
    }
  }))
)

const portfolioHandlersTestLayer = portfolioHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(portfolioLayer)
)

const timelineHandlersTestLayer = timelineHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(timelineApplicationLayer)
)

const deliveryGraphHandlersTestLayer = deliveryGraphHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(mutationMiddlewareLayer),
  Layer.provide(deliveryGraphApplicationLayer)
)

describe("Control Center API handlers", () => {
  it.effect("keeps governed settings private while sharing presentation with a reviewer", () =>
    Effect.gen(function*() {
      const reviewerMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, reviewerSession)
      })
      const reads = yield* Ref.make(0)
      const revision = WorkspaceSettingsRevision.make(1)
      const readModel = WorkspaceSettingsReadModel.make({
        workspaceId: session.workspaceId,
        revision,
        etag: workspaceSettingsEtag(revision),
        settings: {
          ...DEFAULT_WORKSPACE_SETTINGS,
          presentation: {
            defaultLanding: "active-work",
            density: "compact"
          }
        },
        createdAt: session.createdAt,
        updatedAt: session.lastSeenAt,
        updatedByPersonId: null
      })
      const handler = workspaceSettingsHandlersLayer.pipe(
        Layer.provide(reviewerMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(
          Layer.succeed(WorkspaceSettingsAdministration, {
            read: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(readModel)),
            update: () => Effect.die("not used")
          })
        ),
        Layer.provide(ServerLifecycle.layer)
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, [
          "workspaceSettings"
        ])
        const governed = yield* client.workspaceSettings.read().pipe(Effect.result)
        const presentation = yield* client.workspaceSettings.readPresentation()
        return { governed, presentation }
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          reviewerMiddlewareLayer,
          handler
        ])
      )

      assertForbidden(result.governed)
      assert.deepStrictEqual(result.presentation, {
        workspaceId: session.workspaceId,
        revision,
        presentation: {
          defaultLanding: "active-work",
          density: "compact"
        }
      })
      assert.strictEqual(yield* Ref.get(reads), 1)
    }))

  it.effect("admits lazy settings initialization only before server drain", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const reads = yield* Ref.make(0)
      const revision = WorkspaceSettingsRevision.make(1)
      const readModel = {
        workspaceId: session.workspaceId,
        revision,
        etag: workspaceSettingsEtag(revision),
        settings: DEFAULT_WORKSPACE_SETTINGS,
        createdAt: session.createdAt,
        updatedAt: session.lastSeenAt,
        updatedByPersonId: null
      }
      const handler = workspaceSettingsHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(
          Layer.succeed(WorkspaceSettingsAdministration, {
            read: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(readModel)),
            update: () => Effect.die("not used")
          })
        ),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["workspaceSettings"])
        const accepted = yield* client.workspaceSettings.read()
        yield* lifecycle.beginDrain
        const rejected = yield* client.workspaceSettings.read().pipe(Effect.result)
        return { accepted, rejected }
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ])
      )

      assert.strictEqual(result.accepted.revision, revision)
      assert.strictEqual(yield* Ref.get(reads), 1)
      assert.isTrue(Result.isFailure(result.rejected))
      if (Result.isFailure(result.rejected)) {
        assert.strictEqual(result.rejected.failure._tag, "ServiceUnavailableApiError")
      }
    }))

  it.effect("derives workspace-settings mutation attribution from the owner session", () =>
    Effect.gen(function*() {
      const received = yield* Ref.make<unknown>(null)
      const revision = WorkspaceSettingsRevision.make(1)
      const readModel = {
        workspaceId: session.workspaceId,
        revision,
        etag: workspaceSettingsEtag(revision),
        settings: DEFAULT_WORKSPACE_SETTINGS,
        createdAt: session.createdAt,
        updatedAt: session.lastSeenAt,
        updatedByPersonId: null
      }
      const settings = Layer.succeed(WorkspaceSettingsAdministration, {
        read: () => Effect.succeed(readModel),
        update: (input) =>
          Ref.set(received, input).pipe(
            Effect.as({
              ...readModel,
              revision: WorkspaceSettingsRevision.make(2),
              etag: workspaceSettingsEtag(WorkspaceSettingsRevision.make(2)),
              settings: input.request.settings,
              updatedByPersonId: input.session.actor._tag === "human"
                ? input.session.actor.personId
                : null
            })
          )
      })
      const handler = workspaceSettingsHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(settings),
        Layer.provide(ServerLifecycle.layer)
      )
      const mutationId = WorkspaceSettingsMutationId.make(
        "01890f6f-6d6a-7cc0-98d2-000000000191"
      )
      const candidate = {
        ...DEFAULT_WORKSPACE_SETTINGS,
        inference: {
          ...DEFAULT_WORKSPACE_SETTINGS.inference,
          minimumConfidencePercent: 91
        }
      }
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, [
          "workspaceSettings"
        ])
        return yield* client.workspaceSettings.update({
          payload: {
            mutationId,
            expectedRevision: revision,
            settings: candidate,
            acknowledgedGovernedSections: []
          }
        })
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ])
      )

      assert.strictEqual(result.revision, 2)
      assert.deepInclude(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        session,
        request: {
          mutationId,
          expectedRevision: revision,
          settings: candidate,
          acknowledgedGovernedSections: []
        }
      })
    }))

  it.effect("submits an exact-revision Clockify approval through the authenticated product boundary", () =>
    Effect.gen(function*() {
      const received = yield* Ref.make<unknown>(null)
      const actionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
      const applications = Layer.mergeAll(
        deliveryGraphApplicationLayer,
        Layer.succeed(ClockifyActionSubmissions, {
          submit: (input) => Ref.set(received, input).pipe(Effect.as({ actionId, state: "succeeded" }))
        })
      )
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(applications)
      )
      const expectedRevision = Revision.make("clockify-revision-42")
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.submitClockifyAction({
          params: { entityId: sharedEntityId },
          payload: {
            _tag: "record-approval",
            expectedRevision,
            decision: "approved",
            rationale: "Reviewed against the delivery record"
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, { actionId, state: "succeeded" })
      assert.deepInclude(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        entityId: sharedEntityId,
        request: {
          _tag: "record-approval",
          expectedRevision,
          decision: "approved",
          rationale: "Reviewed against the delivery record"
        }
      })
    }))

  it.effect("maps Clockify submission failures through the documented HTTP contract", () =>
    Effect.gen(function*() {
      const expectedRevision = Revision.make("clockify-revision-42")
      const request = Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.submitClockifyAction({
          params: { entityId: sharedEntityId },
          payload: {
            _tag: "record-approval",
            expectedRevision,
            decision: "approved",
            rationale: "Reviewed against the delivery record"
          }
        })
      })
      const attempt = (reason: ClockifyActionSubmissionError["reason"]) => {
        const applications = Layer.mergeAll(
          deliveryGraphApplicationLayer,
          Layer.succeed(ClockifyActionSubmissions, {
            submit: () => Effect.fail(new ClockifyActionSubmissionError({ reason }))
          })
        )
        const handler = deliveryGraphHandlersLayer.pipe(
          Layer.provide(sessionMiddlewareLayer),
          Layer.provide(mutationMiddlewareLayer),
          Layer.provide(applications)
        )
        return request.pipe(
          Effect.provide([
            NodeHttpServer.layerHttpServices,
            mutationMiddlewareLayer,
            sessionMiddlewareLayer,
            handler
          ]),
          Effect.result
        )
      }

      const conflict = yield* attempt("conflict")
      const forbidden = yield* attempt("forbidden")
      const invalid = yield* attempt("invalid-request")
      const unavailable = yield* attempt("unavailable")
      const missingService = yield* request.pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          deliveryGraphHandlersTestLayer
        ]),
        Effect.result
      )

      assert.isTrue(Result.isFailure(conflict))
      assert.isTrue(Result.isFailure(forbidden))
      assert.isTrue(Result.isFailure(invalid))
      assert.isTrue(Result.isFailure(unavailable))
      assert.isTrue(Result.isFailure(missingService))
      if (
        Result.isFailure(conflict) &&
        Result.isFailure(forbidden) &&
        Result.isFailure(invalid) &&
        Result.isFailure(unavailable) &&
        Result.isFailure(missingService)
      ) {
        assert.strictEqual(conflict.failure._tag, "ConflictApiError")
        assert.strictEqual(forbidden.failure._tag, "ForbiddenApiError")
        assert.strictEqual(invalid.failure._tag, "InvalidRequestApiError")
        assert.strictEqual(unavailable.failure._tag, "ServiceUnavailableApiError")
        assert.strictEqual(missingService.failure._tag, "ServiceUnavailableApiError")
      }
    }))

  it.effect("creates an exact share from session-derived human owner authority", () =>
    Effect.gen(function*() {
      const received = yield* Ref.make<
        {
          readonly workspaceId: string
          readonly createdByPersonId: string
          readonly sessionId: string
        } | null
      >(null)
      const shares = Layer.succeed(AuthorizedShares, {
        create: (input) =>
          Ref.set(received, {
            workspaceId: input.workspaceId,
            createdByPersonId: input.createdByPersonId,
            sessionId: input.sessionId
          }).pipe(Effect.as({
            shareId: input.request.shareId,
            entityId: input.request.entityId,
            granteePersonId: input.request.granteePersonId,
            createdAt: session.lastSeenAt,
            expiresAt: input.request.expiresAt,
            revokedAt: null
          })),
        resolve: () => Effect.die("not used"),
        revoke: () => Effect.die("not used")
      })
      const handler = shareHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(shares)
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["shares"])
        return yield* client.shares.create({
          payload: {
            shareId: authorizedShareId,
            entityId: sharedEntityId,
            granteePersonId: sessionPersonId,
            expiresAt: session.absoluteExpiresAt
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(result.shareId, authorizedShareId)
      assert.deepStrictEqual(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        createdByPersonId: sessionPersonId,
        sessionId: session.sessionId
      })
    }))

  it.effect("rejects a watcher before authorized-share persistence", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = shareHandlersLayer.pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(AuthorizedShares, {
          create: () => Effect.die("watcher reached authorized-share persistence"),
          resolve: () => Effect.die("not used"),
          revoke: () => Effect.die("not used")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["shares"])
        return yield* client.shares.create({
          payload: {
            shareId: authorizedShareId,
            entityId: sharedEntityId,
            granteePersonId: sessionPersonId,
            expiresAt: session.absoluteExpiresAt
          }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ForbiddenApiError")
    }))

  it.effect("serves the authenticated workspace entity index", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
      const result = yield* client.deliveryGraph.workspaceEntityProjections({ query: {} })

      assert.deepStrictEqual(result, {
        matchedCount: 0,
        ownerOptions: [],
        ownerOptionsTruncated: false,
        totalCount: 1,
        truncated: false,
        items: []
      })

      const filtered = yield* client.deliveryGraph.workspaceEntityProjections({
        query: { owner: sessionPersonId, q: "refunds", service: "jira", status: "active", type: "issue" }
      })
      assert.deepStrictEqual(filtered, {
        matchedCount: 1,
        ownerOptions: [],
        ownerOptionsTruncated: false,
        totalCount: 1,
        truncated: false,
        items: []
      })
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        deliveryGraphHandlersTestLayer
      ])
    ))

  it.effect("resolves a CodeCommit link in one authenticated server-side batch", () =>
    Effect.gen(function*() {
      const entityReads = yield* Ref.make(0)
      const accountBound = yield* Ref.make(false)
      const selectedRegion = yield* Ref.make("eu-west-1")
      const connected = Schema.decodeUnknownSync(PluginConnectionSummary)({
        pluginConnectionId: codeCommitPluginConnectionId,
        providerAccountId,
        followedResourceId: null,
        providerId: "codecommit",
        displayName: "Payments repository",
        revision: 1,
        isEnabled: true,
        supportsSynchronization: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      })
      const unbound = Schema.decodeUnknownSync(PluginConnectionSummary)({
        ...Schema.encodeSync(PluginConnectionSummary)(connected),
        providerAccountId: null
      })
      const account = Schema.decodeUnknownSync(ProviderAccountSummary)({
        providerAccountId,
        providerFamily: "aws",
        displayName: "Production",
        providerImmutableId: "123456789012",
        resources: []
      })
      const plugins = PluginAdministration.of({
        accounts: () => Effect.succeed([account]),
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Ref.get(accountBound).pipe(Effect.map((bound) => [bound ? connected : unbound])),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const approverMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const inspection = Layer.succeed(DeliveryGraphInspection, {
        codeCommitPullRequestCandidates: (
          { pullRequestId, region, repositoryName, workspaceId: requestedWorkspaceId }
        ) =>
          Ref.get(selectedRegion).pipe(
            Effect.flatMap((expectedRegion) =>
              requestedWorkspaceId === session.workspaceId &&
                region === expectedRegion &&
                repositoryName === "payments" &&
                pullRequestId === "42"
                ? Effect.succeed({ entityIds: [codeCommitPullRequestEntityId], truncated: false })
                : Effect.die("CodeCommit resolution crossed its exact lookup boundary")
            )
          ),
        workspaceEntity: ({ entityId, workspaceId: requestedWorkspaceId }) =>
          requestedWorkspaceId === session.workspaceId && entityId === codeCommitPullRequestEntityId
            ? Ref.update(entityReads, (count) => count + 1).pipe(
              Effect.andThen(Ref.get(selectedRegion)),
              Effect.map(codeCommitPullRequestInspectionForRegion)
            )
            : Effect.die("CodeCommit resolution crossed its candidate boundary"),
        workspaceEntityProjections: () => Effect.die("exact CodeCommit resolution used generic search"),
        releaseSlice: () => Effect.die("not used"),
        repairCandidates: () => Effect.die("not used"),
        repairProposalDraft: () => Effect.die("not used"),
        relationship: () => Effect.die("not used"),
        relationshipHistory: () => Effect.die("not used"),
        evidence: () => Effect.die("not used")
      })
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(approverMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins)),
        Layer.provide(Layer.merge(inspection, relationshipRepairProposalsLayer))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        const locator = Schema.decodeSync(CodeCommitDomain.CodeCommitPullRequestLocator)({
          region: "eu-west-1",
          repositoryName: "payments",
          pullRequestId: "42"
        })
        const unboundResult = yield* client.deliveryGraph.resolveCodeCommitPullRequest({
          query: locator
        })
        yield* Ref.set(accountBound, true)
        const boundResult = yield* client.deliveryGraph.resolveCodeCommitPullRequest({ query: locator })
        yield* Ref.set(selectedRegion, "cn-north-1")
        const chinaResult = yield* client.deliveryGraph.resolveCodeCommitPullRequest({
          query: { ...locator, region: CodeCommitDomain.AwsRegion.make("cn-north-1") }
        })
        yield* Ref.set(selectedRegion, "us-gov-west-1")
        const govCloudResult = yield* client.deliveryGraph.resolveCodeCommitPullRequest({
          query: { ...locator, region: CodeCommitDomain.AwsRegion.make("us-gov-west-1") }
        })
        return { boundResult, chinaResult, govCloudResult, unboundResult }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        approverMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result.unboundResult, { _tag: "account-identity-unavailable" })
      assert.deepStrictEqual(result.boundResult, {
        _tag: "found",
        candidate: {
          entityId: codeCommitPullRequestEntityId,
          accountLabel: "Production · AWS 123456789012",
          title: "Protect payment retries"
        }
      })
      assert.deepStrictEqual(result.chinaResult, result.boundResult)
      assert.deepStrictEqual(result.govCloudResult, result.boundResult)
      assert.strictEqual(yield* Ref.get(entityReads), 4)
    }))

  it.effect("serves one exact workspace entity and maps a missing entity to NotFound", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
      const found = yield* client.deliveryGraph.workspaceEntity({
        params: { entityId: sharedEntityId }
      })
      const missing = yield* client.deliveryGraph.workspaceEntity({
        params: { entityId: missingEntityId }
      }).pipe(Effect.result)

      assert.strictEqual(found.entity.projection.entityId, sharedEntityId)
      assert.strictEqual(found.source.vendorImmutableId, "PAY-42")
      assert.isTrue(Result.isFailure(missing))
      if (Result.isFailure(missing)) assert.strictEqual(missing.failure._tag, "NotFoundApiError")
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        deliveryGraphHandlersTestLayer
      ])
    ))

  it.effect("keeps an exact-share watcher out of adjacent workspace reads", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = Layer.mergeAll(
        shareHandlersLayer,
        deliveryGraphHandlersLayer,
        portfolioHandlersLayer,
        liveEventHandlersLayer
      ).pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(Layer.mergeAll(
          authorizedSharesLayer,
          deliveryGraphApplicationLayer,
          portfolioLayer,
          liveEventsLayer,
          Layer.succeed(Auth, streamAuthentication),
          LiveStreamAdmission.layer
        ))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, [
          "shares",
          "deliveryGraph",
          "portfolio",
          "liveEvents"
        ])
        const shared = yield* client.shares.resolve({
          params: { workspaceId: session.workspaceId, shareId: authorizedShareId }
        })
        assert.strictEqual(shared.item.projection.entityId, sharedEntityId)
        return yield* Effect.all([
          client.deliveryGraph.workspaceEntityProjections({ query: {} }).pipe(Effect.result),
          client.deliveryGraph.workspaceEntity({
            params: { entityId: sharedEntityId }
          }).pipe(Effect.result),
          client.deliveryGraph.releaseSlice({
            params: { releaseId: inspectedReleaseId },
            query: {}
          }).pipe(Effect.result),
          client.portfolio.snapshot().pipe(Effect.result),
          client.liveEvents.stream({ headers: {}, query: {} }).pipe(Effect.result)
        ])
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      const [entityIndex, workspaceEntity, releaseSlice, portfolioSnapshot, liveEventStream] = result
      assertForbidden(entityIndex)
      assertForbidden(workspaceEntity)
      assertForbidden(releaseSlice)
      assertForbidden(portfolioSnapshot)
      assertForbidden(liveEventStream)
    }))

  it.effect("serves a workspace-scoped release relationship slice", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
      const result = yield* client.deliveryGraph.releaseSlice({
        params: { releaseId: inspectedReleaseId },
        query: {}
      })

      assert.strictEqual(result.releaseId, inspectedReleaseId)
      assert.isNull(result.environmentId)
      assert.isFalse(result.truncated)
      assert.deepStrictEqual(result.relationships, [])

      const candidates = yield* client.deliveryGraph.repairCandidates({
        params: { releaseId: inspectedReleaseId },
        query: {}
      })
      assert.deepStrictEqual(candidates.candidates, [])
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        deliveryGraphHandlersTestLayer
      ])
    ))

  it.effect("creates a repair proposal with session-derived owner authority", () =>
    Effect.gen(function*() {
      const received = yield* Ref.make<
        {
          readonly workspaceId: string
          readonly sessionId: string
        } | null
      >(null)
      const proposal = RelationshipRepairProposal.make({
        schemaVersion: 2,
        proposalId: repairProposalId,
        workspaceId: session.workspaceId,
        releaseId: inspectedReleaseId,
        environmentId: null,
        relationshipId: inspectedRelationshipId,
        expectedRevision: inspectedRelationshipRevision,
        disposition: "verify",
        rationale: "Verify the inferred link before release.",
        origin: { actor: session.actor, sessionId: session.sessionId },
        status: "pending",
        proposedAt: session.lastSeenAt,
        review: null
      })
      const proposalApplicationLayer = Layer.merge(
        deliveryGraphLayer,
        Layer.succeed(RelationshipRepairProposals, {
          apply: () => Effect.die("not used"),
          create: (input) =>
            Ref.set(received, {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId
            }).pipe(Effect.as(proposal)),
          get: () => Effect.die("not used"),
          list: () => Effect.die("not used"),
          review: () => Effect.die("not used")
        })
      )
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(proposalApplicationLayer)
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.createRepairProposal({
          params: { releaseId: inspectedReleaseId, relationshipId: inspectedRelationshipId },
          payload: {
            proposalId: repairProposalId,
            environmentId: null,
            expectedRevision: inspectedRelationshipRevision,
            disposition: "verify",
            rationale: "Verify the inferred link before release."
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(result.proposalId, repairProposalId)
      assert.deepStrictEqual(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId
      })
    }))

  it.effect("rejects a watcher before repair proposal persistence", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const proposalApplicationLayer = Layer.merge(
        deliveryGraphLayer,
        Layer.succeed(RelationshipRepairProposals, {
          apply: () => Effect.die("not used"),
          create: () => Effect.die("watcher reached proposal persistence"),
          get: () => Effect.die("not used"),
          list: () => Effect.die("not used"),
          review: () => Effect.die("not used")
        })
      )
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(proposalApplicationLayer)
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.createRepairProposal({
          params: { releaseId: inspectedReleaseId, relationshipId: inspectedRelationshipId },
          payload: {
            proposalId: repairProposalId,
            environmentId: null,
            expectedRevision: inspectedRelationshipRevision,
            disposition: "verify",
            rationale: "Verify the inferred link before release."
          }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ForbiddenApiError")
    }))

  it.effect("derives relationship repair review authority from an approver session", () =>
    Effect.gen(function*() {
      const receivedSessionId = yield* Ref.make<string | null>(null)
      const reviewed = RelationshipRepairProposal.make({
        schemaVersion: 2,
        proposalId: repairProposalId,
        workspaceId: session.workspaceId,
        releaseId: inspectedReleaseId,
        environmentId: null,
        relationshipId: inspectedRelationshipId,
        expectedRevision: inspectedRelationshipRevision,
        disposition: "verify",
        rationale: "Verify the inferred link before release.",
        origin: { actor: session.actor, sessionId: session.sessionId },
        status: "approved",
        proposedAt: session.lastSeenAt,
        review: {
          reviewId: repairReviewId,
          decision: "approved",
          rationale: "The evidence is sufficient.",
          origin: { actor: approverSession.actor, sessionId: approverSession.sessionId },
          reviewedAt: approverSession.lastSeenAt
        }
      })
      const approverMiddleware = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const proposals = Layer.succeed(RelationshipRepairProposals, {
        apply: () => Effect.die("not used"),
        create: () => Effect.die("not used"),
        get: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        review: (input) => Ref.set(receivedSessionId, input.sessionId).pipe(Effect.as(reviewed))
      })
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(approverMiddleware),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.merge(deliveryGraphLayer, proposals))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.reviewRepairProposal({
          params: { proposalId: repairProposalId },
          payload: {
            reviewId: repairReviewId,
            decision: "approved",
            rationale: "The evidence is sufficient."
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        approverMiddleware,
        handler
      ]))

      assert.strictEqual(result.status, "approved")
      assert.strictEqual(yield* Ref.get(receivedSessionId), approverSession.sessionId)
    }))

  it.effect("rejects an approver before applying a reviewed repair proposal", () =>
    Effect.gen(function*() {
      const approverMiddleware = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const proposals = Layer.succeed(RelationshipRepairProposals, {
        apply: () => Effect.die("approver reached repair application persistence"),
        create: () => Effect.die("not used"),
        get: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        review: () => Effect.die("not used")
      })
      const handler = deliveryGraphHandlersLayer.pipe(
        Layer.provide(approverMiddleware),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.merge(deliveryGraphLayer, proposals))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
        return yield* client.deliveryGraph.applyRepairProposal({
          params: { proposalId: repairProposalId }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        approverMiddleware,
        handler
      ]))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ForbiddenApiError")
    }))

  it.effect("serves the bird's-eye snapshot through the generated in-memory client", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["portfolio"])
      const result = yield* client.portfolio.snapshot()

      assert.strictEqual(result.workspaceId, session.workspaceId)
      assert.strictEqual(result.releases.length, 0)
      assert.strictEqual(result.plugins.length, 0)
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        portfolioHandlersTestLayer
      ])
    ))

  it.effect("runs an owner-only live connection test through the generated client", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeSync(PluginConnectionTestResult)({
        _tag: "healthy",
        pluginConnectionId,
        providerId: "jira",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 84,
        identity: {
          kind: "user",
          label: "Atlassian user",
          displayName: "Avery Bell",
          providerImmutableId: "account-123"
        }
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: (input) =>
          input.workspaceId === session.workspaceId && input.pluginConnectionId === pluginConnectionId
            ? Effect.succeed(expected)
            : Effect.die("connection test crossed its authenticated scope")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.testConnection({ params: { pluginConnectionId } })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("runs an owner-only bounded connection synchronization through the generated client", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeSync(PluginSynchronizationState)({
        pluginConnectionId,
        providerId: "codecommit",
        streamKey: "pull-requests",
        lastAttemptAt: "2026-07-14T10:03:00.000Z",
        lastSuccessAt: "2026-07-14T10:03:01.000Z",
        result: "synchronized",
        pagesCommitted: 1
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        synchronization: () => Effect.die("not used"),
        synchronizeConnection: (input) =>
          input.workspaceId === session.workspaceId && input.pluginConnectionId === pluginConnectionId
            ? Effect.succeed(expected)
            : Effect.die("manual synchronization crossed its authenticated scope"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId } })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("routes account editing and credential recovery through owner-scoped administration handlers", () =>
    Effect.gen(function*() {
      const connection = Schema.decodeUnknownSync(PluginConnectionSummary)({
        pluginConnectionId,
        providerAccountId,
        followedResourceId: null,
        providerId: "codecommit",
        displayName: "Payments repository",
        revision: 4,
        isEnabled: true,
        supportsSynchronization: false,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      })
      const configured = Schema.decodeUnknownSync(PluginConfiguration)({
        pluginConnectionId,
        revision: 7,
        values: [{ _tag: "secret-reference", key: "profile", state: "configured" }],
        updatedAt: "2026-07-14T10:03:00.000Z"
      })
      const administration = Schema.decodeUnknownSync(PluginConnectionAdministration)({
        connection: Schema.encodeSync(PluginConnectionSummary)(connection),
        configuration: Schema.encodeSync(PluginConfiguration)(configured),
        metadata: {
          pluginConnectionId,
          pluginId: "dev.knpkv.codecommit",
          contractVersion: { major: 1, minor: 0, patch: 0 },
          adapterVersion: { major: 1, minor: 0, patch: 0 },
          configurationFields: [],
          capabilities: []
        },
        credentialFields: [],
        permissions: [],
        schedule: { mode: "unsupported", nextRunAt: null },
        synchronization: null,
        diagnostics: [{
          code: "connection-health-unverified",
          severity: "warning",
          summary: "The connection has not produced a current health result.",
          observedAt: "2026-07-14T10:03:00.000Z"
        }]
      })
      const renamed = Schema.decodeUnknownSync(ProviderAccountSummary)({
        providerAccountId,
        providerFamily: "aws",
        providerImmutableId: "123456789012",
        displayName: "Production AWS",
        revision: 3,
        resources: []
      })
      const test = Schema.decodeUnknownSync(PluginConnectionTestResult)({
        _tag: "healthy",
        pluginConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:04:00.000Z",
        latencyMilliseconds: 12,
        identity: {
          kind: "account",
          label: "AWS account",
          displayName: "Production AWS",
          providerImmutableId: "123456789012"
        }
      })
      const plugins = PluginAdministration.of({
        administration: (input) =>
          input.workspaceId === session.workspaceId && input.pluginConnectionId === pluginConnectionId
            ? Effect.succeed(administration)
            : Effect.die("administration read crossed its authenticated scope"),
        patchProviderAccount: ({ patch, providerAccountId: requestedAccountId, workspaceId: requestedWorkspaceId }) =>
          requestedWorkspaceId === session.workspaceId &&
            requestedAccountId === providerAccountId &&
            patch.expectedRevision === 2 &&
            patch.displayName === "Production AWS"
            ? Effect.succeed(renamed)
            : Effect.die("account patch crossed its authenticated scope"),
        reauthorizeConnection: ({ credentials, expectedRevision, pluginConnectionId: requestedId, workspaceId }) =>
          workspaceId === session.workspaceId &&
            requestedId === pluginConnectionId &&
            expectedRevision === 7 &&
            credentials[0]?.key === "profile" &&
            credentials[0]?.value === "rotated"
            ? Effect.succeed({ connection, configuration: { ...configured, revision: 8 }, test })
            : Effect.die("reauthorization crossed its authenticated scope"),
        revokeConnection: ({ expectedRevision, pluginConnectionId: requestedId, workspaceId }) =>
          workspaceId === session.workspaceId && requestedId === pluginConnectionId && expectedRevision === 8
            ? Effect.succeed({ ...connection, isEnabled: false, revision: 5 })
            : Effect.die("revocation crossed its authenticated scope"),
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return {
          administration: yield* client.plugins.administration({ params: { pluginConnectionId } }),
          account: yield* client.plugins.patchProviderAccount({
            params: { providerAccountId },
            payload: { expectedRevision: 2, displayName: "Production AWS" }
          }),
          recovered: yield* client.plugins.reauthorizeConnection({
            params: { pluginConnectionId },
            payload: {
              expectedRevision: 7,
              credentials: [{ key: PluginConfigurationKey.make("profile"), value: "rotated" }]
            }
          }),
          revoked: yield* client.plugins.revokeConnection({
            params: { pluginConnectionId },
            payload: { expectedRevision: 8 }
          })
        }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result.administration, administration)
      assert.deepStrictEqual(result.account, renamed)
      assert.strictEqual(result.recovered.configuration.revision, 8)
      assert.isFalse(result.revoked.isEnabled)
    }))

  it.effect("lets an approver read synchronization state without entering mutation authorization", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeSync(PluginSynchronizationState)({
        pluginConnectionId,
        providerId: "codecommit",
        streamKey: "pull-requests",
        lastAttemptAt: "2026-07-14T10:03:00.000Z",
        lastSuccessAt: null,
        result: "running",
        pagesCommitted: 0
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        synchronization: (input) =>
          input.workspaceId === approverSession.workspaceId && input.pluginConnectionId === pluginConnectionId
            ? Effect.succeed(expected)
            : Effect.die("synchronization state read crossed its authenticated scope"),
        synchronizeConnection: () => Effect.die("state read entered manual synchronization"),
        testConnection: () => Effect.die("not used")
      })
      const approverSessionLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const rejectingMutationLayer = Layer.succeed(SessionMutationAuth, {
        csrfToken: () => Effect.die("state read entered mutation authorization")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(approverSessionLayer),
        Layer.provide(rejectingMutationLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.synchronization({ params: { pluginConnectionId } })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        approverSessionLayer,
        rejectingMutationLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("lets a workspace owner enable a connection through the generated client", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeSync(PluginConnectionSummary)({
        pluginConnectionId,
        providerAccountId: null,
        followedResourceId: null,
        providerId: "jira",
        displayName: "Delivery Jira",
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        setConnectionEnabled: (input) =>
          input.workspaceId === session.workspaceId && input.pluginConnectionId === pluginConnectionId &&
            input.isEnabled
            ? Effect.succeed(expected)
            : Effect.die("enablement crossed its authenticated scope"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.setConnectionEnabled({
          params: { pluginConnectionId },
          payload: { isEnabled: true }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("keeps the v1 plugin list and serves the catalog overview separately", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeUnknownSync(PluginConnectionSummary)({
        pluginConnectionId,
        providerAccountId: null,
        followedResourceId: null,
        providerId: "jira",
        displayName: "Delivery Jira",
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      })
      const expectedAccounts = [
        Schema.decodeUnknownSync(ProviderAccountSummary)({
          providerAccountId,
          providerFamily: "aws",
          displayName: "123456789012",
          providerImmutableId: "123456789012",
          resources: [{
            followedResourceId,
            providerId: "codecommit",
            displayName: "payments",
            providerImmutableId: "eu-west-1:payments",
            isEnabled: true
          }]
        })
      ]
      const plugins = PluginAdministration.of({
        accounts: (requestedWorkspaceId) =>
          requestedWorkspaceId === session.workspaceId
            ? Effect.succeed(expectedAccounts)
            : Effect.die("provider account list crossed its authenticated workspace"),
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: (requestedWorkspaceId) =>
          requestedWorkspaceId === session.workspaceId
            ? Effect.succeed([expected])
            : Effect.die("plugin list crossed its authenticated workspace"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return {
          list: yield* client.plugins.list(),
          overview: yield* client.plugins.overview()
        }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result.list, [expected])
      assert.deepStrictEqual(result.overview.connections, [expected])
      assert.deepStrictEqual(result.overview.accounts, expectedAccounts)
      assert.deepStrictEqual(
        result.overview.catalog.map(({ providerId }) => providerId),
        ["codecommit", "codepipeline", "jira", "confluence", "clockify"]
      )
    }))

  it.effect("discovers credential-free AWS profile metadata for workspace owners", () =>
    Effect.gen(function*() {
      const expected = [
        { profile: "default", region: null },
        { profile: "production", region: "eu-west-1" }
      ]
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        discoverAwsProfiles: () => Effect.succeed(expected),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.discoverAwsProfiles()
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("runs bounded AWS resource discovery through the owner mutation boundary", () =>
    Effect.gen(function*() {
      const expected: AwsResourceDiscoveryResponse = {
        accountId: "123456789012",
        codeCommit: { _tag: "failed", failureClass: "authorization" },
        codePipeline: { _tag: "available", names: ["release"], truncated: false }
      }
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        discoverAwsResources: (request) => {
          assert.deepStrictEqual(request, { profile: "production", region: "eu-west-1" })
          return Effect.succeed(expected)
        },
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.discoverAwsResources({
          payload: { profile: "production", region: "eu-west-1" }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
      assert.notInclude(JSON.stringify(result), "arn:")
      assert.notInclude(JSON.stringify(result), "credential")
    }))

  it.effect("discovers secret-free Atlassian OAuth profile metadata for workspace owners", () =>
    Effect.gen(function*() {
      const expected: AtlassianProfileDiscoveryResponse = [{
        profileId: "account-1@cloud-1",
        name: "Avery Bell @ team.atlassian.net",
        siteUrl: "https://team.atlassian.net/",
        cloudId: "cloud-1",
        accountName: "Avery Bell",
        accountEmail: "avery@example.com",
        status: "valid",
        providers: ["jira", "confluence"]
      }]
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        discoverAtlassianProfiles: () => Effect.succeed(expected),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.discoverAtlassianProfiles()
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
      assert.notInclude(JSON.stringify(result), "access_token")
      assert.notInclude(JSON.stringify(result), "refresh_token")
    }))

  it.effect("passes Atlassian OAuth provider intent through the owner handler", () =>
    Effect.gen(function*() {
      const expected: AtlassianOAuthGrantStartResponse = {
        _tag: "configuration-required",
        callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
      }
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        startAtlassianOAuthGrant: (input) => {
          assert.strictEqual(input.workspaceId, session.workspaceId)
          assert.strictEqual(input.sessionId, session.sessionId)
          assert.deepStrictEqual(input.providers, ["confluence"])
          assert.deepStrictEqual(input.configuration, {
            clientId: "control-center-client",
            clientSecret: "control-center-secret"
          })
          return Effect.succeed(expected)
        },
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return yield* client.plugins.createAtlassianOAuthGrant({
          payload: {
            providers: ["confluence"],
            configuration: {
              clientId: "control-center-client",
              clientSecret: "control-center-secret"
            }
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, expected)
    }))

  it.effect("runs owner connection setup through the session and CSRF-protected handler", () =>
    Effect.gen(function*() {
      const expected = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
        connection: {
          pluginConnectionId,
          providerId: "codecommit",
          displayName: "Payments CodeCommit",
          isEnabled: true,
          health: null,
          updatedAt: "2026-07-14T10:03:00.000Z"
        },
        configuration: {
          pluginConnectionId,
          revision: 1,
          values: [
            { _tag: "text", key: "profile", value: "default" },
            { _tag: "text", key: "region", value: "eu-west-1" },
            { _tag: "text", key: "repositoryName", value: "payments" }
          ],
          updatedAt: "2026-07-14T10:03:00.000Z"
        },
        test: {
          _tag: "healthy",
          pluginConnectionId,
          providerId: "codecommit",
          checkedAt: "2026-07-14T10:03:00.000Z",
          latencyMilliseconds: 24,
          identity: {
            kind: "account",
            label: "AWS account",
            displayName: "Production account",
            providerImmutableId: "123456789012"
          }
        }
      })
      const plugins = PluginAdministration.of({
        connectAndTest: ({ request, workspaceId }) =>
          request.pluginConnectionId === pluginConnectionId && workspaceId === session.workspaceId
            ? Effect.succeed(expected)
            : Effect.die("connection setup crossed its authenticated scope"),
        connectAndTestBatch: ({ requests, workspaceId }) =>
          requests.length === 1 && requests[0]?.pluginConnectionId === pluginConnectionId &&
            workspaceId === session.workspaceId
            ? Effect.succeed({ results: [{ _tag: "succeeded", response: expected }] })
            : Effect.die("connection batch setup crossed its authenticated scope"),
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        const payload = Schema.decodeUnknownSync(CreatePluginConnectionRequest)({
          pluginConnectionId,
          providerId: "codecommit",
          displayName: "Payments CodeCommit",
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("profile"), value: "default" },
            { _tag: "text", key: PluginConfigurationKey.make("region"), value: "eu-west-1" },
            { _tag: "text", key: PluginConfigurationKey.make("repositoryName"), value: "payments" }
          ]
        })
        const connection = yield* client.plugins.createConnection({ payload })
        const batch = yield* client.plugins.createConnections({
          payload: { connections: [payload] }
        })
        return { batch, connection }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result.connection, expected)
      assert.deepStrictEqual(result.batch, { results: [{ _tag: "succeeded", response: expected }] })
    }))

  it.effect("serves credential-scoped fields as redacted references while adapter values remain readable", () =>
    Effect.gen(function*() {
      const configuredAt = "2026-07-14T10:03:00.000Z"
      const jira = Schema.decodeUnknownSync(PluginConfiguration)({
        pluginConnectionId,
        revision: 1,
        values: [
          { _tag: "secret-reference", key: "email", state: "configured" },
          { _tag: "url", key: "webBaseUrl", value: "https://knpkv.atlassian.net/" }
        ],
        updatedAt: configuredAt
      })
      const confluence = Schema.decodeUnknownSync(PluginConfiguration)({
        pluginConnectionId: confluencePluginConnectionId,
        revision: 1,
        values: [
          { _tag: "secret-reference", key: "email", state: "configured" },
          { _tag: "text", key: "spaceId", value: "space-1" }
        ],
        updatedAt: configuredAt
      })
      const codeCommit = Schema.decodeUnknownSync(PluginConfiguration)({
        pluginConnectionId: codeCommitPluginConnectionId,
        revision: 1,
        values: [{ _tag: "secret-reference", key: "profile", state: "configured" }],
        updatedAt: configuredAt
      })
      const configurations = new Map([
        [pluginConnectionId, jira],
        [confluencePluginConnectionId, confluence],
        [codeCommitPluginConnectionId, codeCommit]
      ])
      const plugins = PluginAdministration.of({
        configuration: ({ pluginConnectionId: requestedId, workspaceId: requestedWorkspaceId }) => {
          const configured = configurations.get(requestedId)
          return requestedWorkspaceId === session.workspaceId && configured !== undefined
            ? Effect.succeed(configured)
            : Effect.die("configuration read crossed its authenticated workspace")
        },
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const handler = pluginHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(PluginAdministration, plugins))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        return {
          jira: yield* client.plugins.configuration({ params: { pluginConnectionId } }),
          confluence: yield* client.plugins.configuration({
            params: { pluginConnectionId: confluencePluginConnectionId }
          }),
          codeCommit: yield* client.plugins.configuration({
            params: { pluginConnectionId: codeCommitPluginConnectionId }
          })
        }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepInclude(result.jira.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("email"),
        state: "configured"
      })
      assert.deepInclude(result.confluence.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("email"),
        state: "configured"
      })
      assert.deepInclude(result.codeCommit.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("profile"),
        state: "configured"
      })
    }))

  it.effect("serves a bounded Timeline and rejects half a stable cursor", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
      const page = yield* client.timeline.page({ query: { actor: "agent", limit: 25 } })
      const invalid = yield* client.timeline.page({
        query: { beforeEventKey: "audit:event-1" }
      }).pipe(Effect.result)

      assert.deepStrictEqual(page, { events: [], nextCursor: null })
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) assert.strictEqual(invalid.failure._tag, "InvalidRequestApiError")
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        timelineHandlersTestLayer
      ])
    ))

  it.effect("serves exact Timeline details to workspace owners", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
      const detail = yield* client.timeline.detail({
        params: { eventKey: timelineDetail.event.eventKey }
      })
      assert.deepStrictEqual(detail, timelineDetail)
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        timelineHandlersTestLayer
      ])
    ))

  it.effect("rejects Timeline details for workspace approvers before application work", () =>
    Effect.gen(function*() {
      const approverMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const approverLayer = timelineHandlersLayer.pipe(
        Layer.provide(approverMiddlewareLayer),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("approver reached Timeline detail application work"),
          page: () => Effect.die("approver reached Timeline page application work")
        })),
        Layer.provide(timelineExportAuditsLayer)
      )
      const denied = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.detail({
          params: { eventKey: timelineDetail.event.eventKey }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        approverMiddlewareLayer,
        approverLayer
      ]))
      assertForbidden(denied)
    }))

  it.effect("streams hardened CSV and JSON Timeline downloads with explicit truncation metadata", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
      const csvResponse = yield* client.timeline.exportCsv({
        query: { actor: "agent", limit: 25 },
        responseMode: "response-only"
      })
      const jsonResponse = yield* client.timeline.exportJson({
        query: { limit: 25 },
        responseMode: "response-only"
      })
      const csv = yield* csvResponse.stream.pipe(Stream.decodeText(), Stream.mkString)
      const json = yield* jsonResponse.stream.pipe(Stream.decodeText(), Stream.mkString)

      assert.strictEqual(csvResponse.headers["content-type"], "text/csv; charset=utf-8")
      assert.strictEqual(
        csv,
        "event_key,occurred_at,actor_kind,actor_label,source_kind,service,event_type,title,href\r\n"
      )
      assert.strictEqual(jsonResponse.headers["content-type"], "application/json; charset=utf-8")
      assert.deepStrictEqual(JSON.parse(json), {
        metadata: { eventCount: 0, eventLimit: 25, truncated: false },
        events: []
      })
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        timelineHandlersTestLayer
      ])
    ))

  it.effect("attributes each successful Timeline download to its human session", () =>
    Effect.gen(function*() {
      const recorded = yield* Ref.make<
        Array<Parameters<TimelineExportAudits["Service"]["record"]>[0]>
      >([])
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(timelineLayer),
        Layer.provide(Layer.succeed(TimelineExportAudits, {
          record: (input) => Ref.update(recorded, (all) => [...all, input])
        }))
      )
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        const csv = yield* client.timeline.exportCsv({ query: { actor: "agent", limit: 25 } })
        const json = yield* client.timeline.exportJson({ query: { limit: 10 } })
        yield* Stream.runDrain(csv)
        yield* Stream.runDrain(json)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(yield* Ref.get(recorded), [
        {
          workspaceId: session.workspaceId,
          personId: sessionPersonId,
          sessionId: session.sessionId,
          format: "csv",
          actorKind: "agent",
          from: null,
          to: null,
          requestedLimit: 25,
          returnedCount: 0,
          truncated: false
        },
        {
          workspaceId: session.workspaceId,
          personId: sessionPersonId,
          sessionId: session.sessionId,
          format: "json",
          actorKind: null,
          from: null,
          to: null,
          requestedLimit: 10,
          returnedCount: 0,
          truncated: false
        }
      ])
    }))

  it.effect("does not audit a Timeline download when collection fails", () =>
    Effect.gen(function*() {
      const auditCount = yield* Ref.make(0)
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("failed export collection reached Timeline detail work"),
          page: () => Effect.fail(new ApplicationServiceUnavailable({ retryAt: null }))
        })),
        Layer.provide(Layer.succeed(TimelineExportAudits, {
          record: () => Ref.update(auditCount, (count) => count + 1)
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.exportJson({ query: { limit: 25 } }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(yield* Ref.get(auditCount), 0)
    }))

  it("applies Timeline download security and attachment headers to web responses", async () => {
    const authentication = streamAuthentication
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.succeed([]),
      patchConfiguration: () => Effect.die("not used"),
      testConnection: () => Effect.die("not used")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const codePipelineReads = CodePipelineReads.of({
      logs: () => Effect.die("not used"),
      artifact: ({ request }) =>
        Effect.succeed({
          body: new Uint8Array(request.offset >= 9 ? [] : [1, 2, 3]),
          contentLength: request.offset >= 9 ? 0 : 3,
          filename: "BuildOutput.zip",
          offset: request.offset,
          totalBytes: request.offset === 0 ? 3 : 9
        })
    })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(CodePipelineReads, codePipelineReads),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = controlCenterApiLayer.pipe(
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(CodePipelineReads, codePipelineReads),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          authorizedSharesLayer,
          portfolioLayer,
          timelineApplicationLayer,
          deliveryGraphApplicationLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const request = (format: "csv" | "json") =>
      new Request(`http://127.0.0.1:4173/api/v1/timeline/export.${format}?limit=25`, {
        headers: {
          cookie: `cc_session=${"ab".repeat(32)}`,
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173"
        }
      })
    const artifactRequest = (offset: number) =>
      new Request("http://127.0.0.1:4173/api/v1/codepipeline/artifact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `cc_session=${"ab".repeat(32)}`,
          host: "127.0.0.1:4173",
          origin: "http://127.0.0.1:4173"
        },
        body: JSON.stringify({
          pluginConnectionId: codeCommitPluginConnectionId,
          request: {
            action: {
              entity: {
                entityType: "aws.codepipeline.action",
                vendorImmutableId: "execution-1#action-1"
              },
              executionId: "execution-1",
              actionExecutionId: "action-1",
              expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
            },
            direction: "output",
            artifactName: "BuildOutput",
            offset,
            length: 3
          }
        })
      })
    try {
      const csvResponse = await webHandler.handler(request("csv"), requestContext)
      const jsonResponse = await webHandler.handler(request("json"), requestContext)
      const artifactResponse = await webHandler.handler(artifactRequest(3), requestContext)
      const completeArtifactResponse = await webHandler.handler(artifactRequest(0), requestContext)
      const exhaustedArtifactResponse = await webHandler.handler(artifactRequest(10), requestContext)

      assert.strictEqual(csvResponse.headers.get("content-type"), "text/csv; charset=utf-8")
      assert.strictEqual(csvResponse.headers.get("content-disposition"), "attachment; filename=\"timeline-export.csv\"")
      assert.strictEqual(csvResponse.headers.get("cache-control"), "private, no-store")
      assert.strictEqual(csvResponse.headers.get("x-content-type-options"), "nosniff")
      assert.strictEqual(csvResponse.headers.get("x-timeline-export-count"), "0")
      assert.strictEqual(csvResponse.headers.get("x-timeline-export-limit"), "25")
      assert.strictEqual(csvResponse.headers.get("x-timeline-export-truncated"), "false")
      assert.strictEqual(jsonResponse.headers.get("content-type"), "application/json; charset=utf-8")
      assert.strictEqual(
        jsonResponse.headers.get("content-disposition"),
        "attachment; filename=\"timeline-export.json\""
      )
      assert.deepStrictEqual(await jsonResponse.json(), {
        metadata: { eventCount: 0, eventLimit: 25, truncated: false },
        events: []
      })
      assert.strictEqual(artifactResponse.headers.get("content-type"), "application/octet-stream")
      assert.strictEqual(
        artifactResponse.headers.get("content-disposition"),
        "attachment; filename=\"BuildOutput.zip\""
      )
      assert.strictEqual(artifactResponse.headers.get("content-length"), "3")
      assert.strictEqual(artifactResponse.headers.get("content-range"), "bytes 3-5/9")
      assert.strictEqual(artifactResponse.status, 206)
      assert.strictEqual(artifactResponse.headers.get("cache-control"), "private, no-store")
      assert.strictEqual(artifactResponse.headers.get("x-content-type-options"), "nosniff")
      assert.deepStrictEqual(new Uint8Array(await artifactResponse.arrayBuffer()), new Uint8Array([1, 2, 3]))
      assert.strictEqual(completeArtifactResponse.status, 200)
      assert.isNull(completeArtifactResponse.headers.get("content-range"))
      assert.deepStrictEqual(
        new Uint8Array(await completeArtifactResponse.arrayBuffer()),
        new Uint8Array([1, 2, 3])
      )
      assert.strictEqual(exhaustedArtifactResponse.status, 416)
      assert.strictEqual(exhaustedArtifactResponse.headers.get("content-range"), "bytes */9")
      assert.strictEqual((await exhaustedArtifactResponse.arrayBuffer()).byteLength, 0)
    } finally {
      await webHandler.dispose()
    }
  })

  it.effect("rejects inverted Timeline export dates before application reads", () =>
    Effect.gen(function*() {
      const auditCount = yield* Ref.make(0)
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(Layer.succeed(TimelineExportAudits, {
          record: () => Ref.update(auditCount, (count) => count + 1)
        })),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("invalid export range reached Timeline detail work"),
          page: () => Effect.die("invalid export range reached Timeline application work")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.exportJson({
          query: { from: session.absoluteExpiresAt, limit: 10, to: session.createdAt }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "InvalidRequestApiError")
      assert.strictEqual(yield* Ref.get(auditCount), 0)
    }))

  it.effect("rejects watcher Timeline reads before application work", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(timelineExportAuditsLayer),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("watcher reached Timeline detail work"),
          page: () => Effect.die("watcher reached Timeline application work")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.page({ query: {} }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      assertForbidden(result)
    }))

  it.effect("rejects watcher Timeline exports before application work", () =>
    Effect.gen(function*() {
      const auditCount = yield* Ref.make(0)
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(Layer.succeed(TimelineExportAudits, {
          record: () => Ref.update(auditCount, (count) => count + 1)
        })),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("watcher reached Timeline export detail work"),
          page: () => Effect.die("watcher reached Timeline export application work")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.exportCsv({ query: { limit: 10 } }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      assertForbidden(result)
      assert.strictEqual(yield* Ref.get(auditCount), 0)
    }))

  it.effect("rejects agent-owned Timeline exports before reads or audit work", () =>
    Effect.gen(function*() {
      const auditCount = yield* Ref.make(0)
      const agentMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, agentOwnerSession)
      })
      const handler = timelineHandlersLayer.pipe(
        Layer.provide(agentMiddlewareLayer),
        Layer.provide(Layer.succeed(TimelineReads, {
          detail: () => Effect.die("agent owner reached Timeline detail application work"),
          page: () => Effect.die("agent owner reached Timeline export application work")
        })),
        Layer.provide(Layer.succeed(TimelineExportAudits, {
          record: () => Ref.update(auditCount, (count) => count + 1)
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["timeline"])
        return yield* client.timeline.exportCsv({ query: { limit: 10 } }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        agentMiddlewareLayer,
        handler
      ]))

      assertForbidden(result)
      assert.strictEqual(yield* Ref.get(auditCount), 0)
    }))

  it.effect("derives the agent workspace from the authenticated session", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const requestedWorkspace = yield* Ref.make<string | null>(null)
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: (input) =>
            Ref.set(requestedWorkspace, input.workspaceId).pipe(
              Effect.as({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                reply: "The release is waiting for approval."
              })
            )
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Can this ship?", provider: "codex" }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(yield* Ref.get(requestedWorkspace), session.workspaceId)
      assert.strictEqual(result.releaseId, release.releaseId)
      assert.strictEqual(result.reply, "The release is waiting for approval.")
    }))

  it.effect("keeps release-publication commands read-only until explicit confirmation", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const admissions = yield* Ref.make(0)
      const submissions = yield* Ref.make<ReadonlyArray<unknown>>([])
      const publicationResults = yield* Ref.make<ReadonlyArray<string | undefined>>([])
      const actionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleasePublicationSubmissions, {
          submit: (input) =>
            Ref.update(submissions, (items) => [...items, input]).pipe(
              Effect.as({ actionId, state: "succeeded" })
            )
        })),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          admitTurn: (input) =>
            Ref.update(admissions, (count) => count + 1).pipe(
              Effect.as({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                workspaceId: input.workspaceId
              })
            ),
          runTurn: (input) =>
            Ref.update(publicationResults, (items) => [...items, input.publicationResult]).pipe(
              Effect.as({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                reply: "Publication request evaluated."
              })
            )
        }))
      )

      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: {
            history: [],
            prompt: "Create a Jira release version after Jane approves it",
            provider: "codex"
          }
        })
        yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Create a Jira release version", provider: "codex" }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(yield* Ref.get(admissions), 0)
      assert.strictEqual((yield* Ref.get(submissions)).length, 0)
      assert.deepStrictEqual(yield* Ref.get(publicationResults), [undefined, undefined])
    }))

  it.effect("does not dispatch publications when release chat admission or generation fails", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const actionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
      const rejectedSubmissions = yield* Ref.make(0)
      const rejectedHandler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleasePublicationSubmissions, {
          submit: () =>
            Ref.update(rejectedSubmissions, (count) => count + 1).pipe(
              Effect.as({ actionId, state: "succeeded" })
            )
        })),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          admitTurn: () => Effect.fail(new ApplicationInvalidRequest()),
          runTurn: (input) =>
            Effect.succeed({
              eventCursor: releaseSnapshot.eventCursor,
              provider: input.provider,
              release,
              releaseId: release.releaseId,
              reply: "Explicit publication confirmation is still required."
            })
        }))
      )
      const rejected = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Create a Jira release version", provider: "codex" }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        rejectedHandler
      ]))

      assert.isTrue(Result.isSuccess(rejected))
      assert.strictEqual(yield* Ref.get(rejectedSubmissions), 0)

      const publicationCalls = yield* Ref.make(0)
      const recover = (state: GovernedActionState) => {
        const failedGenerationHandler = agentHandlersLayer.pipe(
          Layer.provide(pullRequestReviewsLayer),
          Layer.provide(sessionMiddlewareLayer),
          Layer.provide(mutationMiddlewareLayer),
          Layer.provide(ServerLifecycle.layer),
          Layer.provide(releaseAgentJobsLayer),
          Layer.provide(Layer.succeed(ReleasePublicationSubmissions, {
            submit: () =>
              Ref.update(publicationCalls, (count) => count + 1).pipe(
                Effect.as({ actionId, state })
              )
          })),
          Layer.provide(Layer.succeed(ReleaseAgentTurns, {
            admitTurn: (input) =>
              Effect.succeed({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                workspaceId: input.workspaceId
              }),
            runTurn: () => Effect.fail(new ApplicationServiceUnavailable({ retryAt: null }))
          }))
        )
        return Effect.gen(function*() {
          const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
          return yield* client.agent.turn({
            params: { releaseId: release.releaseId },
            payload: { history: [], prompt: "Create a Jira release version", provider: "codex" }
          }).pipe(Effect.result)
        }).pipe(Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          failedGenerationHandler
        ]))
      }

      const states: ReadonlyArray<GovernedActionState> = ["succeeded", "failed", "unknown", "started"]
      for (const state of states) {
        const result = yield* recover(state)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "ServiceUnavailableApiError")
        }
      }
      assert.strictEqual(yield* Ref.get(publicationCalls), 0)
    }))

  it.effect("never turns natural-language Confluence requests into publication writes", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const actionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
      const currentRelease = {
        ...release,
        releasePageAwareness: {
          state: "current",
          lastPublishedAt: session.lastSeenAt,
          publicationActionId: actionId
        }
      } satisfies typeof release
      const notPublishedRelease = {
        ...release,
        releasePageAwareness: {
          state: "not-published",
          lastPublishedAt: null
        }
      } satisfies typeof release
      const publicationCalls = yield* Ref.make(0)
      const attempt = (admittedRelease: typeof currentRelease | typeof notPublishedRelease) => {
        const handler = agentHandlersLayer.pipe(
          Layer.provide(pullRequestReviewsLayer),
          Layer.provide(sessionMiddlewareLayer),
          Layer.provide(mutationMiddlewareLayer),
          Layer.provide(ServerLifecycle.layer),
          Layer.provide(releaseAgentJobsLayer),
          Layer.provide(Layer.succeed(ReleasePublicationSubmissions, {
            submit: (input) =>
              Effect.sync(() => assert.strictEqual(input.expectedReleaseUpdatedAt, admittedRelease.updatedAt)).pipe(
                Effect.andThen(Ref.update(publicationCalls, (count) => count + 1)),
                Effect.as({ actionId, state: "succeeded" })
              )
          })),
          Layer.provide(Layer.succeed(ReleaseAgentTurns, {
            admitTurn: (input) =>
              Effect.succeed({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release: admittedRelease,
                releaseId: admittedRelease.releaseId,
                workspaceId: input.workspaceId
              }),
            runTurn: (input) =>
              Effect.succeed({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release: admittedRelease,
                releaseId: admittedRelease.releaseId,
                reply: "Publication request evaluated."
              })
          }))
        )
        return Effect.gen(function*() {
          const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
          return yield* client.agent.turn({
            params: { releaseId: release.releaseId },
            payload: { history: [], prompt: "Create a Confluence release page", provider: "codex" }
          }).pipe(Effect.result)
        }).pipe(Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ]))
      }

      const rejected = yield* attempt(currentRelease)
      assert.isTrue(Result.isSuccess(rejected))
      assert.strictEqual(yield* Ref.get(publicationCalls), 0)

      const created = yield* attempt(notPublishedRelease)
      assert.isTrue(Result.isSuccess(created))
      assert.strictEqual(yield* Ref.get(publicationCalls), 0)
    }))

  it.effect("does not invoke release-publication submission errors from agent turns", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const attempt = (reason: ReleasePublicationSubmissionError["reason"]) => {
        const handler = agentHandlersLayer.pipe(
          Layer.provide(pullRequestReviewsLayer),
          Layer.provide(sessionMiddlewareLayer),
          Layer.provide(mutationMiddlewareLayer),
          Layer.provide(ServerLifecycle.layer),
          Layer.provide(releaseAgentJobsLayer),
          Layer.provide(Layer.succeed(ReleasePublicationSubmissions, {
            submit: () => Effect.fail(new ReleasePublicationSubmissionError({ reason }))
          })),
          Layer.provide(Layer.succeed(ReleaseAgentTurns, {
            admitTurn: (input) =>
              Effect.succeed({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                workspaceId: input.workspaceId
              }),
            runTurn: () => Effect.fail(new ApplicationServiceUnavailable({ retryAt: null }))
          }))
        )
        return Effect.gen(function*() {
          const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
          return yield* client.agent.turn({
            params: { releaseId: release.releaseId },
            payload: { history: [], prompt: "Create a Confluence release page", provider: "codex" }
          }).pipe(Effect.result)
        }).pipe(Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ]))
      }

      const conflict = yield* attempt("conflict")
      assert.isTrue(Result.isFailure(conflict))
      if (Result.isFailure(conflict)) {
        assert.strictEqual(conflict.failure._tag, "ServiceUnavailableApiError")
      }

      const unavailable = yield* attempt("unavailable")
      assert.isTrue(Result.isFailure(unavailable))
      if (Result.isFailure(unavailable)) {
        assert.strictEqual(unavailable.failure._tag, "ServiceUnavailableApiError")
      }
    }))

  it.effect("admits release turns only before server drain", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const turnCalls = yield* Ref.make(0)
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle)),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: (input) =>
            Ref.update(turnCalls, (count) => count + 1).pipe(
              Effect.as({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                reply: "The release is waiting for approval."
              })
            )
        }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        assert.strictEqual(yield* Ref.get(turnCalls), 0)
        const accepted = yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Can this ship?", provider: "codex" }
        })
        assert.strictEqual(yield* Ref.get(turnCalls), 1)
        yield* lifecycle.beginDrain
        const rejected = yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Can this still ship?", provider: "codex" }
        }).pipe(Effect.result)
        return { accepted, rejected }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(result.accepted.releaseId, release.releaseId)
      assert.strictEqual(yield* Ref.get(turnCalls), 1)
      assert.isTrue(Result.isFailure(result.rejected))
      if (Result.isFailure(result.rejected)) {
        assert.strictEqual(result.rejected.failure._tag, "ServiceUnavailableApiError")
      }
    }))

  it.effect("enqueues a durable agent job in the owner session workspace", () =>
    Effect.gen(function*() {
      const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
      const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000022")
      const received = yield* Ref.make<unknown>(null)
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: (input) =>
          Ref.set(received, input).pipe(
            Effect.as({ releaseId: input.releaseId, jobId, state: "queued" })
          ),
        providers: () => Effect.die("not used"),
        replay: () => Effect.die("not used")
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.enqueueJob({
          params: { releaseId },
          payload: {
            prompt: "Explain the release blockers.",
            providerId: DurableAgentProviderId.make("codex"),
            model: AgentModelId.make("review-model"),
            profile: "read-only"
          }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result, { releaseId, jobId, state: "queued" })
      assert.deepStrictEqual(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        releaseId,
        request: {
          prompt: "Explain the release blockers.",
          providerId: DurableAgentProviderId.make("codex"),
          model: AgentModelId.make("review-model"),
          profile: "read-only"
        }
      })
    }))

  it.effect("admits lazy provider catalog initialization only before server drain", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const providerCalls = yield* Ref.make(0)
      const catalog = {
        providers: [{
          providerId: DurableAgentProviderId.make("openai-compatible"),
          models: [AgentModelId.make("review-model")],
          capabilities: ["release-chat"],
          health: "available"
        }]
      } satisfies AgentProviderCatalog
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: () => Effect.die("not used"),
        providers: () => Ref.update(providerCalls, (count) => count + 1).pipe(Effect.as(catalog)),
        replay: () => Effect.die("not used")
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle)),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        assert.strictEqual(yield* Ref.get(providerCalls), 0)
        const accepted = yield* client.agent.providers()
        assert.strictEqual(yield* Ref.get(providerCalls), 1)
        yield* lifecycle.beginDrain
        const rejected = yield* client.agent.providers().pipe(Effect.result)
        return { accepted, rejected }
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ])
      )

      assert.deepStrictEqual(result.accepted, catalog)
      assert.strictEqual(yield* Ref.get(providerCalls), 1)
      assert.isTrue(Result.isFailure(result.rejected))
      if (Result.isFailure(result.rejected)) {
        assert.strictEqual(result.rejected.failure._tag, "ServiceUnavailableApiError")
      }
    }))

  it.effect("reads and enqueues immutable pull-request reviews in the authenticated workspace", () =>
    Effect.gen(function*() {
      const entityId = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000023")
      const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000025")
      const subject = Schema.decodeSync(PrReviewSubject)({
        providerId: "codecommit",
        repository: "control-center",
        pullRequestId: "212",
        baseRevision: "1".repeat(40),
        headRevision: "2".repeat(40)
      })
      const suggestionId = PrReviewSuggestionId.make(
        `sha256:${"4".repeat(64)}`
      )
      const suggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
        suggestionId,
        state: "draft",
        title: "Decode the response",
        severity: "P2",
        problem: "The response is persisted before decoding.",
        impact: "Malformed output may reach durable state.",
        evidence: {
          path: "src/review.ts",
          startLine: 42,
          endLine: 42,
          excerpt: "yield* persist(response)"
        },
        recommendation: "Decode the response before persistence.",
        anchor: {
          _tag: "line",
          path: "src/review.ts",
          line: 42,
          relativeFileVersion: "AFTER"
        },
        relatedLocations: [],
        confidence: {
          level: "high",
          reason: "The operation order is explicit."
        }
      })
      const revisionId = PrReviewSuggestionRevisionId.make(
        `sha256:${"5".repeat(64)}`
      )
      const currentRevision = PrReviewSuggestionRevision.make({
        revisionId,
        sequence: PrReviewSuggestionRevisionSequence.make(1),
        predecessorRevisionId: null,
        sourceJobId: jobId,
        subject,
        suggestion,
        validation: PrReviewSuggestionValidated.make({
          reviewedHead: subject.headRevision,
          validatingJobId: jobId,
          sourceRevisionId: revisionId
        }),
        author: PrReviewSuggestionOperatorAuthor.make({
          personId: sessionPersonId
        }),
        createdAt: session.lastSeenAt
      })
      const editedRevisionId = PrReviewSuggestionRevisionId.make(
        `sha256:${"6".repeat(64)}`
      )
      const editedRevision = PrReviewSuggestionRevision.make({
        ...currentRevision,
        revisionId: editedRevisionId,
        sequence: PrReviewSuggestionRevisionSequence.make(2),
        predecessorRevisionId: revisionId,
        suggestion: PrReviewSuggestion.make({
          ...suggestion,
          title: "Decode every response"
        })
      })
      const dismissedRevision = PrReviewSuggestionRevision.make({
        ...editedRevision,
        revisionId: PrReviewSuggestionRevisionId.make(`sha256:${"7".repeat(64)}`),
        sequence: PrReviewSuggestionRevisionSequence.make(3),
        predecessorRevisionId: editedRevisionId,
        suggestion: PrReviewSuggestion.make({
          ...editedRevision.suggestion,
          state: "dismissed"
        })
      })
      const received = yield* Ref.make<ReadonlyArray<unknown>>([])
      const reviewProfile: ReviewAgentProfile = {
        profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
        label: "Full-project review · openai-compatible · review-model",
        budgetMillis: 1_200_000,
        networkAccess: "blocked",
        sandbox: "sbx"
      }
      const reviews = Layer.succeed(PullRequestReviews, {
        thread: (input) =>
          Ref.update(received, (items) => [...items, input]).pipe(
            Effect.as(PullRequestReviewThreadPage.make({
              events: [{
                _tag: "operator-message",
                eventSequence: ReleaseAgentThreadCursor.make(1),
                jobId,
                occurredAt: session.lastSeenAt,
                prompt: "Focus on the persistence boundary."
              }],
              hasMore: false,
              nextCursor: ReleaseAgentThreadCursor.make(1)
            }))
          ),
        current: (input) =>
          Ref.update(received, (items) => [...items, input]).pipe(
            Effect.as(new PullRequestReviewNotStarted({ subject }))
          ),
        enqueue: (input) =>
          Ref.update(received, (items) => [...items, input]).pipe(
            Effect.as(
              new PullRequestReviewPending({
                subject,
                jobId,
                providerId: input.request.providerId,
                model: input.request.model,
                reviewProfile,
                activity: { events: [], truncated: false },
                requestedAt: session.lastSeenAt,
                state: "queued"
              })
            )
          ),
        cancel: () => Effect.die("not used"),
        extendBudget: () => Effect.die("not used"),
        revisions: (input) =>
          Effect.gen(function*() {
            yield* Ref.update(received, (items) => [...items, input])
            if (
              input.beforeSequence !== null &&
              input.beforeSequence > currentRevision.sequence
            ) {
              return yield* new ApplicationInvalidRequest()
            }
            return {
              current: currentRevision,
              revisions: [],
              hasMore: false,
              nextBeforeSequence: null
            }
          }),
        editSuggestion: (input) =>
          Ref.update(received, (items) => [...items, input]).pipe(
            Effect.as(editedRevision)
          ),
        targetSuggestion: () => Effect.die("not used"),
        dismissSuggestion: (input) =>
          Ref.update(received, (items) => [...items, input]).pipe(
            Effect.as(dismissedRevision)
          ),
        previewPublication: () => Effect.die("not used"),
        publishSuggestion: () => Effect.die("not used")
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(reviews),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        const current = yield* client.agent.pullRequestReview({ params: { entityId } })
        const thread = yield* client.agent.pullRequestReviewThread({
          params: { entityId },
          query: { after: ReleaseAgentThreadCursor.make(0), limit: 12 }
        })
        const earlierThread = yield* client.agent.pullRequestReviewThread({
          params: { entityId },
          query: { before: ReleaseAgentThreadCursor.make(2), limit: 1 }
        })
        const conflictingCursors = yield* client.agent.pullRequestReviewThread({
          params: { entityId },
          query: {
            after: ReleaseAgentThreadCursor.make(1),
            before: ReleaseAgentThreadCursor.make(2),
            limit: 1
          }
        }).pipe(Effect.result)
        const revisions = yield* client.agent.reviewSuggestionRevisions({
          params: { entityId, jobId, suggestionId },
          query: {
            limit: PrReviewSuggestionRevisionPageSize.make(3)
          }
        })
        const invalidRevisionCursor = yield* client.agent.reviewSuggestionRevisions({
          params: { entityId, jobId, suggestionId },
          query: {
            before: PrReviewSuggestionRevisionSequence.make(2),
            limit: PrReviewSuggestionRevisionPageSize.make(3)
          }
        }).pipe(Effect.result)
        const edited = yield* client.agent.editReviewSuggestion({
          params: { entityId, jobId, suggestionId },
          payload: {
            expectedRevisionId: revisionId,
            expectedSequence: currentRevision.sequence,
            edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
              ...suggestion,
              title: "Decode every response"
            })
          }
        })
        const dismissed = yield* client.agent.dismissReviewSuggestion({
          params: { entityId, jobId, suggestionId },
          payload: {
            expectedRevisionId: editedRevisionId,
            expectedSequence: editedRevision.sequence,
            reason: "false-positive"
          }
        })
        const accepted = yield* client.agent.enqueuePullRequestReview({
          params: { entityId },
          payload: {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            model: AgentModelId.make("review-model"),
            profile: "read-only",
            reviewProfileId: reviewProfile.profileId,
            prompt: "Re-check transaction ownership."
          }
        })
        return {
          accepted,
          conflictingCursors,
          current,
          dismissed,
          earlierThread,
          edited,
          invalidRevisionCursor,
          revisions,
          thread
        }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(result.current._tag, "not-started")
      assert.strictEqual(result.accepted._tag, "pending")
      assert.strictEqual(result.revisions.current.revisionId, revisionId)
      assert.isTrue(Result.isFailure(result.invalidRevisionCursor))
      if (Result.isFailure(result.invalidRevisionCursor)) {
        assert.strictEqual(
          result.invalidRevisionCursor.failure._tag,
          "InvalidRequestApiError"
        )
      }
      assert.strictEqual(result.edited.revisionId, editedRevisionId)
      assert.strictEqual(result.dismissed.suggestion.state, "dismissed")
      assert.isTrue(Result.isFailure(result.conflictingCursors))
      if (Result.isFailure(result.conflictingCursors)) {
        assert.strictEqual(result.conflictingCursors.failure._tag, "InvalidRequestApiError")
      }
      assert.strictEqual(result.thread.events[0]?._tag, "operator-message")
      assert.strictEqual(result.earlierThread.events[0]?._tag, "operator-message")
      assert.deepStrictEqual(yield* Ref.get(received), [
        { workspaceId: session.workspaceId, entityId },
        {
          workspaceId: session.workspaceId,
          entityId,
          after: ReleaseAgentThreadCursor.make(0),
          before: null,
          limit: 12
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          after: null,
          before: ReleaseAgentThreadCursor.make(2),
          limit: 1
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          jobId,
          suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(3)
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          jobId,
          suggestionId,
          beforeSequence: PrReviewSuggestionRevisionSequence.make(2),
          limit: PrReviewSuggestionRevisionPageSize.make(3)
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          jobId,
          suggestionId,
          request: {
            expectedRevisionId: revisionId,
            expectedSequence: currentRevision.sequence,
            edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
              ...suggestion,
              title: "Decode every response"
            })
          },
          session
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          jobId,
          suggestionId,
          request: {
            expectedRevisionId: editedRevisionId,
            expectedSequence: editedRevision.sequence,
            reason: "false-positive"
          },
          session
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          request: {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            model: AgentModelId.make("review-model"),
            profile: "read-only",
            reviewProfileId: reviewProfile.profileId,
            prompt: "Re-check transaction ownership."
          }
        }
      ])
    }))

  it.effect("previews and publishes one exact review suggestion only through the human session", () =>
    Effect.gen(function*() {
      const entityId = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000026")
      const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000027")
      const suggestionId = PrReviewSuggestionId.make(`sha256:${"5".repeat(64)}`)
      const revisionId = PrReviewSuggestionRevisionId.make(
        `sha256:${"6".repeat(64)}`
      )
      const publicationId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000028")
      const subject = PrReviewSubject.make({
        providerId: "codecommit",
        repository: "control-center",
        pullRequestId: "212",
        baseRevision: "1".repeat(40),
        headRevision: "2".repeat(40)
      })
      const reviewProfile: ReviewAgentProfile = {
        profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
        label: "Full-project review · openai-compatible · review-model",
        budgetMillis: 1_200_000,
        networkAccess: "blocked",
        sandbox: "sbx"
      }
      const editableContent = ReviewSuggestionPublicationContent.make(
        "Authorize before mutating.\n\n```suggestion\nyield* authorize()\nyield* mutate()\n```"
      )
      const publicationFooter = `— ${reviewProfile.label} · head ${
        subject.headRevision.slice(0, 12)
      } · operator ${sessionPersonId}`
      const finalContent = ReviewSuggestionPublicationContent.make(
        `${editableContent}\n\n${publicationFooter}`
      )
      const preview = new ReviewSuggestionPublicationPreview({
        jobId,
        suggestionId,
        revisionId,
        subject,
        suggestionRevision: {
          jobId,
          suggestionId,
          revisionId,
          sequence: PrReviewSuggestionRevisionSequence.make(1),
          reviewedHead: subject.headRevision
        },
        anchor: {
          _tag: "line",
          path: PrReviewPath.make("src/authorization.ts"),
          line: 42,
          relativeFileVersion: "AFTER"
        },
        editableContent,
        editableContentMaximumLength: 10_100 - publicationFooter.length - 2,
        finalContent,
        publicationFooter,
        replacement: "yield* authorize()\nyield* mutate()",
        connectedIdentity: {
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:user/local-operator"
        },
        authorityBinding: ReviewSuggestionPublicationAuthorityBinding.make(
          `sha256:${"a".repeat(64)}`
        ),
        proposingAgent: reviewProfile,
        publishingOperator: sessionPersonId
      })
      const receipt = Schema.decodeSync(PluginProviderReceiptV1)({
        providerOperationId: PluginProviderOperationId.make("comment-42"),
        status: "succeeded",
        safeSummary: "Posted an inline pull-request comment",
        observedAt: "2026-07-14T10:01:00.000Z"
      })
      const published = new PublishedReviewComment({
        publicationId,
        jobId,
        suggestionId,
        revisionId,
        subject,
        suggestionRevision: preview.suggestionRevision,
        anchor: preview.anchor,
        content: finalContent,
        connectedIdentity: preview.connectedIdentity,
        proposingAgent: reviewProfile,
        publishingOperator: sessionPersonId,
        receipt,
        publishedAt: session.lastSeenAt
      })
      const received = yield* Ref.make<ReadonlyArray<unknown>>([])
      const reviews = Layer.succeed(PullRequestReviews, {
        thread: () => Effect.die("not used"),
        current: () => Effect.die("not used"),
        enqueue: () => Effect.die("not used"),
        cancel: () => Effect.die("not used"),
        extendBudget: () => Effect.die("not used"),
        revisions: () => Effect.die("not used"),
        editSuggestion: () => Effect.die("not used"),
        targetSuggestion: () => Effect.die("not used"),
        dismissSuggestion: () => Effect.die("not used"),
        previewPublication: (input) => Ref.update(received, (items) => [...items, input]).pipe(Effect.as(preview)),
        publishSuggestion: (input) => Ref.update(received, (items) => [...items, input]).pipe(Effect.as(published))
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(reviews),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        const publicationPreview = yield* client.agent.previewReviewSuggestionPublication({
          params: { entityId, jobId, suggestionId },
          query: { revisionId }
        })
        const publication = yield* client.agent.publishReviewSuggestion({
          params: { entityId },
          payload: {
            jobId,
            suggestionId,
            revisionId,
            finalContent,
            authorityBinding: preview.authorityBinding
          }
        })
        return { publication, publicationPreview }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))
      const approverMiddleware = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, approverSession)
      })
      const approverHandler = agentHandlersLayer.pipe(
        Layer.provide(reviews),
        Layer.provide(approverMiddleware),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: () => Effect.die("not used")
        }))
      )
      const rejected = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.publishReviewSuggestion({
          params: { entityId },
          payload: {
            jobId,
            suggestionId,
            revisionId,
            finalContent,
            authorityBinding: preview.authorityBinding
          }
        }).pipe(Effect.result)
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        approverMiddleware,
        approverHandler
      ]))

      assert.deepStrictEqual(result.publicationPreview, preview)
      assert.deepStrictEqual(result.publication, published)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "ForbiddenApiError")
      }
      assert.deepStrictEqual(yield* Ref.get(received), [
        {
          workspaceId: session.workspaceId,
          entityId,
          jobId,
          suggestionId,
          revisionId,
          publishingOperator: sessionPersonId
        },
        {
          workspaceId: session.workspaceId,
          entityId,
          request: {
            jobId,
            suggestionId,
            revisionId,
            finalContent,
            authorityBinding: preview.authorityBinding
          },
          session
        }
      ])
    }))

  it.effect("rejects authority-bearing review-suggestion operations after server drain begins", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const authorityBearingCalls = yield* Ref.make(0)
      const entityId = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000023")
      const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000025")
      const suggestionId = PrReviewSuggestionId.make(`sha256:${"4".repeat(64)}`)
      const revisionId = PrReviewSuggestionRevisionId.make(`sha256:${"5".repeat(64)}`)
      const sequence = PrReviewSuggestionRevisionSequence.make(1)
      const edit = Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
        title: "Decode the response",
        severity: "P2",
        problem: "The response is persisted before decoding.",
        impact: "Malformed output may reach durable state.",
        evidence: {
          path: "src/review.ts",
          startLine: 42,
          endLine: 42,
          excerpt: "yield* persist(response)"
        },
        recommendation: "Decode the response before persistence.",
        confidence: {
          level: "high",
          reason: "The operation order is explicit."
        },
        relatedLocations: [],
        anchor: {
          _tag: "line",
          path: "src/review.ts",
          line: 42,
          relativeFileVersion: "AFTER"
        }
      })
      const blockedMutation = Ref.update(authorityBearingCalls, (count) => count + 1).pipe(
        Effect.andThen(Effect.die("authority-bearing review operation crossed the drain guard"))
      )
      const reviews = Layer.succeed(PullRequestReviews, {
        thread: () => Effect.die("not used"),
        current: () => Effect.die("not used"),
        enqueue: () => Effect.die("not used"),
        cancel: () => blockedMutation,
        extendBudget: () => blockedMutation,
        revisions: () => Effect.die("not used"),
        editSuggestion: () => blockedMutation,
        targetSuggestion: () => blockedMutation,
        dismissSuggestion: () => blockedMutation,
        previewPublication: () => blockedMutation,
        publishSuggestion: () => blockedMutation
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(reviews),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle)),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: () => Effect.die("not used")
        }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        yield* lifecycle.beginDrain
        const edited = yield* client.agent.editReviewSuggestion({
          params: { entityId, jobId, suggestionId },
          payload: {
            expectedRevisionId: revisionId,
            expectedSequence: sequence,
            edit
          }
        }).pipe(Effect.result)
        const dismissed = yield* client.agent.dismissReviewSuggestion({
          params: { entityId, jobId, suggestionId },
          payload: {
            expectedRevisionId: revisionId,
            expectedSequence: sequence,
            reason: "other"
          }
        }).pipe(Effect.result)
        const previewed = yield* client.agent.previewReviewSuggestionPublication({
          params: { entityId, jobId, suggestionId },
          query: { revisionId }
        }).pipe(Effect.result)
        const published = yield* client.agent.publishReviewSuggestion({
          params: { entityId },
          payload: {
            jobId,
            suggestionId,
            revisionId,
            finalContent: ReviewSuggestionPublicationContent.make("Decode before persistence."),
            authorityBinding: ReviewSuggestionPublicationAuthorityBinding.make(
              `sha256:${"a".repeat(64)}`
            )
          }
        }).pipe(Effect.result)
        return { dismissed, edited, previewed, published }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.isTrue(Result.isFailure(result.edited))
      if (Result.isFailure(result.edited)) {
        assert.strictEqual(result.edited.failure._tag, "ServiceUnavailableApiError")
      }
      assert.isTrue(Result.isFailure(result.dismissed))
      if (Result.isFailure(result.dismissed)) {
        assert.strictEqual(result.dismissed.failure._tag, "ServiceUnavailableApiError")
      }
      assert.isTrue(Result.isFailure(result.previewed))
      if (Result.isFailure(result.previewed)) {
        assert.strictEqual(result.previewed.failure._tag, "ServiceUnavailableApiError")
      }
      assert.isTrue(Result.isFailure(result.published))
      if (Result.isFailure(result.published)) {
        assert.strictEqual(result.published.failure._tag, "ServiceUnavailableApiError")
      }
      assert.strictEqual(yield* Ref.get(authorityBearingCalls), 0)
    }))

  it.effect("returns only the redacted agent provider catalog to an owner", () =>
    Effect.gen(function*() {
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: () => Effect.die("not used"),
        providers: () =>
          Effect.succeed({
            providers: [{
              providerId: DurableAgentProviderId.make("openai-compatible"),
              models: [AgentModelId.make("review-model")],
              capabilities: ["release-chat", "pr-review"],
              health: "available"
            }]
          }),
        replay: () => Effect.die("not used")
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.providers()
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          handler
        ])
      )

      assert.deepStrictEqual(result, {
        providers: [{
          providerId: DurableAgentProviderId.make("openai-compatible"),
          models: [AgentModelId.make("review-model")],
          capabilities: ["release-chat", "pr-review"],
          health: "available"
        }]
      })
    }))

  it.effect("replays only the authenticated workspace thread with caller bounds", () =>
    Effect.gen(function*() {
      const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000031")
      const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000032")
      const after = ReleaseAgentThreadCursor.make(4)
      const received = yield* Ref.make<unknown>(null)
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: () => Effect.die("not used"),
        providers: () => Effect.die("not used"),
        replay: (input) =>
          Ref.set(received, input).pipe(
            Effect.as({
              releaseId: input.releaseId,
              events: [{
                _tag: "assistant-output",
                eventSequence: ReleaseAgentThreadCursor.make(5),
                jobId,
                occurredAt: session.lastSeenAt,
                text: "The release is ready."
              }],
              nextCursor: ReleaseAgentThreadCursor.make(5)
            })
          )
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.replayThread({ params: { releaseId }, query: { after, limit: 7 } })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      const event = result.events[0]
      assert.strictEqual(event?._tag, "assistant-output")
      if (event?._tag === "assistant-output") assert.strictEqual(event.text, "The release is ready.")
      assert.deepStrictEqual(yield* Ref.get(received), {
        workspaceId: session.workspaceId,
        releaseId,
        after,
        limit: 7
      })
    }))

  it.effect("returns an empty replay for an existing release and NotFound for a missing release", () =>
    Effect.gen(function*() {
      const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000033")
      const missingReleaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000034")
      const after = ReleaseAgentThreadCursor.make(19)
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: () => Effect.die("not used"),
        providers: () => Effect.die("not used"),
        replay: (input) =>
          input.releaseId === releaseId
            ? Effect.succeed({ releaseId, events: [], nextCursor: input.after })
            : Effect.fail(new ApplicationResourceNotFound())
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )

      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        const empty = yield* client.agent.replayThread({
          params: { releaseId },
          query: { after, limit: 7 }
        })
        const missing = yield* client.agent.replayThread({
          params: { releaseId: missingReleaseId },
          query: { after, limit: 7 }
        }).pipe(Effect.result)
        return { empty, missing }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.deepStrictEqual(result.empty, { releaseId, events: [], nextCursor: after })
      assert.isTrue(Result.isFailure(result.missing))
      if (Result.isFailure(result.missing)) {
        assert.strictEqual(result.missing.failure._tag, "NotFoundApiError")
      }
    }))

  it.effect("rejects a watcher before the local agent runtime is invoked", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(releaseAgentJobsLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: () => Effect.die("watcher reached the local agent runtime")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.turn({
          params: { releaseId: ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000011") },
          payload: { history: [], prompt: "Read a repository secret", provider: "codex" }
        })
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          watcherMiddlewareLayer,
          handler
        ]),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ForbiddenApiError")
    }))

  it.effect("rejects watcher provider administration, durable enqueue, and replay before application access", () =>
    Effect.gen(function*() {
      const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000041")
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const jobs = Layer.succeed(ReleaseAgentJobs, {
        enqueue: () => Effect.die("watcher reached durable enqueue"),
        providers: () => Effect.die("watcher reached provider catalog"),
        replay: () => Effect.die("watcher reached durable replay")
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(pullRequestReviewsLayer),
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(jobs),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, { runTurn: () => Effect.die("not used") }))
      )
      const attempted = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        const enqueue = yield* client.agent.enqueueJob({
          params: { releaseId },
          payload: {
            providerId: DurableAgentProviderId.make("codex"),
            model: AgentModelId.make("review-model"),
            profile: "read-only",
            prompt: "Explain the release."
          }
        }).pipe(Effect.result)
        const replay = yield* client.agent.replayThread({
          params: { releaseId },
          query: {}
        }).pipe(Effect.result)
        const providers = yield* client.agent.providers().pipe(Effect.result)
        return { enqueue, providers, replay }
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        watcherMiddlewareLayer,
        handler
      ]))

      assertForbidden(attempted.enqueue)
      assertForbidden(attempted.providers)
      assertForbidden(attempted.replay)
    }))

  it.effect("rejects conflicting live-event resume cursors", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["liveEvents"])
      const response = yield* client.liveEvents.stream({
        headers: {},
        query: { after: EventCursor.make(4) },
        responseMode: "response-only"
      })
      assert.strictEqual(response.status, 200)

      const conflict = yield* client.liveEvents.stream({
        headers: { "last-event-id": EventCursor.make(3) },
        query: { after: EventCursor.make(4) }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(conflict))
      if (Result.isFailure(conflict)) assert.strictEqual(conflict.failure._tag, "InvalidRequestApiError")
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        liveEventHandlerTestLayer,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer
      ])
    ))

  it.effect("closes a live stream and releases its subscription after session revocation", () =>
    Effect.gen(function*() {
      const activeSubscriptions = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const revokedAuthentication = Auth.of({
        ...streamAuthentication,
        authenticate: () => Effect.fail(new CredentialRejectedError())
      })
      const trackedLiveEvents = LiveEvents.of({
        open: () =>
          Ref.update(activeSubscriptions, (count) => count + 1).pipe(
            Effect.as(Stream.never.pipe(
              Stream.ensuring(
                Ref.update(activeSubscriptions, (count) => count - 1).pipe(
                  Effect.andThen(Deferred.succeed(closed, void 0))
                )
              )
            ))
          )
      })
      const trackedHandler = liveEventHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(Layer.succeed(Auth, revokedAuthentication)),
        Layer.provide(LiveStreamAdmission.layer),
        Layer.provide(ServerLifecycle.layer),
        Layer.provide(Layer.succeed(LiveEvents, trackedLiveEvents))
      )
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["liveEvents"])
        const eventStream = yield* client.liveEvents.stream({ headers: {}, query: {} })
        const drained = yield* Stream.runDrain(eventStream).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 1)

        yield* TestClock.adjust(Duration.seconds(25))
        yield* Fiber.join(drained)
        yield* Deferred.await(closed)

        assert.strictEqual(yield* Ref.get(activeSubscriptions), 0)
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          trackedHandler
        ])
      )
    }))

  it.effect("closes an existing live stream when server drain begins", () =>
    Effect.gen(function*() {
      const activeSubscriptions = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const lifecycle = yield* ServerLifecycle.make
      const trackedHandler = liveEventHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(Layer.succeed(Auth, streamAuthentication)),
        Layer.provide(LiveStreamAdmission.layer),
        Layer.provide(Layer.succeed(LiveEvents, {
          open: () =>
            Ref.update(activeSubscriptions, (count) => count + 1).pipe(
              Effect.as(Stream.never.pipe(
                Stream.ensuring(
                  Ref.update(activeSubscriptions, (count) => count - 1).pipe(
                    Effect.andThen(Deferred.succeed(closed, undefined))
                  )
                )
              ))
            )
        })),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle))
      )

      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["liveEvents"])
        const eventStream = yield* client.liveEvents.stream({ headers: {}, query: {} })
        const drained = yield* Stream.runDrain(eventStream).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 1)

        yield* lifecycle.beginDrain
        yield* Fiber.join(drained)
        yield* Deferred.await(closed)

        assert.strictEqual(yield* Ref.get(activeSubscriptions), 0)
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          trackedHandler
        ]),
        Effect.provideService(ServerLifecycle, lifecycle)
      )
    }))

  it.effect("contains periodic authentication defects at the raw SSE boundary", () =>
    Effect.gen(function*() {
      const secretCanary = "periodic-auth-defect-secret-canary"
      const authenticationCalls = yield* Ref.make(0)
      const activeSubscriptions = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const sleepScheduled = yield* Deferred.make<void>()
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock))
      const instrumentedClock: Clock.Clock = {
        ...testClock,
        sleep: (duration) => Deferred.succeed(sleepScheduled, void 0).pipe(Effect.andThen(testClock.sleep(duration)))
      }
      const authentication = Auth.of({
        ...streamAuthentication,
        authenticate: () =>
          Ref.getAndUpdate(authenticationCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 0 ? Effect.succeed(session) : Effect.die(secretCanary)))
          )
      })
      const trackedLiveEvents = LiveEvents.of({
        open: () =>
          Ref.update(activeSubscriptions, (count) => count + 1).pipe(
            Effect.as(
              Stream.never.pipe(
                Stream.ensuring(
                  Ref.update(activeSubscriptions, (count) => count - 1).pipe(
                    Effect.andThen(Deferred.succeed(closed, void 0))
                  )
                )
              )
            )
          )
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used"),
        testConnection: () => Effect.die("not used")
      })
      const media = MediaReads.of({ read: () => Effect.die("not used") })
      const bind = yield* decodeBindConfig({})
      const requestContext = Context.empty().pipe(
        Context.add(Auth, authentication),
        Context.add(ApiBindConfiguration, bind),
        Context.add(MediaReads, media),
        Context.add(PluginAdministration, plugins),
        Context.add(LiveEvents, trackedLiveEvents)
      )
      const webHandlerLayer = controlCenterApiLayer.pipe(
        Layer.provideMerge(HttpServer.layerServices),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Auth, authentication),
            Layer.succeed(ApiBindConfiguration, bind),
            Layer.succeed(MediaReads, media),
            Layer.succeed(PluginAdministration, plugins),
            Layer.succeed(Clock.Clock, instrumentedClock),
            Layer.succeed(LiveEvents, trackedLiveEvents),
            authorizedSharesLayer,
            portfolioLayer,
            timelineApplicationLayer,
            deliveryGraphApplicationLayer,
            agentLayer,
            NodeHttpServer.layerHttpServices,
            NodeServices.layer
          )
        )
      )
      const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })

      yield* Effect.gen(function*() {
        const response = yield* Effect.promise(() =>
          webHandler.handler(
            new Request("http://127.0.0.1:4173/api/v1/events", {
              headers: {
                cookie: `cc_session=${"ab".repeat(32)}`,
                host: "127.0.0.1:4173",
                origin: "http://127.0.0.1:4173"
              }
            }),
            requestContext
          )
        )
        assert.strictEqual(response.status, 200)
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 1)

        const responseBody = yield* Effect.promise(() => response.text()).pipe(Effect.forkChild)
        yield* Deferred.await(sleepScheduled)
        yield* testClock.adjust(Duration.seconds(25))
        const rawSse = yield* Fiber.join(responseBody)
        yield* Deferred.await(closed)

        assert.notInclude(rawSse, secretCanary)
        assert.notInclude(rawSse, "effect/httpapi/stream/failure")
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 0)
      }).pipe(Effect.ensuring(Effect.promise(() => webHandler.dispose())))
    }))

  it("recovers a session-bound CSRF proof only through an authenticated allowed-origin read", async () => {
    const recoveredCsrf = "ef".repeat(32)
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(session),
      authorizeMutation: () => Effect.die("not used"),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("not used"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("not used"),
      logout: () => Effect.die("not used"),
      recoverCsrfToken: () =>
        Effect.succeed({
          csrfToken: Redacted.make(recoveredCsrf),
          session
        }),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("not used")
    })
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
      patchConfiguration: () => Effect.die("not used"),
      testConnection: () => Effect.die("not used")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = controlCenterApiLayer.pipe(
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          authorizedSharesLayer,
          portfolioLayer,
          timelineApplicationLayer,
          deliveryGraphApplicationLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const requestFor = (origin: string) =>
      new Request("http://127.0.0.1:4173/api/v1/session/current", {
        headers: {
          cookie: `cc_session=${"ab".repeat(32)}`,
          host: "127.0.0.1:4173",
          origin
        }
      })
    const liveRequestHeaders = {
      cookie: `cc_session=${"ab".repeat(32)}`,
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173"
    }
    try {
      const response = await webHandler.handler(requestFor("http://127.0.0.1:4173"), requestContext)
      assert.strictEqual(response.status, 200)
      const responseBody = Schema.decodeUnknownSync(CurrentSessionResponse)(await response.json())
      assert.strictEqual(responseBody.csrfToken, recoveredCsrf)
      assert.strictEqual(responseBody.session.sessionId, session.sessionId)

      const shareResponse = await webHandler.handler(
        new Request(`http://127.0.0.1:4173/api/v1/shares/${workspaceId}/${authorizedShareId}`, {
          headers: liveRequestHeaders
        }),
        requestContext
      )
      assert.strictEqual(shareResponse.status, 200)
      assert.strictEqual(shareResponse.headers.get("cache-control"), "private, no-store")

      const crossWorkspaceShareResponse = await webHandler.handler(
        new Request(`http://127.0.0.1:4173/api/v1/shares/${otherShareWorkspaceId}/${authorizedShareId}`, {
          headers: liveRequestHeaders
        }),
        requestContext
      )
      assert.strictEqual(crossWorkspaceShareResponse.status, 404)

      const malformedCursorRequests = [
        ...[
          "http://127.0.0.1:4173/api/v1/events?after=",
          "http://127.0.0.1:4173/api/v1/events?after=%20",
          "http://127.0.0.1:4173/api/v1/events?after=01",
          "http://127.0.0.1:4173/api/v1/events?after=%2B1",
          "http://127.0.0.1:4173/api/v1/events?after=1e3",
          "http://127.0.0.1:4173/api/v1/events?after=0x10"
        ].map((url) => new Request(url, { headers: liveRequestHeaders })),
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: { ...liveRequestHeaders, "last-event-id": "01" }
        })
      ]
      for (const malformedCursorRequest of malformedCursorRequests) {
        const malformedCursorResponse = await webHandler.handler(malformedCursorRequest, requestContext)
        assert.strictEqual(malformedCursorResponse.status, 400, malformedCursorRequest.url)
      }

      const liveResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: liveRequestHeaders
        }),
        requestContext
      )
      assert.strictEqual(liveResponse.status, 200)
      assert.strictEqual(liveResponse.headers.get("cache-control"), "private, no-store")
      assert.strictEqual(liveResponse.headers.get("x-accel-buffering"), "no")
      await liveResponse.body?.cancel()

      const foreignOrigin = await webHandler.handler(requestFor("http://attacker.example"), requestContext)
      assert.strictEqual(foreignOrigin.status, 403)
    } finally {
      await webHandler.dispose()
    }
  })

  it("returns typed 429 at the session stream cap and admits a replacement after cancellation", async () => {
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
      patchConfiguration: () => Effect.die("not used"),
      testConnection: () => Effect.die("not used")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, streamAuthentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = controlCenterApiLayer.pipe(
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, streamAuthentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          authorizedSharesLayer,
          portfolioLayer,
          timelineApplicationLayer,
          deliveryGraphApplicationLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const open = () =>
      webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: {
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173"
          }
        }),
        requestContext
      )
    const retained: Array<Response> = []
    try {
      for (let index = 0; index < DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION; index += 1) {
        const response = await open()
        assert.strictEqual(response.status, 200)
        retained.push(response)
      }

      const rejected = await open()
      assert.strictEqual(rejected.status, 429)
      assert.deepInclude(await rejected.json(), {
        _tag: "RateLimitedApiError",
        code: "rate-limited",
        retryAt: null
      })

      await retained.shift()?.body?.cancel()
      const replacement = await open()
      assert.strictEqual(replacement.status, 200)
      retained.push(replacement)
    } finally {
      await Promise.all(retained.map((response) => response.body?.cancel()))
      await webHandler.dispose()
    }
  })

  it("allows only current-session recovery from the session and configuration APIs on insecure LAN", async () => {
    const recoveredCsrf = "ef".repeat(32)
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(session),
      authorizeMutation: () => Effect.die("blocked insecure-LAN mutation reached CSRF verification"),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("blocked insecure-LAN pairing reached its handler"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("blocked insecure-LAN session list reached its handler"),
      logout: () => Effect.die("blocked insecure-LAN logout reached its handler"),
      recoverCsrfToken: () =>
        Effect.succeed({
          csrfToken: Redacted.make(recoveredCsrf),
          session
        }),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("blocked insecure-LAN revocation reached its handler")
    })
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
      patchConfiguration: () => Effect.die("blocked insecure-LAN configuration reached its handler"),
      testConnection: () => Effect.die("not used")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const origin = "http://192.168.1.42:4173"
    const bind = await Effect.runPromise(
      decodeBindConfig({
        host: "0.0.0.0",
        port: 4173,
        publicOrigin: origin,
        allowedHosts: ["192.168.1.42:4173"],
        allowedOrigins: [origin],
        allowInsecureLan: true
      })
    )
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = controlCenterApiLayer.pipe(
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          authorizedSharesLayer,
          portfolioLayer,
          timelineApplicationLayer,
          deliveryGraphApplicationLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const headers = {
      cookie: `cc_session=${"ab".repeat(32)}`,
      host: "192.168.1.42:4173",
      origin
    }
    try {
      const current = await webHandler.handler(
        new Request(`${origin}/api/v1/session/current`, { headers }),
        requestContext
      )
      assert.strictEqual(current.status, 200)
      assert.strictEqual(
        Schema.decodeUnknownSync(CurrentSessionResponse)(await current.json()).csrfToken,
        recoveredCsrf
      )

      const blockedRequests: ReadonlyArray<readonly [Request, number]> = [
        [new Request(`${origin}/api/v1/session`, { headers }), 403],
        [
          new Request(`${origin}/api/v1/session/pair`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ pairingCode: "ab".repeat(32) })
          }),
          400
        ],
        [
          new Request(`${origin}/api/v1/session/${session.sessionId}`, {
            method: "DELETE",
            headers: { ...headers, "x-csrf-token": recoveredCsrf }
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/session/device-code`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ permission: "workspace-approver" })
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/session/logout`, {
            method: "POST",
            headers: { ...headers, "x-csrf-token": recoveredCsrf }
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/plugins/connections/01890f6f-6d6a-7cc0-98d2-000000000092`, {
            method: "PATCH",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ isEnabled: true })
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/configuration`, {
            method: "PATCH",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ expectedRevision: 0, values: [] })
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000011/turns`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ history: [], prompt: "Read a repository secret", provider: "codex" })
          }),
          403
        ]
      ]
      for (const [blockedRequest, expectedStatus] of blockedRequests) {
        const response = await webHandler.handler(blockedRequest, requestContext)
        assert.strictEqual(response.status, expectedStatus, `${blockedRequest.method} ${blockedRequest.url}`)
      }
    } finally {
      await webHandler.dispose()
    }
  })

  it("rejects a non-owner plugin configuration mutation through the real auth middleware", async () => {
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(watcherSession),
      authorizeMutation: () => Effect.succeed(watcherSession),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("not used"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("not used"),
      logout: () => Effect.die("not used"),
      recoverCsrfToken: () => Effect.die("not used"),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("not used")
    })
    const plugins = PluginAdministration.of({
      administration: () => Effect.die("non-owner reached connection administration"),
      connectAndTest: () => Effect.die("non-owner reached connection creation"),
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.succeed([]),
      patchConfiguration: () => Effect.die("non-owner reached plugin mutation"),
      patchProviderAccount: () => Effect.die("non-owner reached account mutation"),
      reauthorizeConnection: () => Effect.die("non-owner reached credential replacement"),
      revokeConnection: () => Effect.die("non-owner reached credential revocation"),
      setConnectionEnabled: () => Effect.die("non-owner reached connection enablement"),
      synchronizeConnection: () => Effect.die("non-owner reached manual synchronization"),
      testConnection: () => Effect.die("non-owner reached connection test")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = controlCenterApiLayer.pipe(
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          authorizedSharesLayer,
          portfolioLayer,
          timelineApplicationLayer,
          deliveryGraphApplicationLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/configuration", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({ expectedRevision: 0, values: [] })
        }),
        requestContext
      )

      assert.strictEqual(response.status, 403)
      assert.deepInclude(await response.json(), {
        _tag: "ForbiddenApiError",
        code: "forbidden"
      })
      const testResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/test", {
          method: "POST",
          headers: {
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          }
        }),
        requestContext
      )
      assert.strictEqual(testResponse.status, 403)
      const synchronizationResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/sync", {
          method: "POST",
          headers: {
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          }
        }),
        requestContext
      )
      assert.strictEqual(synchronizationResponse.status, 403)
      const recoveryRequests = [
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/reauthorize", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({ expectedRevision: 1, credentials: [{ key: "profile", value: "rotated" }] })
        }),
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/revoke", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({ expectedRevision: 1 })
        }),
        new Request("http://127.0.0.1:4173/api/v1/plugins/accounts/01890f6f-6d6a-7cc0-98d2-000000000013", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({ expectedRevision: 1, displayName: "Blocked rename" })
        })
      ]
      for (const recoveryRequest of recoveryRequests) {
        const recoveryResponse = await webHandler.handler(recoveryRequest, requestContext)
        assert.strictEqual(recoveryResponse.status, 403)
      }
      const createResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/plugins/connections", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({
            pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000092",
            providerId: "codecommit",
            displayName: "Payments CodeCommit",
            values: [
              { _tag: "text", key: "profile", value: "default" },
              { _tag: "text", key: "region", value: "eu-west-1" },
              { _tag: "text", key: "repositoryName", value: "payments" }
            ]
          })
        }),
        requestContext
      )
      assert.strictEqual(createResponse.status, 403)
    } finally {
      await webHandler.dispose()
    }
  })
})
