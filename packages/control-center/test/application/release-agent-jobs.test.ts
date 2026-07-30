import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentProviderError, AgentProviderId, makeAgentRuntime } from "@knpkv/ai-runtime"
import { DateTime, Effect, Ref, Result, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as TestClock from "effect/testing/TestClock"

import {
  AgentModelId,
  DurableAgentProviderId,
  ReleaseAgentThreadCursor,
  type ReviewAgentProfile,
  ReviewAgentProfileId
} from "../../src/api/agent.js"
import {
  AgentThreadId,
  JobId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { DEFAULT_WORKSPACE_SETTINGS, WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import { makeReleaseAgentJobs } from "../../src/server/application/releaseAgentJobs.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  AgentEventCursor,
  AgentThreadEvent,
  EnqueueAgentJobInput,
  type EnqueueAgentJobTask
} from "../../src/server/persistence/repositories/agentJobModels.js"
import {
  ContentBlobDigest,
  RecordRevision,
  ReleaseSnapshotRecord,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { WorkspaceSettingsRecord } from "../../src/server/persistence/repositories/workspaceSettingsRepository.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000201")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000202")
const MISSING_RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000206")
const OTHER_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000207")
const UNAUTHORIZED_RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000208")
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000203")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000204")
const REVIEW_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000211")
const RELEASE_CHAT_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000212")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000205")
const COLLABORATOR_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000209")
const ROLE_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000210")
const PROVIDER_CREDENTIAL_CANARY = "provider-credential-must-not-enter-prompt"
const STARTED_AT_STRING = "2026-07-19T12:00:00.000Z"
const STARTED_AT = Schema.decodeSync(UtcTimestamp)(STARTED_AT_STRING)

const workspaceSettingsRecord = (
  allowedProviders: ReadonlyArray<typeof WorkspaceSettingsV1.Type["agent"]["allowedProviders"][number]>,
  defaults: {
    readonly defaultModel?: string | null
    readonly defaultProvider?: string | null
    readonly toolPolicy?: "read-only" | "review-sandbox"
  } = {}
) =>
  WorkspaceSettingsRecord.make({
    workspaceId: WORKSPACE_ID,
    revision: RecordRevision.make(1),
    policyRevision: RecordRevision.make(1),
    settings: WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      agent: {
        ...DEFAULT_WORKSPACE_SETTINGS.agent,
        allowedProviders,
        defaultModel: defaults.defaultModel ?? null,
        defaultProvider: defaults.defaultProvider ?? null,
        toolPolicy: defaults.toolPolicy ?? "read-only"
      }
    }),
    settingsDigest: ContentBlobDigest.make("1".repeat(64)),
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    updatedByPersonId: null
  })

const release = Schema.decodeSync(Release)({
  id: RELEASE_ID,
  workspaceId: WORKSPACE_ID,
  serviceName: "payments-api",
  version: "2.18.0",
  lifecycle: "candidate",
  relay: deriveReleaseRelay(RELEASE_ID),
  targetEnvironmentIds: [],
  roleAssignments: [],
  sourceRevisions: [],
  freshness: {
    _tag: "unavailable",
    pluginHealth: { _tag: "disabled", checkedAt: STARTED_AT_STRING },
    provenance: { _tag: "none", pluginConnectionId: PLUGIN_CONNECTION_ID },
    sourceObservedAt: null,
    staleAfterSeconds: 300,
    synchronizedAt: null
  },
  createdAt: STARTED_AT_STRING,
  updatedAt: STARTED_AT_STRING
})

const releaseWithCollaborator = Schema.decodeSync(Schema.toType(Release))({
  ...release,
  roleAssignments: [{
    actor: { _tag: "human", personId: COLLABORATOR_ID },
    assignmentId: ROLE_ASSIGNMENT_ID,
    lifecycle: { _tag: "active", assignedAt: STARTED_AT },
    role: "release-owner",
    scope: { _tag: "release", releaseId: RELEASE_ID, workspaceId: WORKSPACE_ID }
  }]
})

const releaseSnapshot = ReleaseSnapshotRecord.make({
  release: releaseWithCollaborator,
  revision: RecordRevision.make(7)
})

const unauthorizedRelease = Schema.decodeSync(Schema.toType(Release))({
  ...release,
  id: UNAUTHORIZED_RELEASE_ID,
  workspaceId: OTHER_WORKSPACE_ID,
  relay: deriveReleaseRelay(UNAUTHORIZED_RELEASE_ID),
  roleAssignments: []
})

