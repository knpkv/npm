import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderError,
  AgentProviderId,
  type AgentRunRequest,
  type AgentRuntimeEvent,
  makeAgentRuntime
} from "@knpkv/ai-runtime"
import { Effect, Layer, Result, Schema, Stream } from "effect"

import { AgentModelId } from "../../src/api/agent.js"
import { AgentThreadId, JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PrReviewReport, type PrReviewSubject } from "../../src/domain/prReview.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { agentRuntimeRegistryLayer } from "../../src/server/agent/AgentRuntimeRegistry.js"
import {
  PrReviewSandboxError,
  PrReviewSandboxEvidence,
  PrReviewSandboxRunner
} from "../../src/server/agent/internal/PrReviewSandboxRunner.js"
import {
  PrReviewTaskExecutor,
  prReviewTaskExecutorLayer
} from "../../src/server/agent/internal/PrReviewTaskExecutor.js"
import {
  AgentAttemptSequence,
  AgentLeaseOwner,
  AgentLeaseToken,
  type ClaimedAgentJob
} from "../../src/server/persistence/repositories/agentJobModels.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000031")
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000041")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000051")
const PROVIDER_ID = AgentProviderId.make("deterministic-review")
const MODEL_ID = AgentModelId.make("review-model")
const HEAD_REVISION = "2".repeat(40)
const FINGERPRINT = AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
const LEASE_TOKEN = AgentLeaseToken.make("b".repeat(64))
const LEASE_EXPIRES_AT = Schema.decodeSync(UtcTimestamp)("2026-07-24T10:05:00.000Z")
const TestSandboxRequest = Schema.Struct({
  attemptId: Schema.String,
  jobId: JobId,
  headRevision: Schema.String
})

const subject = {
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: HEAD_REVISION
} satisfies PrReviewSubject

const claim = {
  workspaceId: WORKSPACE_ID,
  releaseId: RELEASE_ID,
  threadId: THREAD_ID,
  jobId: JOB_ID,
  attemptSequence: AgentAttemptSequence.make(1),
  leaseOwner: AgentLeaseOwner.make("review-worker"),
  leaseToken: LEASE_TOKEN,
  leaseExpiresAt: LEASE_EXPIRES_AT,
  providerId: PROVIDER_ID,
  model: MODEL_ID,
  access: "read-only",
  prompt: "The persisted dispatch prompt is not sent to the review model.",
  context: {
    workspaceId: WORKSPACE_ID,
    releaseId: RELEASE_ID,
    subjectRevision: HEAD_REVISION,
    fingerprint: FINGERPRINT,
    task: { _tag: "pr-review", subject }
  },
  sessionRef: null,
  cancellationRequested: false
} satisfies ClaimedAgentJob

const evidence = Schema.decodeUnknownSync(PrReviewSandboxEvidence)({
  schemaVersion: 1,
  headRevision: HEAD_REVISION,
  tool: {
    name: "eslint",
    version: "10.7.0"
  },
  findings: [
    {
      ruleId: "@typescript-eslint/no-floating-promises",
      severity: "error",
      path: "packages/control-center/src/review.ts",
      startLine: 42,
      endLine: 42,
      message: "Await or explicitly supervise the review promise."
    }
  ]
})

const modelReport = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 1,
  subject,
  recommendation: "changes-recommended",
  summary: "One exact static-analysis finding requires attention.",
  findings: [
    {
      findingId: "evidence-1",
      severity: "high",
      path: "packages/control-center/src/review.ts",
      startLine: 42,
      endLine: 42,
      title: "Review promise is not supervised",
      detail: "The review operation may outlive its intended lifecycle.",
      prevention: {
        summary: "Keep the existing promise rule enabled.",
        enforcement: "none",
        rationale: "The existing ESLint rule already catches this defect."
      }
    }
  ]
})

const makeRegistry = (
  run: (request: AgentRunRequest) => Stream.Stream<AgentRuntimeEvent, AgentProviderError>
) =>
  agentRuntimeRegistryLayer({
    catalog: () => Effect.succeed({ providers: [] }),
    select: ({ access, model, providerId }) =>
      access === "read-only" && model === MODEL_ID && providerId === PROVIDER_ID
        ? Effect.succeed({ model: MODEL_ID, runtime: makeAgentRuntime({ run }) })
        : Effect.fail(
          new AgentProviderError({
            providerId,
            phase: "configuration",
            message: "No matching deterministic review provider.",
            retryable: false
          })
        )
  })

