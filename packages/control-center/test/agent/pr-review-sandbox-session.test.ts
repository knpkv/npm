import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Sink, Stream, Tracer } from "effect"
import * as ConfigProvider from "effect/ConfigProvider"
import * as TestClock from "effect/testing/TestClock"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { AgentThreadId, JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { PrReviewSourceWorkspace } from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"
import { AgentAttemptSequence } from "../../src/server/persistence/repositories/agentJobModels.js"
import { reviewCommandArtifactTestLayer } from "./reviewCommandArtifactTestLayer.js"

const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000070")
const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
const FOREIGN_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000073")
const ATTEMPT_ID = "0123456789ab"
const BASE_REVISION = "1".repeat(40)
const HEAD_REVISION = "2".repeat(40)
const SOURCE_ROOT = "/private/review-source"
const compactUuid = (identifier: string): string => identifier.replaceAll("-", "")
const WORKSPACE_SANDBOX_PREFIX = `cc-pr-review-${compactUuid(WORKSPACE_ID)}-`
const SANDBOX_NAME = `${WORKSPACE_SANDBOX_PREFIX}${compactUuid(JOB_ID).slice(-4)}-${ATTEMPT_ID}`
const UNBOUNDED_SANDBOX_NAME = `cc-pr-review-${WORKSPACE_ID}-${JOB_ID}-${ATTEMPT_ID}`
const CODEX_API_KEY_CANARY = "codex-api-key-canary"
const ANTHROPIC_API_KEY_CANARY = "anthropic-api-key-canary"
const SOURCE_OUTPUT_CANARY = "source-output-canary-41a078c3"
const CREDENTIAL_OUTPUT_CANARY = "credential-output-canary-c20c9fb6"
const ARTIFACT_QUERY_CANARY = "artifact-query-canary-4de6a23b"
const encoder = new TextEncoder()

interface FakeResponse {
  readonly exitCode?: number
  readonly stderr?: string
  readonly stdout?: string
}

interface FakeResponseRule {
  readonly matches: (command: ChildProcess.StandardCommand) => boolean
  readonly response: FakeResponse
}

const makeHandle = (
  response: FakeResponse
): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.succeed(
      ChildProcessSpawner.ExitCode(response.exitCode ?? 0)
    ),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr: Stream.make(encoder.encode(response.stderr ?? "")),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(response.stdout ?? "")),
    unref: Effect.succeed(Effect.void)
  })

const fakeSbxLayer = (
  calls: Array<ChildProcess.StandardCommand>,
  responseRules: ReadonlyArray<FakeResponseRule> = [],
  listedSandboxes = SANDBOX_NAME
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((unknownCommand) => {
      assert.isTrue(ChildProcess.isStandardCommand(unknownCommand))
      if (!ChildProcess.isStandardCommand(unknownCommand)) {
        return Effect.die("expected a standard command")
      }
      calls.push(unknownCommand)
      assert.strictEqual(unknownCommand.command, "sbx")
      const args = unknownCommand.args
      const shellCommand = args.at(-1)
      const matched = responseRules.find(({ matches }) => matches(unknownCommand))
      const response = matched !== undefined
        ? matched.response
        : args[0] === "ls"
        ? { stdout: `${listedSandboxes}\n` }
        : args[0] === "exec" &&
            shellCommand?.startsWith("for remote in $(git remote)") !== true
        ? undefined
        : {}
      if (response === undefined) {
        return Effect.die(`unmatched fake sbx command: ${unknownCommand.args.join(" ")}`)
      }
      return Effect.succeed(makeHandle(response))
    })
  )

const sourceLayer = Layer.succeed(
  PrReviewSourceWorkspace,
  PrReviewSourceWorkspace.of({
    withSource: (_request, use) => use(SOURCE_ROOT)
  })
)

const testLayer = (
  calls: Array<ChildProcess.StandardCommand>,
  responseRules: ReadonlyArray<FakeResponseRule> = [],
  listedSandboxes = SANDBOX_NAME
) =>
  prReviewSandboxSessionsLayer({
    executable: "sbx",
    template: "review-template"
  }).pipe(
    Layer.provide(fakeSbxLayer(calls, responseRules, listedSandboxes)),
    Layer.provide(reviewCommandArtifactTestLayer()),
    Layer.provide(sourceLayer)
  )

