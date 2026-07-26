import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderError,
  AgentProviderId,
  AgentRunId,
  AgentRuntimeEvent,
  type AgentRuntimeService,
  makeAgentRuntime
} from "@knpkv/ai-runtime"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { AgentModelId, type ReviewAgentProfile, ReviewAgentProfileId } from "../../src/api/agent.js"
import { JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PrReviewReport, type PrReviewSubject } from "../../src/domain/prReview.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  AgentJobWorker,
  agentJobWorkerLayer,
  agentJobWorkerWithTaskExecutorLayer
} from "../../src/server/agent/AgentJobWorker.js"
import { agentRuntimeRegistryLayer } from "../../src/server/agent/AgentRuntimeRegistry.js"
import {
  type AgentJobTaskExecution,
  agentJobTaskExecutorLayer,
  type AgentJobTaskExecutorService
} from "../../src/server/agent/internal/AgentJobTaskExecutor.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  AgentEventCursor,
  AgentLeaseOwner,
  AgentLeaseToken,
  type AgentThreadEvent,
  AgentThreadEventPageSize,
  MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../src/server/persistence/repositories/agentJobRepository.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000031")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000041")
const PROVIDER_ID = AgentProviderId.make("deterministic")
const FINGERPRINT = AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
const LEASE_OWNER = AgentLeaseOwner.make("agent-worker-test")
const CURSOR_ZERO = AgentEventCursor.make(0)
const PAGE_SIZE = AgentThreadEventPageSize.make(128)
const STARTED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
type AgentOutputEvent = Extract<AgentRuntimeEvent, { readonly _tag: "output" }>

const completedEvents: ReadonlyArray<AgentRuntimeEvent> = [
  { _tag: "started", providerRunRef: "provider-run-1", sessionRef: null },
  { _tag: "output", channel: "assistant", text: "Durable answer" },
  { _tag: "usage", inputTokens: 12, outputTokens: 3 },
  { _tag: "completed", outcome: "success", sessionRef: null }
]

const reviewSubject = {
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
} satisfies PrReviewSubject
const reviewProfile: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("deterministic:deterministic-model:sbx"),
  label: "Deterministic full-project review",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}

const reviewReport = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 3,
  subject: reviewSubject,
  completion: { status: "complete" },
  suggestions: [
    {
      suggestionId: `sha256:${"1".repeat(64)}`,
      state: "draft",
      title: "Decode review output before persistence",
      severity: "P2",
      problem: "Review output must cross a typed boundary.",
      impact: "Malformed model output could otherwise enter durable state.",
      evidence: {
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        startLine: 42,
        endLine: 45,
        excerpt: "const report = decodeReviewOutput(output)"
      },
      recommendation: "Decode the complete report before committing model-authored output.",
      anchor: {
        _tag: "line",
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        line: 42
      },
      relatedLocations: [],
      confidence: {
        level: "high",
        reason: "The persistence boundary is exercised directly by this test."
      },
      prevention: {
        summary: "Keep raw review chunks out of durable replay.",
        enforcement: "test",
        existingRuleOrConfig: "agent job worker integration suite",
        recurrenceEvidence: "Every durable review completion crosses the same decoded-report boundary.",
        targetFile: "packages/control-center/test/agent/agent-job-worker.test.ts",
        sourcePaths: ["packages/control-center/src/server/agent/AgentJobWorker.ts"],
        matcherOrInvariant: "Review jobs persist only one complete sanitized report.",
        invalidFixture: "execute({ report: malformedRawOutput })",
        validFixture: "execute({ report: decodedReviewReport })",
        boundary: "Release-chat streaming remains unchanged."
      }
    }
  ],
  notes: []
})
const OUTPUT_CHUNK_BYTES = 32_000
const MAXIMUM_RUNTIME_OUTPUT_CHARACTERS = 32_768
const outputEvents = (count: number): ReadonlyArray<AgentRuntimeEvent> => [
  completedEvents[0]!,
  ...Array.from({ length: count }, (): AgentRuntimeEvent => ({
    _tag: "output",
    channel: "assistant",
    text: "x".repeat(OUTPUT_CHUNK_BYTES)
  })),
  completedEvents.at(-1)!
]

const setupFoundation = Effect.gen(function*() {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, 'Agent worker', 1, '2026-07-19T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z'
  )`
  yield* database.sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${RELEASE_ID}, 1, '2026-07-19T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z'
  )`
})

