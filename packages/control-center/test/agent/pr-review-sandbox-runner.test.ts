import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Path, Schema, Sink, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as TestClock from "effect/testing/TestClock"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId } from "../../src/domain/identifiers.js"
import {
  MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES,
  PrReviewSandboxError,
  PrReviewSandboxEvidence,
  PrReviewSandboxRunner,
  prReviewSandboxRunnerLayer,
  type PrReviewSandboxRunnerOptions
} from "../../src/server/agent/internal/PrReviewSandboxRunner.js"

const JOB_ID = Schema.decodeSync(JobId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const ATTEMPT_ID = "0123456789ab"
const SECOND_ATTEMPT_ID = "fedcba987654"
const BASE_REVISION = "1".repeat(40)
const HEAD_REVISION = "2".repeat(40)
const IMAGE = `registry.example.invalid/control-center/pr-review@sha256:${"a".repeat(64)}`
const ANALYZER_COMMAND: readonly [string, string, string] = [
  "/opt/control-center/bin/analyze",
  "--format",
  "json-v1"
]
const CONTAINER_NAME = `cc-pr-review-${JOB_ID}-${ATTEMPT_ID}`
const encoder = new TextEncoder()
const fixtureProcessEnvironment: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin"
}

const evidence = Schema.decodeSync(PrReviewSandboxEvidence)({
  schemaVersion: 1,
  headRevision: HEAD_REVISION,
  tool: {
    name: "eslint",
    version: "9.0.0"
  },
  findings: [{
    ruleId: "example/no-example",
    severity: "warning",
    path: "src/example.ts",
    startLine: 12,
    endLine: 14,
    message: "The analyzer found a deterministic problem."
  }]
})

interface FakeResponse {
  readonly exitCode?: number
  readonly hanging?: boolean
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => Effect.Effect<void>
  readonly started?: Deferred.Deferred<void>
  readonly stderr?: string | Uint8Array
  readonly stdout?: string | Uint8Array
}

const bytes = (value: string | Uint8Array | undefined): Uint8Array =>
  typeof value === "string"
    ? encoder.encode(value)
    : value ?? new Uint8Array()

const makeFakeSpawn = (
  calls: Array<ChildProcess.StandardCommand>,
  responses: Array<FakeResponse>
): ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] =>
(unknownCommand) => {
  assert.isTrue(ChildProcess.isStandardCommand(unknownCommand))
  if (!ChildProcess.isStandardCommand(unknownCommand)) {
    return Effect.die("expected a standard command")
  }
  calls.push(unknownCommand)
  const response = responses.shift()
  if (response === undefined) return Effect.die("missing fake process response")
  const announce = response.started === undefined
    ? Effect.void
    : Deferred.succeed(response.started, undefined)
  const onSpawn = response.onSpawn?.(unknownCommand) ?? Effect.void
  return onSpawn.pipe(
    Effect.andThen(announce),
    Effect.as(ChildProcessSpawner.makeHandle({
      all: Stream.empty,
      exitCode: response.hanging === true
        ? Effect.never
        : Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode ?? 0)),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(response.hanging === true),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(42),
      stderr: response.hanging === true ? Stream.never : Stream.make(bytes(response.stderr)),
      stdin: Sink.drain,
      stdout: response.hanging === true ? Stream.never : Stream.make(bytes(response.stdout)),
      unref: Effect.succeed(Effect.void)
    }))
  )
}

const fakeProcessLayer = (
  calls: Array<ChildProcess.StandardCommand>,
  responses: Array<FakeResponse>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(makeFakeSpawn(calls, responses))
  )

const hybridProcessLayer = (
  dockerCalls: Array<ChildProcess.StandardCommand>,
  dockerResponses: Array<FakeResponse>
): Layer.Layer<
  ChildProcessSpawner.ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function*() {
      const actual = yield* ChildProcessSpawner.ChildProcessSpawner
      const fakeDocker = makeFakeSpawn(dockerCalls, dockerResponses)
      return ChildProcessSpawner.make((child) =>
        ChildProcess.isStandardCommand(child) && child.command === "docker"
          ? fakeDocker(child)
          : actual.spawn(child)
      )
    })
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer))

const missingContainerFor = (name: string): FakeResponse => ({
  exitCode: 1,
  stderr: `Error response from daemon: No such container: ${name}\n`
})

const missingContainer = (): FakeResponse => missingContainerFor(CONTAINER_NAME)

const ordinaryChangedDiff =
  "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -11,0 +12,3 @@\n"

const reviewTreeResponses = (
  checkout: string,
  changedDiff: string | Uint8Array = ordinaryChangedDiff
): Array<FakeResponse> => [
  { stdout: "sha1\n" },
  { stdout: `${checkout}\n` },
  { stdout: `100644 blob ${HEAD_REVISION}\tsrc/example.ts\u0000` },
  {},
  {},
  {},
  { stdout: changedDiff }
]

const sourceGitArguments = (
  checkout: string,
  args: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-C",
  checkout,
  ...args
]

const successResponses = (
  checkout: string,
  analysisOutput: string | Uint8Array = JSON.stringify(evidence),
  container = CONTAINER_NAME,
  changedDiff: string | Uint8Array = ordinaryChangedDiff
): Array<FakeResponse> => [
  { stdout: `${checkout}\n` },
  { stdout: `${HEAD_REVISION}\n` },
  ...reviewTreeResponses(checkout, changedDiff),
  { stdout: "" },
  missingContainerFor(container),
  { stdout: "container-id\n" },
  { stdout: analysisOutput },
  { stdout: CONTAINER_NAME }
]

