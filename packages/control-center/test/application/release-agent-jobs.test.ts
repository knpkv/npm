import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentProviderError, AgentProviderId } from "@knpkv/ai-runtime"
import { DateTime, Effect, Ref, Result, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import * as TestClock from "effect/testing/TestClock"

import { DurableAgentProviderId, ReleaseAgentThreadCursor } from "../../src/api/agent.js"
import { AgentThreadId, JobId, PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeReleaseAgentJobs } from "../../src/server/application/releaseAgentJobs.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import {
  AgentEventCursor,
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
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000205")
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

const releaseSnapshot = ReleaseSnapshotRecord.make({
  release,
  revision: RecordRevision.make(7)
})

const unauthorizedRelease = Schema.decodeSync(Schema.toType(Release))({
  ...release,
  id: UNAUTHORIZED_RELEASE_ID,
  workspaceId: OTHER_WORKSPACE_ID,
  relay: deriveReleaseRelay(UNAUTHORIZED_RELEASE_ID)
})

const threadEvent = (
  eventSequence: number,
  eventKind: AgentThreadEvent["eventKind"],
  payload: unknown
): AgentThreadEvent =>
  AgentThreadEvent.make({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    eventSequence: AgentEventCursor.make(eventSequence),
    jobId: JOB_ID,
    attemptSequence: null,
    eventKind,
    payload,
    occurredAt: STARTED_AT
  })

const replayEvents: Array<AgentThreadEvent> = [
  threadEvent(1, "user-message", { prompt: "Explain the release." }),
  threadEvent(2, "job-queued", {
    access: "read-only",
    contextFingerprint: `sha256:${"a".repeat(64)}`,
    model: null,
    providerId: AgentProviderId.make("codex"),
    subjectRevision: "release-revision:7"
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
  threadEvent(5, "job-failed", {
    error: new AgentProviderError({
      providerId: AgentProviderId.make("codex"),
      phase: "execution",
      message: "provider credential secret must stay server-side",
      retryable: true
    })
  })
]

const withPersistence = <Success, Failure>(use: Effect.Effect<Success, Failure, Crypto.Crypto | Persistence>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-release-agent-jobs-")
    return yield* use.pipe(Effect.provide(persistenceLayer(config)))
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
              Effect.as({ events: replayEvents, nextCursor: AgentEventCursor.make(5) })
            )
        },
        releases: {
          ...persistence.releases,
          get: () => Effect.succeed(releaseSnapshot)
        }
      })
      const service = yield* makeReleaseAgentJobs.pipe(Effect.provideService(Persistence, fakePersistence))

      const enqueued = yield* service.enqueue({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        request: { providerId: DurableAgentProviderId.make("codex"), prompt: "Explain the release." }
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
      assert.strictEqual(capturedEnqueue.model, null)
      assert.strictEqual(capturedEnqueue.providerId, "codex")
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
          { _tag: "job-failed", eventSequence: 5 }
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
      assert.include(browserJson, "\"retryable\":true")
    })))
})