const enqueue = (
  model: string | null = "deterministic-model",
  jobId: JobId = JOB_ID
) =>
  Effect.gen(function*() {
    const jobs = yield* AgentJobRepository
    yield* jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      releaseId: RELEASE_ID,
      jobId,
      providerId: PROVIDER_ID,
      model,
      access: "read-only",
      userPrompt: "Explain the release",
      prompt: "Explain the release",
      contextFingerprint: FINGERPRINT,
      subjectRevision: "release-revision-7",
      task: { _tag: "release-chat" },
      createdAt: STARTED_AT
    })
  })

const enqueueReview = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  yield* jobs.enqueue({
    workspaceId: WORKSPACE_ID,
    releaseId: RELEASE_ID,
    jobId: JOB_ID,
    providerId: PROVIDER_ID,
    model: "deterministic-model",
    access: "read-only",
    userPrompt: "Review the immutable pull request.",
    prompt: "Review the immutable pull request.",
    contextFingerprint: FINGERPRINT,
    subjectRevision: reviewSubject.headRevision,
    task: { _tag: "pr-review", subject: reviewSubject, reviewProfile },
    createdAt: STARTED_AT
  })
})

const replay = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  return yield* jobs.threadAfter({
    workspaceId: WORKSPACE_ID,
    releaseId: RELEASE_ID,
    after: CURSOR_ZERO,
    limit: PAGE_SIZE
  })
})

const replayAll = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  const events = new Array<AgentThreadEvent>()
  let after = CURSOR_ZERO
  while (true) {
    const page = yield* jobs.threadAfter({
      workspaceId: WORKSPACE_ID,
      releaseId: RELEASE_ID,
      after,
      limit: PAGE_SIZE
    })
    for (const event of page.events) events.push(event)
    if (page.events.length < PAGE_SIZE) return events
    after = page.nextCursor
  }
})

const withDatabaseConfig = <Success, Failure>(
  config: {
    readonly blobRoot: string
    readonly busyTimeoutMilliseconds: number
    readonly databaseUrl: string
    readonly maxConnections: number
  },
  runtime: AgentRuntimeService,
  use: Effect.Effect<Success, Failure, AgentJobWorker | AgentJobRepository | Database>
) => {
  const database = databaseLayer(config)
  const jobs = AgentJobRepository.layer.pipe(Layer.provideMerge(database))
  const registry = agentRuntimeRegistryLayer({
    catalog: () => Effect.succeed({ providers: [] }),
    select: ({ model, providerId }) =>
      providerId === PROVIDER_ID
        ? Effect.succeed({
          model: AgentModelId.make(model ?? "deterministic-model"),
          runtime
        })
        : Effect.fail(
          new AgentProviderError({
            providerId,
            phase: "configuration",
            message: "No deterministic provider configured.",
            retryable: false
          })
        )
  })
  const worker = agentJobWorkerLayer({
    leaseOwner: LEASE_OWNER,
    leaseDuration: "5 minutes"
  }).pipe(Layer.provide(registry), Layer.provideMerge(jobs))
  return use.pipe(Effect.provide(worker), Effect.scoped)
}

