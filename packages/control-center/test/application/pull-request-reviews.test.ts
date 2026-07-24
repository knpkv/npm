import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentProviderError, makeAgentRuntime } from "@knpkv/ai-runtime"
import { DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"

import { AgentModelId, DurableAgentProviderId } from "../../src/api/agent.js"
import { WorkspaceEntityInspection } from "../../src/api/deliveryGraph.js"
import { AgentThreadId, EntityId, PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import { DeliveryGraphInspection, PullRequestReviews } from "../../src/server/api/ApplicationServices.js"
import { pullRequestReviewsLayer } from "../../src/server/application/pullRequestReviews.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  AgentEventCursor,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000401")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000402")
const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000403")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000404")
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000405")
const MODEL = AgentModelId.make("review-model")
const PROVIDER_ID = DurableAgentProviderId.make("openai-compatible")
const LEASE_OWNER = AgentLeaseOwner.make("review-test-worker")
const LEASE_TOKEN = AgentLeaseToken.make("1".repeat(64))
const STARTED_AT = "2026-07-24T15:00:00.000Z"

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
        health: "available"
      }]
    }),
  select: ({ access, model, providerId }) =>
    access === "read-only" && model === MODEL && providerId === "openai-compatible"
      ? Effect.succeed({ model: MODEL, runtime, filesystemAccess: "none" })
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

const withService = <Success, Failure>(
  use: (
    service: PullRequestReviews["Service"],
    enqueueInput: Ref.Ref<unknown>
  ) => Effect.Effect<Success, Failure>,
  selectedRegistry = registry
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-pull-request-reviews-")
    return yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      const enqueueInput = yield* Ref.make<unknown>(null)
      const testPersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          enqueue: (input) => Ref.set(enqueueInput, input).pipe(Effect.as(THREAD_ID)),
          latestReview: () => Effect.succeed(Option.none())
        }
      })
      const service = yield* PullRequestReviews.pipe(
        Effect.provide(pullRequestReviewsLayer),
        Effect.provideService(Persistence, testPersistence),
        Effect.provideService(DeliveryGraphInspection, graphInspection),
        Effect.provideService(AgentRuntimeRegistry, selectedRegistry)
      )
      return yield* use(service, enqueueInput)
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
        Effect.provideService(AgentRuntimeRegistry, registry)
      )
      return yield* use(service, persistence)
    }).pipe(Effect.provide(persistenceLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("pull request reviews", () => {
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
            profile: "read-only"
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
              profile: "read-only"
            }
          }).pipe(Effect.result)
          assert.isTrue(result._tag === "Failure")
          assert.isNull(yield* Ref.get(enqueueInput))
        }),
      localRegistry
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
              profile: "read-only"
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
