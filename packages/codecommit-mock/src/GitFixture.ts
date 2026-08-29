/** Scoped Git remote whose advertised source ref follows the mock PR head. @module */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"

const REPOSITORY_NAME = "payments-api"
const SOURCE_REFERENCE = "refs/heads/feature/idempotency"
const DESTINATION_REFERENCE = "refs/heads/main"

export const BASE_RETRY_SOURCE = "export const retry = (run: () => Promise<void>) => run()\n"
export const REVISION_ONE_RETRY_SOURCE = "export const retry = (key: string, run: () => Promise<void>) => run()\n"
export const REVISION_TWO_RETRY_SOURCE =
  "const outcomes = new Map<string, Promise<void>>()\n\nexport const retry = (key: string, run: () => Promise<void>) => {\n  const existing = outcomes.get(key)\n  if (existing !== undefined) return existing\n  const outcome = run()\n  outcomes.set(key, outcome)\n  return outcome\n}\n"
export const REVISION_TWO_TEST_SOURCE = [
  "import { retry } from \"../src/retry.ts\"",
  "",
  "let calls = 0",
  "await retry(\"payment-17\", async () => { calls += 1 })",
  "await retry(\"payment-17\", async () => { calls += 1 })",
  "await retry(\"payment-18\", async () => { calls += 1 })",
  "if (calls !== 2) throw new Error(`expected two operations, received ${String(calls)}`)",
  ""
].join("\n")

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
  readonly firstTestBlob: string
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

const OVERRIDING_GIT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE"
]

const isOverridingGitVariable = (name: string): boolean => {
  const canonical = name.toUpperCase()
  return (
    OVERRIDING_GIT_VARIABLES.some((candidate) => candidate === canonical) ||
    canonical.startsWith("GIT_CONFIG_KEY_") ||
    canonical.startsWith("GIT_CONFIG_VALUE_")
  )
}

const gitEnvironment = (inherited: Record<string, string | undefined>) => ({
  ...Object.fromEntries(OVERRIDING_GIT_VARIABLES.map((name) => [name, undefined])),
  ...Object.fromEntries(
    Object.keys(inherited)
      .filter(isOverridingGitVariable)
      .map((name) => [name, undefined])
  ),
  GIT_AUTHOR_DATE: "2026-08-28T10:00:00Z",
  GIT_AUTHOR_EMAIL: "codecommit-mock@example.invalid",
  GIT_AUTHOR_NAME: "CodeCommit Mock",
  GIT_COMMITTER_DATE: "2026-08-28T10:00:00Z",
  GIT_COMMITTER_EMAIL: "codecommit-mock@example.invalid",
  GIT_COMMITTER_NAME: "CodeCommit Mock",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DEFAULT_HASH: "sha1",
  LANG: "C",
  LC_ALL: "C"
})

const gitError = (operation: string) => new CodeCommitGitFixtureError({ operation })

/** Create one deterministic Git commit graph and expose rev1 through a bare file remote. */
export const makeCodeCommitGitFixture = Effect.fn("CodeCommitGitFixture.make")(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const host = yield* ChildEnv.HostEnvironment
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "codecommit-mock-git-" })
    .pipe(Effect.mapError(() => gitError("create-root")))
  const sourceRoot = path.join(root, "source")
  const remoteRoot = path.join(root, `${REPOSITORY_NAME}.git`)
  const retryPath = path.join(sourceRoot, "src", "retry.ts")
  const testPath = path.join(sourceRoot, "test", "retry.test.ts")

  const runGit = Effect.fn("CodeCommitGitFixture.runGit")(function*(operation: string, args: ReadonlyArray<string>) {
    return yield* spawner
      .string(
        ChildProcess.make("git", args, {
          env: gitEnvironment(host.variables),
          extendEnv: true,
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe"
        })
      )
      .pipe(
        Effect.map((output) => output.trim()),
        Effect.mapError(() => gitError(operation))
      )
  })

  const revision = Effect.fn("CodeCommitGitFixture.revision")(function*(specifier: string) {
    return yield* Schema.decodeUnknownEffect(GitObjectId)(
      yield* runGit("resolve-revision", ["-C", sourceRoot, "rev-parse", "--verify", specifier])
    ).pipe(Effect.mapError(() => gitError("decode-revision")))
  })

  yield* fileSystem
    .makeDirectory(path.dirname(retryPath), { recursive: true })
    .pipe(Effect.mapError(() => gitError("create-source-directory")))
  yield* fileSystem
    .makeDirectory(path.dirname(testPath), { recursive: true })
    .pipe(Effect.mapError(() => gitError("create-test-directory")))
  yield* runGit("initialize-source", ["init", "--quiet", "--initial-branch=main", "--", sourceRoot])
  yield* fileSystem
    .writeFileString(retryPath, BASE_RETRY_SOURCE)
    .pipe(Effect.mapError(() => gitError("write-base-source")))
  yield* runGit("stage-base", ["-C", sourceRoot, "add", "--", "src/retry.ts"])
  yield* runGit("commit-base", ["-C", sourceRoot, "commit", "--quiet", "-m", "Add retry helper"])
  const base = yield* revision("HEAD")
  const baseRetryBlob = yield* revision(`${base}:src/retry.ts`)

  yield* runGit("create-source-branch", ["-C", sourceRoot, "switch", "--quiet", "-c", "feature/idempotency"])
  yield* fileSystem
    .writeFileString(retryPath, REVISION_ONE_RETRY_SOURCE)
    .pipe(Effect.mapError(() => gitError("write-first-source")))
  yield* runGit("stage-first-revision", ["-C", sourceRoot, "add", "--", "src/retry.ts"])
  yield* fileSystem
    .writeFileString(testPath, REVISION_TWO_TEST_SOURCE)
    .pipe(Effect.mapError(() => gitError("write-first-test")))
  yield* runGit("stage-first-test", ["-C", sourceRoot, "add", "--", "test/retry.test.ts"])
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
  const firstTestBlob = yield* revision(`${firstHead}:test/retry.test.ts`)

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

  yield* fileSystem
    .writeFileString(retryPath, REVISION_TWO_RETRY_SOURCE)
    .pipe(Effect.mapError(() => gitError("write-second-source")))
  yield* runGit("stage-second-revision", ["-C", sourceRoot, "add", "--", "src/retry.ts"])
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
  const canonicalRemote = yield* fileSystem.realPath(remoteRoot).pipe(Effect.mapError(() => gitError("resolve-remote")))
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
      firstTestBlob,
      secondRetryBlob,
      secondTestBlob
    },
    advance: moveSourceRef("advance-source-ref", secondHead),
    reset: moveSourceRef("reset-source-ref", firstHead)
  } satisfies CodeCommitGitFixture
})
