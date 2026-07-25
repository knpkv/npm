import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Path, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { PrReviewSourceWorkspace } from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"

const gitEnvironment = (path: string): Readonly<Record<string, string>> => ({
  GIT_AUTHOR_EMAIL: "review-sbx-smoke@example.invalid",
  GIT_AUTHOR_NAME: "Review sbx smoke",
  GIT_COMMITTER_EMAIL: "review-sbx-smoke@example.invalid",
  GIT_COMMITTER_NAME: "Review sbx smoke",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: path
})

const runGit = (
  args: ReadonlyArray<string>,
  executablePath: string
): Effect.Effect<
  string,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* ChildProcess.make("git", args, {
        env: gitEnvironment(executablePath),
        extendEnv: false,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe"
      })
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode,
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
      ])
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0), stderr)
      return stdout.trim()
    })
  )

it.effect("runs the review session through the installed sbx runtime", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const executablePath = yield* Config.string("PATH")
      const sourceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-real-sbx-"
      })
      yield* runGit(["-C", sourceRoot, "init", "--quiet"], executablePath)
      yield* fileSystem.writeFileString(
        path.join(sourceRoot, "README.md"),
        "# Review sandbox smoke\n"
      )
      yield* runGit(["-C", sourceRoot, "add", "--", "README.md"], executablePath)
      yield* runGit(
        ["-C", sourceRoot, "commit", "--quiet", "-m", "fixture"],
        executablePath
      )
      const headRevision = yield* runGit(
        ["-C", sourceRoot, "rev-parse", "HEAD"],
        executablePath
      )
      const sourceLayer = Layer.succeed(
        PrReviewSourceWorkspace,
        PrReviewSourceWorkspace.of({
          withSource: (_request, use) => use(sourceRoot)
        })
      )

      const observed = yield* Effect.gen(function*() {
        const sessions = yield* PrReviewSandboxSessions
        return yield* sessions.withSession({
          workspaceId: WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000082"),
          jobId: JobId.make("01890f6f-6d6a-7cc0-98d2-000000000081"),
          repository: "control-center-sbx-smoke",
          attemptId: "abcdef012345",
          baseRevision: headRevision,
          headRevision
        }, (session) =>
          Effect.gen(function*() {
            const revision = yield* session.runCommand("git rev-parse HEAD")
            const write = yield* session.runCommand(
              "printf 'SBX_WRITE_OK\\n' > .control-center-sbx-smoke"
            )
            const file = yield* session.readFile(".control-center-sbx-smoke")
            const diff = yield* session.readDiff()
            return { diff, file, revision, write }
          }))
      }).pipe(
        Effect.provide(prReviewSandboxSessionsLayer({
          executable: "sbx",
          maximumCommandDurationMillis: 30_000,
          maximumSessionDurationMillis: 120_000
        })),
        Effect.provide(sourceLayer)
      )

      assert.strictEqual(observed.revision.exitCode, 0)
      assert.strictEqual(observed.revision.stdout.text.trim(), headRevision)
      assert.strictEqual(observed.write.exitCode, 0)
      assert.strictEqual(observed.file.stdout.text, "SBX_WRITE_OK\n")
      assert.include(observed.diff.stdout.text, ".control-center-sbx-smoke")
      assert.include(observed.diff.stdout.text, "+SBX_WRITE_OK")
    })
  ).pipe(Effect.provide(NodeServices.layer)))