const options = (
  workspaceRoot: string,
  overrides: Partial<PrReviewSandboxRunnerOptions> = {}
): PrReviewSandboxRunnerOptions => ({
  workspaceRoot,
  image: IMAGE,
  analyzerCommand: ANALYZER_COMMAND,
  ...overrides
})

const provideRunner = <A, E>(
  workspaceRoot: string,
  calls: Array<ChildProcess.StandardCommand>,
  responses: Array<FakeResponse>,
  effect: Effect.Effect<A, E, PrReviewSandboxRunner>,
  overrides: Partial<PrReviewSandboxRunnerOptions> = {}
): Effect.Effect<A, E | PrReviewSandboxError, FileSystem.FileSystem | Path.Path> =>
  effect.pipe(
    Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot, overrides))),
    Effect.provide(fakeProcessLayer(calls, responses))
  )

const withWorkspace = <A, E, R>(
  use: (
    workspaceRoot: string,
    checkout: string,
    path: Path.Path,
    fileSystem: FileSystem.FileSystem
  ) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | R> =>
  Effect.scoped(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-workspaces-" })
      const checkout = path.join(workspaceRoot, JOB_ID)
      yield* fileSystem.makeDirectory(checkout)
      return yield* use(workspaceRoot, checkout, path, fileSystem)
    })
  )

const runGit = (args: ReadonlyArray<string>): Effect.Effect<
  string,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* ChildProcess.make("git", args, {
        env: fixtureProcessEnvironment,
        extendEnv: false,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe"
      })
      const [exitCode, stdout] = yield* Effect.all([
        handle.exitCode,
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.runDrain)
      ])
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
      return stdout
    })
  )

const run = Effect.gen(function*() {
  const runner = yield* PrReviewSandboxRunner
  return yield* runner.run({
    attemptId: ATTEMPT_ID,
    jobId: JOB_ID,
    baseRevision: BASE_REVISION,
    headRevision: HEAD_REVISION
  })
})

const assertRedactedError = (result: {
  readonly _tag: "Failure" | "Success"
  readonly failure?: unknown
}, reason: PrReviewSandboxError["reason"]): void => {
  assert.strictEqual(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.instanceOf(result.failure, PrReviewSandboxError)
    if (
      Predicate.isTagged(result.failure, "PrReviewSandboxError") &&
      Predicate.hasProperty(result.failure, "reason")
    ) {
      assert.strictEqual(result.failure.reason, reason)
      assert.deepStrictEqual(Object.keys(result.failure).sort(), ["_tag", "reason"])
    }
  }
}

