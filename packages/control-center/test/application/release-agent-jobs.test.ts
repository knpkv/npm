import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentProviderError, AgentProviderId, makeAgentRuntime } from "@knpkv/ai-runtime"
import { DateTime, Effect, Ref, Result, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as TestClock from "effect/testing/TestClock"

import { AgentModelId, DurableAgentProviderId, ReleaseAgentThreadCursor } from "../../src/api/agent.js"
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
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import { makeReleaseAgentJobs } from "../../src/server/application/releaseAgentJobs.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  AgentEventCursor,
  type AgentJobTask,
  AgentThreadEvent,
  EnqueueAgentJobInput
} from "../../src/server/persistence/repositories/agentJobModels.js"
import {
  RecordRevision,
  ReleaseSnapshotRecord,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
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
  subject: {
    providerId: "codecommit",
    repository: "control-center",
    pullRequestId: "267",
    baseRevision: "1".repeat(40),
    headRevision: "2".repeat(40)
  }
} satisfies AgentJobTask

const releaseChatTask = { _tag: "release-chat" } satisfies AgentJobTask

const threadEvent = (
  eventSequence: number,
  eventKind: AgentThreadEvent["eventKind"],
  payload: unknown,
  options: {
    readonly jobId?: typeof JobId.Type
    readonly task?: AgentJobTask
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
    sessionRef: "provider-native-session-secret"
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
      const fakePersistence = Persistence.of({
        ...persistence,
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
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

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
