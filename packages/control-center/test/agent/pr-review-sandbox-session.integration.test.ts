/**
 * Credential-free Docker integration for the writable Review Sandbox session.
 *
 * The test pulls one trusted digest-pinned image when Docker is available.
 * No AWS or provider credentials are required.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../../src/server/agent/internal/PrReviewSandboxSession.js"
import { PrReviewSourceWorkspace } from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"
import { PR_REVIEW_AUTHORITY_CONFIG_PATTERN } from "../../src/server/agent/internal/PrReviewWorkspaceProtocol.js"

const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000081")
const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000082")
const ATTEMPT_ID = "89abcdef0123"
const CONTAINER_NAME = `cc-pr-review-session-${JOB_ID}-${ATTEMPT_ID}`
const VOLUME_NAME = `cc-pr-review-${JOB_ID}-${ATTEMPT_ID}`
const IMAGE = "alpine/git@sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26"

const commandEnvironment: Readonly<Record<string, string>> = {
  DOCKER_CONFIG: "/nonexistent",
  GIT_AUTHOR_EMAIL: "review-fixture@example.invalid",
  GIT_AUTHOR_NAME: "Review Fixture",
  GIT_COMMITTER_EMAIL: "review-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Review Fixture",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin"
}

const run = (
  executable: string,
  args: ReadonlyArray<string>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const child = yield* ChildProcess.make(executable, args, {
        env: commandEnvironment,
        extendEnv: false,
        shell: false,
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe"
      })
      const [exitCode, stderr, stdout] = yield* Effect.all([
        child.exitCode,
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.decodeText(), Stream.mkString)
      ], { concurrency: "unbounded" })
      return { exitCode, stderr, stdout }
    })
  )

const runGit = (args: ReadonlyArray<string>) =>
  run("git", args).pipe(
    Effect.tap(({ exitCode, stderr }) =>
      exitCode === ChildProcessSpawner.ExitCode(0)
        ? Effect.void
        : Effect.die(`Git fixture command failed: ${stderr}`)
    ),
    Effect.map(({ stdout }) => stdout.trim())
  )

const sourceLayer = (sourceRoot: string) =>
  Layer.succeed(
    PrReviewSourceWorkspace,
    PrReviewSourceWorkspace.of({
      withSource: (_request, use) => use(sourceRoot)
    })
  )

describe("PrReviewSandboxSessions Docker integration", () => {
  it.effect(
    "runs a writable exact-revision session and destroys it on cancellation",
    () =>
      Effect.scoped(
        Effect.gen(function*() {
          const availability = yield* run("docker", [
            "version",
            "--format",
            "{{.Server.Version}}"
          ]).pipe(Effect.result)
          if (
            Result.isFailure(availability) ||
            availability.success.exitCode !== ChildProcessSpawner.ExitCode(0)
          ) {
            yield* Effect.logWarning(
              "Review Sandbox Docker integration skipped because Docker is unavailable"
            )
            return
          }
          const pulled = yield* run("docker", ["image", "pull", IMAGE])
          assert.strictEqual(pulled.exitCode, 0, pulled.stderr)

          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const fixture = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "pr-review-docker-integration-"
          })
          const sourceRoot = path.join(fixture, "source")
          yield* fileSystem.makeDirectory(sourceRoot)
          yield* runGit(["-C", sourceRoot, "init", "--quiet"])
          yield* fileSystem.writeFileString(
            path.join(sourceRoot, "review.ts"),
            "export const value = 1\n"
          )
          yield* runGit(["-C", sourceRoot, "add", "--", "review.ts"])
          yield* runGit(["-C", sourceRoot, "commit", "--quiet", "-m", "fixture"])
          const revision = yield* runGit(["-C", sourceRoot, "rev-parse", "HEAD"])
          assert.isTrue(
            Schema.is(
              Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
            )(revision)
          )

          const ready = yield* Deferred.make<void>()
          const sessionProgram = yield* Effect.gen(function*() {
            const sessions = yield* PrReviewSandboxSessions
            return yield* sessions.withSession(
              {
                workspaceId: WORKSPACE_ID,
                jobId: JOB_ID,
                repository: "local-fixture",
                attemptId: ATTEMPT_ID,
                baseRevision: revision,
                headRevision: revision
              },
              (session) =>
                Effect.gen(function*() {
                  const environment = yield* session.runCommand(
                    "test -w . && test ! -e /var/run/docker.sock && " +
                      "test -z \"$(git remote)\" && " +
                      "authority_keys=$(git config --local --name-only --get-regexp '.*') && " +
                      "! printf '%s\\n' \"$authority_keys\" | " +
                      "LC_ALL=C tr '[:upper:]' '[:lower:]' | grep -E '" +
                      PR_REVIEW_AUTHORITY_CONFIG_PATTERN +
                      "' && " +
                      "! env | grep -E '^(AWS|CODEX|ANTHROPIC|OPENAI|GITHUB)_' && " +
                      "printf 'writable\\n' > sandbox-created.txt && cat sandbox-created.txt"
                  )
                  assert.strictEqual(environment.exitCode, 0)
                  assert.strictEqual(environment.stdout.text, "writable\n")
                  const read = yield* session.readFile("review.ts", 7, 5)
                  assert.strictEqual(read.exitCode, 0)
                  assert.strictEqual(read.stdout.text, "const")
                  const unsafeList = yield* session.listFiles(
                    "-delete"
                  ).pipe(Effect.result)
                  assert.isTrue(Result.isFailure(unsafeList))
                  if (Result.isFailure(unsafeList)) {
                    assert.strictEqual(
                      unsafeList.failure.reason,
                      "invalid-request"
                    )
                  }
                  const listed = yield* session.listFiles(".")
                  assert.include(listed.stdout.text, "./review.ts")
                  const sentinel = yield* session.readFile(
                    "review.ts",
                    0,
                    128
                  )
                  assert.strictEqual(
                    sentinel.stdout.text,
                    "export const value = 1\n"
                  )

                  const patch = yield* session.applyPatch(
                    [
                      "diff --git a/review.ts b/review.ts",
                      "--- a/review.ts",
                      "+++ b/review.ts",
                      "@@ -1 +1 @@",
                      "-export const value = 1",
                      "+export const value = 2",
                      ""
                    ].join("\n")
                  )
                  assert.strictEqual(patch.exitCode, 0)
                  const diff = yield* session.readDiff()
                  assert.include(diff.stdout.text, "+export const value = 2")

                  const inspected = yield* run("docker", [
                    "container",
                    "inspect",
                    "--format",
                    "{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|" +
                    "{{range .Mounts}}{{.Type}}:{{.Destination}};{{end}}|" +
                    "{{json .HostConfig.PortBindings}}",
                    CONTAINER_NAME
                  ])
                  assert.strictEqual(inspected.exitCode, 0, inspected.stderr)
                  const [
                    networkMode,
                    user,
                    readOnlyRoot,
                    mounts,
                    portBindings
                  ] = inspected.stdout.trim().split("|")
                  assert.strictEqual(networkMode, "none")
                  assert.strictEqual(user, "65532:65532")
                  assert.strictEqual(readOnlyRoot, "true")
                  assert.include(mounts, "volume:/workspace;")
                  assert.notInclude(mounts, "bind:")
                  assert.strictEqual(portBindings, "{}")
                  assert.isFalse(yield* fileSystem.exists(sourceRoot))
                  yield* Deferred.succeed(ready, undefined)
                  return yield* Effect.never
                })
            )
          }).pipe(
            Effect.provide(
              prReviewSandboxSessionsLayer({ image: IMAGE }).pipe(
                Layer.provide(sourceLayer(sourceRoot))
              )
            ),
            Effect.forkScoped
          )

          yield* Effect.raceFirst(
            Deferred.await(ready),
            Fiber.join(sessionProgram)
          )
          yield* Fiber.interrupt(sessionProgram)

          const container = yield* run("docker", [
            "container",
            "inspect",
            CONTAINER_NAME
          ])
          const volume = yield* run("docker", [
            "volume",
            "inspect",
            VOLUME_NAME
          ])
          assert.notStrictEqual(
            container.exitCode,
            ChildProcessSpawner.ExitCode(0)
          )
          assert.notStrictEqual(
            volume.exitCode,
            ChildProcessSpawner.ExitCode(0)
          )
        })
      ).pipe(Effect.provide(NodeServices.layer)),
    120_000
  )
})
