/** Scoped Git remote whose advertised source ref follows the mock PR head. @module */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

const REPOSITORY_NAME = "payments-api"
const SOURCE_REFERENCE = "refs/heads/feature/idempotency"
const DESTINATION_REFERENCE = "refs/heads/main"

export const BASE_RETRY_SOURCE = "export const retry = (run: () => Promise<void>) => run()\n"
export const REVISION_ONE_RETRY_SOURCE = "export const retry = (key: string, run: () => Promise<void>) => run()\n"
export const REVISION_TWO_RETRY_SOURCE =
  "export const retry = async (key: string, run: () => Promise<void>) => {\n  await persist(key)\n  return run()\n}\n"
export const REVISION_TWO_TEST_SOURCE = "it('reuses the key', async () => {})\n"

const GitObjectId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{40}$/u, { expected: "a full SHA-1 Git object identifier" })
)

/** Git subprocess or fixture construction failed without exposing its private path. */
export class CodeCommitGitFixtureError extends Schema.TaggedError<CodeCommitGitFixtureError>()(
  "CodeCommitGitFixtureError",
  { operation: Schema.String }
) {}

export interface CodeCommitGitFixtureRevisions {
  readonly base: string
  readonly firstHead: string
  readonly secondHead: string
  readonly baseRetryBlob: string
  readonly firstRetryBlob: string
  readonly secondRetryBlob: string
  readonly secondTestBlob: string
}

/** Server-private local Git locator and the transitions coupled to mock state. */
export interface CodeCommitGitFixture {
  readonly repositoryName: string
  readonly cloneUrl: string
  readonly revisions: CodeCommitGitFixtureRevisions
  readonly advance: Effect.Effect<void, CodeCommitGitFixtureError>
  readonly reset: Effect.Effect<void, CodeCommitGitFixtureError>
}

const gitEnvironment = {
  GIT_AUTHOR_DATE: "2026-08-28T10:00:00Z",
  GIT_AUTHOR_EMAIL: "codecommit-mock@example.invalid",
  GIT_AUTHOR_NAME: "CodeCommit Mock",
  GIT_COMMITTER_DATE: "2026-08-28T10:00:00Z",
  GIT_COMMITTER_EMAIL: "codecommit-mock@example.invalid",
  GIT_COMMITTER_NAME: "CodeCommit Mock",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LANG: "C",
  LC_ALL: "C"
} satisfies Readonly<Record<string, string>>

const gitError = (operation: string) => new CodeCommitGitFixtureError({ operation })