const request = {
  workspaceId: WORKSPACE_ID,
  threadId: THREAD_ID,
  jobId: JOB_ID,
  attemptSequence: AgentAttemptSequence.make(1),
  repository: "control-center",
  attemptId: ATTEMPT_ID,
  baseRevision: BASE_REVISION,
  headRevision: HEAD_REVISION
}

describe("PrReviewSandboxSessions", () => {
  it("keeps the workspace-owned sandbox name within the sbx limit", () => {
    assert.isAbove(UNBOUNDED_SANDBOX_NAME.length, 63)
    assert.strictEqual(SANDBOX_NAME.length, 63)
  })

  it.effect("keeps native agent credentials out of typed-tool review sandboxes", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      yield* sessions.withSession(request, () => Effect.void)

      assert.isTrue(calls.length > 0)
      assert.isTrue(calls.every(({ args }) => !args.join("\0").includes("CODEX_API_KEY")))
      assert.isTrue(calls.every(({ args }) => !args.join("\0").includes("ANTHROPIC_API_KEY")))
      assert.isTrue(calls.every(({ args }) => !args.join("\0").includes(CODEX_API_KEY_CANARY)))
      assert.isTrue(calls.every(({ args }) => !args.join("\0").includes(ANTHROPIC_API_KEY_CANARY)))
      assert.isTrue(calls.every(({ options }) => !JSON.stringify(options.env ?? {}).includes(CODEX_API_KEY_CANARY)))
      assert.isTrue(calls.every(({ options }) => !JSON.stringify(options.env ?? {}).includes(ANTHROPIC_API_KEY_CANARY)))
      assert.isTrue(calls.every(({ options }) => options.env?.CODEX_API_KEY === undefined))
      assert.isTrue(calls.every(({ options }) => options.env?.ANTHROPIC_API_KEY === undefined))
    }).pipe(
      Effect.provide(testLayer(calls)),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_CANARY,
          CODEX_API_KEY: CODEX_API_KEY_CANARY,
          HOME: "/home/test",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        })
      )
    )
  })

  it.effect("runs native Codex review in the exact cloned sbx workspace", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const report = JSON.stringify({
      schemaVersion: 3,
      completion: { status: "complete" },
      suggestions: [],
      notes: []
    })
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const reviewed = yield* sessions.withSession(
        { ...request, reviewExecution: "native-codex" },
        (session) =>
          session.runNativeCodexReview === undefined
            ? Effect.die("native Codex review runner was not attached")
            : session.runNativeCodexReview({
              executable: "codex-wrapper",
              prompt: "Review the exact base and head.",
              outputSchema: "{\"type\":\"object\"}",
              maximumDurationMillis: 1_800_000
            })
      )

      assert.strictEqual(reviewed.exitCode, 0)
      assert.strictEqual(reviewed.stdout.text, report)
      const create = calls.find(({ args }) => args[0] === "run")
      assert.deepStrictEqual(create?.args, [
        "run",
        "codex",
        SOURCE_ROOT,
        "--clone",
        "--name",
        SANDBOX_NAME,
        "--detached"
      ])
      assert.isFalse(calls.some(({ args }) => args[0] === "policy"))
      const native = calls.find(({ args }) =>
        args[0] === "exec" &&
        args.includes("codex-wrapper") &&
        args.includes("--output-schema")
      )
      assert.include(native?.args ?? [], "--interactive")
      assert.include(native?.args ?? [], "--dangerously-bypass-approvals-and-sandbox")
      const ignoreRules = native?.args.indexOf("--ignore-rules") ?? -1
      assert.strictEqual(native?.args[ignoreRules + 1], "--ignore-user-config")
      assert.include(native?.args ?? [], "project_doc_max_bytes=0")
      assert.include(native?.args ?? [], "mcp_servers={}")
      assert.include(native?.args ?? [], "--output-schema")
      assert.include(native?.args ?? [], "--output-last-message")
      assert.notInclude(native?.args ?? [], "review")
      assert.notInclude(native?.args ?? [], "--base")
      assert.strictEqual(native?.args.at(-1), "-")
      assert.deepStrictEqual(
        native?.args.slice(
          (native?.args.indexOf("codex-wrapper") ?? -1) + 1,
          (native?.args.indexOf("codex-wrapper") ?? -1) + 2
        ),
        ["exec"]
      )
      assert.notInclude((native?.args ?? []).join("\0"), "CODEX_API_KEY")
      assert.notInclude((native?.args ?? []).join("\0"), CODEX_API_KEY_CANARY)
      assert.notInclude(native?.args ?? [], "AWS_SECRET_ACCESS_KEY")
      assert.strictEqual(native?.options.extendEnv, false)
      assert.notInclude(JSON.stringify(native?.options.env ?? {}), "CODEX_API_KEY")
      assert.notInclude(JSON.stringify(native?.options.env ?? {}), CODEX_API_KEY_CANARY)
      assert.notProperty(native?.options.env ?? {}, "AWS_SECRET_ACCESS_KEY")
      assert.isTrue(calls.every(({ options }) => options.env?.CODEX_API_KEY === undefined))
      assert.isTrue(
        calls.some(({ args }) => args.at(-1)?.includes("git branch --force 'control-center-review-base'") === true)
      )
    }).pipe(
      Effect.provide(testLayer(calls, [
        {
          matches: ({ args }) =>
            args.at(-1)?.startsWith("umask 077 && cat > '/tmp/control-center-review-schema.json'") === true,
          response: {}
        },
        {
          matches: ({ args }) =>
            args[0] === "exec" &&
            args.includes("codex-wrapper") &&
            args.includes("--output-schema"),
          response: {}
        },
        {
          matches: ({ args }) => args.at(-1)?.startsWith("test -s '/tmp/control-center-review-output.json'") === true,
          response: { stdout: report }
        }
      ])),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          AWS_SECRET_ACCESS_KEY: "must-not-cross-review-boundary",
          CODEX_API_KEY: CODEX_API_KEY_CANARY,
          HOME: "/home/test",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        })
      )
    )
  })

  it.effect("runs native Claude review and unwraps its validated structured output", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const report = {
      schemaVersion: 3,
      completion: { status: "complete" },
      suggestions: [],
      notes: []
    }
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const reviewed = yield* sessions.withSession(
        { ...request, reviewExecution: "native-claude" },
        (session) =>
          session.runNativeClaudeReview === undefined
            ? Effect.die("native Claude review runner was not attached")
            : session.runNativeClaudeReview({
              executable: "claude-wrapper",
              prompt: "Review the exact base and head.",
              outputSchema: "{\"type\":\"object\"}",
              maximumDurationMillis: 1_800_000
            })
      )

      assert.strictEqual(reviewed.exitCode, 0)
      assert.strictEqual(reviewed.stdout.text, JSON.stringify(report))
      const create = calls.find(({ args }) => args[0] === "run")
      assert.deepStrictEqual(create?.args, [
        "run",
        "claude",
        SOURCE_ROOT,
        "--clone",
        "--name",
        SANDBOX_NAME,
        "--detached"
      ])
      assert.isFalse(calls.some(({ args }) => args[0] === "policy"))
      const native = calls.find(({ args }) =>
        args[0] === "exec" &&
        args.includes("claude-wrapper") &&
        args.includes("--json-schema")
      )
      assert.include(native?.args ?? [], "--interactive")
      assert.include(native?.args ?? [], "--dangerously-skip-permissions")
      assert.include(native?.args ?? [], "--no-session-persistence")
      assert.include(native?.args ?? [], "--safe-mode")
      const settingSources = native?.args.indexOf("--setting-sources") ?? -1
      assert.strictEqual(native?.args[settingSources + 1], "")
      assert.include(native?.args ?? [], "--strict-mcp-config")
      assert.include(native?.args ?? [], "{\"mcpServers\":{}}")
      const tools = native?.args.indexOf("--tools") ?? -1
      assert.strictEqual(native?.args[tools + 1], "Bash,Glob,Grep,Read")
      assert.notInclude((native?.args ?? []).join("\0"), "ANTHROPIC_API_KEY")
      assert.notInclude((native?.args ?? []).join("\0"), ANTHROPIC_API_KEY_CANARY)
      assert.notInclude(native?.args ?? [], "AWS_SECRET_ACCESS_KEY")
      assert.notInclude(JSON.stringify(native?.options.env ?? {}), "ANTHROPIC_API_KEY")
      assert.notInclude(JSON.stringify(native?.options.env ?? {}), ANTHROPIC_API_KEY_CANARY)
      assert.notProperty(native?.options.env ?? {}, "AWS_SECRET_ACCESS_KEY")
      assert.isTrue(calls.every(({ options }) => options.env?.ANTHROPIC_API_KEY === undefined))
      assert.isTrue(
        calls.some(({ args }) => args.at(-1)?.includes("git branch --force 'control-center-review-base'") === true)
      )
    }).pipe(
      Effect.provide(testLayer(calls, [{
        matches: ({ args }) =>
          args[0] === "exec" &&
          args.includes("claude-wrapper") &&
          args.includes("--json-schema"),
        response: {
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            structured_output: report
          })
        }
      }])),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_CANARY,
          AWS_SECRET_ACCESS_KEY: "must-not-cross-review-boundary",
          HOME: "/home/test",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        })
      )
    )
  })

  it.effect("rejects a successful-looking Claude envelope without validated structured output", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const result = yield* sessions.withSession(
        { ...request, reviewExecution: "native-claude" },
        (session) =>
          session.runNativeClaudeReview === undefined
            ? Effect.die("native Claude review runner was not attached")
            : session.runNativeClaudeReview({
              executable: "claude-wrapper",
              prompt: "Review the exact base and head.",
              outputSchema: "{\"type\":\"object\"}",
              maximumDurationMillis: 120_000
            })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.reason, "output-rejected")
      }
    }).pipe(
      Effect.provide(testLayer(calls, [{
        matches: ({ args }) =>
          args[0] === "exec" &&
          args.includes("claude-wrapper") &&
          args.includes("--json-schema"),
        response: {
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "unvalidated free-form output"
          })
        }
      }])),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          HOME: "/home/test",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        })
      )
    )
  })

  it.effect("creates one cloned sbx sandbox, blocks its network, and exposes only contained commands", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const largeOutput = "🙂".repeat(10_000)
    const largeError = "e".repeat(40_000)
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const observed = yield* sessions.withSession(request, (session) =>
        Effect.gen(function*() {
          const listed = yield* session.listFiles(".")
          const tested = yield* session.runCommand("pnpm test")
          const large = yield* session.runCommand("emit-large")
          const read = yield* session.readFile("README.md", 4, 10)
          const page = yield* large.stdout.artifact === null
            ? Effect.die("expected retained output")
            : session.pageArtifact(large.stdout.artifact, 0, 8)
          const unsafe = yield* session.readFile("../secret").pipe(Effect.result)
          return { large, listed, page, read, tested, unsafe }
        }))

      assert.strictEqual(observed.listed.stdout.text, "packages\n")
      assert.strictEqual(observed.tested.stdout.text, "tests passed\n")
      assert.strictEqual(observed.read.stdout.text, "bounded\n")
      assert.isTrue(observed.large.stdout.truncated)
      assert.isTrue(observed.large.stderr.truncated)
      assert.strictEqual(encoder.encode(observed.large.stdout.text).byteLength, 32_768)
      assert.strictEqual(encoder.encode(observed.large.stderr.text).byteLength, 32_768)
      assert.deepStrictEqual(observed.page, {
        complete: false,
        nextOffset: 8,
        text: "🙂🙂"
      })
      assert.isTrue(Result.isFailure(observed.unsafe))
      if (Result.isFailure(observed.unsafe)) {
        assert.strictEqual(observed.unsafe.failure.reason, "invalid-request")
      }

      const create = calls.find(({ args }) => args[0] === "create")
      assert.deepStrictEqual(create?.args, [
        "create",
        "shell",
        SOURCE_ROOT,
        "--clone",
        "--name",
        SANDBOX_NAME,
        "--quiet",
        "--template",
        "review-template"
      ])
      const policy = calls.find(({ args }) => args[0] === "policy")
      assert.deepStrictEqual(policy?.args, [
        "policy",
        "deny",
        "network",
        "--sandbox",
        SANDBOX_NAME,
        "**"
      ])
      const contained = calls.filter(({ args }) => args[0] === "exec")
      assert.isAtLeast(contained.length, 4)
      for (const command of contained) {
        assert.include(command.args, "--workdir")
        assert.include(command.args, SOURCE_ROOT)
        assert.include(command.args, "env")
        assert.include(command.args, "-i")
      }
      assert.isFalse(calls.some(({ command }) => command === "docker"))
      assert.isTrue(
        calls.some(({ args }) => args.at(-1) === "test -f 'README.md' && tail -c +5 -- 'README.md' | head -c 10")
      )
      assert.isTrue(calls.some(({ args }) => args[0] === "rm" && args[1] === "--force" && args[2] === SANDBOX_NAME))
    }).pipe(
      Effect.provide(testLayer(calls, [
        {
          matches: ({ args }) => args.at(-1) === "find '.' -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort",
          response: { stdout: "packages\n" }
        },
        {
          matches: ({ args }) => args.at(-1) === "pnpm test",
          response: { stdout: "tests passed\n" }
        },
        {
          matches: ({ args }) => args.at(-1) === "emit-large",
          response: { stderr: largeError, stdout: largeOutput }
        },
        {
          matches: ({ args }) => args.at(-1) === "test -f 'README.md' && tail -c +5 -- 'README.md' | head -c 10",
          response: { stdout: "bounded\n" }
        }
      ]))
    )
  })

  it.effect("keeps raw command and artifact content out of enclosing spans", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const spans = new Array<Tracer.NativeSpan>()
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const sensitiveOutput = `${SOURCE_OUTPUT_CANARY}\n${"x".repeat(40_000)}\n${CREDENTIAL_OUTPUT_CANARY}`
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const observed = yield* sessions.withSession(request, (session) =>
        Effect.gen(function*() {
          const command = yield* session.runCommand("emit-sensitive")
          if (command.stdout.artifact === null) {
            return yield* Effect.die("expected retained sensitive output")
          }
          const page = yield* session.pageArtifact(command.stdout.artifact, 0, 128)
          const matches = yield* session.searchArtifact(
            command.stdout.artifact,
            ARTIFACT_QUERY_CANARY
          )
          return { command, matches, page }
        }))
      assert.isTrue(observed.command.stdout.truncated)
      assert.include(observed.page.text, SOURCE_OUTPUT_CANARY)

      const telemetry = JSON.stringify(
        spans.map((span) => ({
          attributes: Array.from(span.attributes),
          events: span.events,
          name: span.name,
          status: span.status
        })),
        (_key, value) => typeof value === "bigint" ? value.toString() : value
      )
      for (
        const canary of [
          SOURCE_OUTPUT_CANARY,
          CREDENTIAL_OUTPUT_CANARY,
          ARTIFACT_QUERY_CANARY
        ]
      ) {
        assert.notInclude(telemetry, canary)
      }
    }).pipe(
      Effect.provide(testLayer(calls, [{
        matches: ({ args }) => args.at(-1) === "emit-sensitive",
        response: { stdout: sensitiveOutput }
      }])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          HOME: "/home/test",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        })
      )
    )
  })

  it.effect("reads an exact durable artifact handle after worker-attempt recovery", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const largeOutput = "a".repeat(32_768) + "🙂recovered"
    return Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(
        DateTime.makeUnsafe("2026-07-31T10:00:00.000Z")
      ))
      const sessions = yield* PrReviewSandboxSessions
      yield* sessions.withSession(request, (session) =>
        session.runCommand("emit-recoverable").pipe(
          Effect.filterOrFail(
            ({ stdout }) => stdout.artifact !== null,
            () => new Error("expected retained output")
          ),
          Effect.asVoid
        ))
      const recoveredRequest = {
        ...request,
        attemptId: "abcdef012345",
        attemptSequence: AgentAttemptSequence.make(2)
      }
      yield* TestClock.setTime(DateTime.toEpochMillis(
        DateTime.makeUnsafe("2026-08-07T09:59:59.999Z")
      ))
      const recovered = yield* sessions.withSession(recoveredRequest, (session) =>
        Effect.gen(function*() {
          const listed = yield* session.listArtifacts()
          const metadata = listed[0]
          if (metadata === undefined) return yield* Effect.die("expected discoverable artifact")
          const artifact = {
            artifactId: metadata.artifactId,
            attemptSequence: metadata.attemptSequence,
            commandSequence: metadata.commandSequence,
            stream: metadata.stream
          }
          const page = yield* session.pageArtifact(artifact, 32_768, 13)
          const undersizedUnicodePage = yield* session.pageArtifact(
            artifact,
            32_768,
            1
          ).pipe(Effect.result)
          const continuationOffset = yield* session.pageArtifact(
            artifact,
            32_769,
            4
          ).pipe(Effect.result)
          const mismatchedCommand = yield* session.pageArtifact(
            { ...artifact, commandSequence: artifact.commandSequence + 1 },
            0,
            8
          ).pipe(Effect.result)
          yield* TestClock.setTime(DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-08-07T10:00:00.000Z")
          ))
          const expiredList = yield* session.listArtifacts()
          const expiredPage = yield* session.pageArtifact(artifact, 0, 4).pipe(Effect.result)
          const expiredSearch = yield* session.searchArtifact(artifact, "recovered").pipe(Effect.result)
          return {
            continuationOffset,
            expiredList,
            expiredPage,
            expiredSearch,
            mismatchedCommand,
            page,
            undersizedUnicodePage
          }
        }))

      assert.deepStrictEqual(recovered.page, {
        complete: true,
        nextOffset: 32_781,
        text: "🙂recovered"
      })
      assert.isTrue(Result.isFailure(recovered.undersizedUnicodePage))
      assert.isTrue(Result.isFailure(recovered.continuationOffset))
      assert.isTrue(Result.isFailure(recovered.mismatchedCommand))
      assert.deepStrictEqual(recovered.expiredList, [])
      assert.isTrue(Result.isFailure(recovered.expiredPage))
      assert.isTrue(Result.isFailure(recovered.expiredSearch))
    }).pipe(
      Effect.provide(testLayer(calls, [{
        matches: ({ args }) => args.at(-1) === "emit-recoverable",
        response: { stdout: largeOutput }
      }]))
    )
  })

  it.effect("reconciles only stale review sandboxes owned by the requested workspace", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const ownedA = `${WORKSPACE_SANDBOX_PREFIX}a`
    const ownedB = `${WORKSPACE_SANDBOX_PREFIX}b`
    const foreign = `cc-pr-review-${compactUuid(FOREIGN_WORKSPACE_ID)}-a`
    const legacy = "cc-pr-review-legacy"
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const reconciliation = yield* sessions.reconcile(WORKSPACE_ID)
      assert.deepStrictEqual(reconciliation.removedSandboxes, [
        ownedA,
        ownedB
      ])
      assert.deepStrictEqual(
        calls.filter(({ args }) => args[0] === "rm").map(({ args }) => args.at(-1)),
        [ownedA, ownedB]
      )
      assert.strictEqual(calls.filter(({ args }) => args[0] === "ls").length, 1)
    }).pipe(
      Effect.provide(testLayer(
        calls,
        [],
        `unrelated\n${foreign}\n${ownedB}\n${legacy}\n${ownedA}`
      ))
    )
  })

  it.effect("assigns distinct retained-artifact identities to overlapping commands", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const largeOutput = "x".repeat(40_000)
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const outputs = yield* sessions.withSession(
        request,
        (session) =>
          Effect.all(
            [session.runCommand("emit-large-a"), session.runCommand("emit-large-b")],
            { concurrency: "unbounded" }
          )
      )
      const artifactIds = outputs.map(({ stdout }) => stdout.artifact?.artifactId)
      assert.isTrue(artifactIds.every((artifactId) => artifactId !== undefined))
      assert.strictEqual(new Set(artifactIds).size, 2)
    }).pipe(
      Effect.provide(testLayer(calls, [
        {
          matches: ({ args }) => args.at(-1) === "emit-large-a",
          response: { stdout: largeOutput }
        },
        {
          matches: ({ args }) => args.at(-1) === "emit-large-b",
          response: { stdout: largeOutput }
        }
      ]))
    )
  })

  it.effect("force-removes a partially created sandbox when sbx create fails", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const failed = yield* sessions.withSession(request, () => Effect.void).pipe(Effect.result)
      assert.isTrue(Result.isFailure(failed))
      assert.isTrue(
        calls.some(({ args }) =>
          args[0] === "rm" &&
          args[1] === "--force" &&
          args[2] === SANDBOX_NAME
        )
      )
    }).pipe(
      Effect.provide(testLayer(calls, [{
        matches: ({ args }) => args[0] === "create",
        response: { exitCode: 1 }
      }]))
    )
  })
})
