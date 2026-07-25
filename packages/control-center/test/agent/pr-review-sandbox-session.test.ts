import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Result, Schema, Sink, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  PrReviewCommandArtifactId,
  PrReviewSandboxSessionError,
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { PrReviewSourceWorkspace } from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"

const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
const ATTEMPT_ID = "0123456789ab"
const ORPHAN_ATTEMPT_ID = "fedcba987654"
const STOPPED_ATTEMPT_ID = "abcdefabcdef"
const BASE_REVISION = "1".repeat(40)
const HEAD_REVISION = "2".repeat(40)
const IMAGE = `registry.example.invalid/control-center/review-runner@sha256:${"a".repeat(64)}`
const CONTAINER_NAME = `cc-pr-review-session-${JOB_ID}-${ATTEMPT_ID}`
const INITIALIZER_NAME = `cc-pr-review-init-${JOB_ID}-${ATTEMPT_ID}`
const VOLUME_NAME = `cc-pr-review-${JOB_ID}-${ATTEMPT_ID}`
const ORPHAN_INITIALIZER_NAME = `cc-pr-review-init-${JOB_ID}-${ORPHAN_ATTEMPT_ID}`
const ORPHAN_VOLUME_NAME = `cc-pr-review-${JOB_ID}-${ORPHAN_ATTEMPT_ID}`
const STOPPED_CONTAINER_NAME = `cc-pr-review-session-${JOB_ID}-${STOPPED_ATTEMPT_ID}`
const STOPPED_VOLUME_NAME = `cc-pr-review-${JOB_ID}-${STOPPED_ATTEMPT_ID}`
const encoder = new TextEncoder()

interface FakeResponse {
  readonly exitCode?: number
  readonly hanging?: boolean
  readonly started?: Deferred.Deferred<void>
  readonly stderr?: string
  readonly stdout?: string
  readonly stdoutBytes?: Uint8Array
}

interface FakeDockerOptions {
  readonly cleanupFailure?: {
    readonly resourceName: string
    readonly stderr: string
  }
  readonly commandResponses?: Array<FakeResponse>
  readonly failCopy?: boolean
  readonly hangingCopy?: Deferred.Deferred<void>
  readonly hangingCommand?: {
    readonly command: string
    readonly started: Deferred.Deferred<void>
  }
  readonly reconcileContainerOutput?: string
  readonly reconcileVolumeOutput?: string
}

const makeHandle = (
  response: FakeResponse
): ChildProcessSpawner.ChildProcessHandle => {
  const stdout = response.hanging === true
    ? Stream.never
    : Stream.make(
      response.stdoutBytes ?? encoder.encode(response.stdout ?? "")
    )
  const stderr = response.hanging === true
    ? Stream.never
    : Stream.make(encoder.encode(response.stderr ?? ""))
  return ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: response.hanging === true
      ? Effect.never
      : Effect.succeed(
        ChildProcessSpawner.ExitCode(response.exitCode ?? 0)
      ),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(response.hanging === true),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void)
  })
}

const fakeDockerLayer = (
  calls: Array<ChildProcess.StandardCommand>,
  options: FakeDockerOptions = {}
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
  const commandResponses = [...(options.commandResponses ?? [])]
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((unknownCommand) => {
      assert.isTrue(ChildProcess.isStandardCommand(unknownCommand))
      if (!ChildProcess.isStandardCommand(unknownCommand)) {
        return Effect.die("expected a standard command")
      }
      calls.push(unknownCommand)
      const args = unknownCommand.args
      const shellCommand = args.at(-1)
      const hangingCommand = options.hangingCommand
      const cleanupFailure = options.cleanupFailure
      let response: FakeResponse
      if (args[0] === "container" && args[1] === "ls") {
        response = { stdout: options.reconcileContainerOutput ?? "" }
      } else if (args[0] === "volume" && args[1] === "ls") {
        response = { stdout: options.reconcileVolumeOutput ?? "" }
      } else if (
        (args[1] === "rm") &&
        cleanupFailure !== undefined &&
        args.at(-1) === cleanupFailure.resourceName
      ) {
        response = {
          exitCode: 1,
          stderr: cleanupFailure.stderr
        }
      } else if (
        args[0] === "container" &&
        args[1] === "cp" &&
        options.hangingCopy !== undefined
      ) {
        response = {
          hanging: true,
          started: options.hangingCopy
        }
      } else if (
        args[0] === "container" &&
        args[1] === "cp" &&
        options.failCopy === true
      ) {
        response = { exitCode: 1, stderr: "copy failed\n" }
      } else if (
        args[0] === "container" &&
        args[1] === "exec" &&
        args[2]?.startsWith("cc-pr-review-init-") === true
      ) {
        response = {}
      } else if (
        args[0] === "container" &&
        args[1] === "exec" &&
        shellCommand?.startsWith("test \"$(git rev-parse") === true
      ) {
        response = {}
      } else if (
        args[0] === "container" &&
        args[1] === "exec" &&
        hangingCommand !== undefined &&
        hangingCommand.command === shellCommand
      ) {
        response = {
          hanging: true,
          started: hangingCommand.started
        }
      } else if (args[0] === "container" && args[1] === "exec") {
        response = commandResponses.shift() ?? {}
      } else {
        response = {}
      }
      const announce = response.started === undefined
        ? Effect.void
        : Deferred.succeed(response.started, undefined)
      return announce.pipe(Effect.as(makeHandle(response)))
    })
  )
}