/** Create one deterministic Git commit graph and expose rev1 through a bare file remote. */
export const makeCodeCommitGitFixture = Effect.fn("CodeCommitGitFixture.make")(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-mock-git-" }).pipe(
    Effect.mapError(() => gitError("create-root"))
  )
  const sourceRoot = path.join(root, "source")
  const remoteRoot = path.join(root, `${REPOSITORY_NAME}.git`)
  const retryPath = path.join(sourceRoot, "src", "retry.ts")
  const testPath = path.join(sourceRoot, "test", "retry.test.ts")

  const runGit = Effect.fn("CodeCommitGitFixture.runGit")(function*(
    operation: string,
    args: ReadonlyArray<string>
  ) {
    return yield* spawner.string(ChildProcess.make("git", args, {
      env: gitEnvironment,
      extendEnv: true,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe"
    })).pipe(
      Effect.map((output) => output.trim()),
      Effect.mapError(() => gitError(operation))
    )
  })

  const revision = Effect.fn("CodeCommitGitFixture.revision")(function*(specifier: string) {
    return yield* Schema.decodeUnknownEffect(GitObjectId)(
      yield* runGit("resolve-revision", ["-C", sourceRoot, "rev-parse", "--verify", specifier])
    ).pipe(Effect.mapError(() => gitError("decode-revision")))
  })

  yield* fileSystem.makeDirectory(path.dirname(retryPath), { recursive: true }).pipe(
    Effect.mapError(() => gitError("create-source-directory"))
  )
  yield* fileSystem.makeDirectory(path.dirname(testPath), { recursive: true }).pipe(
    Effect.mapError(() => gitError("create-test-directory"))
  )
  yield* runGit("initialize-source", ["init", "--quiet", "--initial-branch=main", "--", sourceRoot])
  yield* fileSystem.writeFileString(retryPath, BASE_RETRY_SOURCE).pipe(
    Effect.mapError(() => gitError("write-base-source"))
  )
  yield* runGit("stage-base", ["-C", sourceRoot, "add", "--", "src/retry.ts"])
  yield* runGit("commit-base", ["-C", sourceRoot, "commit", "--quiet", "-m", "Add retry helper"])
  const base = yield* revision("HEAD")
  const baseRetryBlob = yield* revision(`${base}:src/retry.ts`)

  yield* runGit("create-source-branch", ["-C", sourceRoot, "switch", "--quiet", "-c", "feature/idempotency"])
  yield* fileSystem.writeFileString(retryPath, REVISION_ONE_RETRY_SOURCE).pipe(
    Effect.mapError(() => gitError("write-first-source"))
  )
  yield* runGit("stage-first-revision", ["-C", sourceRoot, "add", "--", "src/retry.ts"])
  yield* runGit("commit-first-revision", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "-m",
    "Carry idempotency key through retry"
  ])
  const firstHead = yield* revision("HEAD")
  const firstRetryBlob = yield* revision(`${firstHead}:src/retry.ts`)

  yield* runGit("initialize-remote", ["init", "--quiet", "--bare", "--initial-branch=main", "--", remoteRoot])
  yield* runGit("publish-initial-refs", [
    "-C",
    sourceRoot,
    "push",
    "--quiet",
    "--",
    remoteRoot,
    `${base}:${DESTINATION_REFERENCE}`,
    `${firstHead}:${SOURCE_REFERENCE}`
  ])

  yield* fileSystem.writeFileString(retryPath, REVISION_TWO_RETRY_SOURCE).pipe(
    Effect.mapError(() => gitError("write-second-source"))
  )
  yield* fileSystem.writeFileString(testPath, REVISION_TWO_TEST_SOURCE).pipe(
    Effect.mapError(() => gitError("write-second-test"))
  )
  yield* runGit("stage-second-revision", ["-C", sourceRoot, "add", "--", "src/retry.ts", "test/retry.test.ts"])
  yield* runGit("commit-second-revision", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "-m",
    "Persist idempotency key before retry"
  ])
  const secondHead = yield* revision("HEAD")
  const secondRetryBlob = yield* revision(`${secondHead}:src/retry.ts`)
  const secondTestBlob = yield* revision(`${secondHead}:test/retry.test.ts`)
  const canonicalRemote = yield* fileSystem.realPath(remoteRoot).pipe(
    Effect.mapError(() => gitError("resolve-remote"))
  )
  const cloneUrl = yield* path.toFileUrl(canonicalRemote).pipe(
    Effect.mapError(() => gitError("encode-remote-url")),
    Effect.map(String)
  )

  const moveSourceRef = (operation: string, target: string) =>
    runGit(operation, [
      "-C",
      sourceRoot,
      "push",
      "--force",
      "--quiet",
      "--",
      remoteRoot,
      `${target}:${SOURCE_REFERENCE}`
    ]).pipe(Effect.asVoid)

  return {
    repositoryName: REPOSITORY_NAME,
    cloneUrl,
    revisions: {
      base,
      firstHead,
      secondHead,
      baseRetryBlob,
      firstRetryBlob,
      secondRetryBlob,
      secondTestBlob
    },
    advance: moveSourceRef("advance-source-ref", secondHead),
    reset: moveSourceRef("reset-source-ref", firstHead)
  } satisfies CodeCommitGitFixture
})
