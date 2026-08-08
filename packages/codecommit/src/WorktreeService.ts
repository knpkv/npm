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
import { Config, Context, Effect, Layer, Option, Schema, Stream } from "effect"
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
  readonly destinationCommit: ReadClient.CodeCommitCommitId
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

/** Immutable revisions that must exist before Relay can inspect a checkout. */
export const reviewRevisionSpecifiers = (request: WorktreeRequest): ReadonlyArray<ReadClient.CodeCommitCommitId> => [
  request.destinationCommit,
  request.sourceCommit
]

export interface WorktreeServiceShape {
  readonly preflight: (request: WorktreeRequest) => Effect.Effect<WorktreePlan, WorktreeError>
  readonly checkout: (plan: WorktreePlan) => Effect.Effect<WorktreeResult, WorktreeError>
}

const WorktreeCoordinates = Schema.Struct({
  repositoryAccountId: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isPattern(/^[0-9]{12}$/)
  ),
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
  destinationCommit: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{40}$/)),
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
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 24) || "item"
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 48) || "item"
  return `${safeLabel}-${readable}-${stableHash(`${label}\u0000${value}`)}`
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

const runSucceeds = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: WorktreeRequest,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string }
) =>
  spawner.exitCode(gitCommand(request, args, options)).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: (code) => code === ChildProcessSpawner.ExitCode(0)
    })
  )

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

const isCleanWorktree = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: WorktreeRequest,
  targetPath: string
) =>
  spawner.string(ChildProcess.make("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching"
  ], {
    cwd: targetPath,
    env: gitEnvironment(request),
    extendEnv: true,
    stderr: "ignore",
    stdout: "pipe"
  })).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: (output) => output.length === 0
    })
  )

const isReusableWorktree = Effect.fn("WorktreeService.isReusableWorktree")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: WorktreeRequest,
  targetPath: string
) {
  const exact = yield* isExactHead(spawner, request, targetPath)
  return exact && (yield* isCleanWorktree(spawner, request, targetPath))
})

const LOCK_READY_LINE = "knpkv-codecommit-lock-ready"
const LOCK_HOLDER_SCRIPT = `printf '${LOCK_READY_LINE}\\n'; exec /bin/sleep 2147483647`
export const WORKTREE_LOCK_REQUIREMENT =
  "Checkout requires macOS or Linux with /bin/sh, /bin/sleep, and either lockf or flock"

/** Sidecar advisory lock shared by every process operating on one repository cache. */
export const repositoryLockPath = (cachePath: string): string => `${cachePath}.knpkv.lock`

const lockHolderCommands = (lockPath: string): ReadonlyArray<ChildProcess.Command> => [
  ChildProcess.make("lockf", ["-k", lockPath, "/bin/sh", "-c", LOCK_HOLDER_SCRIPT], {
    stderr: "pipe",
    stdout: "pipe"
  }),
  ChildProcess.make("flock", ["-F", "-x", lockPath, "/bin/sh", "-c", LOCK_HOLDER_SCRIPT], {
    stderr: "pipe",
    stdout: "pipe"
  })
]

const AWS_PARTITION_DNS_SUFFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^us-isob-[a-z0-9-]+-\d+$/u, "sc2s.sgov.gov"],
  [/^us-isof-[a-z0-9-]+-\d+$/u, "csp.hci.ic.gov"],
  [/^us-iso-[a-z0-9-]+-\d+$/u, "c2s.ic.gov"],
  [/^eu-isoe-[a-z0-9-]+-\d+$/u, "cloud.adc-e.uk"],
  [/^eusc-de-[a-z0-9-]+-\d+$/u, "amazonaws.eu"],
  [/^cn-[a-z0-9-]+-\d+$/u, "amazonaws.com.cn"],
  [/^us-gov-[a-z0-9-]+-\d+$/u, "amazonaws.com"],
  [/^(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z0-9-]+-\d+$/u, "amazonaws.com"]
]

const awsPartitionDnsSuffix = (region: string): string | null =>
  AWS_PARTITION_DNS_SUFFIXES.find(([pattern]) => pattern.test(region))?.[1] ?? null

/** Resolves CodeCommit's HTTPS Git endpoint through AWS partition metadata. */
export const codeCommitRemoteUrl = (request: WorktreeRequest): Effect.Effect<string, WorktreeError> => {
  const suffix = awsPartitionDnsSuffix(request.account.region)
  return suffix === null
    ? commandFailure("resolve-git-endpoint", `Unsupported AWS region ${request.account.region}`)
    : Effect.succeed(
      `https://git-codecommit.${request.account.region}.${suffix}/v1/repos/${
        encodeURIComponent(request.repositoryName)
      }`
    )
}