const withWorker = <Success, Failure>(
  runtime: AgentRuntimeService,
  use: Effect.Effect<Success, Failure, AgentJobWorker | AgentJobRepository | Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-agent-worker-")
    return yield* withDatabaseConfig(config, runtime, use)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const withTaskExecutor = <Success, Failure>(
  executor: AgentJobTaskExecutorService,
  use: Effect.Effect<Success, Failure, AgentJobWorker | AgentJobRepository | Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-agent-task-worker-")
    const database = databaseLayer(config)
    const jobs = AgentJobRepository.layer.pipe(Layer.provideMerge(database))
    const worker = agentJobWorkerWithTaskExecutorLayer({
      leaseOwner: LEASE_OWNER,
      leaseDuration: "5 minutes"
    }).pipe(Layer.provide(agentJobTaskExecutorLayer(executor)), Layer.provideMerge(jobs))
    return yield* use.pipe(Effect.provide(worker), Effect.scoped)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("agent job worker", () => {
  it.effect("persists one sanitized PR review report without durable raw model chunks", () => {
    const claims = new Array<Parameters<AgentJobTaskExecutorService["execute"]>[0]>()
    const executor: AgentJobTaskExecutorService = {
      taskTags: ["pr-review"],
      execute: (claim, onActivity = () => Effect.void) => {
        claims.push(claim)
        return onActivity({
          _tag: "started",
          providerRunRef: "review-run-1",
          sessionRef: null
        }).pipe(
          Effect.andThen(onActivity({
            _tag: "output",
            channel: "progress",
            text: "ReviewListFiles completed."
          })),
          Effect.andThen(onActivity({
            _tag: "usage",
            inputTokens: 12,
            outputTokens: 4
          })),
          Effect.as({ _tag: "pr-review", report: reviewReport } satisfies AgentJobTaskExecution)
        )
      }
    }
    return withTaskExecutor(
      executor,
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueueReview

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const persisted = yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
        const events = yield* replay

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.strictEqual(claims.length, 1)
        assert.strictEqual(claims[0]?.context.task._tag, "pr-review")
        assert.deepStrictEqual(persisted.report, reviewReport)
        assert.deepStrictEqual(
          events.events.map(({ eventKind }) => eventKind),
          [
            "user-message",
            "job-queued",
            "job-started",
            "progress",
            "usage",
            "review-report",
            "job-completed"
          ]
        )
        assert.isFalse(events.events.some(({ eventKind }) => eventKind === "assistant-output"))
        const latest = yield* jobs.latestReview({
          workspaceId: WORKSPACE_ID,
          subject: reviewSubject
        })
        assert.isTrue(Option.isSome(latest))
        if (Option.isSome(latest)) {
          assert.deepStrictEqual(latest.value.activity.events, [
            "ReviewListFiles completed."
          ])
        }
      })
    )
  })

  it.effect("interrupts a running review after durable cancellation and cleans through scope release", () => {
    let interrupted = false
    return Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const executor: AgentJobTaskExecutorService = {
        taskTags: ["pr-review"],
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              })
            )
          )
      }
      return yield* withTaskExecutor(
        executor,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
          yield* setupFoundation
          yield* enqueueReview
          const fiber = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* jobs.requestCancellation({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            requestedAt: STARTED_AT
          })
          yield* TestClock.adjust("10 seconds")
          const result = yield* Fiber.join(fiber)
          const events = yield* replay

          assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "cancelled" })
          assert.isTrue(interrupted)
          assert.deepStrictEqual(
            events.events.map(({ eventKind }) => eventKind),
            ["user-message", "job-queued", "cancel-requested", "job-completed"]
          )
        })
      )
    })
  })

  it.effect("honors cancellation persisted after a heartbeat but before review completion", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const executor: AgentJobTaskExecutorService = {
        taskTags: ["pr-review"],
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as({ _tag: "pr-review", report: reviewReport } satisfies AgentJobTaskExecution)
          )
      }
      return yield* withTaskExecutor(
        executor,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
          yield* setupFoundation
          yield* enqueueReview
          const fiber = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* TestClock.adjust("10 seconds")
          const requestedAt = yield* DateTime.now
          yield* jobs.requestCancellation({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            requestedAt
          })
          yield* Deferred.succeed(finish, undefined)

          const result = yield* Fiber.join(fiber)
          const missingReview = yield* jobs
            .reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
            .pipe(Effect.result)
          const events = yield* replay

          assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "cancelled" })
          assert.isTrue(Result.isFailure(missingReview))
          assert.deepStrictEqual(
            events.events.map(({ eventKind }) => eventKind),
            ["user-message", "job-queued", "cancel-requested", "job-completed"]
          )
        })
      )
    }))

  it.effect("preserves cancellation requested while review activity is being persisted", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const executor: AgentJobTaskExecutorService = {
        taskTags: ["pr-review"],
        execute: (_claim, onActivity = () => Effect.void) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(onActivity({
              _tag: "completed",
              outcome: "success",
              sessionRef: null
            })),
            Effect.as({ _tag: "pr-review", report: reviewReport } satisfies AgentJobTaskExecution)
          )
      }
      return yield* withTaskExecutor(
        executor,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
          yield* setupFoundation
          yield* enqueueReview
          const fiber = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* jobs.requestCancellation({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            requestedAt: STARTED_AT
          })
          yield* Deferred.succeed(finish, undefined)

          const result = yield* Fiber.join(fiber)
          const events = yield* replay
          assert.deepStrictEqual(result, {
            _tag: "completed",
            jobId: JOB_ID,
            outcome: "cancelled"
          })
          assert.deepStrictEqual(
            events.events.map(({ eventKind }) => eventKind),
            ["user-message", "job-queued", "cancel-requested", "job-completed"]
          )
        })
      )
    }))

  it.effect("renews a long review lease so another worker cannot duplicate the claim", () => {
    let executionCount = 0
    return Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const executor: AgentJobTaskExecutorService = {
        taskTags: ["pr-review"],
        execute: () => {
          executionCount += 1
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.sleep("6 minutes")),
            Effect.as({ _tag: "pr-review", report: reviewReport } satisfies AgentJobTaskExecution)
          )
        }
      }
      return yield* withTaskExecutor(
        executor,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
          yield* setupFoundation
          yield* enqueueReview
          const fiber = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* TestClock.adjust("330 seconds")
          const secondClaimAt = yield* DateTime.now
          const secondClaim = yield* jobs.claimNext({
            workspaceId: WORKSPACE_ID,
            taskTags: ["pr-review"],
            leaseOwner: AgentLeaseOwner.make("second-review-worker"),
            leaseToken: Schema.decodeSync(AgentLeaseToken)("d".repeat(64)),
            claimedAt: secondClaimAt,
            leaseExpiresAt: DateTime.addDuration(secondClaimAt, "5 minutes")
          })
          assert.isTrue(Option.isNone(secondClaim))
          yield* TestClock.adjust("30 seconds")
          const result = yield* Fiber.join(fiber)
          const persisted = yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })

          assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
          assert.strictEqual(executionCount, 1)
          assert.deepStrictEqual(persisted.report, reviewReport)
        })
      )
    })
  })

  it.effect("terminally rejects malformed review output without persisting its raw canary", () => {
    const rawCanary = "RAW_MODEL_CANARY_MUST_NOT_PERSIST"
    const executor: AgentJobTaskExecutorService = {
      taskTags: ["pr-review"],
      execute: () =>
        Effect.succeed(
          {
            _tag: "pr-review",
            report: {
              ...reviewReport,
              suggestions: [
                {
                  ...reviewReport.suggestions[0]!,
                  evidence: {
                    ...reviewReport.suggestions[0]!.evidence,
                    path: `../${rawCanary}`
                  }
                }
              ]
            }
          } satisfies AgentJobTaskExecution
        )
    }
    return withTaskExecutor(
      executor,
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueueReview

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const events = yield* replay
        const missing = yield* jobs
          .reviewResult({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID
          })
          .pipe(Effect.result)

        assert.deepStrictEqual(result, { _tag: "failed", jobId: JOB_ID })
        assert.isTrue(Result.isFailure(missing))
        assert.strictEqual(events.events.at(-1)?.eventKind, "job-failed")
        assert.notInclude(JSON.stringify(events.events), rawCanary)
        assert.isFalse(events.events.some(({ eventKind }) => eventKind === "assistant-output"))
      })
    )
  })

  it.effect("claims and executes one queued job through the selected runtime", () => {
    const requests = new Array<Parameters<AgentRuntimeService["run"]>[0]>()
    const runtime = makeAgentRuntime({
      run: (request) =>
        Stream.suspend(() => {
          requests.push(request)
          return Stream.fromIterable(completedEvents)
        })
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.strictEqual(requests.length, 1)
        assert.strictEqual(requests[0]?.runId, AgentRunId.make(JOB_ID))
        assert.strictEqual(requests[0]?.model, "deterministic-model")
        assert.strictEqual(requests[0]?.context.workspaceId, WORKSPACE_ID)
      })
    )
  })

  it.effect("maps a legacy null model to the configured default before runtime execution", () => {
    const requests = new Array<Parameters<AgentRuntimeService["run"]>[0]>()
    const runtime = makeAgentRuntime({
      run: (request) =>
        Stream.suspend(() => {
          requests.push(request)
          return Stream.fromIterable(completedEvents)
        })
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue(null)

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.strictEqual(requests.length, 1)
        assert.strictEqual(requests[0]?.model, "deterministic-model")
      })
    )
  })

  it.effect("persists and replays one maximum-sized assistant output event exactly", () => {
    const output = "x".repeat(MAXIMUM_RUNTIME_OUTPUT_CHARACTERS)
    const runtime = makeAgentRuntime({
      run: () =>
        Stream.fromIterable([
          completedEvents[0]!,
          { _tag: "output", channel: "assistant", text: output },
          completedEvents.at(-1)!
        ])
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const page = yield* replay
        const persistedOutputs = page.events
          .filter(({ eventKind }) => eventKind === "assistant-output")
          .map(({ payload }) => Schema.decodeUnknownSync(AgentRuntimeEvent)(payload))
          .filter((event): event is AgentOutputEvent => event._tag === "output")

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.isAbove(persistedOutputs.length, 1)
        assert.isTrue(persistedOutputs.every(({ channel }) => channel === "assistant"))
        assert.strictEqual(persistedOutputs.map(({ text }) => text).join(""), output)
        assert.strictEqual(page.events.at(-1)?.eventKind, "job-completed")
      })
    )
  })

  it.effect("preserves Unicode and ordering while chunking progress output", () => {
    const output = `${"α".repeat(4_999)}😀${"β".repeat(5_001)}`
    const runtime = makeAgentRuntime({
      run: () =>
        Stream.fromIterable([
          completedEvents[0]!,
          { _tag: "output", channel: "progress", text: output },
          completedEvents.at(-1)!
        ])
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const page = yield* replay
        const persistedOutputs = page.events
          .filter(({ eventKind }) => eventKind === "progress")
          .map(({ payload }) => Schema.decodeUnknownSync(AgentRuntimeEvent)(payload))
          .filter((event): event is AgentOutputEvent => event._tag === "output")

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.isAbove(persistedOutputs.length, 1)
        assert.isTrue(persistedOutputs.every(({ channel }) => channel === "progress"))
        assert.strictEqual(persistedOutputs.map(({ text }) => text).join(""), output)
        assert.strictEqual(page.events.at(-1)?.eventKind, "job-completed")
      })
    )
  })

  it.effect("completes an attempt whose cumulative output remains under the durable limit", () => {
    const outputCount = Math.floor(MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES / OUTPUT_CHUNK_BYTES)
    const runtime = makeAgentRuntime({ run: () => Stream.fromIterable(outputEvents(outputCount)) })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        const database = yield* Database
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const rows = yield* database.sql<{
          readonly leaseCount: number
          readonly outputBytes: number
          readonly state: string
        }>`SELECT job.state, attempt.output_bytes AS outputBytes,
        (SELECT COUNT(*) FROM agent_job_leases lease
          WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.job_id) AS leaseCount
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "success" })
        assert.strictEqual(rows[0]?.state, "succeeded")
        assert.strictEqual(rows[0]?.outputBytes, outputCount * OUTPUT_CHUNK_BYTES)
        assert.strictEqual(rows[0]?.leaseCount, 0)
      })
    )
  })

  it.effect("terminally fails an attempt whose cumulative output exceeds the durable limit", () => {
    const outputCount = Math.floor(MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES / OUTPUT_CHUNK_BYTES) + 1
    const runtime = makeAgentRuntime({ run: () => Stream.fromIterable(outputEvents(outputCount)) })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        const database = yield* Database
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const rows = yield* database.sql<{
          readonly leaseCount: number
          readonly outcome: string
          readonly state: string
        }>`SELECT job.state, attempt.outcome,
        (SELECT COUNT(*) FROM agent_job_leases lease
          WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.job_id) AS leaseCount
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`

        assert.deepStrictEqual(result, { _tag: "failed", jobId: JOB_ID })
        assert.strictEqual(rows[0]?.state, "failed")
        assert.strictEqual(rows[0]?.outcome, "failed")
        assert.strictEqual(rows[0]?.leaseCount, 0)
        assert.strictEqual((yield* replayAll).at(-1)?.eventKind, "job-failed")
      })
    )
  })

  it.effect("persists the first terminal event without waiting for the provider stream to end", () => {
    const runtime = makeAgentRuntime({
      run: () => Stream.fromIterable(completedEvents).pipe(Stream.concat(Stream.never))
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        const database = yield* Database
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const observed = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const rows = yield* database.sql<{
          readonly leaseCount: number
          readonly state: string
        }>`SELECT job.state,
        (SELECT COUNT(*) FROM agent_job_leases lease
          WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.job_id) AS leaseCount
        FROM agent_jobs job
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`

        assert.deepStrictEqual(observed, {
          _tag: "completed",
          jobId: JOB_ID,
          outcome: "success"
        })
        assert.strictEqual(rows[0]?.state, "succeeded")
        assert.strictEqual(rows[0]?.leaseCount, 0)
        assert.strictEqual((yield* replay).events.at(-1)?.eventKind, "job-completed")
      })
    )
  })

  it.effect("does not duplicate a claim when run-once calls race", () => {
    let runtimeCalls = 0
    const runtime = makeAgentRuntime({
      run: () =>
        Stream.suspend(() => {
          runtimeCalls += 1
          return Stream.fromIterable(completedEvents)
        })
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()
        const worker = yield* AgentJobWorker

        const results = yield* Effect.all([worker.runOnce(WORKSPACE_ID), worker.runOnce(WORKSPACE_ID)], {
          concurrency: "unbounded"
        })

        assert.strictEqual(runtimeCalls, 1)
        assert.deepStrictEqual(results.map(({ _tag }) => _tag).sort(), ["completed", "idle"])
      })
    )
  })

  it.effect("persists a provider failure and releases the terminal lease", () => {
    const providerFailure = new AgentProviderError({
      providerId: PROVIDER_ID,
      phase: "execution",
      message: "Deterministic provider failure",
      retryable: true
    })
    const runtime = makeAgentRuntime({
      run: () => Stream.make(completedEvents[0]!).pipe(Stream.concat(Stream.fail(providerFailure)))
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        const database = yield* Database
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
        const rows = yield* database.sql<{
          readonly errorJson: string
          readonly leaseCount: number
          readonly outcome: string
          readonly state: string
        }>`SELECT attempt.error_json AS errorJson, attempt.outcome, job.state,
        (SELECT COUNT(*) FROM agent_job_leases lease
          WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.job_id) AS leaseCount
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`

        assert.deepStrictEqual(result, { _tag: "failed", jobId: JOB_ID })
        assert.strictEqual(rows[0]?.state, "failed")
        assert.strictEqual(rows[0]?.outcome, "failed")
        assert.strictEqual(rows[0]?.leaseCount, 0)
        assert.include(rows[0]?.errorJson ?? "", "Deterministic provider failure")
        assert.strictEqual((yield* replay).events.at(-1)?.eventKind, "job-failed")
      })
    )
  })

  it.effect("completes a recovered cancellation without invoking the provider", () => {
    let runtimeCalls = 0
    const runtime = makeAgentRuntime({
      run: () => {
        runtimeCalls += 1
        return Stream.fromIterable(completedEvents)
      }
    })
    return withWorker(
      runtime,
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))
        yield* setupFoundation
        yield* enqueue()
        const original = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["release-chat"],
          leaseOwner: LEASE_OWNER,
          leaseToken: Schema.decodeSync(AgentLeaseToken)("e".repeat(64)),
          claimedAt: STARTED_AT,
          leaseExpiresAt: DateTime.addDuration(STARTED_AT, "1 minute")
        })
        assert.isTrue(Option.isSome(original))
        yield* jobs.requestCancellation({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          requestedAt: DateTime.addDuration(STARTED_AT, "30 seconds")
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.addDuration(STARTED_AT, "2 minutes")))

        const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)

        assert.deepStrictEqual(result, { _tag: "completed", jobId: JOB_ID, outcome: "cancelled" })
        assert.strictEqual(runtimeCalls, 0)
        assert.strictEqual((yield* replay).events.at(-1)?.eventKind, "job-completed")
      })
    )
  })

  it.effect("replays the ordered terminal thread after the SQLite database is reopened", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-agent-worker-replay-")
      const runtime = makeAgentRuntime({ run: () => Stream.fromIterable(completedEvents) })
      yield* TestClock.setTime(DateTime.toEpochMillis(STARTED_AT))

      yield* withDatabaseConfig(
        config,
        runtime,
        Effect.gen(function*() {
          yield* setupFoundation
          yield* enqueue()
          const result = yield* (yield* AgentJobWorker).runOnce(WORKSPACE_ID)
          assert.strictEqual(result._tag, "completed")
        })
      )

      yield* withDatabaseConfig(
        config,
        runtime,
        Effect.gen(function*() {
          const page = yield* replay
          assert.deepStrictEqual(
            page.events.map(({ eventKind, eventSequence }) => ({ eventKind, eventSequence })),
            [
              { eventKind: "user-message", eventSequence: 1 },
              { eventKind: "job-queued", eventSequence: 2 },
              { eventKind: "job-started", eventSequence: 3 },
              { eventKind: "assistant-output", eventSequence: 4 },
              { eventKind: "usage", eventSequence: 5 },
              { eventKind: "job-completed", eventSequence: 6 }
            ]
          )
          assert.isTrue(
            Option.isNone(
              yield* (yield* AgentJobRepository).claimNext({
                workspaceId: WORKSPACE_ID,
                taskTags: ["release-chat"],
                leaseOwner: LEASE_OWNER,
                leaseToken: Schema.decodeSync(AgentLeaseToken)("f".repeat(64)),
                claimedAt: STARTED_AT,
                leaseExpiresAt: DateTime.addDuration(STARTED_AT, "5 minutes")
              })
            )
          )
        })
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