const runExecutor = <Success, Failure>(
  sandbox: PrReviewSandboxRunner["Service"],
  run: Parameters<typeof makeRegistry>[0],
  use: Effect.Effect<Success, Failure, PrReviewTaskExecutor>
) =>
  use.pipe(
    Effect.provide(
      prReviewTaskExecutorLayer.pipe(
        Layer.provide(makeRegistry(run)),
        Layer.provide(Layer.succeed(PrReviewSandboxRunner, sandbox))
      )
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped
  )

const successfulRuntime = (
  requests: Array<AgentRunRequest>,
  report: unknown = modelReport
): Parameters<typeof makeRegistry>[0] =>
(request) =>
  Stream.suspend(() => {
    requests.push(request)
    const output = JSON.stringify(report)
    const midpoint = Math.floor(output.length / 2)
    const events: ReadonlyArray<AgentRuntimeEvent> = [
      { _tag: "started", providerRunRef: null, sessionRef: null },
      { _tag: "output", channel: "assistant", text: output.slice(0, midpoint) },
      { _tag: "output", channel: "assistant", text: output.slice(midpoint) },
      { _tag: "completed", outcome: "success", sessionRef: null }
    ]
    return Stream.fromIterable(events)
  })

describe("PR review task executor", () => {
  it.effect("runs exact sandbox evidence through the selected host model and derives a stable immutable finding identity", () => {
    const sandboxRequests = new Array<typeof TestSandboxRequest.Type>()
    const modelRequests: Array<AgentRunRequest> = []
    const sandbox = PrReviewSandboxRunner.of({
      run: (request) =>
        Effect.sync(() => {
          sandboxRequests.push(Schema.decodeUnknownSync(TestSandboxRequest)(request))
          return evidence
        })
    })
    return runExecutor(
      sandbox,
      successfulRuntime(modelRequests),
      Effect.gen(function*() {
        const executor = yield* PrReviewTaskExecutor
        const first = yield* executor.execute(claim)
        const second = yield* executor.execute(claim)

        assert.strictEqual(first.findings[0]?.findingId, second.findings[0]?.findingId)
        assert.match(first.findings[0]?.findingId ?? "", /^sha256:[0-9a-f]{64}$/u)
        assert.notStrictEqual(
          String(first.findings[0]?.findingId),
          modelReport.findings[0]?.findingId ?? ""
        )
        const sandboxAttemptId = sandboxRequests[0]?.attemptId
        assert.deepStrictEqual(
          sandboxRequests,
          [
            { attemptId: sandboxAttemptId, jobId: JOB_ID, headRevision: HEAD_REVISION },
            { attemptId: sandboxAttemptId, jobId: JOB_ID, headRevision: HEAD_REVISION }
          ]
        )
        assert.match(sandboxAttemptId ?? "", /^[0-9a-f]{12}$/u)
        assert.strictEqual(modelRequests.length, 2)
        assert.strictEqual(modelRequests[0]?.access, "read-only")
        assert.deepStrictEqual(modelRequests[0]?.continuation, { _tag: "fresh" })
        assert.include(modelRequests[0]?.prompt ?? "", "\"findingId\":\"evidence-1\"")
        assert.include(modelRequests[0]?.prompt ?? "", "\"ruleId\":\"@typescript-eslint/no-floating-promises\"")
        assert.notInclude(modelRequests[0]?.prompt ?? "", LEASE_TOKEN)
        assert.isTrue(Schema.is(PrReviewReport)(first))
      })
    )
  })

  it.effect("rejects a model finding that does not match an exact sandbox path and line range", () => {
    const requests: Array<AgentRunRequest> = []
    const sandbox = PrReviewSandboxRunner.of({ run: () => Effect.succeed(evidence) })
    const moved = {
      ...modelReport,
      findings: [{ ...modelReport.findings[0], startLine: 41, endLine: 41 }]
    }
    return runExecutor(
      sandbox,
      successfulRuntime(requests, moved),
      Effect.gen(function*() {
        const result = yield* (yield* PrReviewTaskExecutor).execute(claim).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.phase, "protocol")
          assert.strictEqual(result.failure.message, "PR review finding did not match exact sandbox evidence.")
        }
      })
    )
  })

  it.effect("rejects an invented evidence identity even when its path and line range match", () => {
    const requests: Array<AgentRunRequest> = []
    const sandbox = PrReviewSandboxRunner.of({ run: () => Effect.succeed(evidence) })
    const invented = {
      ...modelReport,
      findings: [{ ...modelReport.findings[0], findingId: "evidence-99" }]
    }
    return runExecutor(
      sandbox,
      successfulRuntime(requests, invented),
      Effect.gen(function*() {
        const result = yield* (yield* PrReviewTaskExecutor).execute(claim).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.message, "PR review finding did not match exact sandbox evidence.")
        }
      })
    )
  })

  it.effect("rejects contradictory recommendations after structured decoding", () => {
    const requests: Array<AgentRunRequest> = []
    const sandbox = PrReviewSandboxRunner.of({ run: () => Effect.succeed(evidence) })
    const contradictory = { ...modelReport, recommendation: "no-material-findings" }
    return runExecutor(
      sandbox,
      successfulRuntime(requests, contradictory),
      Effect.gen(function*() {
        const result = yield* (yield* PrReviewTaskExecutor).execute(claim).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.message, "PR review recommendation contradicted its findings.")
        }
      })
    )
  })

  it.effect("redacts sandbox failure and never invokes the model", () => {
    let modelCalls = 0
    const sandbox = PrReviewSandboxRunner.of({
      run: () => Effect.fail(new PrReviewSandboxError({ reason: "source-rejected" }))
    })
    return runExecutor(
      sandbox,
      () => {
        modelCalls += 1
        return Stream.empty
      },
      Effect.gen(function*() {
        const result = yield* (yield* PrReviewTaskExecutor).execute(claim).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.phase, "execution")
          assert.strictEqual(result.failure.retryable, false)
          assert.strictEqual(result.failure.message, "Immutable PR review sandbox failed (source-rejected).")
        }
        assert.strictEqual(modelCalls, 0)
      })
    )
  })

  it.effect("rejects workspace-write review claims before sandbox execution", () => {
    let sandboxCalls = 0
    let modelCalls = 0
    const sandbox = PrReviewSandboxRunner.of({
      run: () => {
        sandboxCalls += 1
        return Effect.succeed(evidence)
      }
    })
    return runExecutor(
      sandbox,
      () => {
        modelCalls += 1
        return Stream.empty
      },
      Effect.gen(function*() {
        const unsafeClaim = { ...claim, access: "workspace-write" } satisfies ClaimedAgentJob
        const result = yield* (yield* PrReviewTaskExecutor).execute(unsafeClaim).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.phase, "configuration")
        }
        assert.strictEqual(sandboxCalls, 0)
        assert.strictEqual(modelCalls, 0)
      })
    )
  })
})