const sourceLayer = (sourceRoot: string) =>
  Layer.succeed(
    PrReviewSourceWorkspace,
    PrReviewSourceWorkspace.of({
      withSource: (_request, use) => use(sourceRoot)
    })
  )

const sessionsLayer = (
  sourceRoot: string,
  calls: Array<ChildProcess.StandardCommand>,
  docker: FakeDockerOptions = {},
  maximumCommandDurationMillis?: number
) =>
  prReviewSandboxSessionsLayer({
    image: IMAGE,
    ...(maximumCommandDurationMillis === undefined
      ? {}
      : { maximumCommandDurationMillis })
  }).pipe(
    Layer.provide(fakeDockerLayer(calls, docker)),
    Layer.provide(sourceLayer(sourceRoot)),
    Layer.provide(NodeFileSystem.layer)
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
  it.effect("uses a credential-free named volume and exposes writable review operations", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-source-"
        })
        yield* fileSystem.makeDirectory(`${sourceRoot}/.git`)
        yield* fileSystem.writeFileString(
          `${sourceRoot}/.git/config`,
          "[core]\n\trepositoryformatversion = 0\n"
        )
        yield* fileSystem.writeFileString(
          `${sourceRoot}/review.ts`,
          "export const value = 2\n"
        )
        const largeOutput = "\"🙂".repeat(20_000)
        const calls: Array<ChildProcess.StandardCommand> = []
        const observed = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, (session) =>
            Effect.gen(function*() {
              const read = yield* session.readFile("review.ts", 0, 128)
              const listed = yield* session.listFiles(".")
              const unsafeList = yield* session.listFiles("-delete").pipe(
                Effect.result
              )
              const searched = yield* session.searchFiles("value", ".")
              const command = yield* session.runCommand("pnpm test")
              const large = yield* session.runCommand("emit-large")
              const patch = yield* session.applyPatch(
                [
                  "diff --git a/review.ts b/review.ts",
                  "--- a/review.ts",
                  "+++ b/review.ts",
                  "@@ -1 +1 @@",
                  "-export const value = 2",
                  "+export const value = 3",
                  ""
                ].join("\n")
              )
              const largePatch = yield* session.applyPatch(
                `diff --git a/large.txt b/large.txt\n${"+".repeat(20_000)}\n`
              )
              const diff = yield* session.readDiff()
              assert.strictEqual(read.stdout.text, "export const value = 2\n")
              assert.include(listed.stdout.text, "review.ts")
              assert.isTrue(Result.isFailure(unsafeList))
              if (Result.isFailure(unsafeList)) {
                assert.strictEqual(unsafeList.failure.reason, "invalid-request")
              }
              assert.include(searched.stdout.text, "review.ts:1")
              assert.strictEqual(command.exitCode, 0)
              assert.strictEqual(command.stdout.text, "tests passed\n")
              assert.strictEqual(patch.exitCode, 0)
              assert.strictEqual(largePatch.exitCode, 0)
              assert.include(diff.stdout.text, "+export const value = 3")
              assert.isTrue(large.stdout.truncated)
              assert.isNotNull(large.stdout.artifactId)
              const artifactId = large.stdout.artifactId
              if (artifactId === null) return yield* Effect.die("artifact missing")
              assert.isTrue(Schema.is(PrReviewCommandArtifactId)(artifactId))
              assert.strictEqual(
                yield* session.pageArtifact(artifactId, 0, 3),
                "\"🙂"
              )
              assert.deepStrictEqual(
                (yield* session.searchArtifact(artifactId, "🙂")).slice(0, 3),
                [1, 4, 7]
              )
              return session.headRevision
            }))
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              commandResponses: [
                { stdout: "export const value = 2\n" },
                { stdout: "./review.ts\n" },
                { stdout: "./review.ts:1:export const value = 2\n" },
                { stdout: "tests passed\n" },
                { stdout: largeOutput },
                {},
                {},
                {
                  stdout: "diff --git a/review.ts b/review.ts\n+export const value = 3\n"
                }
              ]
            })
          )
        )

        assert.strictEqual(observed, HEAD_REVISION)
        assert.isFalse(yield* fileSystem.exists(sourceRoot))

        const initializerCreate = calls.find(
          ({ args }) =>
            args[0] === "container" &&
            args[1] === "create" &&
            args.includes(INITIALIZER_NAME)
        )
        const sessionCreate = calls.find(
          ({ args }) =>
            args[0] === "container" &&
            args[1] === "create" &&
            args.includes(CONTAINER_NAME)
        )
        const copy = calls.find(
          ({ args }) => args[0] === "container" && args[1] === "cp"
        )
        assert.isDefined(initializerCreate)
        assert.isDefined(sessionCreate)
        assert.isDefined(copy)
        if (
          initializerCreate === undefined ||
          sessionCreate === undefined ||
          copy === undefined
        ) {
          return assert.fail("expected initializer, session, and copy calls")
        }

        assert.include(initializerCreate.args, "0:0")
        assert.include(initializerCreate.args, "--cap-add")
        assert.include(
          initializerCreate.args,
          "dev.knpkv.control-center.pr-review.kind=initializer"
        )
        assert.include(sessionCreate.args, "65532:65532")
        assert.include(
          sessionCreate.args,
          "dev.knpkv.control-center.pr-review.kind=session"
        )
        assert.include(sessionCreate.args, "--read-only")
        assert.include(sessionCreate.args, "none")
        assert.include(
          sessionCreate.args,
          `type=volume,src=${VOLUME_NAME},dst=/workspace,volume-nocopy`
        )
        assert.include(
          initializerCreate.args,
          `type=volume,src=${VOLUME_NAME},dst=/workspace,volume-nocopy`
        )
        assert.notInclude(sessionCreate.args.join(" "), "type=bind")
        assert.notInclude(sessionCreate.args.join(" "), sourceRoot)
        assert.notInclude(sessionCreate.args.join(" "), "/var/run/docker.sock")
        assert.notInclude(sessionCreate.args, "--publish")
        assert.notInclude(sessionCreate.args, "--env")
        assert.include(copy.args, `${sourceRoot}/.`)

        const toolExecs = calls.filter(
          ({ args }) => args[0] === "container" && args[1] === "exec"
        )
        assert.isAbove(toolExecs.length, 1)
        assert.isTrue(
          toolExecs.some(
            ({ args }) =>
              args.at(-1)?.includes(
                "find '.' -mindepth 1 -maxdepth 1 -print"
              ) === true
          )
        )
        assert.isFalse(
          toolExecs.some(({ args }) => args.join(" ").includes("-delete"))
        )
        const patchExecs = toolExecs.filter(
          ({ args }) => args.at(-1) === "git apply --whitespace=nowarn --"
        )
        assert.lengthOf(patchExecs, 2)
        assert.isTrue(
          patchExecs.every(({ options }) => options.stdin !== "ignore")
        )
        assert.isTrue(
          patchExecs.every(({ args }) => args.includes("--interactive"))
        )
        assert.isFalse(
          patchExecs.some(({ args }) => args.join(" ").includes("+".repeat(100)))
        )
        const volumeCreate = calls.find(
          ({ args }) => args[0] === "volume" && args[1] === "create"
        )
        assert.isDefined(volumeCreate)
        assert.include(
          volumeCreate?.args ?? [],
          "dev.knpkv.control-center.pr-review.kind=volume"
        )
        assert.include(volumeCreate?.args ?? [], "type=tmpfs")
        assert.include(volumeCreate?.args ?? [], "device=tmpfs")
        assert.include(
          volumeCreate?.args ?? [],
          `o=size=${1_024 * 1_024 * 1_024}`
        )
        for (const child of calls) {
          assert.strictEqual(child.command, "docker")
          assert.strictEqual(child.options.shell, false)
          assert.strictEqual(child.options.extendEnv, false)
          assert.deepStrictEqual(child.options.env, {
            DOCKER_CONFIG: "/nonexistent",
            HOME: "/nonexistent",
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin"
          })
        }
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "rm" &&
              args.at(-1) === CONTAINER_NAME
          )
        )
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "volume" &&
              args[1] === "rm" &&
              args.at(-1) === VOLUME_NAME
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("cleans the initializer and volume when source handoff fails", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pr-review-session-copy-failure-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        const result = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(
            request,
            () => Effect.die("session callback must not run")
          )
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, { failCopy: true })
          ),
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, PrReviewSandboxSessionError)
          assert.strictEqual(result.failure.reason, "sandbox-unavailable")
        }
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "rm" &&
              args.at(-1) === INITIALIZER_NAME
          )
        )
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "volume" &&
              args[1] === "rm" &&
              args.at(-1) === VOLUME_NAME
          )
        )
        assert.isFalse(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "create" &&
              args.includes(CONTAINER_NAME)
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("gives full-source handoff its own timeout and cleans after expiry", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pr-review-session-copy-timeout-"
        })
        const copyStarted = yield* Deferred.make<void>()
        const calls: Array<ChildProcess.StandardCommand> = []
        const fiber = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(
            request,
            () => Effect.die("session callback must not run")
          )
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              hangingCopy: copyStarted
            })
          ),
          Effect.result,
          Effect.forkScoped
        )
        yield* Deferred.await(copyStarted)
        yield* TestClock.adjust("31 seconds")
        assert.isUndefined(fiber.pollUnsafe())
        yield* TestClock.adjust("5 minutes")
        const result = yield* Fiber.join(fiber)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, PrReviewSandboxSessionError)
          assert.strictEqual(result.failure.reason, "sandbox-timeout")
        }
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "rm" &&
              args.at(-1) === INITIALIZER_NAME
          )
        )
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "volume" &&
              args[1] === "rm" &&
              args.at(-1) === VOLUME_NAME
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("caps command timeouts and closes the session before returning", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-timeout-"
        })
        const started = yield* Deferred.make<void>()
        const calls: Array<ChildProcess.StandardCommand> = []
        const fiber = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(
            request,
            (session) =>
              Effect.gen(function*() {
                assert.strictEqual(
                  (yield* session.runCommand("echo quick", 5)).exitCode,
                  0
                )
                assert.strictEqual(
                  (yield* session.runCommand("echo default")).exitCode,
                  0
                )
                const timedOut = yield* session.runCommand(
                  "sleep forever",
                  1_000
                ).pipe(Effect.result)
                assert.isTrue(Result.isFailure(timedOut))
                if (Result.isFailure(timedOut)) {
                  assert.instanceOf(
                    timedOut.failure,
                    PrReviewSandboxSessionError
                  )
                  assert.strictEqual(
                    timedOut.failure.reason,
                    "command-timeout"
                  )
                }
                assert.isTrue(
                  calls.some(
                    ({ args }) =>
                      args[0] === "container" &&
                      args[1] === "rm" &&
                      args.at(-1) === CONTAINER_NAME
                  )
                )
                assert.isTrue(
                  calls.some(
                    ({ args }) =>
                      args[0] === "volume" &&
                      args[1] === "rm" &&
                      args.at(-1) === VOLUME_NAME
                  )
                )
                const afterTimeout = yield* session.runCommand(
                  "echo unavailable"
                ).pipe(Effect.result)
                assert.isTrue(Result.isFailure(afterTimeout))
                if (Result.isFailure(afterTimeout)) {
                  assert.strictEqual(
                    afterTimeout.failure.reason,
                    "session-closed"
                  )
                }
                const readAfterTimeout = yield* session.readFile(
                  "review.ts"
                ).pipe(Effect.result)
                assert.isTrue(Result.isFailure(readAfterTimeout))
                if (Result.isFailure(readAfterTimeout)) {
                  assert.strictEqual(
                    readAfterTimeout.failure.reason,
                    "session-closed"
                  )
                }
              })
          )
        }).pipe(
          Effect.provide(
            sessionsLayer(
              sourceRoot,
              calls,
              {
                hangingCommand: {
                  command: "sleep forever",
                  started
                }
              },
              10
            )
          ),
          Effect.result,
          Effect.forkScoped
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("20 millis")
        const result = yield* Fiber.join(fiber)
        assert.isTrue(Result.isSuccess(result))
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "rm" &&
              args.at(-1) === CONTAINER_NAME
          )
        )
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "volume" &&
              args[1] === "rm" &&
              args.at(-1) === VOLUME_NAME
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("rejects pathological per-command output at the hard byte cap", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-output-cap-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, (session) =>
            Effect.gen(function*() {
              const rejected = yield* session.runCommand(
                "emit-pathological-output"
              ).pipe(Effect.result)
              assert.isTrue(Result.isFailure(rejected))
              if (Result.isFailure(rejected)) {
                assert.strictEqual(
                  rejected.failure.reason,
                  "output-rejected"
                )
              }
            }))
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              commandResponses: [{
                stdoutBytes: new Uint8Array(16 * 1_024 * 1_024 + 1)
              }]
            })
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("preserves complete UTF-8 characters at read page boundaries", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-utf8-page-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, (session) =>
            Effect.gen(function*() {
              const splitCharacter = yield* session.readFile(
                "review.ts",
                0,
                3
              )
              const ascii = yield* session.readFile("review.ts", 0, 3)
              const exactCharacter = yield* session.readFile(
                "review.ts",
                0,
                4
              )
              assert.strictEqual(splitCharacter.stdout.text, "ab🙂")
              assert.strictEqual(ascii.stdout.text, "asc")
              assert.strictEqual(exactCharacter.stdout.text, "🙂")
            }))
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              commandResponses: [
                { stdout: "ab🙂cd" },
                { stdout: "ascii" },
                { stdout: "🙂x" }
              ]
            })
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("preserves callback failures while cleaning the session", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-callback-failure-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        const callbackFailure: "review-callback-failed" = "review-callback-failed"
        const result = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(
            request,
            () => Effect.fail(callbackFailure)
          )
        }).pipe(
          Effect.provide(sessionsLayer(sourceRoot, calls)),
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure, "review-callback-failed")
        }
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "container" &&
              args[1] === "rm" &&
              args.at(-1) === CONTAINER_NAME
          )
        )
        assert.isTrue(
          calls.some(
            ({ args }) =>
              args[0] === "volume" &&
              args[1] === "rm" &&
              args.at(-1) === VOLUME_NAME
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("evicts oldest retained artifacts within the session budget", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-artifact-budget-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        const output = "x".repeat(40_000)
        yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, (session) =>
            Effect.gen(function*() {
              const ids = new Array<PrReviewCommandArtifactId>()
              for (let index = 0; index < 65; index += 1) {
                const result = yield* session.runCommand(`emit-${index}`)
                if (result.stdout.artifactId === null) {
                  return yield* Effect.die("expected retained artifact")
                }
                ids.push(result.stdout.artifactId)
              }
              const first = ids[0]
              const last = ids.at(-1)
              if (first === undefined || last === undefined) {
                return yield* Effect.die("expected artifact identities")
              }
              const evicted = yield* session.pageArtifact(
                first,
                0,
                1
              ).pipe(Effect.result)
              assert.isTrue(Result.isFailure(evicted))
              if (Result.isFailure(evicted)) {
                assert.strictEqual(
                  evicted.failure.reason,
                  "artifact-unavailable"
                )
              }
              assert.strictEqual(
                yield* session.pageArtifact(last, 0, 1),
                "x"
              )
            }))
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              commandResponses: Array.from(
                { length: 65 },
                () => ({ stdout: output })
              )
            })
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("does not hide unrelated cleanup errors as missing resources", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-cleanup-error-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        const result = yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, () => Effect.void)
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              cleanupFailure: {
                resourceName: CONTAINER_NAME,
                stderr: "authorization plugin not found\n"
              }
            })
          ),
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, PrReviewSandboxSessionError)
          assert.strictEqual(result.failure.reason, "cleanup-failed")
        }
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("tolerates Docker's exact missing-resource cleanup response", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const sourceRoot = yield* fileSystem.makeTempDirectory({
          prefix: "pr-review-session-cleanup-missing-"
        })
        const calls: Array<ChildProcess.StandardCommand> = []
        yield* Effect.gen(function*() {
          const sessions = yield* PrReviewSandboxSessions
          return yield* sessions.withSession(request, () => Effect.void)
        }).pipe(
          Effect.provide(
            sessionsLayer(sourceRoot, calls, {
              cleanupFailure: {
                resourceName: CONTAINER_NAME,
                stderr: `Error response from daemon: No such container: ${CONTAINER_NAME}\n`
              }
            })
          )
        )
      })
    ).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("reconciles sessions and removes exact orphaned resources", () => {
    const calls: Array<ChildProcess.StandardCommand> = []
    const source = Layer.succeed(
      PrReviewSourceWorkspace,
      PrReviewSourceWorkspace.of({
        withSource: () => Effect.die("reconciliation must not materialize source")
      })
    )
    return Effect.gen(function*() {
      const sessions = yield* PrReviewSandboxSessions
      const reconciled = yield* sessions.reconcile()
      assert.deepStrictEqual(reconciled, {
        liveSessions: [{
          attemptId: ATTEMPT_ID,
          containerName: CONTAINER_NAME,
          jobId: JOB_ID
        }],
        removedInitializerContainers: [ORPHAN_INITIALIZER_NAME],
        removedNonRunningSessionContainers: [STOPPED_CONTAINER_NAME],
        removedOrphanVolumes: [
          STOPPED_VOLUME_NAME,
          ORPHAN_VOLUME_NAME
        ]
      })
      assert.isTrue(
        calls.some(
          ({ args }) =>
            args[0] === "container" &&
            args[1] === "rm" &&
            args.at(-1) === ORPHAN_INITIALIZER_NAME
        )
      )
      assert.isTrue(
        calls.some(
          ({ args }) =>
            args[0] === "container" &&
            args[1] === "rm" &&
            args.at(-1) === STOPPED_CONTAINER_NAME
        )
      )
      assert.isTrue(
        calls.some(
          ({ args }) =>
            args[0] === "volume" &&
            args[1] === "rm" &&
            args.at(-1) === STOPPED_VOLUME_NAME
        )
      )
      assert.isTrue(
        calls.some(
          ({ args }) =>
            args[0] === "volume" &&
            args[1] === "rm" &&
            args.at(-1) === ORPHAN_VOLUME_NAME
        )
      )
      assert.isFalse(
        calls.some(
          ({ args }) =>
            args[1] === "rm" &&
            args.at(-1) === VOLUME_NAME
        )
      )
    }).pipe(
      Effect.provide(
        prReviewSandboxSessionsLayer({ image: IMAGE }).pipe(
          Layer.provide(fakeDockerLayer(calls, {
            reconcileContainerOutput: [
              `${CONTAINER_NAME}\tsession\t${JOB_ID}\t${ATTEMPT_ID}\trunning`,
              `${STOPPED_CONTAINER_NAME}\tsession\t${JOB_ID}\t${STOPPED_ATTEMPT_ID}\texited`,
              `${ORPHAN_INITIALIZER_NAME}\tinitializer\t${JOB_ID}\t${ORPHAN_ATTEMPT_ID}\trunning`,
              "malformed-resource"
            ].join("\n"),
            reconcileVolumeOutput: [
              `${VOLUME_NAME}\tvolume\t${JOB_ID}\t${ATTEMPT_ID}`,
              `${STOPPED_VOLUME_NAME}\tvolume\t${JOB_ID}\t${STOPPED_ATTEMPT_ID}`,
              `${ORPHAN_VOLUME_NAME}\tvolume\t${JOB_ID}\t${ORPHAN_ATTEMPT_ID}`,
              "malformed-resource"
            ].join("\n")
          })),
          Layer.provide(source),
          Layer.provide(NodeFileSystem.layer)
        )
      ),
      Effect.provide(NodePath.layer)
    )
  })
})
