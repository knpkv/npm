import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentProviderError, makeAgentRuntime, makeDeterministicLanguageModel } from "@knpkv/ai-runtime"
import { DateTime, Deferred, Duration, Effect, Fiber, Option, Ref, Result, Schema, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"

import {
  AgentModelId,
  DurableAgentProviderId,
  MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH,
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
  ReleaseId,
  SessionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import {
  PluginProviderOperationId,
  type PluginProviderReceiptV1,
  ProposePluginActionRequestV1
} from "../../src/domain/plugins/actions.js"
import { PrReviewPath, PrReviewReport, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import {
  ApplicationInvalidRequest,
  DeliveryGraphInspection,
  PullRequestReviews
} from "../../src/server/api/ApplicationServices.js"
import {
  reviewPublicationActionCanAdvance,
  reviewPublicationProposalRequestMatches,
  reviewPublicationSessionIsAuthorized
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
  LatestAgentReviewRecord
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000401")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000402")
const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000403")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000404")
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000405")
const REVIEW_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000406")
const OPERATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000407")
const PUBLICATION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000408")
const SUGGESTION_ID = PrReviewSuggestionId.make(`sha256:${"3".repeat(64)}`)
const MODEL = AgentModelId.make("review-model")
const PROVIDER_ID = DurableAgentProviderId.make("openai-compatible")
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
  label: "Full-project review · openai-compatible · review-model",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
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
      line: 42
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
  publish: () => Effect.die("review publication is not used")
})

