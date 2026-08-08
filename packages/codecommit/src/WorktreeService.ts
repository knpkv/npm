/**
 * Exact-head local worktrees for CodeCommit pull requests.
 *
 * A private bare clone is retained under the user's CodeCommit data directory;
 * each PR revision is exposed as a detached worktree. Existing targets are
 * reused only when HEAD is the requested immutable commit.
 *
 * @module
 */
import { ChildEnv, type Domain, type ReadClient } from "@knpkv/codecommit-core"
import { Config, Context, Effect, Layer, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()(
  "WorktreeError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

export interface WorktreeRequest {
  readonly account: Domain.Account
  readonly pullRequestId: Domain.PullRequestId
  readonly repositoryName: Domain.RepositoryName
  readonly sourceCommit: ReadClient.CodeCommitCommitId
}

export interface WorktreePlan extends WorktreeRequest {
  readonly cachePath: string
  readonly targetPath: string
  readonly targetExists: boolean
}

export interface WorktreeResult {
  readonly path: string
  readonly reused: boolean
  readonly sourceCommit: ReadClient.CodeCommitCommitId
}

export interface WorktreeServiceShape {
  readonly preflight: (request: WorktreeRequest) => Effect.Effect<WorktreePlan, WorktreeError>
  readonly checkout: (plan: WorktreePlan) => Effect.Effect<WorktreeResult, WorktreeError>
}

const WorktreeCoordinates = Schema.Struct({
  region: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)+$/),
    Schema.isMaxLength(64)
  ),
  repositoryName: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isPattern(/^[A-Za-z0-9._-]+$/),
    Schema.isMaxLength(100)
  ),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{40}$/))
})

const homeDirectory = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE"))
)

const stableHash = (value: string): string => {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

/** Produces one bounded, traversal-safe path segment while retaining identity. */
export const safePathSegment = (label: string, value: string): string => {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 48) || "item"
  return `${label}-${readable}-${stableHash(value)}`
}

const gitEnvironment = (request: WorktreeRequest) =>
  ChildEnv.profileScopedEnv({
    AWS_PROFILE: request.account.profile,
    AWS_REGION: request.account.region
  })

const gitCommand = (
  request: WorktreeRequest,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {}
) =>
  ChildProcess.make("git", args, {
    ...options,
    env: gitEnvironment(request),
    extendEnv: true,
    stderr: "ignore",
    stdout: "ignore"
  })

const commandFailure = (operation: string, message: string, cause?: unknown) =>
  new WorktreeError({ operation, message, ...(cause === undefined ? {} : { cause }) })

const runChecked = Effect.fn("WorktreeService.runChecked")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: WorktreeRequest,
  operation: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string }
) {
  const exitCode = yield* spawner.exitCode(gitCommand(request, args, options)).pipe(
    Effect.mapError((cause) => commandFailure(operation, "Unable to run git", cause))
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* commandFailure(operation, `git exited with code ${exitCode}`)
  }
})

const isExactHead = Effect.fn("WorktreeService.isExactHead")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: WorktreeRequest,
  targetPath: string
) {
  const isAncestor = (left: string, right: string) =>
    spawner.exitCode(gitCommand(request, ["merge-base", "--is-ancestor", left, right], { cwd: targetPath })).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: (code) => code === ChildProcessSpawner.ExitCode(0)
      })
    )
  const [headBeforeTarget, targetBeforeHead] = yield* Effect.all([
    isAncestor("HEAD", request.sourceCommit),
    isAncestor(request.sourceCommit, "HEAD")
  ])
  return headBeforeTarget && targetBeforeHead
})

const makeService = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* homeDirectory.pipe(
    Effect.mapError((cause) => commandFailure("resolve-home", "HOME or USERPROFILE is required", cause))
  )

  const preflight = Effect.fn("WorktreeService.preflight")(function*(request: WorktreeRequest) {
    yield* Schema.decodeUnknownEffect(WorktreeCoordinates)({
      region: request.account.region,
      repositoryName: request.repositoryName,
      sourceCommit: request.sourceCommit
    }).pipe(
      Effect.mapError((cause) =>
        commandFailure("validate-coordinates", "Invalid CodeCommit worktree coordinates", cause)
      )
    )
    const accountSegment = safePathSegment("account", `${request.account.profile}-${request.account.region}`)
    const repositorySegment = safePathSegment("repo", request.repositoryName)
    const revisionSegment = safePathSegment(
      `pr-${request.pullRequestId}`,
      `${request.pullRequestId}-${request.sourceCommit}`
    )
    const root = path.join(home, ".codecommit")
    const cachePath = path.join(root, "repositories", accountSegment, `${repositorySegment}.git`)
    const targetPath = path.join(root, "worktrees", accountSegment, repositorySegment, revisionSegment)
    const targetExists = yield* fs.exists(targetPath).pipe(
      Effect.mapError((cause) => commandFailure("inspect-target", `Unable to inspect ${targetPath}`, cause))
    )
    return { ...request, cachePath, targetPath, targetExists } satisfies WorktreePlan
  })

  const checkout = Effect.fn("WorktreeService.checkout")(function*(plan: WorktreePlan) {
    const targetExists = yield* fs.exists(plan.targetPath).pipe(
      Effect.mapError((cause) => commandFailure("inspect-target", `Unable to inspect ${plan.targetPath}`, cause))
    )
    if (targetExists) {
      const exact = yield* isExactHead(spawner, plan, plan.targetPath)
      if (!exact) {
        return yield* commandFailure(
          "validate-existing-target",
          `Worktree path exists but is not at ${plan.sourceCommit}`
        )
      }
      return { path: plan.targetPath, reused: true, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
    }

    yield* fs.makeDirectory(path.dirname(plan.cachePath), { recursive: true }).pipe(
      Effect.mapError((cause) => commandFailure("create-cache-directory", "Unable to create repository cache", cause))
    )
    yield* fs.makeDirectory(path.dirname(plan.targetPath), { recursive: true }).pipe(
      Effect.mapError((cause) =>
        commandFailure("create-worktree-directory", "Unable to create worktree directory", cause)
      )
    )

    const cacheExists = yield* fs.exists(plan.cachePath).pipe(
      Effect.mapError((cause) => commandFailure("inspect-cache", `Unable to inspect ${plan.cachePath}`, cause))
    )
    const remoteUrl = `https://git-codecommit.${plan.account.region}.amazonaws.com/v1/repos/${
      encodeURIComponent(plan.repositoryName)
    }`
    if (!cacheExists) {
      yield* runChecked(spawner, plan, "clone-cache", ["clone", "--bare", remoteUrl, plan.cachePath])
    } else {
      yield* runChecked(spawner, plan, "update-cache-remote", [
        `--git-dir=${plan.cachePath}`,
        "remote",
        "set-url",
        "origin",
        remoteUrl
      ])
    }

    yield* runChecked(spawner, plan, "fetch-head", [
      `--git-dir=${plan.cachePath}`,
      "fetch",
      "--no-tags",
      "origin",
      plan.sourceCommit
    ])
    yield* runChecked(spawner, plan, "add-worktree", [
      `--git-dir=${plan.cachePath}`,
      "worktree",
      "add",
      "--detach",
      plan.targetPath,
      plan.sourceCommit
    ])

    return { path: plan.targetPath, reused: false, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
  })

  return { checkout, preflight } satisfies WorktreeServiceShape
})

export class WorktreeService extends Context.Service<WorktreeService, WorktreeServiceShape>()(
  "@knpkv/codecommit/WorktreeService"
) {
  static readonly live = Layer.effect(WorktreeService, makeService)
}