const reviewTask = {
  _tag: "pr-review",
  pluginConnectionId: PLUGIN_CONNECTION_ID,
  reviewProfile: {
    profileId: ReviewAgentProfileId.make("openai-compatible:review-model:sbx"),
    label: "Full-project review",
    budgetMillis: 1_200_000,
    networkAccess: "blocked",
    sandbox: "sbx"
  },
  subject: {
    providerId: "codecommit",
    repository: "control-center",
    pullRequestId: "267",
    baseRevision: "1".repeat(40),
    headRevision: "2".repeat(40)
  }
} satisfies EnqueueAgentJobTask

const releaseChatTask = { _tag: "release-chat" } satisfies EnqueueAgentJobTask

const threadEvent = (
  eventSequence: number,
  eventKind: AgentThreadEvent["eventKind"],
  payload: unknown,
  options: {
    readonly jobId?: typeof JobId.Type
    readonly task?: EnqueueAgentJobTask
  } = {}
): AgentThreadEvent =>
  AgentThreadEvent.make({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    eventSequence: AgentEventCursor.make(eventSequence),
    jobId: options.jobId ?? JOB_ID,
    attemptSequence: null,
    ...(options.task === undefined ? {} : { task: options.task }),
    eventKind,
    payload,
    occurredAt: STARTED_AT
  })

const replayEvents: Array<AgentThreadEvent> = [
  threadEvent(1, "user-message", { prompt: "Explain the release." }),
  threadEvent(2, "job-queued", {
    providerId: AgentProviderId.make("codex")
  }),
  threadEvent(3, "job-started", {
    _tag: "started",
    providerRunRef: "provider-native-run-secret",
    sessionRef: "provider-native-session-secret",
    runtimeMetadata: {
      _tag: "local-cli",
      implementation: "codex-cli",
      version: "1.2.3"
    }
  }),
  threadEvent(4, "assistant-output", {
    _tag: "output",
    channel: "assistant",
    text: "The release is waiting for approval."
  }),
  threadEvent(5, "review-report", {
    privateReviewResult: "RAW_REVIEW_RESULT_MUST_NOT_REACH_RELEASE_CHAT"
  }),
  threadEvent(6, "job-failed", {
    error: new AgentProviderError({
      providerId: AgentProviderId.make("codex"),
      phase: "execution",
      message: "provider credential secret must stay server-side",
      retryable: true
    })
  })
]

const configuredRuntime = makeAgentRuntime({ run: () => Stream.empty })
const configuredRegistry = AgentRuntimeRegistry.of({
  catalog: () => Effect.succeed({ providers: [] }),
  select: ({ access, model, providerId }) =>
    providerId === "codex" && model === "review-model" && access === "read-only"
      ? Effect.succeed({ model: AgentModelId.make("review-model"), runtime: configuredRuntime })
      : Effect.fail(
        new AgentProviderError({
          providerId,
          phase: "configuration",
          message: "Selection unavailable.",
          retryable: false
        })
      )
})

