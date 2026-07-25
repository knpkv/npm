import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderId,
  type AgentRuntimeEvent,
  type DeterministicLanguageModelScript,
  makeAgentRuntime,
  makeDeterministicLanguageModel
} from "@knpkv/ai-runtime"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"

import {
  AgentModelId,
  DurableAgentProviderId,
  type ReviewAgentProfile,
  ReviewAgentProfileId
} from "../../src/api/agent.js"
import { AgentThreadId, JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { type PrReviewSubject, PrReviewSuggestionDraft } from "../../src/domain/prReview.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"
import {
  type PrReviewSandboxCommandResult,
  type PrReviewSandboxSession,
  PrReviewSandboxSessions
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
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
const DURABLE_PROVIDER_ID = DurableAgentProviderId.make("deterministic-review")
const MODEL_ID = AgentModelId.make("review-model")
const PROFILE_ID = ReviewAgentProfileId.make("deterministic-review:review-model:sbx")
const REVIEW_PROFILE: ReviewAgentProfile = {
  profileId: PROFILE_ID,
  label: "Deterministic full-project review",
  budgetMillis: 120_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}
const HEAD_REVISION = "2".repeat(40)
const FINGERPRINT = AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
const LEASE_TOKEN = AgentLeaseToken.make("b".repeat(64))
const LEASE_EXPIRES_AT = Schema.decodeSync(UtcTimestamp)("2026-07-24T10:05:00.000Z")
const EVIDENCE_PATH = "packages/control-center/src/review.ts"
const EVIDENCE_EXCERPT = "const unsafe = true"

const subject = {
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "276",
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
  prompt: "Review the immutable pull request.",
  context: {
    workspaceId: WORKSPACE_ID,
    releaseId: RELEASE_ID,
    subjectRevision: HEAD_REVISION,
    fingerprint: FINGERPRINT,
    task: { _tag: "pr-review", subject, reviewProfile: REVIEW_PROFILE }
  },
  sessionRef: null,
  cancellationRequested: false
} satisfies ClaimedAgentJob

const suggestion = Schema.decodeUnknownSync(PrReviewSuggestionDraft)({
  severity: "P2",
  problem: "An unsafe value is enabled.",
  impact: "The production review path can accept unsafe state.",
  evidence: {
    path: EVIDENCE_PATH,
    startLine: 42,
    endLine: 42,
    excerpt: EVIDENCE_EXCERPT
  },
  recommendation: "Replace the unsafe value with a validated configuration.",
  confidence: {
    level: "high",
    reason: "The exact added line enables the unsafe state."
  },
  prevention: {
    summary: "Exercise the configuration boundary.",
    enforcement: "test",
    existingRuleOrConfig: "PR review task executor suite",
    targetFile: "packages/control-center/test/agent/pr-review-task-executor.test.ts",
    sourcePaths: [EVIDENCE_PATH],
    matcherOrInvariant: "Unsafe review configuration cannot be enabled.",
    invalidFixture: "const unsafe = true",
    validFixture: "const unsafe = false",
    boundary: "Nearby validated configuration remains accepted."
  }
})

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    total: 12,
    uncached: 12
  },
  outputTokens: {
    reasoning: undefined,
    text: 4,
    total: 4
  }
}

const response = (
  ...parts: ReadonlyArray<Response.PartEncoded>
): ReadonlyArray<Response.PartEncoded> => [
  ...parts,
  {
    reason: "stop",
    response: undefined,
    type: "finish",
    usage
  }
]

const completeScript = (report: unknown = {
  schemaVersion: 2,
  completion: { status: "complete" },
  suggestions: [suggestion]
}): DeterministicLanguageModelScript => [
  {
    _tag: "response",
    parts: response({
      id: "list-project",
      name: "ReviewListFiles",
      params: { path: "." },
      type: "tool-call"
    })
  },
  {
    _tag: "response",
    parts: response({
      id: "read-instructions",
      name: "ReviewRunCommand",
      params: { command: `git show ${subject.baseRevision}:AGENTS.md` },
      type: "tool-call"
    })
  },
  {
    _tag: "response",
    parts: response({
      id: "inspect-diff",
      name: "ReviewRunCommand",
      params: {
        command: `git diff --stat ${subject.baseRevision} ${subject.headRevision}`
      },
      type: "tool-call"
    })
  },
  {
    _tag: "response",
    parts: response({
      text: JSON.stringify(report),
      type: "text"
    })
  }
]

