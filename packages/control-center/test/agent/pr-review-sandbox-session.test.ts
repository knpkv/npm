import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { PrReviewSourceWorkspace } from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"

const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
const ATTEMPT_ID = "0123456789ab"
const BASE_REVISION = "1".repeat(40)
const HEAD_REVISION = "2".repeat(40)
const SOURCE_ROOT = "/private/review-source"
const SANDBOX_NAME = `cc-pr-review-${JOB_ID}-${ATTEMPT_ID}`
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
    Layer.provide(sourceLayer)
  )

const request = {
  workspaceId: WORKSPACE_ID,
  jobId: JOB_ID,
  repository: "control-center",
  attemptId: ATTEMPT_ID,
  baseRevision: BASE_REVISION,
  headRevision: HEAD_REVISION
}

describe("PrReviewSandboxSessions", () => {
  it.effect("creates one cloned sbx sandbox, blocks its network, and exposes only contained commands", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const largeOutput = "🙂".repeat(10_000)
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const observed = yield* sessions.withSession(request, (session) =>
        Effect.gen(function*() {
          const listed = yield* session.listFiles(".")
          const tested = yield* session.runCommand("pnpm test")
          const large = yield* session.runCommand("emit-large")
          const read = yield* session.readFile("README.md", 4, 10)
          const page = yield* large.stdout.artifactId === null
            ? Effect.die("expected retained output")
            : session.pageArtifact(large.stdout.artifactId, 0, 8)
          const unsafe = yield* session.readFile("../secret").pipe(Effect.result)
          return { large, listed, page, read, tested, unsafe }
        }))

      assert.strictEqual(observed.listed.stdout.text, "packages\n")
      assert.strictEqual(observed.tested.stdout.text, "tests passed\n")
      assert.strictEqual(observed.read.stdout.text, "bounded\n")
      assert.isTrue(observed.large.stdout.truncated)
      assert.strictEqual(observed.page, "🙂🙂🙂🙂")
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
          response: { stdout: largeOutput }
        },
        {
          matches: ({ args }) => args.at(-1) === "test -f 'README.md' && tail -c +5 -- 'README.md' | head -c 10",
          response: { stdout: "bounded\n" }
        }
      ]))
    )
  })

  it.effect("reconciles only stale Control Center review sandboxes", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const reconciliation = yield* sessions.reconcile()
      assert.deepStrictEqual(reconciliation.removedSandboxes, [
        "cc-pr-review-a",
        "cc-pr-review-b"
      ])
      assert.deepStrictEqual(
        calls.filter(({ args }) => args[0] === "rm").map(({ args }) => args.at(-1)),
        ["cc-pr-review-a", "cc-pr-review-b"]
      )
      assert.strictEqual(calls.filter(({ args }) => args[0] === "ls").length, 1)
    }).pipe(
      Effect.provide(testLayer(
        calls,
        [],
        "unrelated\ncc-pr-review-b\ncc-pr-review-a"
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
      const artifactIds = outputs.map(({ stdout }) => stdout.artifactId)
      assert.isTrue(artifactIds.every((artifactId) => artifactId !== null))
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