const withPersistence = <Success, Failure>(
  use: Effect.Effect<Success, Failure, AgentRuntimeRegistry | Crypto.Crypto | Persistence>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-release-agent-jobs-")
    return yield* use.pipe(
      Effect.provideService(AgentRuntimeRegistry, configuredRegistry),
      Effect.provide(persistenceLayer(config))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("release agent jobs", () => {
  it.effect("filters the runtime catalog through durable workspace policy", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const catalogRegistry = AgentRuntimeRegistry.of({
        ...configuredRegistry,
        catalog: () =>
          Effect.succeed({
            providers: [
              {
                providerId: DurableAgentProviderId.make("codex"),
                displayName: "Codex",
                models: [AgentModelId.make("review-model")],
                capabilities: ["release-chat"],
                health: "available"
              },
              {
                providerId: DurableAgentProviderId.make("claude"),
                displayName: "Claude",
                models: [AgentModelId.make("review-model")],
                capabilities: ["release-chat"],
                health: "available"
              }
            ]
          })
      })
      const fakePersistence = Persistence.of({
        ...persistence,
        workspaceSettings: {
          ...persistence.workspaceSettings,
          get: () => Effect.succeed(workspaceSettingsRecord(["codex"]))
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(
        Effect.provideService(Persistence, fakePersistence),
        Effect.provideService(AgentRuntimeRegistry, catalogRegistry)
      )

      assert.deepStrictEqual(
        (yield* service.providers(WORKSPACE_ID)).providers.map(({ providerId }) => providerId),
        ["codex"]
      )
    })))

  it.effect("hides review capabilities unless the durable tool policy enables the review sandbox", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const reviewProfile = {
        profileId: ReviewAgentProfileId.make("codex:review-model:sbx"),
        label: "Full-project review",
        budgetMillis: 1_200_000,
        networkAccess: "blocked",
        sandbox: "sbx"
      } satisfies ReviewAgentProfile
      const catalogRegistry = AgentRuntimeRegistry.of({
        ...configuredRegistry,
        catalog: () =>
          Effect.succeed({
            providers: [{
              providerId: DurableAgentProviderId.make("codex"),
              displayName: "Codex",
              models: [AgentModelId.make("review-model")],
              capabilities: ["release-chat", "pr-review"],
              health: "available",
              reviewProfile
            }]
          })
      })
      const serviceFor = (toolPolicy: "read-only" | "review-sandbox") =>
        makeReleaseAgentJobs.pipe(
          Effect.provideService(
            Persistence,
            Persistence.of({
              ...persistence,
              workspaceSettings: {
                ...persistence.workspaceSettings,
                get: () => Effect.succeed(workspaceSettingsRecord(["codex"], { toolPolicy }))
              }
            })
          ),
          Effect.provideService(AgentRuntimeRegistry, catalogRegistry)
        )

      const readOnly = yield* serviceFor("read-only")
      assert.deepStrictEqual((yield* readOnly.providers(WORKSPACE_ID)).providers, [{
        providerId: DurableAgentProviderId.make("codex"),
        displayName: "Codex",
        models: [AgentModelId.make("review-model")],
        capabilities: ["release-chat"],
        health: "available"
      }])

      const reviewSandbox = yield* serviceFor("review-sandbox")
      assert.deepStrictEqual((yield* reviewSandbox.providers(WORKSPACE_ID)).providers, [{
        providerId: DurableAgentProviderId.make("codex"),
        displayName: "Codex",
        models: [AgentModelId.make("review-model")],
        capabilities: ["release-chat", "pr-review"],
        health: "available",
        reviewProfile
      }])
    })))

  it.effect("orders the configured default provider and model first in the filtered catalog", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const catalogRegistry = AgentRuntimeRegistry.of({
        ...configuredRegistry,
        catalog: () =>
          Effect.succeed({
            providers: [
              {
                providerId: DurableAgentProviderId.make("claude"),
                displayName: "Claude",
                models: [AgentModelId.make("claude-model")],
                capabilities: ["release-chat"],
                health: "available"
              },
              {
                providerId: DurableAgentProviderId.make("codex"),
                displayName: "Codex",
                models: [AgentModelId.make("fallback"), AgentModelId.make("preferred")],
                capabilities: ["release-chat"],
                health: "available"
              }
            ]
          })
      })
      const fakePersistence = Persistence.of({
        ...persistence,
        workspaceSettings: {
          ...persistence.workspaceSettings,
          get: () =>
            Effect.succeed(workspaceSettingsRecord(["claude", "codex"], {
              defaultProvider: "codex",
              defaultModel: "preferred"
            }))
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(
        Effect.provideService(Persistence, fakePersistence),
        Effect.provideService(AgentRuntimeRegistry, catalogRegistry)
      )

      const catalog = yield* service.providers(WORKSPACE_ID)
      assert.deepStrictEqual(
        catalog.providers.map(({ providerId }) => providerId),
        ["codex", "claude"]
      )
      assert.deepStrictEqual(
        catalog.providers[0]?.models,
        [AgentModelId.make("preferred"), AgentModelId.make("fallback")]
      )

      const nullDefaults = yield* makeReleaseAgentJobs.pipe(
        Effect.provideService(
          Persistence,
          Persistence.of({
            ...persistence,
            workspaceSettings: {
              ...persistence.workspaceSettings,
              get: () => Effect.succeed(workspaceSettingsRecord(["claude", "codex"]))
            }
          })
        ),
        Effect.provideService(AgentRuntimeRegistry, catalogRegistry)
      )
      const unchanged = yield* nullDefaults.providers(WORKSPACE_ID)
      assert.deepStrictEqual(
        unchanged.providers.map(({ providerId }) => providerId),
        ["claude", "codex"]
      )
      assert.deepStrictEqual(
        unchanged.providers[1]?.models,
        [AgentModelId.make("fallback"), AgentModelId.make("preferred")]
      )
    })))

  it.effect("returns an empty cursor-preserving replay only for an existing release", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* persistence.workspaces.create(WORKSPACE_ID, {
        displayName: WorkspaceName.make("Release agent jobs"),
        createdAt: STARTED_AT
      })
      yield* persistence.workspaces.create(OTHER_WORKSPACE_ID, {
        displayName: WorkspaceName.make("Other release agent jobs"),
        createdAt: STARTED_AT
      })
      yield* persistence.releases.create(WORKSPACE_ID, release)
      yield* persistence.releases.create(OTHER_WORKSPACE_ID, unauthorizedRelease)
      const service = yield* makeReleaseAgentJobs
      const after = ReleaseAgentThreadCursor.make(17)

      const page = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after,
        limit: 5
      })
      const missing = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: MISSING_RELEASE_ID,
        after,
        limit: 5
      }).pipe(Effect.result)
      const unauthorized = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: UNAUTHORIZED_RELEASE_ID,
        after,
        limit: 5
      }).pipe(Effect.result)

      assert.deepStrictEqual(page, { releaseId: RELEASE_ID, events: [], nextCursor: after })
      assert.isTrue(Result.isFailure(missing))
      if (Result.isFailure(missing)) {
        assert.strictEqual(missing.failure._tag, "ApplicationResourceNotFound")
      }
      assert.isTrue(Result.isFailure(unauthorized))
      if (Result.isFailure(unauthorized)) {
        assert.strictEqual(unauthorized.failure._tag, "ApplicationResourceNotFound")
      }
    })))

  it.effect("derives immutable job context and returns a redacted ordered replay", () =>
    withPersistence(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
      const persistence = yield* Persistence
      const enqueuedInput = yield* Ref.make<unknown>(null)
      const replayInput = yield* Ref.make<unknown>(null)
      const transactionActive = yield* Ref.make(false)
      const settingsAdmissionReads = yield* Ref.make<Array<boolean>>([])
      const allowedProviders = yield* Ref.make<
        ReadonlyArray<typeof WorkspaceSettingsV1.Type["agent"]["allowedProviders"][number]>
      >(["codex"])
      const fakePersistence = Persistence.of({
        ...persistence,
        transact: <Success, Failure, Requirements>(
          effect: Effect.Effect<Success, Failure, Requirements>
        ) =>
          Ref.set(transactionActive, true).pipe(
            Effect.andThen(persistence.transact(effect)),
            Effect.ensuring(Ref.set(transactionActive, false))
          ),
        agentJobs: {
          ...persistence.agentJobs,
          enqueue: (input) => Ref.set(enqueuedInput, input).pipe(Effect.as(THREAD_ID)),
          threadAfter: (input) =>
            Ref.set(replayInput, input).pipe(
              Effect.as({ events: replayEvents, nextCursor: AgentEventCursor.make(6) })
            )
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        },
        workspaceSettings: {
          ...persistence.workspaceSettings,
          get: () =>
            Ref.get(transactionActive).pipe(
              Effect.tap((isActive) => Ref.update(settingsAdmissionReads, (reads) => [...reads, isActive])),
              Effect.andThen(Ref.get(allowedProviders)),
              Effect.map(workspaceSettingsRecord)
            )
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      yield* Ref.set(allowedProviders, ["anthropic"])
      const disallowed = yield* service.enqueue({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        request: {
          providerId: DurableAgentProviderId.make("codex"),
          model: AgentModelId.make("review-model"),
          profile: "read-only",
          prompt: "Explain the release."
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(disallowed))
      if (Result.isFailure(disallowed)) {
        assert.strictEqual(disallowed.failure._tag, "ApplicationInvalidRequest")
      }
      assert.isNull(yield* Ref.get(enqueuedInput))

      yield* Ref.set(allowedProviders, ["codex"])
      const rejected = yield* service.enqueue({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        request: {
          providerId: DurableAgentProviderId.make("codex"),
          model: AgentModelId.make("unregistered-model"),
          profile: "read-only",
          prompt: "Explain the release."
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      assert.isNull(yield* Ref.get(enqueuedInput))

      const enqueued = yield* service.enqueue({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        request: {
          providerId: DurableAgentProviderId.make("codex"),
          model: AgentModelId.make("review-model"),
          profile: "read-only",
          prompt: "Explain the release."
        }
      })
      const capturedEnqueue = Schema.decodeUnknownSync(Schema.toType(EnqueueAgentJobInput))(
        yield* Ref.get(enqueuedInput)
      )
      assert.isTrue(Schema.is(JobId)(enqueued.jobId))
      assert.strictEqual(enqueued.releaseId, RELEASE_ID)
      assert.strictEqual(enqueued.state, "queued")
      assert.strictEqual(capturedEnqueue.workspaceId, WORKSPACE_ID)
      assert.strictEqual(capturedEnqueue.releaseId, RELEASE_ID)
      assert.strictEqual(capturedEnqueue.subjectRevision, "release-revision:7")
      assert.strictEqual(capturedEnqueue.access, "read-only")
      assert.strictEqual(capturedEnqueue.model, "review-model")
      assert.strictEqual(capturedEnqueue.providerId, "codex")
      assert.deepStrictEqual(yield* Ref.get(settingsAdmissionReads), [true, true])
      assert.deepStrictEqual(capturedEnqueue.task, { _tag: "release-chat" })
      assert.strictEqual(capturedEnqueue.userPrompt, "Explain the release.")
      assert.include(capturedEnqueue.prompt, `"releaseId":"${RELEASE_ID}"`)
      assert.include(capturedEnqueue.prompt, "\"service\":\"payments-api\"")
      assert.include(capturedEnqueue.prompt, "\"version\":\"2.18.0\"")
      assert.include(capturedEnqueue.prompt, "\"status\":\"candidate\"")
      assert.include(capturedEnqueue.prompt, "\"freshness\":\"unavailable\"")
      assert.include(capturedEnqueue.prompt, `"actorId":"${COLLABORATOR_ID}"`)
      assert.include(capturedEnqueue.prompt, "<current-question>\nExplain the release.")
      assert.notInclude(capturedEnqueue.prompt, PROVIDER_CREDENTIAL_CANARY)
      assert.isTrue(DateTime.Equivalence(capturedEnqueue.createdAt, STARTED_AT))
      assert.strictEqual(
        capturedEnqueue.contextFingerprint,
        "sha256:36fefa9c60d7ab107e717e70e590dd84027bb44679f526beb0edf60e39b639b0"
      )

      const page = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: ReleaseAgentThreadCursor.make(0),
        limit: 5
      })
      assert.deepStrictEqual(
        page.events.map(({ _tag, eventSequence }) => ({ _tag, eventSequence })),
        [
          { _tag: "user-message", eventSequence: 1 },
          { _tag: "job-queued", eventSequence: 2 },
          { _tag: "job-started", eventSequence: 3 },
          { _tag: "assistant-output", eventSequence: 4 },
          { _tag: "job-failed", eventSequence: 6 }
        ]
      )
      assert.deepStrictEqual(page.events[2], {
        _tag: "job-started",
        eventSequence: ReleaseAgentThreadCursor.make(3),
        jobId: JOB_ID,
        occurredAt: STARTED_AT,
        runtimeMetadata: {
          _tag: "local-cli",
          implementation: "codex-cli",
          version: "1.2.3"
        }
      })
      assert.deepStrictEqual(yield* Ref.get(replayInput), {
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: AgentEventCursor.make(0),
        limit: 5
      })
      const browserJson = JSON.stringify(page)
      assert.notInclude(browserJson, "provider-native-run-secret")
      assert.notInclude(browserJson, "provider-native-session-secret")
      assert.notInclude(browserJson, "provider credential secret")
      assert.notInclude(browserJson, "RAW_REVIEW_RESULT_MUST_NOT_REACH_RELEASE_CHAT")
      assert.include(browserJson, "\"retryable\":true")
    })))

  it.effect("pages past a hidden review report to fill the visible replay limit", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const replayInputs = yield* Ref.make<Array<unknown>>([])
      const hiddenThenCompleted = [
        threadEvent(5, "review-report", {
          privateReviewResult: "RAW_REVIEW_RESULT_MUST_NOT_REACH_RELEASE_CHAT"
        }),
        threadEvent(6, "job-completed", {
          _tag: "completed",
          outcome: "success",
          sessionRef: null
        })
      ]
      const fakePersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          threadAfter: (input) => {
            const pageEvents = hiddenThenCompleted
              .filter(({ eventSequence }) => eventSequence > input.after)
              .slice(0, input.limit)
            return Ref.update(replayInputs, (inputs) => [...inputs, input]).pipe(
              Effect.as({
                events: pageEvents,
                nextCursor: pageEvents.at(-1)?.eventSequence ?? input.after
              })
            )
          }
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      const page = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: ReleaseAgentThreadCursor.make(4),
        limit: 1
      })

      assert.deepStrictEqual(
        page.events.map(({ _tag, eventSequence }) => ({ _tag, eventSequence })),
        [{ _tag: "job-completed", eventSequence: 6 }]
      )
      assert.strictEqual(page.nextCursor, 6)
      assert.deepStrictEqual(yield* Ref.get(replayInputs), [
        {
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          after: AgentEventCursor.make(4),
          limit: 1
        },
        {
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          after: AgentEventCursor.make(5),
          limit: 1
        }
      ])
    })))

  it.effect("hides classified review jobs while replaying release-chat and historical events", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const durableEvents = [
        threadEvent(
          1,
          "user-message",
          { prompt: "Review-only prompt must remain private." },
          { jobId: REVIEW_JOB_ID, task: reviewTask }
        ),
        threadEvent(
          2,
          "job-queued",
          { providerId: AgentProviderId.make("codex") },
          { jobId: REVIEW_JOB_ID, task: reviewTask }
        ),
        threadEvent(
          3,
          "review-report",
          { privateReviewResult: "review-only report" },
          { jobId: REVIEW_JOB_ID, task: reviewTask }
        ),
        threadEvent(
          4,
          "job-completed",
          { _tag: "completed", outcome: "success", sessionRef: null },
          { jobId: REVIEW_JOB_ID, task: reviewTask }
        ),
        threadEvent(5, "job-queued", { providerId: AgentProviderId.make("historical") }),
        threadEvent(
          6,
          "user-message",
          { prompt: "Visible release question." },
          { jobId: RELEASE_CHAT_JOB_ID, task: releaseChatTask }
        ),
        threadEvent(
          7,
          "job-queued",
          { providerId: AgentProviderId.make("codex") },
          { jobId: RELEASE_CHAT_JOB_ID, task: releaseChatTask }
        )
      ]
      const fakePersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          threadAfter: (input) => {
            const pageEvents = durableEvents
              .filter(({ eventSequence }) => eventSequence > input.after)
              .slice(0, input.limit)
            return Effect.succeed({
              events: pageEvents,
              nextCursor: pageEvents.at(-1)?.eventSequence ?? input.after
            })
          }
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      const page = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: ReleaseAgentThreadCursor.make(0),
        limit: 3
      })

      assert.deepStrictEqual(
        page.events.map(({ _tag, eventSequence }) => ({ _tag, eventSequence })),
        [
          { _tag: "job-queued", eventSequence: 5 },
          { _tag: "user-message", eventSequence: 6 },
          { _tag: "job-queued", eventSequence: 7 }
        ]
      )
      assert.strictEqual(page.nextCursor, 7)
      const browserJson = JSON.stringify(page)
      assert.notInclude(browserJson, "Review-only prompt")
      assert.notInclude(browserJson, "review-only report")
      assert.include(browserJson, "historical")
      assert.include(browserJson, "Visible release question")
    })))

  it.effect("rejects a historical queued event without its provider identity", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const fakePersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          threadAfter: () =>
            Effect.succeed({
              events: [threadEvent(1, "job-queued", {})],
              nextCursor: AgentEventCursor.make(1)
            })
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      const replay = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: ReleaseAgentThreadCursor.make(0),
        limit: 1
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(replay))
      if (Result.isFailure(replay)) {
        assert.strictEqual(replay.failure._tag, "ApplicationServiceUnavailable")
      }
    })))

  it.effect("fails a replay page whose durable cursor does not advance", () =>
    withPersistence(Effect.gen(function*() {
      const persistence = yield* Persistence
      const fakePersistence = Persistence.of({
        ...persistence,
        agentJobs: {
          ...persistence.agentJobs,
          threadAfter: (input) =>
            Effect.succeed({
              events: [threadEvent(5, "review-report", {})],
              nextCursor: input.after
            })
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      const replay = yield* service.replay({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: ReleaseAgentThreadCursor.make(4),
        limit: 1
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(replay))
      if (Result.isFailure(replay)) {
        assert.strictEqual(replay.failure._tag, "ApplicationServiceUnavailable")
      }
    })))
})
