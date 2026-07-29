import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderError,
  AgentProviderId,
  makeAgentRuntime,
  makeDeterministicLanguageModel
} from "@knpkv/ai-runtime"
import { DateTime, Deferred, Duration, Effect, Fiber, Option, Ref, Result, Schema, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"

import {
  AgentModelId,
  DurableAgentProviderId,
  MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH,
  type PullRequestReviewUnavailable,
  ReleaseAgentThreadCursor,
  type ReviewAgentProfile,
  ReviewAgentProfileId,
  ReviewSuggestionPublicationAuthorityBinding,
  ReviewSuggestionPublicationContent
} from "../../src/api/agent.js"
import { WorkspaceEntityInspection } from "../../src/api/deliveryGraph.js"
import {
  AgentId,
  AgentThreadId,
  EntityId,
  GovernedActionId,
  JobId,
  PersonId,
  PluginConnectionId,
  PrReviewSuggestionRevisionId,
  ReleaseId,
  ReviewSuggestionPublicationReservationId,
  SessionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import {
  PluginProviderOperationId,
  type PluginProviderReceiptV1,
  ProposePluginActionRequestV1
} from "../../src/domain/plugins/actions.js"
import { PrReviewPath, PrReviewReport, PrReviewSuggestion, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import {
  PrReviewSuggestionAgentAuthor,
  PrReviewSuggestionEdit,
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPage,
  PrReviewSuggestionRevisionPageSize,
  PrReviewSuggestionRevisionSequence,
  PrReviewSuggestionValidated
} from "../../src/domain/prReviewRevision.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  DeliveryGraphInspection,
  PullRequestReviews
} from "../../src/server/api/ApplicationServices.js"
import {
  reviewPublicationActionCanAdvance,
  reviewPublicationActionConfirmedNoWrite,
  reviewPublicationProposalRequestMatches,
  reviewPublicationSessionIsAuthorized,
  reviewSuggestionPublicationLocation
} from "../../src/server/application/GovernedReviewSuggestionPublicationGateway.js"
import { pullRequestReviewsLayer } from "../../src/server/application/pullRequestReviews.js"
import {
  type PublishReviewSuggestionCommand,
  ReviewSuggestionPublicationGateway,
  ReviewSuggestionPublicationGatewayError
} from "../../src/server/application/ReviewSuggestionPublicationGateway.js"
import { SessionSummary } from "../../src/server/auth/models.js"
import { RecordNotFoundError } from "../../src/server/persistence/errors.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  AgentEventCursor,
  AgentJobInputError,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize,
  LatestAgentReviewRecord,
  ReviewSuggestionPublicationReservation
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000401")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000402")
const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000403")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000404")
const OTHER_ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-00000000040b")
const OTHER_PLUGIN_CONNECTION_ID = PluginConnectionId.make(
  "01890f6f-6d6a-7cc0-98d2-00000000040c"
)
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000405")
const REVIEW_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000406")
const OPERATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000407")
const PUBLICATION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000408")
const RESERVATION_ID = ReviewSuggestionPublicationReservationId.make(
  "01890f6f-6d6a-7cc0-98d2-000000000409"
)
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"3".repeat(64)}`)
const REVIEW_REVISION_ID = PrReviewSuggestionRevisionId.make(
  `sha256:${"4".repeat(64)}`
)
const MODEL = AgentModelId.make("review-model")
const PROVIDER_ID = DurableAgentProviderId.make("openai-compatible")
const CLAUDE_MODEL = AgentModelId.make("default")
const CLAUDE_PROVIDER_ID = DurableAgentProviderId.make("claude")
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
  label: "Full-project review · openai-compatible · review-model",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}
const CLAUDE_REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("claude:default:sbx"),
  label: "Full-project review · claude · default",
  budgetMillis: 1_200_000,
  networkAccess: "provider-enabled",
  sandbox: "sbx"
}
const LANGUAGE_MODEL = Effect.runSync(
  LanguageModel.LanguageModel.pipe(
    Effect.provide(makeDeterministicLanguageModel([]).layer)
  )
)
const LEASE_OWNER = AgentLeaseOwner.make("review-test-worker")
const LEASE_TOKEN = AgentLeaseToken.make("1".repeat(64))
const STARTED_AT = "2026-07-24T15:00:00.000Z"
const PUBLISHED_AT = "2026-07-24T15:05:00.000Z"
const PUBLISHED_TIMESTAMP = Schema.decodeUnknownSync(UtcTimestamp)(PUBLISHED_AT)
const SESSION_ID = SessionId.make("01890f6f-6d6a-7cc0-98d2-000000000409")
const AGENT_ID = AgentId.make("01890f6f-6d6a-7cc0-98d2-00000000040a")
const IDLE_EXPIRES_AT = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-24T16:00:00.000Z")
const ABSOLUTE_EXPIRES_AT = Schema.decodeUnknownSync(UtcTimestamp)("2026-08-24T15:00:00.000Z")
const STARTED_TIMESTAMP = Schema.decodeUnknownSync(UtcTimestamp)(STARTED_AT)
const AUTHORITY_BINDING = ReviewSuggestionPublicationAuthorityBinding.make(
  `sha256:${"a".repeat(64)}`
)
const HUMAN_SESSION = {
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  actor: { _tag: "human", personId: OPERATOR_ID },
  permission: "workspace-owner",
  createdAt: STARTED_TIMESTAMP,
  lastSeenAt: STARTED_TIMESTAMP,
  idleExpiresAt: IDLE_EXPIRES_AT,
  absoluteExpiresAt: ABSOLUTE_EXPIRES_AT,
  revokedAt: null
} satisfies typeof SessionSummary.Type

const release = Schema.decodeSync(Release)({
  id: RELEASE_ID,
  workspaceId: WORKSPACE_ID,
  serviceName: "control-center",
  version: "review-212",
  lifecycle: "candidate",
  relay: deriveReleaseRelay(RELEASE_ID),
  targetEnvironmentIds: [],
  roleAssignments: [],
  sourceRevisions: [],
  freshness: {
    _tag: "unavailable",
    pluginHealth: { _tag: "disabled", checkedAt: STARTED_AT },
    provenance: { _tag: "none", pluginConnectionId: PLUGIN_CONNECTION_ID },
    sourceObservedAt: null,
    staleAfterSeconds: 300,
    synchronizedAt: null
  },
  createdAt: STARTED_AT,
  updatedAt: STARTED_AT
})

const inspection = Schema.decodeSync(WorkspaceEntityInspection)({
  clockifyApproval: null,
  entity: {
    canonicalReleaseId: RELEASE_ID,
    owners: [],
    ownersTruncated: false,
    releaseIds: [RELEASE_ID],
    releaseMembershipsTruncated: false,
    projection: {
      workspaceId: WORKSPACE_ID,
      entityId: ENTITY_ID,
      projectionRevision: 1,
      sourceEntityRevision: 1,
      supersedesProjectionRevision: null,
      projectionSchemaVersion: 1,
      entityState: "present",
      entityType: "pull-request",
      displayKey: "PR-212",
      title: "Complete immutable review",
      details: {
        _tag: "pull-request",
        repository: "control-center",
        sourceBranch: "refs/heads/feature",
        targetBranch: "refs/heads/main",
        baseRevision: "1".repeat(40),
        headRevision: "2".repeat(40),
        reviewState: "requested"
      }
    },
    recordedAt: "2026-07-24T15:00:00.000Z"
  },
  source: {
    providerId: "codecommit",
    pluginConnectionId: PLUGIN_CONNECTION_ID,
    vendorImmutableId: "212",
    revision: "source-7",
    sourceUrl:
      "https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/control-center/pull-requests/212",
    firstObservedAt: "2026-07-24T14:58:00.000Z",
    lastObservedAt: "2026-07-24T14:59:00.000Z",
    synchronizedAt: "2026-07-24T15:00:00.000Z",
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

const encodedInspection = Schema.encodeSync(WorkspaceEntityInspection)(inspection)
const otherConnectionInspection = Schema.decodeSync(WorkspaceEntityInspection)({
  ...encodedInspection,
  entity: {
    ...encodedInspection.entity,
    projection: {
      ...encodedInspection.entity.projection,
      entityId: OTHER_ENTITY_ID
    }
  },
  source: {
    ...encodedInspection.source,
    pluginConnectionId: OTHER_PLUGIN_CONNECTION_ID
  }
})

const reviewReport = Schema.decodeSync(PrReviewReport)({
  schemaVersion: 3,
  subject: {
    providerId: "codecommit",
    repository: "control-center",
    pullRequestId: "212",
    baseRevision: "1".repeat(40),
    headRevision: "2".repeat(40)
  },
  completion: { status: "complete" },
  suggestions: [{
    suggestionId: SUGGESTION_ID,
    state: "draft",
    title: "Authorize before mutating",
    severity: "P2",
    problem: "Authorization is checked after the mutation.",
    impact: "An unauthorized caller can change durable state.",
    evidence: {
      path: "src/authorization.ts",
      startLine: 42,
      endLine: 42,
      excerpt: "yield* mutate()"
    },
    recommendation: "Move the authorization check before the mutation.",
    anchor: {
      _tag: "line",
      path: "src/authorization.ts",
      line: 42,
      relativeFileVersion: "AFTER"
    },
    relatedLocations: [],
    confidence: {
      level: "high",
      reason: "The execution order is explicit in the reviewed source."
    },
    replacement: {
      reviewedHead: "2".repeat(40),
      unifiedDiff: [
        "--- a/src/authorization.ts",
        "+++ b/src/authorization.ts",
        "@@ -42,1 +42,2 @@",
        "+yield* authorize()",
        " yield* mutate()"
      ].join("\n"),
      explanation: "Authorize before mutating."
    }
  }],
  notes: []
})

const completedReview = Schema.decodeSync(LatestAgentReviewRecord)({
  jobId: REVIEW_JOB_ID,
  threadId: THREAD_ID,
  providerId: "openai-compatible",
  model: "review-model",
  state: "succeeded",
  createdAt: STARTED_AT,
  terminalAt: PUBLISHED_AT,
  report: reviewReport,
  reviewProfile: REVIEW_PROFILE,
  activity: { events: [], truncated: false }
})
const FOLLOW_UP_REVIEW_JOB_ID = JobId.make(
  "01890f6f-6d6a-7cc0-98d2-000000000099"
)
const failedFollowUpReview = Schema.decodeSync(LatestAgentReviewRecord)({
  ...Schema.encodeSync(LatestAgentReviewRecord)(completedReview),
  jobId: FOLLOW_UP_REVIEW_JOB_ID,
  state: "failed",
  report: null
})

const completedReviewWithSuggestion = (
  overrides: Partial<typeof reviewReport.suggestions[number]>
) => {
  const encoded = Schema.encodeSync(LatestAgentReviewRecord)(completedReview)
  const report = Schema.decodeUnknownSync(PrReviewReport)({
    ...reviewReport,
    suggestions: [{
      ...reviewReport.suggestions[0],
      ...overrides
    }]
  })
  return Schema.decodeSync(LatestAgentReviewRecord)({
    ...encoded,
    report: Schema.encodeSync(PrReviewReport)(report)
  })
}

const graphInspection = DeliveryGraphInspection.of({
  workspaceEntity: ({ entityId, workspaceId }) =>
    entityId === ENTITY_ID && workspaceId === WORKSPACE_ID
      ? Effect.succeed(inspection)
      : Effect.die("review crossed its workspace or entity boundary"),
  workspaceEntityProjections: () => Effect.die("not used"),
  releaseSlice: () => Effect.die("not used"),
  repairCandidates: () => Effect.die("not used"),
  repairProposalDraft: () => Effect.die("not used"),
  relationship: () => Effect.die("not used"),
  relationshipHistory: () => Effect.die("not used"),
  evidence: () => Effect.die("not used")
})

const multipleConnectionGraphInspection = DeliveryGraphInspection.of({
  ...graphInspection,
  workspaceEntity: ({ entityId, workspaceId }) =>
    workspaceId !== WORKSPACE_ID
      ? Effect.die("review crossed its workspace boundary")
      : entityId === ENTITY_ID
      ? Effect.succeed(inspection)
      : entityId === OTHER_ENTITY_ID
      ? Effect.succeed(otherConnectionInspection)
      : Effect.die("review crossed its entity boundary")
})

const runtime = makeAgentRuntime({ run: () => Stream.empty })
const registry = AgentRuntimeRegistry.of({
  catalog: () =>
    Effect.succeed({
      providers: [{
        providerId: PROVIDER_ID,
        models: [MODEL],
        capabilities: ["release-chat", "pr-review"],
        health: "available",
        reviewProfile: REVIEW_PROFILE
      }]
    }),
  select: ({ access, model, providerId }) =>
    access === "read-only" && model === MODEL && providerId === "openai-compatible"
      ? Effect.succeed({
        model: MODEL,
        runtime,
        filesystemAccess: "none",
        reviewExecution: "effect-ai",
        languageModel: LANGUAGE_MODEL
      })
      : Effect.fail(
        new AgentProviderError({
          providerId,
          phase: "configuration",
          message: "Unavailable test selection.",
          retryable: false
        })
      )
})

const localRegistry = AgentRuntimeRegistry.of({
  ...registry,
  select: () => Effect.succeed({ model: MODEL, runtime, filesystemAccess: "configured-workspace" })
})

const nativeClaudeRegistry = AgentRuntimeRegistry.of({
  catalog: () =>
    Effect.succeed({
      providers: [{
        providerId: CLAUDE_PROVIDER_ID,
        models: [CLAUDE_MODEL],
        capabilities: ["release-chat", "pr-review"],
        health: "available",
        reviewProfile: CLAUDE_REVIEW_PROFILE
      }]
    }),
  select: ({ access, model, providerId }) =>
    access === "read-only" && model === CLAUDE_MODEL && providerId === "claude"
      ? Effect.succeed({
        model: CLAUDE_MODEL,
        runtime,
        filesystemAccess: "configured-workspace",
        reviewExecution: "native-claude",
        reviewExecutable: "claude"
      })
      : Effect.fail(
        new AgentProviderError({
          providerId,
          phase: "configuration",
          message: "Unavailable native Claude test selection.",
          retryable: false
        })
      )
})

const reviewDisabledRegistry = AgentRuntimeRegistry.of({
  ...registry,
  select: ({ capability, providerId }) =>
    capability === "pr-review"
      ? Effect.fail(
        new AgentProviderError({
          providerId,
          phase: "configuration",
          message: "PR review worker is not configured.",
          retryable: false
        })
      )
      : Effect.succeed({ model: MODEL, runtime, filesystemAccess: "none" })
})

const offlineRegistry = AgentRuntimeRegistry.of({
  ...registry,
  select: () => Effect.die("provider selection must not run while recovering active work")
})

const unusedPublicationGateway = ReviewSuggestionPublicationGateway.of({
  identity: () => Effect.die("review publication identity is not used"),
  publish: () => Effect.die("review publication is not used"),
  replay: () => Effect.die("review publication replay is not used")
})

const withService = <Success, Failure>(
  use: (
    service: PullRequestReviews["Service"],
    enqueueInput: Ref.Ref<unknown>,
    publicationCommands: Ref.Ref<ReadonlyArray<PublishReviewSuggestionCommand>>,
    publicationAuthority: Ref.Ref<ReviewSuggestionPublicationAuthorityBinding>,
    publicationFailure: Ref.Ref<null | ReviewSuggestionPublicationGatewayError["reason"]>,
    revisionInputs: Ref.Ref<ReadonlyArray<unknown>>
  ) => Effect.Effect<Success, Failure>,
  selectedRegistry = registry,
  latestReview: Option.Option<LatestAgentReviewRecord> = Option.none(),
  recordPublication: Persistence["Service"]["agentJobs"]["recordReviewSuggestionPublication"] = () =>
    Effect.succeed(undefined),
  reservePublication: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = () =>
    Effect.succeed({ _tag: "acquired" }),
  releasePublication: Persistence["Service"]["agentJobs"]["releaseReviewSuggestionPublication"] = () =>
    Effect.succeed(undefined),
  publishPublication?: ReviewSuggestionPublicationGateway["Service"]["publish"],
  latestReviewOverride?: Persistence["Service"]["agentJobs"]["latestReview"],
  appendRevision?: Persistence["Service"]["agentJobs"]["appendReviewSuggestionRevision"]
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-pull-request-reviews-")
    return yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      const enqueueInput = yield* Ref.make<unknown>(null)
      const publicationCommands = yield* Ref.make<ReadonlyArray<PublishReviewSuggestionCommand>>([])
      const publicationAuthority = yield* Ref.make(AUTHORITY_BINDING)
      const publicationFailure = yield* Ref.make<
        null | ReviewSuggestionPublicationGatewayError["reason"]
      >(null)
      const revisionInputs = yield* Ref.make<ReadonlyArray<unknown>>([])
      const resolveLatestReview = latestReviewOverride ??
        (() => Effect.succeed(latestReview))
      const testPersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          enqueue: (input) => Ref.set(enqueueInput, input).pipe(Effect.as(THREAD_ID)),
          latestReview: resolveLatestReview,
          appendReviewSuggestionRevision: (input) =>
            Ref.update(revisionInputs, (inputs) => [...inputs, input]).pipe(
              Effect.andThen(
                (appendRevision ?? persistence.agentJobs.appendReviewSuggestionRevision)(input)
              )
            ),
          reviewSuggestionRevisions: (input) =>
            Effect.gen(function*() {
              const selected = yield* resolveLatestReview({
                workspaceId: input.workspaceId,
                pluginConnectionId: PLUGIN_CONNECTION_ID,
                subject: reviewReport.subject,
                jobId: input.jobId
              })
              if (
                Option.isNone(selected) ||
                selected.value.report === null ||
                selected.value.terminalAt === null
              ) {
                return yield* new RecordNotFoundError({
                  workspaceId: input.workspaceId,
                  recordKind: "agent-review-suggestion",
                  recordKey: input.suggestionId
                })
              }
              const suggestion = selected.value.report.suggestions.find(
                ({ suggestionId }) => suggestionId === input.suggestionId
              )
              if (suggestion === undefined) {
                return yield* new RecordNotFoundError({
                  workspaceId: input.workspaceId,
                  recordKind: "agent-review-suggestion",
                  recordKey: input.suggestionId
                })
              }
              const revision = new PrReviewSuggestionRevision({
                revisionId: REVIEW_REVISION_ID,
                sequence: PrReviewSuggestionRevisionSequence.make(1),
                predecessorRevisionId: null,
                sourceJobId: selected.value.jobId,
                subject: selected.value.report.subject,
                suggestion: PrReviewSuggestion.make({
                  ...suggestion,
                  state: "draft"
                }),
                validation: new PrReviewSuggestionValidated({
                  reviewedHead: selected.value.report.subject.headRevision,
                  validatingJobId: selected.value.jobId,
                  sourceRevisionId: REVIEW_REVISION_ID
                }),
                author: new PrReviewSuggestionAgentAuthor({
                  jobId: selected.value.jobId,
                  providerId: AgentProviderId.make(selected.value.providerId),
                  model: selected.value.model,
                  runtimeMetadata: null
                }),
                createdAt: selected.value.terminalAt
              })
              return PrReviewSuggestionRevisionPage.make({
                current: revision,
                revisions: [revision],
                hasMore: false,
                nextBeforeSequence: null
              })
            }),
          recordReviewSuggestionPublication: recordPublication,
          releaseReviewSuggestionPublication: releasePublication,
          reserveReviewSuggestionPublication: reservePublication
        }
      })
      const defaultPublish: ReviewSuggestionPublicationGateway["Service"]["publish"] = (command) =>
        Ref.get(publicationAuthority).pipe(
          Effect.filterOrFail(
            (authorityBinding) => authorityBinding === command.authorityBinding,
            () =>
              new ReviewSuggestionPublicationGatewayError({
                reason: "publication-conflict"
              })
          ),
          Effect.andThen(
            Ref.get(publicationFailure)
          ),
          Effect.flatMap((failure) =>
            failure === null
              ? Ref.update(publicationCommands, (commands) => [...commands, command])
              : Effect.fail(new ReviewSuggestionPublicationGatewayError({ reason: failure }))
          ),
          Effect.as({
            publicationId: PUBLICATION_ID,
            receipt: {
              status: "succeeded",
              providerOperationId: PluginProviderOperationId.make("comment:review-comment-42"),
              safeSummary: "CodeCommit review comment posted",
              observedAt: PUBLISHED_TIMESTAMP
            } satisfies PluginProviderReceiptV1,
            publishedAt: PUBLISHED_TIMESTAMP,
            connectedIdentity: {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:user/local-operator"
            }
          })
        )
      const publicationGateway = ReviewSuggestionPublicationGateway.of({
        identity: () =>
          Ref.get(publicationAuthority).pipe(Effect.map((authorityBinding) => ({
            connectedIdentity: {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:user/local-operator"
            },
            authorityBinding
          }))),
        publish: publishPublication ?? defaultPublish,
        replay: () =>
          Effect.succeed({
            publicationId: PUBLICATION_ID,
            receipt: {
              status: "succeeded",
              providerOperationId: PluginProviderOperationId.make("comment:review-comment-42"),
              safeSummary: "CodeCommit review comment posted",
              observedAt: PUBLISHED_TIMESTAMP
            },
            publishedAt: PUBLISHED_TIMESTAMP,
            connectedIdentity: {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:user/local-operator"
            }
          })
      })
      const service = yield* PullRequestReviews.pipe(
        Effect.provide(pullRequestReviewsLayer),
        Effect.provideService(Persistence, testPersistence),
        Effect.provideService(DeliveryGraphInspection, graphInspection),
        Effect.provideService(AgentRuntimeRegistry, selectedRegistry),
        Effect.provideService(ReviewSuggestionPublicationGateway, publicationGateway)
      )
      return yield* use(
        service,
        enqueueInput,
        publicationCommands,
        publicationAuthority,
        publicationFailure,
        revisionInputs
      )
    }).pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const withRealService = <Success, Failure>(
  use: (
    service: PullRequestReviews["Service"],
    persistence: Persistence["Service"]
  ) => Effect.Effect<Success, Failure>,
  selectedInspection = graphInspection
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-pull-request-review-race-")
    return yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* persistence.workspaces.create(WORKSPACE_ID, {
        displayName: WorkspaceName.make("PR review race"),
        createdAt: release.createdAt
      })
      yield* persistence.releases.create(WORKSPACE_ID, release)
      const service = yield* PullRequestReviews.pipe(
        Effect.provide(pullRequestReviewsLayer),
        Effect.provideService(DeliveryGraphInspection, selectedInspection),
        Effect.provideService(AgentRuntimeRegistry, registry),
        Effect.provideService(ReviewSuggestionPublicationGateway, unusedPublicationGateway)
      )
      return yield* use(service, persistence)
    }).pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("pull request reviews", () => {
  it("advances only dispatchable or recoverable publication states", () => {
    assert.isTrue(reviewPublicationActionCanAdvance("authorized"))
    assert.isTrue(reviewPublicationActionCanAdvance("started"))
    assert.isTrue(reviewPublicationActionCanAdvance("unknown"))
    assert.isTrue(reviewPublicationActionCanAdvance("cancel-requested"))
    assert.isTrue(reviewPublicationActionCanAdvance("cancel-requested-unknown"))
    assert.isFalse(reviewPublicationActionCanAdvance("succeeded"))
    assert.isFalse(reviewPublicationActionCanAdvance("failed"))
    assert.isTrue(reviewPublicationActionConfirmedNoWrite("failed"))
    assert.isTrue(reviewPublicationActionConfirmedNoWrite("cancelled"))
    assert.isFalse(reviewPublicationActionConfirmedNoWrite("unknown"))
  })

  it("recovers publication only for the exact immutable review evidence", () => {
    const request = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
      actionKind: "comment",
      target: {
        entityType: "pull-request",
        vendorImmutableId: "212"
      },
      expectedRevision: "source-7",
      payload: { content: "Publish this review suggestion." },
      evidenceIds: [
        `pr-review:${REVIEW_JOB_ID}:${SUGGESTION_ID}:${REVIEW_REVISION_ID}`
      ]
    })
    const differentReview = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
      ...request,
      evidenceIds: [
        `pr-review:01890f6f-6d6a-7cc0-98d2-000000000099:${SUGGESTION_ID}:${REVIEW_REVISION_ID}`
      ]
    })
    const exactReplay = Schema.decodeUnknownSync(ProposePluginActionRequestV1)(
      Schema.encodeSync(ProposePluginActionRequestV1)(request)
    )

    assert.isTrue(reviewPublicationProposalRequestMatches(request, exactReplay))
    assert.isFalse(reviewPublicationProposalRequestMatches(request, differentReview))
  })

  it("publishes deleted-file anchors against the base revision", () => {
    assert.deepStrictEqual(
      reviewSuggestionPublicationLocation({
        _tag: "file",
        path: PrReviewPath.make("src/deleted.ts"),
        line: 1,
        relativeFileVersion: "BEFORE"
      }),
      {
        filePath: "src/deleted.ts",
        filePosition: 1,
        relativeFileVersion: "BEFORE"
      }
    )
    assert.deepStrictEqual(
      reviewSuggestionPublicationLocation({
        _tag: "file",
        path: PrReviewPath.make("src/modified.ts"),
        line: 4,
        relativeFileVersion: "AFTER"
      }),
      {
        filePath: "src/modified.ts",
        filePosition: 4,
        relativeFileVersion: "AFTER"
      }
    )
    assert.isUndefined(reviewSuggestionPublicationLocation({ _tag: "changes" }))
  })

  it.effect("rejects publication when provider authority rotates after preview", () =>
    withService(
      (service, _enqueueInput, publicationCommands, publicationAuthority) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })
          yield* Ref.set(
            publicationAuthority,
            ReviewSuggestionPublicationAuthorityBinding.make(
              `sha256:${"b".repeat(64)}`
            )
          )

          const result = yield* service.publishSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              finalContent: preview.finalContent,
              authorityBinding: preview.authorityBinding
            },
            session: {
              sessionId: SESSION_ID,
              workspaceId: WORKSPACE_ID,
              actor: { _tag: "human", personId: OPERATOR_ID },
              permission: "workspace-owner",
              createdAt: STARTED_TIMESTAMP,
              lastSeenAt: STARTED_TIMESTAMP,
              idleExpiresAt: IDLE_EXPIRES_AT,
              absoluteExpiresAt: ABSOLUTE_EXPIRES_AT,
              revokedAt: null
            }
          }).pipe(Effect.result)

          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.isTrue(Schema.is(ApplicationInvalidRequest)(result.failure))
          }
          assert.deepStrictEqual(yield* Ref.get(publicationCommands), [])
        }),
      registry,
      Option.some(completedReview)
    ))

  it.effect("keeps an earlier same-head completed suggestion publishable after a failed follow-up", () =>
    withService(
      (service) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })

          assert.strictEqual(preview.jobId, REVIEW_JOB_ID)
          assert.strictEqual(preview.suggestionId, SUGGESTION_ID)
        }),
      registry,
      Option.some(failedFollowUpReview),
      undefined,
      undefined,
      undefined,
      undefined,
      (input) =>
        Effect.succeed(
          input.jobId === REVIEW_JOB_ID
            ? Option.some(completedReview)
            : Option.some(failedFollowUpReview)
        )
    ))

  it("rejects non-owner, expired, revoked, and cross-workspace publication sessions", () => {
    const checkedAt = Schema.decodeUnknownSync(UtcTimestamp)(
      "2026-07-24T15:30:00.000Z"
    )
    const session = Schema.decodeUnknownSync(SessionSummary)({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      actor: { _tag: "human", personId: OPERATOR_ID },
      permission: "workspace-owner",
      createdAt: STARTED_AT,
      lastSeenAt: STARTED_AT,
      idleExpiresAt: "2026-07-24T16:00:00.000Z",
      absoluteExpiresAt: "2026-08-24T15:00:00.000Z",
      revokedAt: null
    })

    assert.isTrue(
      reviewPublicationSessionIsAuthorized(session, WORKSPACE_ID, checkedAt)
    )
    assert.isFalse(reviewPublicationSessionIsAuthorized(
      { ...session, permission: "workspace-approver" },
      WORKSPACE_ID,
      checkedAt
    ))
    assert.isFalse(reviewPublicationSessionIsAuthorized(
      { ...session, idleExpiresAt: checkedAt },
      WORKSPACE_ID,
      checkedAt
    ))
    assert.isFalse(reviewPublicationSessionIsAuthorized(
      { ...session, absoluteExpiresAt: checkedAt },
      WORKSPACE_ID,
      checkedAt
    ))
    assert.isFalse(reviewPublicationSessionIsAuthorized(
      { ...session, revokedAt: checkedAt },
      WORKSPACE_ID,
      checkedAt
    ))
    assert.isFalse(reviewPublicationSessionIsAuthorized(
      session,
      WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000499"),
      checkedAt
    ))
  })

  it.effect("derives the immutable subject and release server-side before enqueue", () =>
    withService((service, enqueueInput) =>
      Effect.gen(function*() {
        const before = yield* service.current({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID
        })
        assert.strictEqual(before._tag, "not-started")

        const accepted = yield* service.enqueue({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          request: {
            providerId: PROVIDER_ID,
            model: MODEL,
            profile: "read-only",
            reviewProfileId: REVIEW_PROFILE.profileId
          }
        })
        assert.strictEqual(accepted._tag, "pending")
        assert.deepStrictEqual(accepted.subject, {
          providerId: "codecommit",
          repository: "control-center",
          pullRequestId: "212",
          baseRevision: "1".repeat(40),
          headRevision: "2".repeat(40)
        })

        const persisted = yield* Ref.get(enqueueInput)
        assert.isNotNull(persisted)
        if (
          typeof persisted === "object" &&
          persisted !== null &&
          "task" in persisted
        ) {
          assert.deepStrictEqual(persisted.task, {
            _tag: "pr-review",
            pluginConnectionId: PLUGIN_CONNECTION_ID,
            reviewProfile: REVIEW_PROFILE,
            subject: {
              providerId: "codecommit",
              repository: "control-center",
              pullRequestId: "212",
              baseRevision: "1".repeat(40),
              headRevision: "2".repeat(40)
            }
          })
        } else {
          return yield* Effect.die("review enqueue input was not captured")
        }
      })
    ))

  it.effect("admits an advertised native Claude review before durable enqueue", () =>
    withService(
      (service, enqueueInput) =>
        Effect.gen(function*() {
          const accepted = yield* service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: CLAUDE_PROVIDER_ID,
              model: CLAUDE_MODEL,
              profile: "read-only",
              reviewProfileId: CLAUDE_REVIEW_PROFILE.profileId
            }
          })

          assert.strictEqual(accepted._tag, "pending")
          const persisted = yield* Ref.get(enqueueInput)
          assert.isNotNull(persisted)
          if (typeof persisted !== "object" || persisted === null || !("task" in persisted)) {
            return yield* Effect.die("native Claude review enqueue input was not captured")
          }
          assert.deepStrictEqual(persisted.task, {
            _tag: "pr-review",
            pluginConnectionId: PLUGIN_CONNECTION_ID,
            reviewProfile: CLAUDE_REVIEW_PROFILE,
            subject: {
              providerId: "codecommit",
              repository: "control-center",
              pullRequestId: "212",
              baseRevision: "1".repeat(40),
              headRevision: "2".repeat(40)
            }
          })
        }),
      nativeClaudeRegistry
    ))

  it.effect("rejects local workspace-capable providers before durable enqueue", () =>
    withService(
      (service, enqueueInput) =>
        Effect.gen(function*() {
          const result = yield* service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: PROVIDER_ID,
              model: MODEL,
              profile: "read-only",
              reviewProfileId: REVIEW_PROFILE.profileId
            }
          }).pipe(Effect.result)
          assert.isTrue(result._tag === "Failure")
          assert.isNull(yield* Ref.get(enqueueInput))
        }),
      localRegistry
    ))

  it.effect("rejects a Review Agent Profile other than the catalog selection", () =>
    withService((service, enqueueInput) =>
      Effect.gen(function*() {
        const result = yield* service.enqueue({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          request: {
            providerId: PROVIDER_ID,
            model: MODEL,
            profile: "read-only",
            reviewProfileId: ReviewAgentProfileId.make("openai-compatible:other-model:sbx")
          }
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, ApplicationInvalidRequest)
        }
        assert.isNull(yield* Ref.get(enqueueInput))
      })
    ))

  it.effect("rejects direct review enqueue when the provider has no review worker opt-in", () =>
    withService(
      (service, enqueueInput) =>
        Effect.gen(function*() {
          const result = yield* service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: PROVIDER_ID,
              model: MODEL,
              profile: "read-only",
              reviewProfileId: REVIEW_PROFILE.profileId
            }
          }).pipe(Effect.result)
          assert.isTrue(Result.isFailure(result))
          assert.isNull(yield* Ref.get(enqueueInput))
        }),
      reviewDisabledRegistry
    ))

  it.effect("recovers an active exact-subject review before selecting its provider", () => {
    const active = Schema.decodeSync(LatestAgentReviewRecord)({
      jobId: "01890f6f-6d6a-7cc0-98d2-000000000406",
      threadId: THREAD_ID,
      providerId: "openai-compatible",
      model: "review-model",
      state: "queued",
      createdAt: STARTED_AT,
      terminalAt: null,
      report: null,
      reviewProfile: REVIEW_PROFILE,
      activity: { events: [], truncated: false }
    })
    return withService(
      (service, enqueueInput) =>
        Effect.gen(function*() {
          const recovered = yield* service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: PROVIDER_ID,
              model: MODEL,
              profile: "read-only",
              reviewProfileId: REVIEW_PROFILE.profileId
            }
          })
          assert.strictEqual(recovered.jobId, active.jobId)
          assert.strictEqual(recovered.state, "queued")
          assert.isNull(yield* Ref.get(enqueueInput))
        }),
      offlineRegistry,
      Option.some(active)
    )
  })

  it.effect("previews without publishing, then grants one exact human-confirmed publication", () =>
    withService(
      (service, _enqueueInput, publicationCommands) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })

          assert.deepStrictEqual(preview.connectedIdentity, {
            accountId: "123456789012",
            arn: "arn:aws:iam::123456789012:user/local-operator"
          })
          assert.deepStrictEqual(preview.anchor, {
            _tag: "line",
            path: PrReviewPath.make("src/authorization.ts"),
            line: 42,
            relativeFileVersion: "AFTER"
          })
          assert.strictEqual(preview.suggestionRevision.reviewedHead, "2".repeat(40))
          assert.include(preview.replacement ?? "", "@@ -42,1 +42,2 @@")
          assert.include(preview.finalContent, "```diff")
          assert.notInclude(preview.editableContent, "Related locations:")
          assert.include(preview.finalContent, preview.publicationFooter)
          assert.deepStrictEqual(yield* Ref.get(publicationCommands), [])

          const editedBody = ReviewSuggestionPublicationContent.make(
            "Authorization must run first.\n\n```suggestion\nyield* authorize()\nyield* mutate()\n```"
          )
          const editedContent = ReviewSuggestionPublicationContent.make(
            `${editedBody}\n\n${preview.publicationFooter}`
          )
          const published = yield* service.publishSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              finalContent: editedContent,
              authorityBinding: preview.authorityBinding
            },
            session: {
              sessionId: SESSION_ID,
              workspaceId: WORKSPACE_ID,
              actor: { _tag: "human", personId: OPERATOR_ID },
              permission: "workspace-owner",
              createdAt: STARTED_TIMESTAMP,
              lastSeenAt: STARTED_TIMESTAMP,
              idleExpiresAt: IDLE_EXPIRES_AT,
              absoluteExpiresAt: ABSOLUTE_EXPIRES_AT,
              revokedAt: null
            }
          })

          assert.strictEqual(published.publicationId, PUBLICATION_ID)
          assert.include(published.content, editedBody)
          assert.include(published.content, REVIEW_PROFILE.label)
          assert.strictEqual(published.receipt.status, "succeeded")
          const commands = yield* Ref.get(publicationCommands)
          assert.strictEqual(commands.length, 1)
          assert.strictEqual(commands[0]?.target.sourceRevision, "source-7")
          assert.strictEqual(commands[0]?.suggestion.suggestionId, SUGGESTION_ID)
          assert.strictEqual(commands[0]?.session.actor._tag, "human")
          assert.strictEqual(commands[0]?.authorityBinding, AUTHORITY_BINDING)
          assert.include(commands[0]?.finalContent ?? "", REVIEW_PROFILE.label)
        }),
      registry,
      Option.some(completedReview)
    ))

  it.effect("records a human dismissal without calling the CodeCommit publication gateway", () => {
    const dismissedRevision = new PrReviewSuggestionRevision({
      revisionId: PrReviewSuggestionRevisionId.make(`sha256:${"6".repeat(64)}`),
      sequence: PrReviewSuggestionRevisionSequence.make(2),
      predecessorRevisionId: REVIEW_REVISION_ID,
      sourceJobId: REVIEW_JOB_ID,
      subject: reviewReport.subject,
      suggestion: PrReviewSuggestion.make({
        ...reviewReport.suggestions[0]!,
        state: "dismissed"
      }),
      validation: new PrReviewSuggestionValidated({
        reviewedHead: reviewReport.subject.headRevision,
        validatingJobId: REVIEW_JOB_ID,
        sourceRevisionId: REVIEW_REVISION_ID
      }),
      author: PrReviewSuggestionOperatorAuthor.make({
        personId: OPERATOR_ID
      }),
      createdAt: PUBLISHED_TIMESTAMP
    })
    return withService(
      (service, _enqueueInput, publicationCommands, _authority, _failure, revisionInputs) =>
        Effect.gen(function*() {
          const dismissed = yield* service.dismissSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            request: {
              expectedRevisionId: REVIEW_REVISION_ID,
              expectedSequence: PrReviewSuggestionRevisionSequence.make(1)
            },
            session: HUMAN_SESSION
          })

          assert.strictEqual(dismissed.suggestion.state, "dismissed")
          assert.deepStrictEqual(yield* Ref.get(publicationCommands), [])
          const inputs = yield* Ref.get(revisionInputs)
          assert.strictEqual(inputs.length, 1)
          assert.deepInclude(inputs[0], {
            workspaceId: WORKSPACE_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            expectedRevisionId: REVIEW_REVISION_ID,
            expectedSequence: PrReviewSuggestionRevisionSequence.make(1),
            state: "dismissed"
          })
        }),
      registry,
      Option.some(completedReview),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => Effect.succeed(dismissedRevision)
    )
  })

  it.effect("reserves one edited body before allowing the provider call", () =>
    Effect.gen(function*() {
      const reservedDigest = yield* Ref.make<null | string>(null)
      const firstReservationEntered = yield* Deferred.make<void>()
      const releaseFirstReservation = yield* Deferred.make<void>()
      const reserve: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = (input) =>
        Ref.modify(reservedDigest, (current): [
          "acquired" | "conflict" | "replay",
          null | string
        ] =>
          current === null
            ? ["acquired", String(input.contentDigest)]
            : current === input.contentDigest
            ? ["replay", current]
            : ["conflict", current]).pipe(
            Effect.flatMap((outcome) =>
              (
                outcome === "acquired"
                  ? Deferred.succeed(firstReservationEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstReservation))
                  )
                  : outcome === "replay"
                  ? Effect.void
                  : new AgentJobInputError({
                    workspaceId: input.workspaceId,
                    jobId: input.jobId,
                    reason: "invalid-transition"
                  })
              ).pipe(Effect.as(outcome))
            ),
            Effect.map((outcome) =>
              ReviewSuggestionPublicationReservation.make({
                _tag: outcome === "acquired" ? "acquired" : "in-progress"
              })
            )
          )

      yield* withService(
        (service, _enqueueInput, publicationCommands) =>
          Effect.gen(function*() {
            const preview = yield* service.previewPublication({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              publishingOperator: OPERATOR_ID
            })
            const differentContent = ReviewSuggestionPublicationContent.make(
              `A different confirmed body.\n\n${preview.publicationFooter}`
            )
            const first = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent: preview.finalContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(firstReservationEntered)
            const joiner = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent: preview.finalContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            }).pipe(Effect.result)
            const different = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent: differentContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            }).pipe(Effect.result)
            yield* Deferred.succeed(releaseFirstReservation, undefined)
            yield* Fiber.join(first)

            assert.isTrue(Result.isFailure(joiner))
            if (Result.isFailure(joiner)) {
              assert.instanceOf(joiner.failure, ApplicationServiceUnavailable)
            }
            assert.isTrue(Result.isFailure(different))
            if (Result.isFailure(different)) {
              assert.instanceOf(different.failure, ApplicationInvalidRequest)
            }
            assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
          }),
        registry,
        Option.some(completedReview),
        () => Effect.succeed(undefined),
        reserve
      )
    }))

  it.effect("replays an exact completed publication without posting again", () =>
    Effect.gen(function*() {
      const completedDigest = yield* Ref.make<null | string>(null)
      const reserve: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = (input) =>
        Ref.modify(completedDigest, (current): [boolean, string] =>
          current === null || current === input.contentDigest
            ? [true, String(input.contentDigest)]
            : [false, current]).pipe(
            Effect.flatMap((matches) =>
              matches
                ? Effect.succeed(ReviewSuggestionPublicationReservation.make({
                  _tag: "published",
                  publicationId: PUBLICATION_ID,
                  publishedAt: PUBLISHED_TIMESTAMP
                }))
                : new AgentJobInputError({
                  workspaceId: input.workspaceId,
                  jobId: input.jobId,
                  reason: "invalid-transition"
                })
            )
          )

      yield* withService(
        (service, _enqueueInput, publicationCommands) =>
          Effect.gen(function*() {
            const footer = `— ${REVIEW_PROFILE.label} · head ${"2".repeat(12)} · operator ${OPERATOR_ID}`
            const finalContent = ReviewSuggestionPublicationContent.make(
              `Exact completed body.\n\n${footer}`
            )
            const replay = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent,
                authorityBinding: AUTHORITY_BINDING
              },
              session: HUMAN_SESSION
            })
            assert.strictEqual(replay.publicationId, PUBLICATION_ID)
            assert.strictEqual((yield* Ref.get(publicationCommands)).length, 0)

            const history = yield* service.revisions({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              beforeSequence: null,
              limit: PrReviewSuggestionRevisionPageSize.make(1)
            })
            assert.strictEqual(history.current.suggestion.state, "published")
            const editAfterPublication = yield* service.editSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              request: {
                expectedRevisionId: history.current.revisionId,
                expectedSequence: history.current.sequence,
                edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
                  ...history.current.suggestion,
                  title: "Published suggestions cannot be edited"
                })
              },
              session: HUMAN_SESSION
            }).pipe(Effect.result)
            assert.isTrue(Result.isFailure(editAfterPublication))
            if (Result.isFailure(editAfterPublication)) {
              assert.instanceOf(
                editAfterPublication.failure,
                ApplicationInvalidRequest
              )
            }

            const changed = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent: ReviewSuggestionPublicationContent.make(
                  `Changed after publication.\n\n${footer}`
                ),
                authorityBinding: AUTHORITY_BINDING
              },
              session: HUMAN_SESSION
            }).pipe(Effect.result)
            assert.isTrue(Result.isFailure(changed))
            assert.strictEqual((yield* Ref.get(publicationCommands)).length, 0)
          }),
        registry,
        Option.some(completedReviewWithSuggestion({ state: "published" })),
        () => Effect.succeed(undefined),
        reserve
      )
    }))

  it.effect("releases confirmed no-write failures but retains unknown outcomes", () => {
    const verify = (failureReason: "publication-rejected" | "publication-unavailable") =>
      Effect.gen(function*() {
        const reservedDigest = yield* Ref.make<null | string>(null)
        const reserve: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = (input) =>
          Ref.modify(reservedDigest, (current): [boolean, null | string] =>
            current === null || current === input.contentDigest
              ? [true, String(input.contentDigest)]
              : [false, current]).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.succeed(
                    ReviewSuggestionPublicationReservation.make({ _tag: "acquired" })
                  )
                  : new AgentJobInputError({
                    workspaceId: input.workspaceId,
                    jobId: input.jobId,
                    reason: "invalid-transition"
                  })
              )
            )
        const release: Persistence["Service"]["agentJobs"]["releaseReviewSuggestionPublication"] = (input) =>
          Ref.update(
            reservedDigest,
            (current) =>
              current === input.contentDigest ? null : current
          ).pipe(Effect.as(undefined))

        yield* withService(
          (service, _enqueueInput, publicationCommands, _authority, publicationFailure) =>
            Effect.gen(function*() {
              const preview = yield* service.previewPublication({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                publishingOperator: OPERATOR_ID
              })
              const editedContent = ReviewSuggestionPublicationContent.make(
                `Edited after a confirmed failure.\n\n${preview.publicationFooter}`
              )
              yield* Ref.set(publicationFailure, failureReason)
              const failed = yield* service.publishSuggestion({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                request: {
                  jobId: REVIEW_JOB_ID,
                  suggestionId: SUGGESTION_ID,
                  revisionId: REVIEW_REVISION_ID,
                  finalContent: preview.finalContent,
                  authorityBinding: preview.authorityBinding
                },
                session: HUMAN_SESSION
              }).pipe(Effect.result)
              assert.isTrue(Result.isFailure(failed))
              yield* Ref.set(publicationFailure, null)

              const edited = yield* service.publishSuggestion({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                request: {
                  jobId: REVIEW_JOB_ID,
                  suggestionId: SUGGESTION_ID,
                  revisionId: REVIEW_REVISION_ID,
                  finalContent: editedContent,
                  authorityBinding: preview.authorityBinding
                },
                session: HUMAN_SESSION
              }).pipe(Effect.result)
              if (failureReason === "publication-rejected") {
                assert.isTrue(Result.isSuccess(edited))
                assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
                return
              }
              assert.isTrue(Result.isFailure(edited))
              assert.strictEqual((yield* Ref.get(publicationCommands)).length, 0)

              const replay = yield* service.publishSuggestion({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                request: {
                  jobId: REVIEW_JOB_ID,
                  suggestionId: SUGGESTION_ID,
                  revisionId: REVIEW_REVISION_ID,
                  finalContent: preview.finalContent,
                  authorityBinding: preview.authorityBinding
                },
                session: HUMAN_SESSION
              })
              assert.strictEqual(replay.publicationId, PUBLICATION_ID)
              assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
            }),
          registry,
          Option.some(completedReview),
          () =>
            Effect.succeed(undefined),
          reserve,
          release
        )
      })

    return Effect.all([
      verify("publication-rejected"),
      verify("publication-unavailable")
    ], { concurrency: 1, discard: true })
  })

  it.effect("preserves the provider failure when reservation release also fails", () =>
    withService(
      (service, _enqueueInput, _publicationCommands, _authority, publicationFailure) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })
          yield* Ref.set(publicationFailure, "publication-conflict")
          const result = yield* service.publishSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              finalContent: preview.finalContent,
              authorityBinding: preview.authorityBinding
            },
            session: HUMAN_SESSION
          }).pipe(Effect.result)

          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.instanceOf(result.failure, ApplicationInvalidRequest)
          }
        }),
      registry,
      Option.some(completedReview),
      () => Effect.succeed(undefined),
      () =>
        Effect.succeed(
          ReviewSuggestionPublicationReservation.make({ _tag: "acquired" })
        ),
      () =>
        Effect.fail(
          new RecordNotFoundError({
            workspaceId: WORKSPACE_ID,
            recordKind: "agent-review-publication",
            recordKey: SUGGESTION_ID
          })
        )
    ))

  it.effect("publishes file anchors inline and whole-change anchors without a location", () => {
    const verifyScope = (
      anchor: typeof reviewReport.suggestions[number]["anchor"]
    ) =>
      withService(
        (service, _enqueueInput, publicationCommands) =>
          Effect.gen(function*() {
            const preview = yield* service.previewPublication({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              publishingOperator: OPERATOR_ID
            })
            assert.deepStrictEqual(preview.anchor, anchor)

            yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                revisionId: REVIEW_REVISION_ID,
                finalContent: preview.finalContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            })
            const commands = yield* Ref.get(publicationCommands)
            assert.strictEqual(commands.length, 1)
            assert.deepStrictEqual(commands[0]?.suggestion.anchor, anchor)
          }),
        registry,
        Option.some(completedReviewWithSuggestion({ anchor }))
      )

    return Effect.all([
      verifyScope({
        _tag: "file",
        path: PrReviewPath.make("src/authorization.ts"),
        line: 1,
        relativeFileVersion: "AFTER"
      }),
      verifyScope({ _tag: "changes" })
    ], { concurrency: 1, discard: true })
  })

  it.effect("recovers a provider success after the lifecycle projection initially fails", () =>
    Effect.gen(function*() {
      const reservation = yield* Ref.make<"acquired" | "recoverable" | "published">("acquired")
      const failProjection = yield* Ref.make(true)
      const reserve: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = () =>
        Ref.get(reservation).pipe(
          Effect.map((state) =>
            state === "acquired"
              ? ReviewSuggestionPublicationReservation.make({ _tag: "acquired" })
              : state === "recoverable"
              ? ReviewSuggestionPublicationReservation.make({
                _tag: "recoverable",
                publicationId: PUBLICATION_ID,
                publishedAt: PUBLISHED_TIMESTAMP,
                reservationId: RESERVATION_ID
              })
              : ReviewSuggestionPublicationReservation.make({
                _tag: "published",
                publicationId: PUBLICATION_ID,
                publishedAt: PUBLISHED_TIMESTAMP
              })
          )
        )
      const record: Persistence["Service"]["agentJobs"]["recordReviewSuggestionPublication"] = (input) =>
        (input.finalize === false
          ? Ref.set(reservation, "recoverable")
          : Ref.getAndSet(failProjection, false).pipe(
            Effect.flatMap((mustFail) =>
              mustFail
                ? Effect.fail(
                  new RecordNotFoundError({
                    workspaceId: WORKSPACE_ID,
                    recordKind: "agent-review-result",
                    recordKey: REVIEW_JOB_ID
                  })
                )
                : Ref.set(reservation, "published")
            )
          )).pipe(Effect.as(undefined))
      yield* withService(
        (service, _enqueueInput, publicationCommands) =>
          Effect.gen(function*() {
            const preview = yield* service.previewPublication({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              publishingOperator: OPERATOR_ID
            })
            const publish = () =>
              service.publishSuggestion({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                request: {
                  jobId: REVIEW_JOB_ID,
                  suggestionId: SUGGESTION_ID,
                  revisionId: REVIEW_REVISION_ID,
                  finalContent: preview.finalContent,
                  authorityBinding: preview.authorityBinding
                },
                session: HUMAN_SESSION
              }).pipe(Effect.result)
            const first = yield* publish()
            const recovered = yield* publish()

            assert.isTrue(Result.isFailure(first))
            if (Result.isFailure(first)) {
              assert.strictEqual(first.failure._tag, "ApplicationResourceNotFound")
            }
            assert.isTrue(Result.isSuccess(recovered))
            assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
          }),
        registry,
        Option.some(completedReview),
        record,
        reserve
      )
    }))

  it.effect("retries an expired null-handle reservation through governed idempotency", () =>
    Effect.gen(function*() {
      const reservationIds = yield* Ref.make<ReadonlyArray<string>>([])
      const handleWrites = yield* Ref.make(0)
      const gatewayCalls = yield* Ref.make(0)
      const providerWrites = yield* Ref.make(0)
      const reserve: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = (input) =>
        Ref.update(reservationIds, (current) => [...current, input.reservationId]).pipe(
          Effect.as(ReviewSuggestionPublicationReservation.make({ _tag: "acquired" }))
        )
      const record: Persistence["Service"]["agentJobs"]["recordReviewSuggestionPublication"] = (input) =>
        (input.finalize === false
          ? Ref.getAndUpdate(handleWrites, (current) => current + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 0
                ? Effect.fail(
                  new RecordNotFoundError({
                    workspaceId: WORKSPACE_ID,
                    recordKind: "agent-review-publication",
                    recordKey: REVIEW_JOB_ID
                  })
                )
                : Effect.void
            )
          )
          : Effect.void).pipe(Effect.as(undefined))
      const idempotentPublish: ReviewSuggestionPublicationGateway["Service"]["publish"] = () =>
        Ref.update(gatewayCalls, (current) => current + 1).pipe(
          Effect.andThen(
            Ref.update(providerWrites, (current) => current === 0 ? 1 : current)
          ),
          Effect.as({
            publicationId: PUBLICATION_ID,
            receipt: {
              status: "succeeded",
              providerOperationId: PluginProviderOperationId.make("comment:review-comment-42"),
              safeSummary: "CodeCommit review comment posted",
              observedAt: PUBLISHED_TIMESTAMP
            },
            publishedAt: PUBLISHED_TIMESTAMP,
            connectedIdentity: {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:user/local-operator"
            }
          })
        )

      yield* withService(
        (service) =>
          Effect.gen(function*() {
            const preview = yield* service.previewPublication({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              publishingOperator: OPERATOR_ID
            })
            const publish = () =>
              service.publishSuggestion({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                request: {
                  jobId: REVIEW_JOB_ID,
                  suggestionId: SUGGESTION_ID,
                  revisionId: REVIEW_REVISION_ID,
                  finalContent: preview.finalContent,
                  authorityBinding: preview.authorityBinding
                },
                session: HUMAN_SESSION
              }).pipe(Effect.result)

            assert.isTrue(Result.isFailure(yield* publish()))
            assert.isTrue(Result.isSuccess(yield* publish()))
            const owners = yield* Ref.get(reservationIds)
            assert.strictEqual(owners.length, 2)
            assert.notStrictEqual(owners[0], owners[1])
            assert.strictEqual(yield* Ref.get(gatewayCalls), 2)
            assert.strictEqual(yield* Ref.get(providerWrites), 1)
          }),
        registry,
        Option.some(completedReview),
        record,
        reserve,
        () => Effect.succeed(undefined),
        idempotentPublish
      )
    }))

  it.effect("includes every grouped related location in default publication content", () =>
    withService(
      (service) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })

          assert.include(preview.editableContent, "Related locations:")
          assert.include(preview.editableContent, "src/handler.ts:18-18")
          assert.include(preview.editableContent, "src/policy.ts:30-34")
        }),
      registry,
      Option.some(completedReviewWithSuggestion({
        relatedLocations: [
          {
            path: PrReviewPath.make("src/handler.ts"),
            startLine: 18,
            endLine: 18,
            label: "Same policy branch"
          },
          {
            path: PrReviewPath.make("src/policy.ts"),
            startLine: 30,
            endLine: 34,
            label: "Shared policy implementation"
          }
        ]
      }))
    ))

  it.effect("bounds every generated editable draft before adding the provider footer", () =>
    withService(
      (service) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })

          assert.strictEqual(
            preview.editableContent.length,
            preview.editableContentMaximumLength
          )
          assert.strictEqual(
            preview.finalContent.length,
            MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH
          )
          assert.isTrue(preview.editableContent.endsWith("…"))
        }),
      registry,
      Option.some(completedReviewWithSuggestion({
        problem: "p".repeat(4_000),
        recommendation: "r".repeat(8_000)
      }))
    ))

  it.effect("never truncates through a generated suggestion fence", () =>
    withService(
      (service) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            revisionId: REVIEW_REVISION_ID,
            publishingOperator: OPERATOR_ID
          })

          assert.notInclude(preview.editableContent, "```suggestion")
          assert.notInclude(preview.editableContent, "```")
          assert.include(preview.editableContent, "src/handler.ts:18-18")
          assert.include(preview.replacement ?? "", "x".repeat(15_800))
        }),
      registry,
      Option.some(completedReviewWithSuggestion({
        problem: "Keep the concise explanation.",
        recommendation: "Apply the replacement.",
        relatedLocations: [{
          path: PrReviewPath.make("src/handler.ts"),
          startLine: 18,
          endLine: 18,
          label: "Same policy branch"
        }],
        replacement: {
          reviewedHead: reviewReport.subject.headRevision,
          unifiedDiff: `--- a/src/authorization.ts\n+++ b/src/authorization.ts\n@@ -42,1 +42,1 @@\n-${
            "x".repeat(15_800)
          }\n+y`,
          explanation: "Apply the bounded replacement."
        }
      }))
    ))

  it.effect("rejects agent publication before the authority-bearing gateway", () =>
    withService(
      (service, _enqueueInput, publicationCommands) =>
        Effect.gen(function*() {
          const result = yield* service.publishSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              revisionId: REVIEW_REVISION_ID,
              finalContent: ReviewSuggestionPublicationContent.make("Post this comment."),
              authorityBinding: AUTHORITY_BINDING
            },
            session: {
              sessionId: SESSION_ID,
              workspaceId: WORKSPACE_ID,
              actor: {
                _tag: "agent",
                agentId: AGENT_ID
              },
              permission: "workspace-owner",
              createdAt: STARTED_TIMESTAMP,
              lastSeenAt: STARTED_TIMESTAMP,
              idleExpiresAt: IDLE_EXPIRES_AT,
              absoluteExpiresAt: ABSOLUTE_EXPIRES_AT,
              revokedAt: null
            }
          }).pipe(Effect.result)
          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.isTrue(Schema.is(ApplicationInvalidRequest)(result.failure))
          }
          assert.deepStrictEqual(yield* Ref.get(publicationCommands), [])
        }),
      registry,
      Option.some(completedReview)
    ))

  it.effect("reads and immutably edits the exact current review suggestion", () =>
    withRealService((service, persistence) =>
      Effect.gen(function*() {
        const accepted = yield* service.enqueue({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          request: {
            providerId: PROVIDER_ID,
            model: MODEL,
            profile: "read-only",
            reviewProfileId: REVIEW_PROFILE.profileId
          }
        })
        const claimedAt = yield* DateTime.now
        const claim = yield* persistence.agentJobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: LEASE_TOKEN,
          claimedAt,
          leaseExpiresAt: DateTime.addDuration(claimedAt, Duration.minutes(1))
        })
        assert.isTrue(Option.isSome(claim))
        if (Option.isNone(claim)) return yield* Effect.die("review claim missing")
        yield* persistence.agentJobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: accepted.jobId,
          attemptSequence: claim.value.attemptSequence,
          leaseToken: claim.value.leaseToken,
          report: reviewReport,
          completedAt: yield* DateTime.now
        })

        const originalPage = yield* service.revisions({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        assert.strictEqual(originalPage.current.sequence, 1)
        const originalEdit = Schema.decodeUnknownSync(
          PrReviewSuggestionEdit
        )(reviewReport.suggestions[0])
        const renamed = yield* service.editSuggestion({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          request: {
            expectedRevisionId: originalPage.current.revisionId,
            expectedSequence: originalPage.current.sequence,
            edit: {
              ...originalEdit,
              title: "Authorize before any durable mutation"
            }
          },
          session: HUMAN_SESSION
        })
        assert.strictEqual(renamed.sequence, 2)
        assert.strictEqual(renamed.validation._tag, "validated")

        const stale = yield* service.editSuggestion({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          request: {
            expectedRevisionId: originalPage.current.revisionId,
            expectedSequence: originalPage.current.sequence,
            edit: {
              ...originalEdit,
              title: "Stale edit"
            }
          },
          session: HUMAN_SESSION
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(stale))
        if (Result.isFailure(stale)) {
          assert.instanceOf(stale.failure, ApplicationConflict)
        }

        const technical = yield* service.editSuggestion({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          request: {
            expectedRevisionId: renamed.revisionId,
            expectedSequence: renamed.sequence,
            edit: {
              ...originalEdit,
              title: renamed.suggestion.title,
              problem: "The mutation executes before authority is established."
            }
          },
          session: HUMAN_SESSION
        })
        assert.strictEqual(technical.sequence, 3)
        assert.strictEqual(
          technical.validation._tag,
          "requires-revalidation"
        )

        const denied = yield* service.editSuggestion({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          request: {
            expectedRevisionId: technical.revisionId,
            expectedSequence: technical.sequence,
            edit: {
              ...originalEdit,
              title: "Approver edit"
            }
          },
          session: {
            ...HUMAN_SESSION,
            permission: "workspace-approver"
          }
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(denied))
        if (Result.isFailure(denied)) {
          assert.instanceOf(denied.failure, ApplicationInvalidRequest)
        }

        const history = yield* service.revisions({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          jobId: accepted.jobId,
          suggestionId: SUGGESTION_ID,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        assert.strictEqual(history.current.revisionId, technical.revisionId)
        assert.deepStrictEqual(
          history.revisions.map(({ sequence }) => sequence),
          [2, 1]
        )

        const replay = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: ReleaseAgentThreadCursor.make(0),
          limit: 128
        })
        const revisionEvents = replay.events.filter(
          (
            event
          ): event is Extract<
            (typeof replay.events)[number],
            { readonly _tag: "suggestion-revised" }
          > => event._tag === "suggestion-revised"
        )
        assert.deepStrictEqual(
          revisionEvents.map(({ sequence }) => sequence),
          [
            PrReviewSuggestionRevisionSequence.make(2),
            PrReviewSuggestionRevisionSequence.make(3)
          ]
        )
        assert.deepInclude(revisionEvents[0], {
          suggestionId: SUGGESTION_ID,
          authorKind: "operator",
          validationState: "validated"
        })
        assert.deepInclude(revisionEvents[1], {
          suggestionId: SUGGESTION_ID,
          authorKind: "operator",
          validationState: "requires-revalidation"
        })
      })
    ))

  it.effect("atomically reuses one active exact-head review and permits a retry after terminal failure", () =>
    withRealService((service, persistence) =>
      Effect.gen(function*() {
        const enqueue = (prompt?: string) =>
          service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: PROVIDER_ID,
              model: MODEL,
              profile: "read-only",
              reviewProfileId: REVIEW_PROFILE.profileId,
              ...(prompt === undefined ? {} : { prompt })
            }
          })
        const active = yield* Effect.all([enqueue(), enqueue()], {
          concurrency: "unbounded"
        })
        assert.strictEqual(active[0].jobId, active[1].jobId)

        const page = yield* persistence.agentJobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject: active[0].subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.deepStrictEqual(page.events.map(({ eventKind }) => eventKind), [
          "user-message",
          "job-queued"
        ])
        const firstPresented = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: ReleaseAgentThreadCursor.make(0),
          limit: 1
        })
        assert.strictEqual(
          firstPresented.events[0]?._tag === "operator-message"
            ? firstPresented.events[0].prompt
            : null,
          "Review this pull request."
        )
        const secondPresented = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: firstPresented.nextCursor,
          limit: 1
        })
        assert.deepStrictEqual(
          secondPresented.events.map(({ _tag }) => _tag),
          ["run-queued"]
        )
        const boundedTail = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: null,
          before: null,
          limit: 1
        })
        assert.deepStrictEqual(
          boundedTail.events.map(({ _tag }) => _tag),
          ["run-queued"]
        )
        assert.isTrue(boundedTail.hasEarlier)
        assert.isFalse(boundedTail.hasMore)
        const completeTail = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: null,
          before: null,
          limit: 2
        })
        assert.isFalse(completeTail.hasEarlier)
        assert.isFalse(completeTail.hasMore)
        const earlierPresented = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: null,
          before: secondPresented.nextCursor,
          limit: 1
        })
        assert.deepStrictEqual(
          earlierPresented.events.map(({ _tag }) => _tag),
          ["operator-message"]
        )
        assert.isFalse(earlierPresented.hasMore)
        assert.strictEqual(
          earlierPresented.nextCursor,
          ReleaseAgentThreadCursor.make(1)
        )

        const claimedAt = yield* DateTime.now
        const claim = yield* persistence.agentJobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: LEASE_TOKEN,
          claimedAt,
          leaseExpiresAt: DateTime.addDuration(claimedAt, Duration.minutes(1))
        })
        assert.isTrue(Option.isSome(claim))
        if (Option.isNone(claim)) return yield* Effect.die("review claim missing")
        yield* persistence.agentJobs.appendEvent({
          workspaceId: WORKSPACE_ID,
          jobId: claim.value.jobId,
          attemptSequence: claim.value.attemptSequence,
          leaseToken: claim.value.leaseToken,
          event: {
            _tag: "started",
            providerRunRef: null,
            sessionRef: null,
            runtimeMetadata: {
              _tag: "local-cli",
              implementation: "codex-cli",
              version: "1.2.3"
            }
          },
          occurredAt: claimedAt
        })
        const failedAt = yield* DateTime.now
        yield* persistence.agentJobs.failAttempt({
          workspaceId: WORKSPACE_ID,
          jobId: claim.value.jobId,
          attemptSequence: claim.value.attemptSequence,
          leaseToken: claim.value.leaseToken,
          error: new AgentProviderError({
            providerId: claim.value.providerId,
            phase: "execution",
            message: "Expected review test failure.",
            retryable: true
          }),
          failedAt
        })
        const failedPresented = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: secondPresented.nextCursor,
          limit: 128
        })
        assert.deepStrictEqual(
          failedPresented.events.map(({ _tag }) => _tag),
          ["run-started", "run-failed"]
        )
        assert.deepStrictEqual(failedPresented.events[0], {
          _tag: "run-started",
          eventSequence: ReleaseAgentThreadCursor.make(secondPresented.nextCursor + 1),
          jobId: active[0].jobId,
          occurredAt: claimedAt,
          runtimeMetadata: {
            _tag: "local-cli",
            implementation: "codex-cli",
            version: "1.2.3"
          }
        })

        const retry = yield* enqueue("Re-check the durable transaction boundary.")
        assert.notStrictEqual(retry.jobId, active[0].jobId)
        const retryPresented = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: failedPresented.nextCursor,
          limit: 2
        })
        assert.strictEqual(
          retryPresented.events[0]?._tag === "operator-message"
            ? retryPresented.events[0].prompt
            : null,
          "Re-check the durable transaction boundary."
        )
        assert.strictEqual(retryPresented.events[1]?._tag, "run-queued")
      })
    ))

  it.effect("keeps stable thread history visible while a pull request is temporarily ineligible", () =>
    Effect.gen(function*() {
      const selectedInspection = yield* Ref.make(inspection)
      const changingInspection = DeliveryGraphInspection.of({
        ...graphInspection,
        workspaceEntity: () => Ref.get(selectedInspection)
      })
      yield* withRealService(
        (service) =>
          Effect.gen(function*() {
            yield* service.enqueue({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                providerId: PROVIDER_ID,
                model: MODEL,
                profile: "read-only",
                reviewProfileId: REVIEW_PROFILE.profileId
              }
            })
            const unavailableInspections: ReadonlyArray<{
              readonly reason: PullRequestReviewUnavailable["reason"]
              readonly value: WorkspaceEntityInspection
            }> = [
              {
                reason: "source-stale",
                value: Schema.decodeUnknownSync(WorkspaceEntityInspection)({
                  ...encodedInspection,
                  isSourceCurrent: false
                })
              },
              {
                reason: "release-unavailable",
                value: Schema.decodeSync(WorkspaceEntityInspection)({
                  ...encodedInspection,
                  entity: {
                    ...encodedInspection.entity,
                    canonicalReleaseId: null,
                    releaseIds: []
                  }
                })
              },
              {
                reason: "base-revision-unavailable",
                value: Schema.decodeUnknownSync(WorkspaceEntityInspection)({
                  ...encodedInspection,
                  entity: {
                    ...encodedInspection.entity,
                    projection: {
                      ...encodedInspection.entity.projection,
                      details: {
                        ...encodedInspection.entity.projection.details,
                        baseRevision: null
                      }
                    }
                  }
                })
              }
            ]
            for (const candidate of unavailableInspections) {
              yield* Ref.set(selectedInspection, candidate.value)
              const current = yield* service.current({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID
              })
              assert.deepInclude(current, {
                _tag: "unavailable",
                reason: candidate.reason
              })
              const page = yield* service.thread({
                workspaceId: WORKSPACE_ID,
                entityId: ENTITY_ID,
                after: ReleaseAgentThreadCursor.make(0),
                limit: 128
              })
              assert.deepStrictEqual(
                page.events.map(({ _tag }) => _tag),
                ["operator-message", "run-queued"]
              )
            }

            yield* Ref.set(
              selectedInspection,
              Schema.decodeSync(WorkspaceEntityInspection)({
                ...encodedInspection,
                source: {
                  ...encodedInspection.source,
                  providerId: "jira"
                }
              })
            )
            const unrelated = yield* service.thread({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              after: ReleaseAgentThreadCursor.make(0),
              limit: 128
            })
            assert.deepStrictEqual(unrelated.events, [])
          }),
        changingInspection
      )
    }))

  it.effect("isolates identical pull-request identities across plugin connections", () =>
    withRealService(
      (service, persistence) =>
        Effect.gen(function*() {
          const enqueue = (entityId: EntityId, prompt: string) =>
            service.enqueue({
              workspaceId: WORKSPACE_ID,
              entityId,
              request: {
                providerId: PROVIDER_ID,
                model: MODEL,
                profile: "read-only",
                reviewProfileId: REVIEW_PROFILE.profileId,
                prompt
              }
            })
          const first = yield* enqueue(ENTITY_ID, "Review account one.")
          const second = yield* enqueue(OTHER_ENTITY_ID, "Review account two.")
          assert.notStrictEqual(first.jobId, second.jobId)
          assert.deepStrictEqual(first.subject, second.subject)

          const firstPage = yield* persistence.agentJobs.reviewThreadAfter({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: PLUGIN_CONNECTION_ID,
            subject: first.subject,
            after: AgentEventCursor.make(0),
            limit: AgentThreadEventPageSize.make(128)
          })
          const secondPage = yield* persistence.agentJobs.reviewThreadAfter({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: OTHER_PLUGIN_CONNECTION_ID,
            subject: second.subject,
            after: AgentEventCursor.make(0),
            limit: AgentThreadEventPageSize.make(128)
          })
          assert.deepStrictEqual(
            firstPage.events.map(({ jobId }) => jobId),
            [first.jobId, first.jobId]
          )
          assert.deepStrictEqual(
            secondPage.events.map(({ jobId }) => jobId),
            [second.jobId, second.jobId]
          )
          const firstPresented = yield* service.thread({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            after: ReleaseAgentThreadCursor.make(0),
            limit: 128
          })
          const secondPresented = yield* service.thread({
            workspaceId: WORKSPACE_ID,
            entityId: OTHER_ENTITY_ID,
            after: ReleaseAgentThreadCursor.make(0),
            limit: 128
          })
          assert.strictEqual(
            firstPresented.events[0]?._tag === "operator-message"
              ? firstPresented.events[0].prompt
              : null,
            "Review account one."
          )
          assert.strictEqual(
            secondPresented.events[0]?._tag === "operator-message"
              ? secondPresented.events[0].prompt
              : null,
            "Review account two."
          )
        }),
      multipleConnectionGraphInspection
    ))

  it.effect("replays a queued review whose optional model is null", () =>
    withRealService((service, persistence) =>
      Effect.gen(function*() {
        const jobId = JobId.make("01890f6f-6d6a-7cc0-98d2-00000000040d")
        yield* persistence.agentJobs.enqueue({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          jobId,
          providerId: AgentProviderId.make("openai-compatible"),
          model: null,
          access: "read-only",
          userPrompt: "Review without a selected model.",
          prompt: "Review without a selected model.",
          contextFingerprint: AgentContextFingerprint.make(`sha256:${"d".repeat(64)}`),
          subjectRevision: reviewReport.subject.headRevision,
          task: {
            _tag: "pr-review",
            pluginConnectionId: PLUGIN_CONNECTION_ID,
            subject: reviewReport.subject,
            reviewProfile: REVIEW_PROFILE
          },
          createdAt: STARTED_TIMESTAMP
        })

        const page = yield* service.thread({
          workspaceId: WORKSPACE_ID,
          entityId: ENTITY_ID,
          after: ReleaseAgentThreadCursor.make(0),
          limit: 128
        })
        const queued = page.events.find(({ _tag }) => _tag === "run-queued")
        if (queued?._tag !== "run-queued") {
          return yield* Effect.die("queued review event missing")
        }
        assert.isNull(queued.model)
      })
    ))
})