const output = (
  stdout = "",
  exitCode = 0
): PrReviewSandboxCommandResult => ({
  exitCode,
  stderr: {
    artifactId: null,
    byteLength: 0,
    text: "",
    truncated: false
  },
  stdout: {
    artifactId: null,
    byteLength: new TextEncoder().encode(stdout).byteLength,
    text: stdout,
    truncated: false
  }
})

interface SessionObservation {
  readonly commands: Array<string>
  readonly operations: Array<string>
  readonly requests: Array<unknown>
}

const makeSessionLayer = (
  observation: SessionObservation,
  diff = `@@ -0,0 +42 @@\n+${EVIDENCE_EXCERPT}\n`,
  sourceExcerpt = EVIDENCE_EXCERPT
) => {
  const session: PrReviewSandboxSession = {
    attemptId: "0123456789ab",
    baseRevision: subject.baseRevision,
    headRevision: subject.headRevision,
    jobId: JOB_ID,
    listFiles: () =>
      Effect.sync(() => {
        observation.operations.push("listFiles")
        return output("AGENTS.md\npackages\n")
      }),
    readFile: () =>
      Effect.sync(() => {
        observation.operations.push("readFile")
        return output("# Review instructions\n")
      }),
    searchFiles: () => Effect.succeed(output()),
    runCommand: (command) =>
      Effect.sync(() => {
        observation.operations.push("runCommand")
        observation.commands.push(command)
        if (command.startsWith("git -c core.quotePath=false diff --unified=0")) {
          return output(diff)
        }
        if (command.startsWith(`git show '${HEAD_REVISION}:${EVIDENCE_PATH}' | sed -n '42,42p'`)) {
          return output(`${sourceExcerpt}\n`)
        }
        return command.startsWith("git show ")
          ? output("# Review instructions\n")
          : output("1 file changed\n")
      }),
    applyPatch: () => Effect.succeed(output()),
    readDiff: () => Effect.succeed(output(diff)),
    pageArtifact: () => Effect.succeed(""),
    searchArtifact: () => Effect.succeed([]),
    close: Effect.void
  }
  return Layer.succeed(
    PrReviewSandboxSessions,
    PrReviewSandboxSessions.of({
      withSession: (request, use) =>
        Effect.sync(() => {
          observation.requests.push(request)
        }).pipe(Effect.andThen(use(session))),
      reconcile: () => Effect.succeed({ removedSandboxes: [] })
    })
  )
}

