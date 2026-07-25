import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Path, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { createServer, type Server } from "node:net"

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

const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>
): Effect.Effect<
  {
    readonly exitCode: ChildProcessSpawner.ExitCode
    readonly stderr: string
    readonly stdout: string
  },
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args, {
        env: environment,
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
      return { exitCode, stderr, stdout }
    })
  )

const runGit = (
  args: ReadonlyArray<string>,
  executablePath: string
): Effect.Effect<
  string,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runProcess("git", args, gitEnvironment(executablePath)).pipe(
    Effect.map(({ exitCode, stderr, stdout }) => {
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0), stderr)
      return stdout.trim()
    })
  )

const acquireNetworkProbe = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new Promise<{ readonly port: number; readonly server: Server }>(
        (resolve, reject) => {
          const server = createServer((socket) => {
            socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
          })
          server.once("error", reject)
          server.listen(0, "0.0.0.0", () => {
            const address = server.address()
            if (address === null || typeof address === "string") {
              server.close()
              reject(new Error("Network probe did not expose an internet port"))
              return
            }
            resolve({ port: address.port, server })
          })
        }
      ),
    catch: (cause) =>
      new Error("Could not start the sandbox network probe", {
        cause
      })
  }),
  ({ server }) => Effect.sync(() => server.close())
)

it.effect("runs the review session through the installed sbx runtime", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const executablePath = yield* Config.string("PATH")
      const home = yield* Config.string("HOME")
      const sbxEnvironment = {
        HOME: home,
        LANG: "C",
        LC_ALL: "C",
        PATH: executablePath
      }
      const networkProbe = yield* acquireNetworkProbe
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
      const controlName = `cc-network-${path.basename(sourceRoot)}`
      yield* Effect.acquireUseRelease(
        runProcess(
          "sbx",
          [
            "create",
            "shell",
            sourceRoot,
            "--clone",
            "--name",
            controlName,
            "--quiet"
          ],
          sbxEnvironment
        ).pipe(
          Effect.map(({ exitCode, stderr }) => {
            assert.strictEqual(
              exitCode,
              ChildProcessSpawner.ExitCode(0),
              stderr
            )
            return controlName
          })
        ),
        (name) =>
          runProcess(
            "sbx",
            [
              "exec",
              name,
              "curl",
              "--fail",
              "--silent",
              "--show-error",
              "--max-time",
              "3",
              `http://host.docker.internal:${String(networkProbe.port)}/`
            ],
            sbxEnvironment
          ).pipe(
            Effect.map(({ exitCode, stderr }) =>
              assert.strictEqual(
                exitCode,
                ChildProcessSpawner.ExitCode(0),
                stderr
              )
            )
          ),
        (name) =>
          runProcess(
            "sbx",
            ["rm", "--force", name],
            sbxEnvironment
          ).pipe(Effect.asVoid, Effect.orDie)
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
            const network = yield* session.runCommand(
              `curl --fail --silent --show-error --max-time 3 http://host.docker.internal:${String(networkProbe.port)}/`
            )
            const file = yield* session.readFile(".control-center-sbx-smoke")
            const diff = yield* session.readDiff()
            return { diff, file, network, revision, write }
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
      assert.notStrictEqual(observed.network.exitCode, 0)
      assert.strictEqual(observed.file.stdout.text, "SBX_WRITE_OK\n")
      assert.include(observed.diff.stdout.text, ".control-center-sbx-smoke")
      assert.include(observed.diff.stdout.text, "+SBX_WRITE_OK")
    })
  ).pipe(Effect.provide(NodeServices.layer)))