const withService = <Success, Failure>(
  use: (
    service: PullRequestReviews["Service"],
    enqueueInput: Ref.Ref<unknown>,
    publicationCommands: Ref.Ref<ReadonlyArray<PublishReviewSuggestionCommand>>,
    publicationAuthority: Ref.Ref<ReviewSuggestionPublicationAuthorityBinding>
  ) => Effect.Effect<Success, Failure>,
  selectedRegistry = registry,
  latestReview: Option.Option<LatestAgentReviewRecord> = Option.none(),
  recordPublication: Persistence["Service"]["agentJobs"]["recordReviewSuggestionPublication"] = () =>
    Effect.succeed(undefined),
  reservePublication: Persistence["Service"]["agentJobs"]["reserveReviewSuggestionPublication"] = () =>
    Effect.succeed(undefined)
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-pull-request-reviews-")
    return yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      const enqueueInput = yield* Ref.make<unknown>(null)
      const publicationCommands = yield* Ref.make<ReadonlyArray<PublishReviewSuggestionCommand>>([])
      const publicationAuthority = yield* Ref.make(AUTHORITY_BINDING)
      const testPersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          enqueue: (input) => Ref.set(enqueueInput, input).pipe(Effect.as(THREAD_ID)),
          latestReview: () => Effect.succeed(latestReview),
          recordReviewSuggestionPublication: recordPublication,
          reserveReviewSuggestionPublication: reservePublication
        }
      })
      const publicationGateway = ReviewSuggestionPublicationGateway.of({
        identity: () =>
          Ref.get(publicationAuthority).pipe(Effect.map((authorityBinding) => ({
            connectedIdentity: {
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:user/local-operator"
            },
            authorityBinding
          }))),
        publish: (command) =>
          Ref.get(publicationAuthority).pipe(
            Effect.filterOrFail(
              (authorityBinding) => authorityBinding === command.authorityBinding,
              () =>
                new ReviewSuggestionPublicationGatewayError({
                  reason: "publication-conflict"
                })
            ),
            Effect.andThen(
              Ref.update(publicationCommands, (commands) => [...commands, command])
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
        publicationAuthority
      )
    }).pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const withRealService = <Success, Failure>(
  use: (
    service: PullRequestReviews["Service"],
    persistence: Persistence["Service"]
  ) => Effect.Effect<Success, Failure>
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
        Effect.provideService(DeliveryGraphInspection, graphInspection),
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
      evidenceIds: [`pr-review:${REVIEW_JOB_ID}:${SUGGESTION_ID}`]
    })
    const differentReview = Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
      ...request,
      evidenceIds: [
        `pr-review:01890f6f-6d6a-7cc0-98d2-000000000099:${SUGGESTION_ID}`
      ]
    })
    const exactReplay = Schema.decodeUnknownSync(ProposePluginActionRequestV1)(
      Schema.encodeSync(ProposePluginActionRequestV1)(request)
    )

    assert.isTrue(reviewPublicationProposalRequestMatches(request, exactReplay))
    assert.isFalse(reviewPublicationProposalRequestMatches(request, differentReview))
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
            publishingOperator: OPERATOR_ID
          })

          assert.deepStrictEqual(preview.connectedIdentity, {
            accountId: "123456789012",
            arn: "arn:aws:iam::123456789012:user/local-operator"
          })
          assert.deepStrictEqual(preview.anchor, {
            _tag: "line",
            path: PrReviewPath.make("src/authorization.ts"),
            line: 42
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
            ),
            Effect.as(undefined)
          )

      yield* withService(
        (service, _enqueueInput, publicationCommands) =>
          Effect.gen(function*() {
            const preview = yield* service.previewPublication({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
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
                finalContent: preview.finalContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(firstReservationEntered)
            const second = yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
                finalContent: differentContent,
                authorityBinding: preview.authorityBinding
              },
              session: HUMAN_SESSION
            }).pipe(Effect.result)
            yield* Deferred.succeed(releaseFirstReservation, undefined)
            yield* Fiber.join(first)

            assert.isTrue(Result.isFailure(second))
            if (Result.isFailure(second)) {
              assert.instanceOf(second.failure, ApplicationInvalidRequest)
            }
            assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
          }),
        registry,
        Option.some(completedReview),
        () => Effect.succeed(undefined),
        reserve
      )
    }))

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
              publishingOperator: OPERATOR_ID
            })
            assert.deepStrictEqual(preview.anchor, anchor)

            yield* service.publishSuggestion({
              workspaceId: WORKSPACE_ID,
              entityId: ENTITY_ID,
              request: {
                jobId: REVIEW_JOB_ID,
                suggestionId: SUGGESTION_ID,
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
        line: 1
      }),
      verifyScope({ _tag: "changes" })
    ], { concurrency: 1, discard: true })
  })

  it.effect("preserves a deterministic lifecycle-write failure after provider publication", () =>
    withService(
      (service, _enqueueInput, publicationCommands) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
            publishingOperator: OPERATOR_ID
          })
          const result = yield* service.publishSuggestion({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              jobId: REVIEW_JOB_ID,
              suggestionId: SUGGESTION_ID,
              finalContent: preview.finalContent,
              authorityBinding: preview.authorityBinding
            },
            session: HUMAN_SESSION
          }).pipe(Effect.result)

          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "ApplicationResourceNotFound")
          }
          assert.strictEqual((yield* Ref.get(publicationCommands)).length, 1)
        }),
      registry,
      Option.some(completedReview),
      () =>
        Effect.fail(
          new RecordNotFoundError({
            workspaceId: WORKSPACE_ID,
            recordKind: "agent-review-result",
            recordKey: REVIEW_JOB_ID
          })
        )
    ))

  it.effect("includes every grouped related location in default publication content", () =>
    withService(
      (service) =>
        Effect.gen(function*() {
          const preview = yield* service.previewPublication({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            jobId: REVIEW_JOB_ID,
            suggestionId: SUGGESTION_ID,
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

  it.effect("atomically reuses one active exact-head review and permits a retry after terminal failure", () =>
    withRealService((service, persistence) =>
      Effect.gen(function*() {
        const enqueue = () =>
          service.enqueue({
            workspaceId: WORKSPACE_ID,
            entityId: ENTITY_ID,
            request: {
              providerId: PROVIDER_ID,
              model: MODEL,
              profile: "read-only",
              reviewProfileId: REVIEW_PROFILE.profileId
            }
          })
        const active = yield* Effect.all([enqueue(), enqueue()], {
          concurrency: "unbounded"
        })
        assert.strictEqual(active[0].jobId, active[1].jobId)

        const page = yield* persistence.agentJobs.threadAfter({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.deepStrictEqual(page.events.map(({ eventKind }) => eventKind), [
          "user-message",
          "job-queued"
        ])

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

        const retry = yield* enqueue()
        assert.notStrictEqual(retry.jobId, active[0].jobId)
      })
    ))
})
