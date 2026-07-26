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
import { Config, Effect, FileSystem, Layer, Path, Result, Schema, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

import {
  AgentModelId,
  DurableAgentProviderId,
  type ReviewAgentProfile,
  ReviewAgentProfileId
} from "../../src/api/agent.js"
import { AgentThreadId, JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  MAXIMUM_PR_REVIEW_REPORT_BYTES,
  PrReviewPath,
  type PrReviewSubject,
  PrReviewSuggestionDraft
} from "../../src/domain/prReview.js"
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
  title: "Reject unsafe review configuration",
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
  anchor: {
    _tag: "line",
    path: EVIDENCE_PATH,
    line: 42
  },
  relatedLocations: [],
  confidence: {
    level: "high",
    reason: "The exact added line enables the unsafe state."
  },
  prevention: {
    summary: "Exercise the configuration boundary.",
    enforcement: "test",
    existingRuleOrConfig: "PR review task executor suite",
    recurrenceEvidence: "The configuration boundary is shared by every provider-backed review run.",
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

const completeScript = (
  report: unknown = {
    schemaVersion: 3,
    completion: { status: "complete" },
    suggestions: [suggestion],
    notes: []
  },
  reviewSubject: PrReviewSubject = subject
): DeterministicLanguageModelScript => [
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
      params: { command: `git show ${reviewSubject.baseRevision}:AGENTS.md` },
      type: "tool-call"
    })
  },
  {
    _tag: "response",
    parts: response({
      id: "inspect-diff",
      name: "ReviewRunCommand",
      params: {
        command: `git diff --stat ${reviewSubject.baseRevision} ${reviewSubject.headRevision}`
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

const runShellCommand = (
  cwd: string,
  command: string
): Effect.Effect<PrReviewSandboxCommandResult, never> =>
  Effect.scoped(
    Effect.gen(function*() {
      const executablePath = yield* Config.string("PATH")
      const handle = yield* ChildProcess.make("sh", ["-c", command], {
        cwd,
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          PATH: executablePath
        },
        extendEnv: false,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe"
      })
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode,
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
      ], { concurrency: "unbounded" })
      return {
        exitCode: Number(exitCode),
        stderr: {
          artifactId: null,
          byteLength: new TextEncoder().encode(stderr).byteLength,
          text: stderr,
          truncated: false
        },
        stdout: {
          artifactId: null,
          byteLength: new TextEncoder().encode(stdout).byteLength,
          text: stdout,
          truncated: false
        }
      }
    })
  ).pipe(
    Effect.orDie,
    Effect.provide(NodeServices.layer)
  )

interface SessionObservation {
  readonly commands: Array<string>
  readonly operations: Array<string>
  readonly requests: Array<unknown>
}

const makeRealGitSessionLayer = (
  observation: SessionObservation,
  cwd: string,
  baseRevision: string,
  headRevision: string
) => {
  const session: PrReviewSandboxSession = {
    attemptId: "0123456789ab",
    baseRevision,
    headRevision,
    jobId: JOB_ID,
    listFiles: () => Effect.succeed(output("AGENTS.md\npackages\n")),
    readFile: () => Effect.succeed(output("# Review instructions\n")),
    searchFiles: () => Effect.succeed(output()),
    runCommand: (command) =>
      Effect.sync(() => {
        observation.operations.push("runCommand")
        observation.commands.push(command)
      }).pipe(Effect.andThen(runShellCommand(cwd, command))),
    applyPatch: () => Effect.succeed(output()),
    readDiff: () => runShellCommand(cwd, `git diff '${baseRevision}' '${headRevision}'`),
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
        if (command.includes("git apply --check")) {
          return command.includes("GIT_INDEX_FILE=") &&
              command.includes(`git read-tree '${HEAD_REVISION}'`) &&
              command.includes("printf '%s\\n' ") &&
              command.includes("git apply --check --cached")
            ? output()
            : output("", 1)
        }
        if (command.includes("| awk 'END { exit NR ==")) {
          return command.includes("missing.ts") ? output("", 1) : output()
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
  sourceExcerpt?: string,
  sessionLayer?: Layer.Layer<PrReviewSandboxSessions>
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
          Layer.provide(sessionLayer ?? makeSessionLayer(observation, diff, sourceExcerpt))
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
  it.effect("reserves durable report space for host-authored metadata", () => {
    const note = (index: number) => ({
      reason: "low-confidence",
      title: `Bounded observation ${String(index)}`,
      observation: `${"x".repeat(64)}-${String(index)}`,
      confidence: {
        level: "low",
        reason: "The provider could not verify this observation."
      }
    })
    const projectedBytes = (notes: ReadonlyArray<ReturnType<typeof note>>) =>
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 3,
        subject,
        completion: { status: "complete" },
        suggestions: [],
        notes: notes.map((item) => ({
          ...item,
          noteId: `sha256:${"f".repeat(64)}`
        }))
      })).byteLength
    const notes = new Array<ReturnType<typeof note>>()
    while (projectedBytes([...notes, note(notes.length)]) <= MAXIMUM_PR_REVIEW_REPORT_BYTES) {
      notes.push(note(notes.length))
    }
    const oversizedNotes = [...notes, note(notes.length)]
    assert.isAtMost(
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 3,
        completion: { status: "complete" },
        suggestions: [],
        notes: oversizedNotes
      })).byteLength,
      MAXIMUM_PR_REVIEW_REPORT_BYTES
    )
    const execute = (candidateNotes: ReadonlyArray<ReturnType<typeof note>>) => {
      const observation: SessionObservation = {
        commands: [],
        operations: [],
        requests: []
      }
      return runExecutor(
        completeScript({
          schemaVersion: 3,
          completion: { status: "complete" },
          suggestions: [],
          notes: candidateNotes
        }),
        observation,
        Effect.gen(function*() {
          const executor = yield* PrReviewTaskExecutor
          return yield* executor.execute(claim)
        })
      )
    }

    return Effect.gen(function*() {
      const accepted = yield* execute(notes)
      assert.strictEqual(accepted.result.notes.length, notes.length)
      const rejected = yield* execute(oversizedNotes).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.include(rejected.failure.message, "insufficient room for host metadata")
      }
    })
  })

  it.effect("resolves file anchors and derives identities for non-publishable notes", () => {
    const observation: SessionObservation = {
      commands: [],
      operations: [],
      requests: []
    }
    return runExecutor(
      completeScript({
        schemaVersion: 3,
        completion: { status: "complete" },
        suggestions: [{
          ...suggestion,
          anchor: {
            _tag: "file",
            path: EVIDENCE_PATH
          },
          relatedLocations: [{
            path: "packages/control-center/test/fixture.ts",
            startLine: 8,
            endLine: 8,
            label: "Same root cause"
          }, {
            path: "missing.ts",
            startLine: 999,
            endLine: 999,
            label: "Invented occurrence"
          }],
          replacement: {
            reviewedHead: HEAD_REVISION,
            unifiedDiff: [
              `--- a/${EVIDENCE_PATH}`,
              `+++ b/${EVIDENCE_PATH}`,
              "@@ -42,1 +42,1 @@",
              `-${EVIDENCE_EXCERPT}`,
              "+const unsafe = false"
            ].join("\n"),
            explanation: "Use the validated value."
          }
        }],
        notes: [{
          reason: "low-confidence",
          title: "Provider retry behavior needs reproduction",
          observation: "The sandbox cannot reproduce the external provider response.",
          confidence: {
            level: "low",
            reason: "Only a local control-flow path is available."
          },
          location: {
            path: EVIDENCE_PATH,
            startLine: 42,
            endLine: 42
          }
        }]
      }),
      observation,
      Effect.gen(function*() {
        return yield* (yield* PrReviewTaskExecutor).execute(claim)
      })
    ).pipe(
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          const anchor = result.suggestions[0]?.anchor
          assert.strictEqual(anchor?._tag, "file")
          if (anchor?._tag === "file") {
            assert.strictEqual(String(anchor.path), EVIDENCE_PATH)
            assert.strictEqual(anchor.line, 42)
          }
          assert.strictEqual(result.suggestions[0]?.state, "draft")
          assert.strictEqual(result.suggestions[0]?.relatedLocations.length, 1)
          assert.strictEqual(result.suggestions[0]?.replacement?.reviewedHead, HEAD_REVISION)
          assert.isTrue(
            observation.commands.some((command) =>
              command.includes(`git read-tree '${HEAD_REVISION}'`) &&
              command.includes("printf '%s\\n' ") &&
              command.includes("git apply --check --cached")
            )
          )
          assert.match(result.notes[0]?.noteId ?? "", /^sha256:[0-9a-f]{64}$/u)
          assert.strictEqual(result.notes[0]?.reason, "low-confidence")
        })
      ),
      Effect.asVoid
    )
  })

  it.effect("checks trimmed replacement patches against the immutable head with real Git", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-replacement-" })
      const sourcePath = path.join(root, EVIDENCE_PATH)
      const deletedPath = path.join(root, "packages/control-center/src/deleted.ts")
      yield* fileSystem.makeDirectory(path.dirname(sourcePath), { recursive: true })
      yield* fileSystem.writeFileString(path.join(root, "AGENTS.md"), "# Review instructions\n")
      yield* fileSystem.writeFileString(deletedPath, "const obsolete = true\n")
      const source = (unsafe: string) =>
        `${Array.from({ length: 41 }, (_, index) => `// line ${String(index + 1)}`).join("\n")}\n` +
        `const unsafe = ${unsafe}\n`
      yield* fileSystem.writeFileString(sourcePath, source("false"))

      const initialize = yield* runShellCommand(
        root,
        "git init --quiet && git add -- AGENTS.md packages/control-center/src/review.ts " +
          "packages/control-center/src/deleted.ts && " +
          "git -c user.name=Review -c user.email=review@example.invalid commit --quiet -m base"
      )
      assert.strictEqual(initialize.exitCode, 0, initialize.stderr.text)
      const topLevel = yield* runShellCommand(root, "git rev-parse --show-toplevel")
      assert.strictEqual(topLevel.exitCode, 0, topLevel.stderr.text)
      const resolvedRoot = yield* fileSystem.realPath(root)
      assert.strictEqual(topLevel.stdout.text.trim(), resolvedRoot)
      const base = yield* runShellCommand(root, "git rev-parse HEAD")
      assert.strictEqual(base.exitCode, 0, base.stderr.text)
      const baseRevision = base.stdout.text.trim()

      yield* fileSystem.writeFileString(sourcePath, source("true"))
      yield* fileSystem.remove(deletedPath)
      const unterminatedPath = path.join(root, "packages/control-center/src/unterminated.ts")
      yield* fileSystem.writeFileString(unterminatedPath, "const finalLine = true")
      const commitHead = yield* runShellCommand(
        root,
        "git add --all -- packages/control-center/src/review.ts packages/control-center/src/unterminated.ts " +
          "packages/control-center/src/deleted.ts && " +
          "git -c user.name=Review -c user.email=review@example.invalid commit --quiet -m head"
      )
      assert.strictEqual(commitHead.exitCode, 0, commitHead.stderr.text)
      const head = yield* runShellCommand(root, "git rev-parse HEAD")
      assert.strictEqual(head.exitCode, 0, head.stderr.text)
      const headRevision = head.stdout.text.trim()

      yield* fileSystem.writeFileString(sourcePath, source("mutated"))
      const reviewSubject = { ...subject, baseRevision, headRevision }
      const actualClaim = {
        ...claim,
        context: {
          ...claim.context,
          subjectRevision: headRevision,
          task: {
            ...claim.context.task,
            subject: reviewSubject
          }
        }
      } satisfies ClaimedAgentJob
      const observation: SessionObservation = {
        commands: [],
        operations: [],
        requests: []
      }
      const sessionLayer = makeRealGitSessionLayer(
        observation,
        root,
        baseRevision,
        headRevision
      )
      const replacement = {
        reviewedHead: headRevision,
        unifiedDiff: [
          `--- a/${EVIDENCE_PATH}`,
          `+++ b/${EVIDENCE_PATH}`,
          "@@ -42,1 +42,1 @@",
          `-${EVIDENCE_EXCERPT}`,
          "+const unsafe = false"
        ].join("\n"),
        explanation: "Use the validated value."
      }
      const execute = (draft: unknown) =>
        runExecutor(
          completeScript({
            schemaVersion: 3,
            completion: { status: "complete" },
            suggestions: [draft],
            notes: []
          }, reviewSubject),
          observation,
          Effect.gen(function*() {
            return yield* (yield* PrReviewTaskExecutor).execute(actualClaim)
          }),
          undefined,
          undefined,
          sessionLayer
        )

      const valid = yield* execute({ ...suggestion, replacement })
      assert.strictEqual(valid.result.suggestions.length, 1)
      assert.strictEqual(valid.result.suggestions[0]?.replacement?.reviewedHead, headRevision)
      assert.isFalse(
        observation.commands.some((command) => command.includes("--recount"))
      )

      const malformed = yield* execute({
        ...suggestion,
        replacement: {
          ...replacement,
          unifiedDiff: [
            `--- a/${EVIDENCE_PATH}`,
            `+++ b/${EVIDENCE_PATH}`,
            "@@ -42,1 +42,1 @@",
            `-${EVIDENCE_EXCERPT}`,
            "not-a-unified-diff-record"
          ].join("\n")
        }
      })
      assert.deepStrictEqual(malformed.result.suggestions, [])

      const inaccurateHunkCount = yield* execute({
        ...suggestion,
        replacement: {
          ...replacement,
          unifiedDiff: [
            `--- a/${EVIDENCE_PATH}`,
            `+++ b/${EVIDENCE_PATH}`,
            "@@ -42,1 +42,1 @@",
            ` ${EVIDENCE_EXCERPT}`,
            "+const omittedByTheDeclaredCount = true"
          ].join("\n")
        }
      })
      assert.deepStrictEqual(inaccurateHunkCount.result.suggestions, [])

      const withoutReplacement = yield* execute(suggestion)
      assert.strictEqual(withoutReplacement.result.suggestions.length, 1)
      assert.include(yield* fileSystem.readFileString(sourcePath), "const unsafe = mutated")

      const relatedAtUnterminatedEof = yield* execute({
        ...suggestion,
        relatedLocations: [{
          path: PrReviewPath.make("packages/control-center/src/unterminated.ts"),
          startLine: 1,
          endLine: 1,
          label: "Unterminated final line"
        }, {
          path: PrReviewPath.make("packages/control-center/src/unterminated.ts"),
          startLine: 2,
          endLine: 2,
          label: "Past end of file"
        }]
      })
      assert.deepStrictEqual(
        relatedAtUnterminatedEof.result.suggestions[0]?.relatedLocations,
        [{
          path: PrReviewPath.make("packages/control-center/src/unterminated.ts"),
          startLine: 1,
          endLine: 1,
          label: "Unterminated final line"
        }]
      )

      const deletionOnlyFile = yield* execute({
        ...suggestion,
        anchor: {
          _tag: "file",
          path: PrReviewPath.make("packages/control-center/src/deleted.ts")
        },
        evidence: {
          path: PrReviewPath.make("packages/control-center/src/deleted.ts"),
          startLine: 1,
          endLine: 1,
          excerpt: "const obsolete = true"
        }
      })
      assert.deepStrictEqual(deletionOnlyFile.result.suggestions[0]?.anchor, {
        _tag: "file",
        path: PrReviewPath.make("packages/control-center/src/deleted.ts"),
        line: 1
      })
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

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
          assert.strictEqual(result.schemaVersion, 3)
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
    const relatedLocations = [{
      path: "packages/control-center/test/a.ts",
      startLine: 8,
      endLine: 8,
      label: "First occurrence"
    }, {
      path: "packages/control-center/test/b.ts",
      startLine: 12,
      endLine: 14,
      label: "Second occurrence"
    }]
    return runExecutor(
      completeScript({
        schemaVersion: 3,
        completion: { status: "complete" },
        suggestions: [
          { ...suggestion, relatedLocations },
          {
            ...suggestion,
            relatedLocations: [...relatedLocations].reverse(),
            confidence: {
              ...suggestion.confidence,
              reason: "A second model pass reached the same finding independently."
            }
          }
        ],
        notes: []
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
        schemaVersion: 3,
        completion: { status: "complete" },
        suggestions: Array.from({ length: 80 }, () => suggestion),
        notes: []
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
        schemaVersion: 3,
        completion: {
          status: "unable-to-conclude",
          reason: "The project build dependency was unavailable."
        },
        suggestions: [],
        notes: []
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