describe("PrReviewSandboxRunner", () => {
  it.effect("runs the exact hardened immutable container command without a shell", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      return provideRunner(workspaceRoot, calls, successResponses(checkout), run).pipe(
        Effect.map((result) => {
          assert.deepStrictEqual(result, evidence)
          assert.strictEqual(calls.length, 14)
          const archiveGitDirectory = calls[5]?.args[4]
          const archive = calls[7]?.args[2]
          const reviewTree = calls[7]?.args[4]
          if (
            archiveGitDirectory === undefined ||
            archive === undefined ||
            reviewTree === undefined
          ) {
            return assert.fail("expected archive repository, archive, and review-tree paths")
          }
          assert.deepStrictEqual(calls.map(({ args, command }) => [command, args]), [
            ["git", sourceGitArguments(checkout, ["rev-parse", "--show-toplevel"])],
            ["git", sourceGitArguments(checkout, ["rev-parse", "--verify", "HEAD"])],
            ["git", sourceGitArguments(checkout, ["rev-parse", "--show-object-format"])],
            [
              "git",
              sourceGitArguments(checkout, [
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects"
              ])
            ],
            [
              "git",
              sourceGitArguments(checkout, [
                "ls-tree",
                "-r",
                "-z",
                "--full-tree",
                HEAD_REVISION
              ])
            ],
            ["git", [
              "init",
              "--bare",
              "--quiet",
              "--object-format=sha1",
              archiveGitDirectory
            ]],
            ["git", [
              "--no-replace-objects",
              "--no-optional-locks",
              "--git-dir",
              archiveGitDirectory,
              "-c",
              "core.bare=true",
              "-c",
              "tar.umask=0022",
              "archive",
              "--format=tar",
              HEAD_REVISION
            ]],
            ["tar", [
              "--extract",
              "--file",
              archive,
              "--directory",
              reviewTree,
              "--no-same-owner",
              "--same-permissions"
            ]],
            [
              "git",
              sourceGitArguments(checkout, [
                "-c",
                "core.quotePath=false",
                "diff",
                "--default-prefix",
                "--text",
                "--unified=0",
                "--inter-hunk-context=0",
                "--diff-algorithm=myers",
                "--no-indent-heuristic",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                BASE_REVISION,
                HEAD_REVISION,
                "--"
              ])
            ],
            ["docker", [
              "container",
              "ls",
              "--all",
              "--filter",
              `label=dev.knpkv.control-center.pr-review.job=${JOB_ID}`,
              "--format",
              "{{.Names}}"
            ]],
            ["docker", [
              "container",
              "inspect",
              "--type",
              "container",
              "--format",
              "{{.Id}}",
              CONTAINER_NAME
            ]],
            ["docker", [
              "container",
              "create",
              "--name",
              CONTAINER_NAME,
              "--label",
              `dev.knpkv.control-center.pr-review.job=${JOB_ID}`,
              "--label",
              `dev.knpkv.control-center.pr-review.attempt=${ATTEMPT_ID}`,
              "--pull",
              "never",
              "--log-driver",
              "none",
              "--user",
              "65532:65532",
              "--read-only",
              "--network",
              "none",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges:true",
              "--pids-limit",
              "128",
              "--cpus",
              "1",
              "--memory",
              "512m",
              "--memory-swap",
              "512m",
              "--tmpfs",
              "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
              "--mount",
              `type=bind,src=${reviewTree},dst=/workspace,readonly`,
              "--workdir",
              "/workspace",
              "--entrypoint",
              ANALYZER_COMMAND[0],
              IMAGE,
              ...ANALYZER_COMMAND.slice(1),
              "--head-revision",
              HEAD_REVISION
            ]],
            ["docker", ["container", "start", "--attach", CONTAINER_NAME]],
            ["docker", ["container", "rm", "--force", "--volumes", CONTAINER_NAME]]
          ])
          assert.notStrictEqual(reviewTree, checkout)
          assert.notInclude(calls[11]?.args.join(" "), checkout)
          assert.notInclude(calls[11]?.args.join(" "), ".git")
          assert.strictEqual(
            calls[11]?.args.filter((argument) => argument === "--head-revision").length,
            1
          )
          for (const child of calls) {
            assert.strictEqual(child.options.shell, false)
            assert.strictEqual(child.options.extendEnv, false)
            assert.deepStrictEqual(child.options.env, {
              DOCKER_CONFIG: "/nonexistent",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_NO_LAZY_FETCH: "1",
              HOME: "/nonexistent",
              LANG: "C",
              LC_ALL: "C",
              PATH: "/usr/bin:/bin"
            })
            assert.isDefined(child.options.forceKillAfter)
            assert.notInclude(child.args.join(" "), "/var/run/docker.sock")
            assert.notInclude(child.args, "--env")
            assert.notInclude(child.args, "--publish")
            assert.notInclude(child.args.join(" "), "seccomp=unconfined")
            assert.notInclude(child.args, "json-file")
          }
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("reserves analyzer revision arguments for the runner", () =>
    withWorkspace((workspaceRoot) =>
      Effect.gen(function*() {
        for (const reserved of ["--", "--head-revision", "--head-revision=untrusted"]) {
          const calls: Array<ChildProcess.StandardCommand> = []
          const result = yield* provideRunner(
            workspaceRoot,
            calls,
            [],
            run,
            { analyzerCommand: [ANALYZER_COMMAND[0], reserved] }
          ).pipe(Effect.result)
          assertRedactedError(result, "invalid-configuration")
          assert.lengthOf(calls, 0)
        }
        const commaCalls: Array<ChildProcess.StandardCommand> = []
        const commaRoot = yield* provideRunner(
          workspaceRoot,
          commaCalls,
          [],
          run,
          { workspaceRoot: `${workspaceRoot},invalid` }
        ).pipe(Effect.result)
        assertRedactedError(commaRoot, "invalid-configuration")
        assert.lengthOf(commaCalls, 0)
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("fences container identity by review attempt", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      const secondContainer = `cc-pr-review-${JOB_ID}-${SECOND_ATTEMPT_ID}`
      const secondRun = Effect.gen(function*() {
        const runner = yield* PrReviewSandboxRunner
        return yield* runner.run({
          attemptId: SECOND_ATTEMPT_ID,
          jobId: JOB_ID,
          baseRevision: BASE_REVISION,
          headRevision: HEAD_REVISION
        })
      })
      return provideRunner(
        workspaceRoot,
        calls,
        successResponses(checkout, JSON.stringify(evidence), secondContainer),
        secondRun
      ).pipe(
        Effect.map((result) => {
          assert.deepStrictEqual(result, evidence)
          assert.notStrictEqual(secondContainer, CONTAINER_NAME)
          assert.strictEqual(calls[10]?.args.at(-1), secondContainer)
          assert.strictEqual(calls[11]?.args[3], secondContainer)
          assert.strictEqual(calls[12]?.args.at(-1), secondContainer)
          assert.strictEqual(calls[13]?.args.at(-1), secondContainer)
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("materializes exact readable commit bytes without repository metadata", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        const originalSource = "$Format:%H$\nORIGINAL\n"
        yield* runGit(["init", "--quiet", checkout])
        yield* fileSystem.writeFileString(
          path.join(checkout, ".gitattributes"),
          "source.txt export-subst -diff\nignored.txt export-ignore\nfiltered.txt filter=pwn\n"
        )
        yield* fileSystem.writeFileString(path.join(checkout, ".gitignore"), "node_modules/\n")
        yield* fileSystem.writeFileString(path.join(checkout, "source.txt"), originalSource)
        yield* fileSystem.writeFileString(path.join(checkout, "filtered.txt"), "filter input\n")
        yield* fileSystem.writeFileString(path.join(checkout, "ignored.txt"), "still review this\n")
        yield* fileSystem.writeFileString(
          path.join(checkout, "executable.sh"),
          "#!/bin/sh\nexit 0\n",
          { mode: 0o755 }
        )
        yield* runGit(["-C", checkout, "add", "--all"])
        yield* runGit([
          "-C",
          checkout,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "original"
        ])
        const originalRevision = (yield* runGit(["-C", checkout, "rev-parse", "HEAD"])).trim()

        yield* fileSystem.writeFileString(
          path.join(checkout, "source.txt"),
          "$Format:%H$\nREPLACEMENT\n"
        )
        yield* runGit(["-C", checkout, "add", "source.txt"])
        yield* runGit([
          "-C",
          checkout,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "replacement"
        ])
        const replacementRevision = (yield* runGit(["-C", checkout, "rev-parse", "HEAD"])).trim()
        yield* runGit(["-C", checkout, "replace", originalRevision, replacementRevision])
        yield* runGit([
          "--no-replace-objects",
          "-C",
          checkout,
          "reset",
          "--hard",
          "--quiet",
          originalRevision
        ])
        yield* runGit(["-C", checkout, "gc", "--quiet"])
        yield* fileSystem.writeFileString(
          path.join(checkout, ".git", "info", "attributes"),
          "source.txt export-ignore\n"
        )
        yield* runGit(["-C", checkout, "config", "tar.umask", "0077"])
        yield* runGit(["-C", checkout, "config", "diff.noprefix", "true"])
        yield* runGit(["-C", checkout, "config", "diff.interHunkContext", "10"])
        const fsmonitorMarker = path.join(checkout, ".git", "fsmonitor-ran")
        const fsmonitorHook = path.join(checkout, ".git", "hooks", "fsmonitor-test")
        yield* fileSystem.writeFileString(
          fsmonitorHook,
          `#!/bin/sh\n: > "${fsmonitorMarker}"\n`,
          { mode: 0o755 }
        )
        yield* runGit(["-C", checkout, "config", "core.fsmonitor", fsmonitorHook])
        const cleanFilterMarker = path.join(checkout, ".git", "clean-filter-ran")
        const cleanFilterHook = path.join(checkout, ".git", "hooks", "clean-filter-test")
        yield* fileSystem.writeFileString(
          cleanFilterHook,
          `#!/bin/sh\n: > "${cleanFilterMarker}"\ncat\n`,
          { mode: 0o755 }
        )
        yield* runGit(["-C", checkout, "config", "filter.pwn.clean", cleanFilterHook])
        yield* fileSystem.writeFileString(
          path.join(checkout, "source.txt"),
          "MUTABLE WORKTREE CONTENT\n"
        )
        yield* fileSystem.writeFileString(
          path.join(checkout, "injected.ts"),
          "throw new Error('must not be reviewed')\n"
        )
        yield* fileSystem.makeDirectory(
          path.join(checkout, "node_modules", "ignored-package"),
          { recursive: true }
        )
        yield* fileSystem.writeFileString(
          path.join(checkout, "node_modules", "ignored-package", "index.js"),
          "ignored worktree artifact\n"
        )

        const expectedEvidence = Schema.decodeSync(PrReviewSandboxEvidence)({
          ...evidence,
          headRevision: originalRevision,
          findings: evidence.findings.map((finding) => ({
            ...finding,
            path: "source.txt",
            startLine: 2,
            endLine: 2
          }))
        })
        const dockerCalls: Array<ChildProcess.StandardCommand> = []
        const verifyReviewTree = (
          child: ChildProcess.StandardCommand
        ): Effect.Effect<void> => {
          const revisionIndex = child.args.indexOf("--head-revision")
          assert.strictEqual(child.args[revisionIndex + 1], originalRevision)
          const mountIndex = child.args.indexOf("--mount")
          const mount = child.args[mountIndex + 1]
          const prefix = "type=bind,src="
          const suffix = ",dst=/workspace,readonly"
          if (
            mount === undefined ||
            !mount.startsWith(prefix) ||
            !mount.endsWith(suffix)
          ) {
            return Effect.die("expected a sanitized review-tree mount")
          }
          const reviewTree = mount.slice(prefix.length, -suffix.length)
          return Effect.gen(function*() {
            assert.strictEqual(
              yield* fileSystem.readFileString(path.join(reviewTree, "source.txt")),
              originalSource
            )
            assert.strictEqual(
              yield* fileSystem.readFileString(path.join(reviewTree, "ignored.txt")),
              "still review this\n"
            )
            assert.isFalse(yield* fileSystem.exists(path.join(reviewTree, ".git")))
            assert.isFalse(yield* fileSystem.exists(path.join(reviewTree, "injected.ts")))
            assert.isFalse(yield* fileSystem.exists(path.join(reviewTree, "node_modules")))
            const rootInfo = yield* fileSystem.stat(reviewTree)
            const sourceInfo = yield* fileSystem.stat(path.join(reviewTree, "source.txt"))
            const executableInfo = yield* fileSystem.stat(path.join(reviewTree, "executable.sh"))
            assert.strictEqual(rootInfo.mode & 0o777, 0o755)
            assert.strictEqual(sourceInfo.mode & 0o777, 0o644)
            assert.strictEqual(executableInfo.mode & 0o777, 0o755)
          }).pipe(Effect.orDie)
        }
        const actualRun = Effect.gen(function*() {
          const runner = yield* PrReviewSandboxRunner
          return yield* runner.run({
            attemptId: ATTEMPT_ID,
            jobId: JOB_ID,
            baseRevision: replacementRevision,
            headRevision: originalRevision
          })
        }).pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.provide(hybridProcessLayer(dockerCalls, [
            { stdout: "" },
            missingContainer(),
            { onSpawn: verifyReviewTree },
            { stdout: JSON.stringify(expectedEvidence) },
            {}
          ]))
        )
        assert.deepStrictEqual(yield* actualRun, expectedEvidence)
        assert.isFalse(yield* fileSystem.exists(fsmonitorMarker))
        assert.isFalse(yield* fileSystem.exists(cleanFilterMarker))
        assert.deepStrictEqual(
          dockerCalls.map(({ args }) => args.slice(0, 2)),
          [
            ["container", "ls"],
            ["container", "inspect"],
            ["container", "create"],
            ["container", "start"],
            ["container", "rm"]
          ]
        )
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("rejects a checkout nested inside a parent repository", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        yield* runGit(["init", "--quiet", workspaceRoot])
        yield* fileSystem.writeFileString(
          path.join(checkout, "source.ts"),
          "export const source = true\n"
        )
        yield* fileSystem.writeFileString(
          path.join(workspaceRoot, "sibling-secret.txt"),
          "must not enter the analyzer mount\n"
        )
        yield* runGit(["-C", workspaceRoot, "add", "--all"])
        yield* runGit([
          "-C",
          workspaceRoot,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "parent repository"
        ])
        const result = yield* run.pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.result
        )
        assertRedactedError(result, "source-rejected")
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("rejects a linked checkout whose Git object store is outside the workspace", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        const externalRepository = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pr-review-external-repository-"
        })
        yield* runGit(["init", "--quiet", externalRepository])
        yield* fileSystem.writeFileString(
          path.join(externalRepository, "source.ts"),
          "export const source = true\n"
        )
        yield* runGit(["-C", externalRepository, "add", "source.ts"])
        yield* runGit([
          "-C",
          externalRepository,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "external object store"
        ])
        const revision = (yield* runGit([
          "-C",
          externalRepository,
          "rev-parse",
          "HEAD"
        ])).trim()
        yield* fileSystem.remove(checkout, { recursive: true })
        yield* runGit([
          "-C",
          externalRepository,
          "worktree",
          "add",
          "--quiet",
          "--detach",
          checkout,
          revision
        ])

        const result = yield* Effect.gen(function*() {
          const runner = yield* PrReviewSandboxRunner
          return yield* runner.run({
            attemptId: ATTEMPT_ID,
            jobId: JOB_ID,
            baseRevision: revision,
            headRevision: revision
          })
        }).pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.result
        )
        assertRedactedError(result, "source-rejected")
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("rejects an in-workspace object store with an external Git alternate", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        const externalRepository = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pr-review-external-alternate-"
        })
        yield* runGit(["init", "--quiet", externalRepository])
        yield* fileSystem.writeFileString(
          path.join(externalRepository, "source.ts"),
          "export const source = true\n"
        )
        yield* runGit(["-C", externalRepository, "add", "source.ts"])
        yield* runGit([
          "-C",
          externalRepository,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "external alternate"
        ])
        yield* fileSystem.remove(checkout, { recursive: true })
        yield* runGit(["clone", "--quiet", "--shared", externalRepository, checkout])
        const revision = (yield* runGit(["-C", checkout, "rev-parse", "HEAD"])).trim()

        const result = yield* Effect.gen(function*() {
          const runner = yield* PrReviewSandboxRunner
          return yield* runner.run({
            attemptId: ATTEMPT_ID,
            jobId: JOB_ID,
            baseRevision: revision,
            headRevision: revision
          })
        }).pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.result
        )
        assertRedactedError(result, "source-rejected")
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("rejects symlinked directories inside the Git object store", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        yield* runGit(["init", "--quiet", checkout])
        yield* fileSystem.writeFileString(
          path.join(checkout, "source.ts"),
          "export const source = true\n"
        )
        yield* runGit(["-C", checkout, "add", "source.ts"])
        yield* runGit([
          "-C",
          checkout,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "packed objects"
        ])
        const revision = (yield* runGit(["-C", checkout, "rev-parse", "HEAD"])).trim()
        yield* runGit(["-C", checkout, "gc", "--quiet"])

        const outside = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pr-review-external-pack-"
        })
        const packDirectory = path.join(checkout, ".git", "objects", "pack")
        const externalPackDirectory = path.join(outside, "pack")
        yield* fileSystem.rename(packDirectory, externalPackDirectory)
        yield* fileSystem.symlink(externalPackDirectory, packDirectory)

        const result = yield* Effect.gen(function*() {
          const runner = yield* PrReviewSandboxRunner
          return yield* runner.run({
            attemptId: ATTEMPT_ID,
            jobId: JOB_ID,
            baseRevision: revision,
            headRevision: revision
          })
        }).pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.result
        )
        assertRedactedError(result, "source-rejected")
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("rejects submodule gitlinks instead of silently omitting their source", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      return provideRunner(workspaceRoot, calls, [
        { stdout: `${checkout}\n` },
        { stdout: `${HEAD_REVISION}\n` },
        { stdout: "sha1\n" },
        { stdout: `${checkout}\n` },
        { stdout: `160000 commit ${HEAD_REVISION}\tvendor/module\u0000` }
      ], run).pipe(
        Effect.result,
        Effect.map((result) => {
          assertRedactedError(result, "source-rejected")
          assert.deepStrictEqual(
            calls.map(({ command }) => command),
            ["git", "git", "git", "git", "git"]
          )
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("rejects committed symlinks before extracting the review tree", () =>
    withWorkspace((workspaceRoot, checkout, path, fileSystem) =>
      Effect.gen(function*() {
        yield* runGit(["init", "--quiet", checkout])
        yield* fileSystem.symlink("/etc/passwd", path.join(checkout, "escape.ts"))
        yield* runGit(["-C", checkout, "add", "escape.ts"])
        yield* runGit([
          "-C",
          checkout,
          "-c",
          "user.name=Control Center",
          "-c",
          "user.email=control-center@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "symlink"
        ])
        const revision = (yield* runGit(["-C", checkout, "rev-parse", "HEAD"])).trim()
        const result = yield* Effect.gen(function*() {
          const runner = yield* PrReviewSandboxRunner
          return yield* runner.run({
            attemptId: ATTEMPT_ID,
            jobId: JOB_ID,
            baseRevision: revision,
            headRevision: revision
          })
        }).pipe(
          Effect.provide(prReviewSandboxRunnerLayer(options(workspaceRoot))),
          Effect.result
        )
        assertRedactedError(result, "source-rejected")
      })
    ).pipe(
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide([NodeFileSystem.layer, NodePath.layer])
    ))

  it.effect("stops before OCI access when the checkout head differs", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      return provideRunner(
        workspaceRoot,
        calls,
        [
          { stdout: `${checkout}\n` },
          { stdout: `${"3".repeat(40)}\n` }
        ],
        run
      ).pipe(
        Effect.result,
        Effect.map((result) => {
          assertRedactedError(result, "revision-mismatch")
          assert.deepStrictEqual(calls.map(({ command }) => command), ["git", "git"])
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("rejects traversal and a symlink escape before spawning a process", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-workspaces-" })
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-outside-" })
        yield* fileSystem.symlink(outside, path.join(workspaceRoot, JOB_ID))
        const calls: Array<ChildProcess.StandardCommand> = []

        const traversal = yield* provideRunner(
          workspaceRoot,
          calls,
          [],
          Effect.gen(function*() {
            const runner = yield* PrReviewSandboxRunner
            return yield* runner.run({
              attemptId: ATTEMPT_ID,
              jobId: "../outside",
              baseRevision: BASE_REVISION,
              headRevision: HEAD_REVISION
            })
          })
        ).pipe(Effect.result)
        assertRedactedError(traversal, "invalid-request")

        const symlink = yield* provideRunner(workspaceRoot, calls, [], run).pipe(Effect.result)
        assertRedactedError(symlink, "source-rejected")
        assert.lengthOf(calls, 0)
      }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]))
    ))

  it.effect("rejects hostile, oversized, invalid UTF-8, and invalid JSON analyzer output", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const hostile = {
          ...evidence,
          findings: [{ ...evidence.findings[0], path: "../host-secret" }]
        }
        const cases: ReadonlyArray<string | Uint8Array> = [
          JSON.stringify(hostile),
          JSON.stringify({ ...evidence, unexpectedHostField: "/host/secret" }),
          JSON.stringify({ ...evidence, headRevision: "3".repeat(40) }),
          new Uint8Array(MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES + 1),
          Uint8Array.from([0xc3, 0x28]),
          "{not-json"
        ]
        for (const output of cases) {
          const calls: Array<ChildProcess.StandardCommand> = []
          const result = yield* provideRunner(
            workspaceRoot,
            calls,
            successResponses(checkout, output),
            run
          ).pipe(
            Effect.result
          )
          assertRedactedError(result, "output-rejected")
          assert.deepStrictEqual(calls.at(-1)?.args, [
            "container",
            "rm",
            "--force",
            "--volumes",
            CONTAINER_NAME
          ])
        }
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("ignores source lines that resemble diff headers while retaining later changed hunks", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const spoofedHeaderDiff = [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -11,0 +12,1 @@",
        "+++ b/src/unchanged.ts",
        "@@ -20,0 +21,1 @@",
        "+ordinary changed source",
        ""
      ].join("\n")
      const mixed = Schema.decodeSync(PrReviewSandboxEvidence)({
        ...evidence,
        findings: [
          {
            ruleId: "example/no-example",
            severity: "warning",
            path: "src/example.ts",
            startLine: 21,
            endLine: 21,
            message: "The analyzer found a deterministic problem."
          },
          {
            ruleId: "example/unchanged",
            severity: "warning",
            path: "src/unchanged.ts",
            startLine: 21,
            endLine: 21,
            message: "This finding is outside the pull-request diff."
          }
        ]
      })
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(checkout, JSON.stringify(mixed), CONTAINER_NAME, spoofedHeaderDiff),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "src/example.ts")
          assert.strictEqual(filtered.findings[0]?.startLine, 21)
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("ignores invalid UTF-8 in binary source lines while retaining later text hunks", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const beforeBinary = encoder.encode([
        "diff --git a/image.bin b/image.bin",
        "--- a/image.bin",
        "+++ b/image.bin",
        "@@ -0,0 +1,1 @@",
        ""
      ].join("\n"))
      const afterBinary = encoder.encode([
        "",
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -11,0 +12,3 @@",
        ""
      ].join("\n"))
      const binaryDiff = new Uint8Array(beforeBinary.length + 4 + afterBinary.length)
      binaryDiff.set(beforeBinary)
      binaryDiff.set([0x2b, 0xc3, 0x28, 0x0a], beforeBinary.length)
      binaryDiff.set(afterBinary, beforeBinary.length + 4)

      return provideRunner(
        workspaceRoot,
        [],
        successResponses(checkout, JSON.stringify(evidence), CONTAINER_NAME, binaryDiff),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.deepStrictEqual(filtered, evidence)
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("retains changed evidence for an unquoted non-ASCII Git path", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const unicodeDiff = [
        "diff --git a/café.ts b/café.ts",
        "--- a/café.ts",
        "+++ b/café.ts",
        "@@ -0,0 +1,1 @@",
        "+export const café = true",
        ""
      ].join("\n")
      const unicodeEvidence = {
        ...evidence,
        findings: [{
          ...evidence.findings[0],
          path: "café.ts",
          startLine: 1,
          endLine: 1
        }]
      }
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(unicodeEvidence),
          CONTAINER_NAME,
          unicodeDiff
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "café.ts")
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("retains changed evidence for an unquoted Git path with spaces", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const spacedDiff = [
        "diff --git a/src/a b.ts b/src/a b.ts",
        "--- a/src/a b.ts",
        "+++ b/src/a b.ts\t",
        "@@ -0,0 +1,1 @@",
        "+export const spaced = true",
        ""
      ].join("\n")
      const spacedEvidence = {
        ...evidence,
        findings: [{
          ...evidence.findings[0],
          path: "src/a b.ts",
          startLine: 1,
          endLine: 1
        }]
      }
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(spacedEvidence),
          CONTAINER_NAME,
          spacedDiff
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "src/a b.ts")
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("retains changed evidence for a C-quoted Git path", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const quotedDiff = [
        "diff --git \"a/src/a\\\"b.ts\" \"b/src/a\\\"b.ts\"",
        "--- \"a/src/a\\\"b.ts\"",
        "+++ \"b/src/a\\\"b.ts\"",
        "@@ -0,0 +1,1 @@",
        "+export const quoted = true",
        ""
      ].join("\n")
      const quotedEvidence = {
        ...evidence,
        findings: [{
          ...evidence.findings[0],
          path: "src/a\"b.ts",
          startLine: 1,
          endLine: 1
        }]
      }
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(quotedEvidence),
          CONTAINER_NAME,
          quotedDiff
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "src/a\"b.ts")
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("decodes UTF-8 octal bytes in a C-quoted Git path", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const quotedUnicodeDiff = [
        "diff --git \"a/src/caf\\303\\251\\\"x.ts\" \"b/src/caf\\303\\251\\\"x.ts\"",
        "--- \"a/src/caf\\303\\251\\\"x.ts\"",
        "+++ \"b/src/caf\\303\\251\\\"x.ts\"",
        "@@ -0,0 +1,1 @@",
        "+export const quotedUnicode = true",
        ""
      ].join("\n")
      const quotedUnicodeEvidence = {
        ...evidence,
        findings: [{
          ...evidence.findings[0],
          path: "src/café\"x.ts",
          startLine: 1,
          endLine: 1
        }]
      }
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(quotedUnicodeEvidence),
          CONTAINER_NAME,
          quotedUnicodeDiff
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "src/café\"x.ts")
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("accepts deletion-only hunks without inventing changed head lines", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const deletionDiff = [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +0,0 @@",
        "-removed",
        ""
      ].join("\n")
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(checkout, JSON.stringify(evidence), CONTAINER_NAME, deletionDiff),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 0)
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("does not retain unchanged lines between separate zero-context hunks", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const separateHunks = [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1 @@",
        "-old first",
        "+new first",
        "@@ -5 +5 @@",
        "-old last",
        "+new last",
        ""
      ].join("\n")
      const separatedEvidence = {
        ...evidence,
        findings: [
          { ...evidence.findings[0], startLine: 1, endLine: 1 },
          { ...evidence.findings[0], startLine: 3, endLine: 3 },
          { ...evidence.findings[0], startLine: 5, endLine: 5 }
        ]
      }
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(separatedEvidence),
          CONTAINER_NAME,
          separateHunks
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.deepStrictEqual(
            filtered.findings.map(({ startLine }) => startLine),
            [1, 5]
          )
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("applies durable evidence caps after removing unchanged findings", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const maximumRangeDiff = [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        ...Array.from(
          { length: 100_000 },
          (_, index) => `@@ -${index * 2 + 12},0 +${index * 2 + 12},1 @@`
        ),
        ""
      ].join("\n")
      const noisyEvidence = {
        ...evidence,
        findings: [
          {
            ...evidence.findings[0],
            message: "Changed finding ".repeat(30).trim()
          },
          ...Array.from({ length: 999 }, (_, index) => ({
            ...evidence.findings[0],
            path: `src/legacy-${index}.ts`,
            message: `Unchanged legacy finding ${index} `.repeat(20).trim()
          }))
        ]
      }
      assert.isAbove(
        encoder.encode(JSON.stringify(noisyEvidence)).byteLength,
        MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES
      )
      return provideRunner(
        workspaceRoot,
        [],
        successResponses(
          checkout,
          JSON.stringify(noisyEvidence),
          CONTAINER_NAME,
          maximumRangeDiff
        ),
        run
      ).pipe(
        Effect.map((filtered) => {
          assert.lengthOf(filtered.findings, 1)
          assert.strictEqual(filtered.findings[0]?.path, "src/example.ts")
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("accepts scoped rule identifiers without accepting traversal tokens", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const scoped = Schema.decodeSync(PrReviewSandboxEvidence)({
          ...evidence,
          findings: [{
            ruleId: "@typescript-eslint/no-unused-vars",
            severity: "warning",
            path: "src/example.ts",
            startLine: 12,
            endLine: 14,
            message: "The analyzer found a deterministic problem."
          }]
        })
        const accepted = yield* provideRunner(
          workspaceRoot,
          [],
          successResponses(checkout, JSON.stringify(scoped)),
          run
        )
        assert.deepStrictEqual(accepted, scoped)

        const traversal = {
          ...evidence,
          findings: [{
            ruleId: "../secret",
            severity: "warning",
            path: "src/example.ts",
            startLine: 12,
            endLine: 14,
            message: "The analyzer found a deterministic problem."
          }]
        }
        const rejected = yield* provideRunner(
          workspaceRoot,
          [],
          successResponses(checkout, JSON.stringify(traversal)),
          run
        ).pipe(Effect.result)
        assertRedactedError(rejected, "output-rejected")
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("does not mask a nonzero analyzer exit when cleanup also fails", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      return provideRunner(workspaceRoot, calls, [
        { stdout: `${checkout}\n` },
        { stdout: `${HEAD_REVISION}\n` },
        ...reviewTreeResponses(checkout),
        { stdout: "" },
        missingContainer(),
        {},
        { exitCode: 23, stderr: "hostile daemon detail /host/path" },
        { exitCode: 1, stderr: "cleanup daemon unavailable" }
      ], run).pipe(
        Effect.result,
        Effect.map((result) => {
          assertRedactedError(result, "sandbox-failed")
          assert.deepStrictEqual(calls.at(-1)?.args, [
            "container",
            "rm",
            "--force",
            "--volumes",
            CONTAINER_NAME
          ])
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("does not mask create failure when partial-container cleanup also fails", () =>
    withWorkspace((workspaceRoot, checkout) => {
      const calls: Array<ChildProcess.StandardCommand> = []
      return provideRunner(workspaceRoot, calls, [
        { stdout: `${checkout}\n` },
        { stdout: `${HEAD_REVISION}\n` },
        ...reviewTreeResponses(checkout),
        { stdout: "" },
        missingContainer(),
        { exitCode: 125, stderr: "daemon failed after allocating a container" },
        { exitCode: 1, stderr: "cleanup daemon unavailable" }
      ], run).pipe(
        Effect.result,
        Effect.map((result) => {
          assertRedactedError(result, "sandbox-unavailable")
          assert.deepStrictEqual(calls.at(-1)?.args, [
            "container",
            "rm",
            "--force",
            "--volumes",
            CONTAINER_NAME
          ])
        })
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("removes a partially created container when cancellation arrives during create", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const calls: Array<ChildProcess.StandardCommand> = []
        const createStarted = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(provideRunner(workspaceRoot, calls, [
          { stdout: `${checkout}\n` },
          { stdout: `${HEAD_REVISION}\n` },
          ...reviewTreeResponses(checkout),
          { stdout: "" },
          missingContainer(),
          { hanging: true, started: createStarted },
          {}
        ], run))
        yield* Deferred.await(createStarted)
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(calls.at(-1)?.args, [
          "container",
          "rm",
          "--force",
          "--volumes",
          CONTAINER_NAME
        ])
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("does not mask an analysis timeout when cleanup also fails", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const calls: Array<ChildProcess.StandardCommand> = []
        const started = yield* Deferred.make<void>()
        const resultFiber = yield* Effect.forkChild(
          provideRunner(
            workspaceRoot,
            calls,
            [
              { stdout: `${checkout}\n` },
              { stdout: `${HEAD_REVISION}\n` },
              ...reviewTreeResponses(checkout),
              { stdout: "" },
              missingContainer(),
              {},
              { hanging: true, started },
              { exitCode: 1, stderr: "cleanup daemon unavailable" }
            ],
            run,
            { maximumDurationMillis: 10 }
          ).pipe(Effect.result)
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(Duration.millis(11))
        const result = yield* Fiber.join(resultFiber)
        assertRedactedError(result, "sandbox-timeout")
        assert.deepStrictEqual(calls.at(-1)?.args, [
          "container",
          "rm",
          "--force",
          "--volumes",
          CONTAINER_NAME
        ])
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("removes the container when analysis is cancelled", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const calls: Array<ChildProcess.StandardCommand> = []
        const started = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(provideRunner(workspaceRoot, calls, [
          { stdout: `${checkout}\n` },
          { stdout: `${HEAD_REVISION}\n` },
          ...reviewTreeResponses(checkout),
          { stdout: "" },
          missingContainer(),
          {},
          { hanging: true, started },
          {}
        ], run))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(calls.at(-1)?.args, [
          "container",
          "rm",
          "--force",
          "--volumes",
          CONTAINER_NAME
        ])
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("bounds a hung cleanup without exposing daemon details", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const calls: Array<ChildProcess.StandardCommand> = []
        const cleanupStarted = yield* Deferred.make<void>()
        const resultFiber = yield* Effect.forkChild(
          provideRunner(workspaceRoot, calls, [
            { stdout: `${checkout}\n` },
            { stdout: `${HEAD_REVISION}\n` },
            ...reviewTreeResponses(checkout),
            { stdout: "" },
            missingContainer(),
            {},
            { stdout: JSON.stringify(evidence) },
            { hanging: true, started: cleanupStarted }
          ], run).pipe(Effect.result)
        )
        yield* Deferred.await(cleanupStarted)
        yield* TestClock.adjust(Duration.millis(30_001))
        const result = yield* Fiber.join(resultFiber)
        assertRedactedError(result, "cleanup-failed")
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))

  it.effect("reconciles a prior attempt for the same job and does not mask list failures", () =>
    withWorkspace((workspaceRoot, checkout) =>
      Effect.gen(function*() {
        const staleCalls: Array<ChildProcess.StandardCommand> = []
        const staleContainer = `cc-pr-review-${JOB_ID}-${SECOND_ATTEMPT_ID}`
        const staleResult = yield* provideRunner(workspaceRoot, staleCalls, [
          { stdout: `${checkout}\n` },
          { stdout: `${HEAD_REVISION}\n` },
          ...reviewTreeResponses(checkout),
          { stdout: `${staleContainer}\n` },
          {},
          missingContainer(),
          {},
          { stdout: JSON.stringify(evidence) },
          {}
        ], run)
        assert.deepStrictEqual(staleResult, evidence)
        assert.deepStrictEqual(staleCalls[10]?.args, [
          "container",
          "rm",
          "--force",
          "--volumes",
          staleContainer
        ])
        assert.deepStrictEqual(staleCalls[11]?.args, [
          "container",
          "inspect",
          "--type",
          "container",
          "--format",
          "{{.Id}}",
          CONTAINER_NAME
        ])
        assert.deepStrictEqual(staleCalls[12]?.args.slice(0, 2), ["container", "create"])

        const daemonCalls: Array<ChildProcess.StandardCommand> = []
        const daemonResult = yield* provideRunner(workspaceRoot, daemonCalls, [
          { stdout: `${checkout}\n` },
          { stdout: `${HEAD_REVISION}\n` },
          ...reviewTreeResponses(checkout),
          { exitCode: 1, stderr: "Cannot connect to the container daemon at /host/socket.\n" }
        ], run).pipe(Effect.result)
        assertRedactedError(daemonResult, "sandbox-unavailable")
        assert.deepStrictEqual(
          daemonCalls.map(({ command }) => command),
          ["git", "git", "git", "git", "git", "git", "git", "tar", "git", "docker"]
        )
      })
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])))
})