const runExecutor = <Success, Failure>(
  script: ReturnType<typeof completeScript>,
  observation: SessionObservation,
  use: Effect.Effect<Success, Failure, PrReviewTaskExecutor>,
  diff?: string,
  sourceExcerpt?: string
) => {
  const fake = makeDeterministicLanguageModel(script)
  return Effect.gen(function*() {
    const languageModel = yield* LanguageModel.LanguageModel
    const runtime = makeAgentRuntime({ run: () => Stream.empty })
    const registry = AgentRuntimeRegistry.of({
      catalog: () =>
        Effect.succeed({
          providers: [{
            providerId: DURABLE_PROVIDER_ID,
            models: [MODEL_ID],
            capabilities: ["release-chat", "pr-review"],
            health: "available",
            reviewProfile: REVIEW_PROFILE
          }]
        }),
      select: () =>
        Effect.succeed({
          model: MODEL_ID,
          runtime,
          filesystemAccess: "none",
          languageModel
        })
    })
    return yield* use.pipe(
      Effect.provide(
        prReviewTaskExecutorLayer.pipe(
          Layer.provide(Layer.succeed(AgentRuntimeRegistry, registry)),
          Layer.provide(makeSessionLayer(observation, diff, sourceExcerpt))
        )
      )
    )
  }).pipe(
    Effect.provide(fake.layer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.map((result) => ({ fake, result }))
  )
}

describe("PR review task executor", () => {
  it.effect("drives full-project exploration through sandbox tools and publishes only anchored suggestions", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    const activity = new Array<AgentRuntimeEvent>()
    return runExecutor(
      completeScript(),
      observation,
      Effect.gen(function*() {
        const executor = yield* PrReviewTaskExecutor
        return yield* executor.execute(
          claim,
          (event) =>
            Effect.sync(() => {
              activity.push(event)
            })
        )
      })
    ).pipe(
      Effect.tap(({ fake, result }) =>
        Effect.sync(() => {
          assert.strictEqual(result.schemaVersion, 2)
          assert.strictEqual(result.completion.status, "complete")
          assert.strictEqual(result.suggestions.length, 1)
          assert.match(
            result.suggestions[0]?.suggestionId ?? "",
            /^sha256:[0-9a-f]{64}$/u
          )
          assert.deepStrictEqual(
            observation.operations.slice(0, 3),
            ["listFiles", "runCommand", "runCommand"]
          )
          assert.isTrue(
            observation.commands.some((command) => command.startsWith("git -c core.quotePath=false diff --unified=0"))
          )
          assert.isTrue(
            observation.commands.some((command) =>
              command.startsWith(`git show '${HEAD_REVISION}:${EVIDENCE_PATH}' | sed -n '42,42p'`)
            )
          )
          assert.strictEqual(observation.requests.length, 1)
          assert.strictEqual(fake.requests.length, 4)
          assert.isTrue(activity.some((event) => event._tag === "output" && event.channel === "progress"))
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("drops unverifiable suggestions while retaining a durable report and live activity", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    const activity = new Array<AgentRuntimeEvent>()
    return runExecutor(
      completeScript(),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(
          claim,
          (event) =>
            Effect.sync(() => {
              activity.push(event)
            })
        )
      }),
      "@@ -43 +43 @@\n-const unsafe = false\n+const safe = true\n"
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.deepStrictEqual(result.suggestions, [])
          assert.isTrue(
            activity.some((event) =>
              event._tag === "output" &&
              event.channel === "progress" &&
              event.text.startsWith("Rejected unverifiable suggestion")
            )
          )
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("deduplicates validated suggestions by their host-derived identity", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    const activity = new Array<AgentRuntimeEvent>()
    return runExecutor(
      completeScript({
        schemaVersion: 2,
        completion: { status: "complete" },
        suggestions: [suggestion, suggestion]
      }),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(
          claim,
          (event) =>
            Effect.sync(() => {
              activity.push(event)
            })
        )
      })
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.strictEqual(result.suggestions.length, 1)
          assert.isTrue(
            activity.some((event) =>
              event._tag === "output" &&
              event.channel === "progress" &&
              event.text.startsWith("Dropped duplicate validated suggestion")
            )
          )
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("reads evidence from the immutable head and drops excerpt mismatches", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    return runExecutor(
      completeScript(),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(claim)
      }),
      undefined,
      "const modelPatchedThis = true"
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.deepStrictEqual(result.suggestions, [])
          assert.isTrue(
            observation.commands.some((command) => command.includes(`${HEAD_REVISION}:${EVIDENCE_PATH}`))
          )
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("rejects execution when the frozen profile differs from the live catalog", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    const mismatchedClaim: ClaimedAgentJob = {
      ...claim,
      context: {
        ...claim.context,
        task: {
          ...claim.context.task,
          reviewProfile: {
            ...REVIEW_PROFILE,
            budgetMillis: REVIEW_PROFILE.budgetMillis - 1
          }
        }
      }
    }
    return runExecutor(
      completeScript(),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(mismatchedClaim).pipe(Effect.result)
      })
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.isTrue(Result.isFailure(result))
          assert.deepStrictEqual(observation.requests, [])
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("rejects assistant output before unbounded accumulation", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    return runExecutor(
      completeScript({
        schemaVersion: 2,
        completion: { status: "complete" },
        suggestions: Array.from({ length: 80 }, () => suggestion)
      }),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(claim).pipe(Effect.result)
      })
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "AgentProviderError")
            if (result.failure._tag === "AgentProviderError") {
              assert.strictEqual(
                result.failure.message,
                "PR review provider output exceeded the structured result limit."
              )
            }
          }
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("accepts an inconclusive completion without inventing a model verdict", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    return runExecutor(
      completeScript({
        schemaVersion: 2,
        completion: {
          status: "unable-to-conclude",
          reason: "The project build dependency was unavailable."
        },
        suggestions: []
      }),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(claim)
      })
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          assert.deepStrictEqual(result.suggestions, [])
          assert.strictEqual(result.completion.status, "unable-to-conclude")
          assert.isFalse("outcome" in result)
          assert.isFalse("verdict" in result)
        })
      ),
      Effect.asVoid
    )
  })
})
