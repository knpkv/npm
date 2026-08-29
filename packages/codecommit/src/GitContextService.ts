/**
 * Reading a working directory as "a branch checked out against a remote".
 *
 * A service rather than a bare function because this is the one part of
 * `pr open` that talks to the outside world: three local `git` reads. Behind a
 * service tag, a caller's test states the working directory it wants in a line,
 * instead of assembling a {@link ChildProcessSpawner.ChildProcessSpawner} handle
 * to drive `git` it never meant to exercise.
 *
 * @category Service
 * @module
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as GitEnvironment from "./GitEnvironment.js"

/** Why the working directory could not be read as a checked-out branch. */
export const GitContextReason = Schema.Literals([
  "not-a-git-repository",
  "no-remote",
  "detached-head",
  "git-failed"
])
export type GitContextReason = typeof GitContextReason.Type

export class GitContextError extends Schema.TaggedError<GitContextError>()(
  "GitContextError",
  {
    reason: GitContextReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/** A working directory read as a repository root, its chosen remote and the branch on HEAD. */
export interface GitContext {
  readonly branch: string
  readonly remoteUrl: string
  readonly repositoryRoot: string
}

export interface GitContextServiceContract {
  readonly resolve: (input: {
    readonly cwd: string
    readonly remote: string
  }) => Effect.Effect<GitContext, GitContextError>
}

const gitContextFailure = (reason: GitContextReason, message: string, cause?: unknown) =>
  new GitContextError({ reason, message, ...(!(cause === undefined) && { cause }) })

const notRepositoryDiagnostic = (stderr: string): boolean =>
  stderr.startsWith("fatal: not a git repository (or any of the parent directories):")

const missingRemoteDiagnostic = (stderr: string, remote: string): boolean =>
  stderr === `error: No such remote '${remote}'`

const make = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  /**
   * Runs one local `git` read and returns its trimmed stdout.
   *
   * `GitEnvironment.isolated()` is what makes the `cwd` authoritative: without it
   * an inherited `GIT_DIR` — which a Git hook exports — would bind the child to the
   * caller's repository instead of the one being asked about. No credential helper
   * is configured because every read here is local.
   */
  const gitOutput = Effect.fn("GitContextService.gitOutput")(function*(
    repositoryPath: string,
    args: ReadonlyArray<string>
  ) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, {
        cwd: repositoryPath,
        env: { ...GitEnvironment.isolated(), LC_ALL: "C" },
        extendEnv: true,
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe"
      }))
      const [output, stderr] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
      ], { concurrency: "unbounded" })
      const exitCode = yield* handle.exitCode
      return {
        exitCode,
        output: output.replace(/\r?\n$/u, ""),
        stderr: stderr.replace(/\r?\n$/u, "")
      }
    }))
  })

  const resolve: GitContextServiceContract["resolve"] = Effect.fn("GitContextService.resolve")(
    function*(input) {
      const rootResult = yield* gitOutput(input.cwd, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.mapError((cause) => gitContextFailure("git-failed", `Unable to run git in ${input.cwd}`, cause))
      )
      const repositoryRoot = rootResult.output
      if (rootResult.exitCode !== ChildProcessSpawner.ExitCode(0) && notRepositoryDiagnostic(rootResult.stderr)) {
        return yield* gitContextFailure("not-a-git-repository", `${input.cwd} is not inside a git repository`)
      }
      if (rootResult.exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* gitContextFailure("git-failed", `git exited with status ${rootResult.exitCode} in ${input.cwd}`)
      }
      if (repositoryRoot === "") {
        return yield* gitContextFailure("not-a-git-repository", `${input.cwd} is not inside a git repository`)
      }

      const remoteResult = yield* gitOutput(repositoryRoot, ["remote", "get-url", "--", input.remote]).pipe(
        Effect.mapError((cause) => gitContextFailure("git-failed", `Unable to run git in ${repositoryRoot}`, cause))
      )
      const remoteUrl = remoteResult.output
      if (
        remoteResult.exitCode !== ChildProcessSpawner.ExitCode(0) &&
        missingRemoteDiagnostic(remoteResult.stderr, input.remote)
      ) {
        return yield* gitContextFailure("no-remote", `${repositoryRoot} has no '${input.remote}' remote`)
      }
      if (remoteResult.exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* gitContextFailure(
          "git-failed",
          `git remote get-url exited with status ${remoteResult.exitCode} in ${repositoryRoot}`
        )
      }
      if (remoteUrl === "") {
        return yield* gitContextFailure("no-remote", `${repositoryRoot} has no '${input.remote}' remote`)
      }

      const branchResult = yield* gitOutput(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
        Effect.mapError((cause) => gitContextFailure("git-failed", `Unable to read HEAD in ${repositoryRoot}`, cause))
      )
      if (branchResult.exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* gitContextFailure(
          "git-failed",
          `git rev-parse exited with status ${branchResult.exitCode} in ${repositoryRoot}`
        )
      }
      const localBranch = branchResult.output
      // `--abbrev-ref` answers the literal "HEAD" for a detached checkout, which is
      // not a branch any pull request can have as its source.
      if (localBranch === "" || localBranch === "HEAD") {
        return yield* gitContextFailure("detached-head", `${repositoryRoot} has no branch checked out`)
      }

      // A local review branch may track a differently named source branch. Ask
      // Git for structured upstream fields instead of splitting `origin/x` —
      // both remote and branch names may themselves contain slashes.
      const upstreamResult = yield* gitOutput(repositoryRoot, [
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        `refs/heads/${localBranch}`
      ]).pipe(
        Effect.mapError((cause) =>
          gitContextFailure("git-failed", `Unable to read upstream in ${repositoryRoot}`, cause)
        )
      )
      if (upstreamResult.exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* gitContextFailure(
          "git-failed",
          `git for-each-ref exited with status ${upstreamResult.exitCode} in ${repositoryRoot}`
        )
      }
      const [upstreamRemote, upstreamRef] = upstreamResult.output.split("\0")
      const branch =
        upstreamRemote === input.remote && upstreamRef !== undefined && upstreamRef.startsWith("refs/heads/")
          ? upstreamRef.slice("refs/heads/".length)
          : localBranch

      return { branch, remoteUrl, repositoryRoot }
    }
  )

  return { resolve } satisfies GitContextServiceContract
})

/**
 * Reads the repository root, remote and branch for one directory.
 *
 * A non-zero `git` exit and an empty answer are both failures, and they are
 * reported apart: "this is not a repository" and "this repository has no such
 * remote" are different things to tell the caller, and only the second is worth
 * naming a remote in.
 *
 * The spawner's `string` never inspects the exit code, so a `git` that ran and
 * refused answers with empty stdout — which is what the `=== ""` checks
 * diagnose. That leaves the error channel for the case where `git` did not run
 * at all, dominantly because it is not on PATH, and calling that "not a git
 * repository" would point the caller at the wrong prerequisite.
 *
 * @category Service
 */
export class GitContextService extends Context.Service<GitContextService, GitContextServiceContract>()(
  "@knpkv/codecommit/GitContextService"
) {
  static readonly live: Layer.Layer<GitContextService, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
    GitContextService,
    make
  )
}