/** Builds the worktree service; the URL seam keeps transport tests local. */
export const makeWorktreeService = (
  remoteUrlFor: (request: WorktreeRequest) => Effect.Effect<string, WorktreeError> = codeCommitRemoteUrl
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* homeDirectory.pipe(
      Effect.mapError((cause) => commandFailure("resolve-home", "HOME or USERPROFILE is required", cause))
    )

    const preflight = Effect.fn("WorktreeService.preflight")(function*(request: WorktreeRequest) {
      const repositoryAccountId = request.account.repoAccountId
      yield* Schema.decodeUnknownEffect(WorktreeCoordinates)({
        destinationCommit: request.destinationCommit,
        repositoryAccountId,
        region: request.account.region,
        repositoryName: request.repositoryName,
        sourceCommit: request.sourceCommit
      }).pipe(
        Effect.mapError((cause) =>
          commandFailure("validate-coordinates", "Invalid CodeCommit worktree coordinates", cause)
        )
      )
      yield* remoteUrlFor(request).pipe(Effect.asVoid)
      const accountSegment = safePathSegment(
        "account",
        `${repositoryAccountId}-${request.account.profile}-${request.account.region}`
      )
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

    interface CheckoutPaths {
      readonly canonicalRepositoriesRoot: string
      readonly canonicalWorktreesRoot: string
      readonly repositoriesRoot: string
      readonly worktreesRoot: string
    }

    const assertContained = (
      operation: string,
      root: string,
      candidate: string
    ): Effect.Effect<void, WorktreeError> => {
      const relative = path.relative(root, candidate)
      const segments = relative.split(/[\\/]/u)
      return path.isAbsolute(relative) || segments[0] === ".."
        ? commandFailure(operation, `Refusing CodeCommit path outside ${root}`)
        : Effect.void
    }

    const assertCanonical = Effect.fn("WorktreeService.assertCanonical")(function*(
      operation: string,
      root: string,
      canonicalRoot: string,
      candidate: string
    ) {
      yield* assertContained(operation, root, candidate)
      const expected = path.join(canonicalRoot, path.relative(root, candidate))
      const actual = yield* fs.realPath(candidate).pipe(
        Effect.mapError((cause) => commandFailure(operation, `Unable to resolve ${candidate}`, cause))
      )
      if (actual !== expected) {
        return yield* commandFailure(operation, `Refusing non-canonical CodeCommit path ${candidate}`)
      }
    })

    const assertNearestExistingParent = Effect.fn("WorktreeService.assertNearestExistingParent")(function*(
      operation: string,
      root: string,
      canonicalRoot: string,
      candidate: string
    ) {
      yield* assertContained(operation, root, candidate)
      let cursor = candidate
      while (
        !(yield* fs.exists(cursor).pipe(
          Effect.mapError((cause) => commandFailure(operation, `Unable to inspect ${cursor}`, cause))
        ))
      ) {
        const parent = path.dirname(cursor)
        if (parent === cursor) return yield* commandFailure(operation, `Unable to locate parent for ${candidate}`)
        cursor = parent
      }
      yield* assertCanonical(operation, root, canonicalRoot, cursor)
    })

    const prepareCheckoutPaths = Effect.fn("WorktreeService.prepareCheckoutPaths")(function*(plan: WorktreePlan) {
      const repositoriesRoot = path.join(home, ".codecommit", "repositories")
      const worktreesRoot = path.join(home, ".codecommit", "worktrees")
      yield* Effect.all([
        Effect.gen(function*() {
          yield* fs.makeDirectory(repositoriesRoot, { mode: 0o700, recursive: true }).pipe(
            Effect.mapError((cause) => commandFailure("create-cache-root", "Unable to create repository root", cause))
          )
          yield* fs.chmod(repositoriesRoot, 0o700).pipe(
            Effect.mapError((cause) =>
              commandFailure("restrict-cache-root", "Unable to restrict repository root", cause)
            )
          )
        }),
        Effect.gen(function*() {
          yield* fs.makeDirectory(worktreesRoot, { mode: 0o700, recursive: true }).pipe(
            Effect.mapError((cause) => commandFailure("create-worktree-root", "Unable to create worktree root", cause))
          )
          yield* fs.chmod(worktreesRoot, 0o700).pipe(
            Effect.mapError((cause) =>
              commandFailure("restrict-worktree-root", "Unable to restrict worktree root", cause)
            )
          )
        })
      ])
      const [canonicalRepositoriesRoot, canonicalWorktreesRoot] = yield* Effect.all([
        fs.realPath(repositoriesRoot).pipe(
          Effect.mapError((cause) => commandFailure("resolve-cache-root", "Unable to resolve repository root", cause))
        ),
        fs.realPath(worktreesRoot).pipe(
          Effect.mapError((cause) => commandFailure("resolve-worktree-root", "Unable to resolve worktree root", cause))
        )
      ])
      const cacheParent = path.dirname(plan.cachePath)
      const targetParent = path.dirname(plan.targetPath)
      yield* assertNearestExistingParent(
        "validate-cache-parent-before-create",
        repositoriesRoot,
        canonicalRepositoriesRoot,
        cacheParent
      )
      yield* assertNearestExistingParent(
        "validate-worktree-parent-before-create",
        worktreesRoot,
        canonicalWorktreesRoot,
        targetParent
      )
      yield* fs.makeDirectory(cacheParent, { recursive: true }).pipe(
        Effect.mapError((cause) => commandFailure("create-cache-directory", "Unable to create repository cache", cause))
      )
      yield* fs.makeDirectory(targetParent, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          commandFailure("create-worktree-directory", "Unable to create worktree directory", cause)
        )
      )
      yield* assertCanonical(
        "validate-cache-parent-after-create",
        repositoriesRoot,
        canonicalRepositoriesRoot,
        cacheParent
      )
      yield* assertCanonical(
        "validate-worktree-parent-after-create",
        worktreesRoot,
        canonicalWorktreesRoot,
        targetParent
      )
      const lockPath = repositoryLockPath(plan.cachePath)
      if (
        yield* fs.exists(lockPath).pipe(
          Effect.mapError((cause) => commandFailure("inspect-repository-lock", `Unable to inspect ${lockPath}`, cause))
        )
      ) {
        yield* assertCanonical("validate-repository-lock", repositoriesRoot, canonicalRepositoriesRoot, lockPath)
      }
      return {
        canonicalRepositoriesRoot,
        canonicalWorktreesRoot,
        repositoriesRoot,
        worktreesRoot
      } satisfies CheckoutPaths
    })

    const spawnLockHolder = (lockPath: string) => {
      const [lockf, flock] = lockHolderCommands(lockPath)
      return spawner.spawn(lockf!).pipe(
        Effect.catch(() => spawner.spawn(flock!)),
        Effect.mapError((cause) =>
          commandFailure("acquire-repository-lock", `${WORKTREE_LOCK_REQUIREMENT}; unable to lock ${lockPath}`, cause)
        )
      )
    }

    const releaseLockHolder = (handle: ChildProcessSpawner.ChildProcessHandle) =>
      handle.isRunning.pipe(
        Effect.flatMap((running) => running ? handle.kill() : Effect.void),
        Effect.ignore
      )

    const withRepositoryLock = <A>(plan: WorktreePlan, effect: Effect.Effect<A, WorktreeError>) =>
      Effect.scoped(
        Effect.acquireUseRelease(
          spawnLockHolder(repositoryLockPath(plan.cachePath)),
          (handle) =>
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runHead,
              Effect.mapError((cause) =>
                commandFailure("acquire-repository-lock", "Unable to read repository lock readiness", cause)
              ),
              Effect.flatMap((line) =>
                Option.isSome(line) && line.value === LOCK_READY_LINE
                  ? Effect.raceFirst(
                    effect,
                    handle.exitCode.pipe(
                      Effect.mapError((cause) =>
                        commandFailure("hold-repository-lock", "Repository lock holder failed", cause)
                      ),
                      Effect.flatMap((exitCode) =>
                        commandFailure("hold-repository-lock", `Repository lock holder exited with code ${exitCode}`)
                      )
                    )
                  )
                  : commandFailure("acquire-repository-lock", "Repository lock holder exited before acquisition")
              )
            ),
          releaseLockHolder
        )
      )

    const checkoutUnlocked = Effect.fn("WorktreeService.checkoutUnlocked")(function*(
      plan: WorktreePlan,
      paths: CheckoutPaths
    ) {
      const { canonicalRepositoriesRoot, canonicalWorktreesRoot, repositoriesRoot, worktreesRoot } = paths
      yield* assertCanonical(
        "revalidate-cache-parent",
        repositoriesRoot,
        canonicalRepositoriesRoot,
        path.dirname(plan.cachePath)
      )
      yield* assertCanonical(
        "validate-acquired-repository-lock",
        repositoriesRoot,
        canonicalRepositoriesRoot,
        repositoryLockPath(plan.cachePath)
      )
      yield* assertCanonical(
        "revalidate-worktree-parent",
        worktreesRoot,
        canonicalWorktreesRoot,
        path.dirname(plan.targetPath)
      )

      const cacheExists = yield* fs.exists(plan.cachePath).pipe(
        Effect.mapError((cause) => commandFailure("inspect-cache", `Unable to inspect ${plan.cachePath}`, cause))
      )
      const remoteUrl = yield* remoteUrlFor(plan)
      if (cacheExists) {
        yield* assertCanonical("validate-cache-path", repositoriesRoot, canonicalRepositoriesRoot, plan.cachePath)
        const validCache = yield* runSucceeds(spawner, plan, [
          `--git-dir=${plan.cachePath}`,
          "rev-parse",
          "--is-bare-repository"
        ])
        if (!validCache) {
          return yield* commandFailure(
            "validate-cache",
            "Repository cache is unreadable; preserving it for manual recovery"
          )
        }
      }

      if (!cacheExists) {
        yield* Effect.scoped(
          Effect.gen(function*() {
            const stagingRoot = yield* fs.makeTempDirectoryScoped({
              directory: path.dirname(plan.cachePath),
              prefix: ".clone-"
            }).pipe(
              Effect.mapError((cause) => commandFailure("stage-cache", "Unable to stage repository cache", cause))
            )
            const stagedCache = path.join(stagingRoot, "repository.git")
            yield* runChecked(spawner, plan, "clone-cache", ["clone", "--bare", remoteUrl, stagedCache]).pipe(
              Effect.flatMap(() =>
                fs.rename(stagedCache, plan.cachePath).pipe(
                  Effect.catch((renameCause) =>
                    runSucceeds(spawner, plan, [
                      `--git-dir=${plan.cachePath}`,
                      "rev-parse",
                      "--is-bare-repository"
                    ]).pipe(
                      Effect.flatMap((wonByAnotherProcess) =>
                        wonByAnotherProcess
                          ? Effect.void
                          : commandFailure("install-cache", "Unable to install repository cache", renameCause)
                      )
                    )
                  )
                )
              )
            )
          })
        )
      } else {
        yield* runChecked(spawner, plan, "update-cache-remote", [
          `--git-dir=${plan.cachePath}`,
          "remote",
          "set-url",
          "origin",
          remoteUrl
        ])
      }

      yield* assertCanonical("validate-ready-cache-path", repositoriesRoot, canonicalRepositoriesRoot, plan.cachePath)

      const [baseAvailable, headAvailable] = yield* Effect.all([
        runSucceeds(spawner, plan, [
          `--git-dir=${plan.cachePath}`,
          "cat-file",
          "-e",
          `${plan.destinationCommit}^{commit}`
        ]),
        runSucceeds(spawner, plan, [`--git-dir=${plan.cachePath}`, "cat-file", "-e", `${plan.sourceCommit}^{commit}`])
      ])
      if (!baseAvailable || !headAvailable) {
        const revisions = reviewRevisionSpecifiers(plan)
        yield* runChecked(spawner, plan, "fetch-review-revisions", [
          `--git-dir=${plan.cachePath}`,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "origin",
          ...revisions
        ])
      }
      yield* Effect.all([
        runChecked(spawner, plan, "verify-base", [
          `--git-dir=${plan.cachePath}`,
          "cat-file",
          "-e",
          `${plan.destinationCommit}^{commit}`
        ]),
        runChecked(spawner, plan, "verify-head", [
          `--git-dir=${plan.cachePath}`,
          "cat-file",
          "-e",
          `${plan.sourceCommit}^{commit}`
        ])
      ])

      const targetExists = yield* fs.exists(plan.targetPath).pipe(
        Effect.mapError((cause) => commandFailure("inspect-target", `Unable to inspect ${plan.targetPath}`, cause))
      )
      if (targetExists) {
        yield* assertCanonical("validate-target-path", worktreesRoot, canonicalWorktreesRoot, plan.targetPath)
        const reusable = yield* isReusableWorktree(spawner, plan, plan.targetPath)
        if (!reusable) {
          return yield* commandFailure(
            "validate-existing-target",
            `Worktree path is dirty or is not at ${plan.sourceCommit}; preserving it for manual recovery`
          )
        }
        return { path: plan.targetPath, reused: true, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
      }

      const addExitCode = yield* spawner.exitCode(gitCommand(plan, [
        `--git-dir=${plan.cachePath}`,
        "worktree",
        "add",
        "--detach",
        plan.targetPath,
        plan.sourceCommit
      ])).pipe(
        Effect.mapError((cause) => commandFailure("add-worktree", "Unable to run git", cause))
      )
      if (addExitCode !== ChildProcessSpawner.ExitCode(0)) {
        let racedTargetExists = yield* fs.exists(plan.targetPath).pipe(
          Effect.mapError((cause) => commandFailure("inspect-raced-target", "Unable to inspect raced worktree", cause))
        )
        if (racedTargetExists) {
          yield* assertCanonical("validate-raced-target-path", worktreesRoot, canonicalWorktreesRoot, plan.targetPath)
          if (yield* isReusableWorktree(spawner, plan, plan.targetPath)) {
            return { path: plan.targetPath, reused: true, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
          }
          return yield* commandFailure(
            "validate-raced-target",
            `Concurrent worktree path is dirty or is not at ${plan.sourceCommit}`
          )
        }

        const removedStaleRegistration = yield* runSucceeds(spawner, plan, [
          `--git-dir=${plan.cachePath}`,
          "worktree",
          "remove",
          "--force",
          plan.targetPath
        ])
        if (removedStaleRegistration) {
          const retryExitCode = yield* spawner.exitCode(gitCommand(plan, [
            `--git-dir=${plan.cachePath}`,
            "worktree",
            "add",
            "--detach",
            plan.targetPath,
            plan.sourceCommit
          ])).pipe(
            Effect.mapError((cause) => commandFailure("retry-add-worktree", "Unable to run git", cause))
          )
          if (retryExitCode === ChildProcessSpawner.ExitCode(0)) {
            yield* assertCanonical(
              "validate-retried-target-path",
              worktreesRoot,
              canonicalWorktreesRoot,
              plan.targetPath
            )
            if (!(yield* isReusableWorktree(spawner, plan, plan.targetPath))) {
              return yield* commandFailure(
                "validate-retried-target",
                "Retried worktree is not a clean exact-head checkout"
              )
            }
            return { path: plan.targetPath, reused: false, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
          }
          racedTargetExists = yield* fs.exists(plan.targetPath).pipe(
            Effect.mapError((cause) =>
              commandFailure("inspect-retried-target", "Unable to inspect retried worktree", cause)
            )
          )
          if (racedTargetExists) {
            yield* assertCanonical(
              "validate-retried-target-path",
              worktreesRoot,
              canonicalWorktreesRoot,
              plan.targetPath
            )
            if (yield* isReusableWorktree(spawner, plan, plan.targetPath)) {
              return { path: plan.targetPath, reused: true, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
            }
          }
          return yield* commandFailure("retry-add-worktree", `git exited with code ${retryExitCode}`)
        }
        return yield* commandFailure("add-worktree", `git exited with code ${addExitCode}`)
      }

      yield* assertCanonical("validate-created-target-path", worktreesRoot, canonicalWorktreesRoot, plan.targetPath)
      if (!(yield* isReusableWorktree(spawner, plan, plan.targetPath))) {
        return yield* commandFailure("validate-created-target", "New worktree is not a clean exact-head checkout")
      }
      return { path: plan.targetPath, reused: false, sourceCommit: plan.sourceCommit } satisfies WorktreeResult
    })

    const checkout = Effect.fn("WorktreeService.checkout")(function*(plan: WorktreePlan) {
      if (path.sep === "\\") return yield* commandFailure("unsupported-platform", WORKTREE_LOCK_REQUIREMENT)
      const paths = yield* prepareCheckoutPaths(plan)
      return yield* withRepositoryLock(plan, checkoutUnlocked(plan, paths))
    })

    return { checkout, preflight } satisfies WorktreeServiceShape
  })

export class WorktreeService extends Context.Service<WorktreeService, WorktreeServiceShape>()(
  "@knpkv/codecommit/WorktreeService"
) {
  static readonly live = Layer.effect(WorktreeService, makeWorktreeService())
}
