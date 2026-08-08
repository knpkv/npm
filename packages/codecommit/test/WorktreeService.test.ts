import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { ConfigProvider, Effect, Exit, Fiber, Option, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import {
  codeCommitRemoteUrl,
  makeWorktreeService,
  repositoryLockPath,
  WORKTREE_LOCK_REQUIREMENT,
  WorktreeError
} from "../src/WorktreeService.js"

describe("WorktreeService", () => {
  it.effect("isolates repository accounts and resolves partition-aware Git endpoints", () =>
    Effect.gen(function*() {
      const service = yield* makeWorktreeService()
      const request = {
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make("shared-profile"),
          region: Domain.AwsRegion.make("eu-west-1"),
          repoAccountId: "111122223333"
        }),
        destinationCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
        pullRequestId: Domain.PullRequestId.make("77"),
        repositoryName: Domain.RepositoryName.make("review-repository"),
        sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40))
      }
      const first = yield* service.preflight(request)
      const sameAccount = yield* service.preflight({
        ...request,
        account: new Domain.Account({
          profile: request.account.profile,
          region: request.account.region,
          repoAccountId: request.account.repoAccountId
        })
      })
      const otherAccount = yield* service.preflight({
        ...request,
        account: new Domain.Account({
          profile: request.account.profile,
          region: request.account.region,
          repoAccountId: "999900001111"
        })
      })

      expect(sameAccount.cachePath).toBe(first.cachePath)
      expect(sameAccount.targetPath).toBe(first.targetPath)
      expect(otherAccount.cachePath).not.toBe(first.cachePath)
      expect(otherAccount.targetPath).not.toBe(first.targetPath)

      const missingIdentity = yield* service.preflight({
        ...request,
        account: new Domain.Account({
          profile: request.account.profile,
          region: request.account.region
        })
      }).pipe(Effect.flip)
      expect(missingIdentity.operation).toBe("validate-coordinates")

      expect(yield* codeCommitRemoteUrl(request)).toBe(
        "https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/review-repository"
      )
      expect(
        yield* codeCommitRemoteUrl({
          ...request,
          account: new Domain.Account({
            profile: request.account.profile,
            region: Domain.AwsRegion.make("cn-north-1"),
            repoAccountId: request.account.repoAccountId
          })
        })
      ).toBe("https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/review-repository")
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ HOME: "/tmp/codecommit-worktree-coordinate-test" })
      ),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("states every required lock-holder executable in unsupported-platform failures", () =>
    Effect.gen(function*() {
      expect(WORKTREE_LOCK_REQUIREMENT).toContain("macOS or Linux")
      expect(WORKTREE_LOCK_REQUIREMENT).toContain("/bin/sh")
      expect(WORKTREE_LOCK_REQUIREMENT).toContain("/bin/sleep")
      expect(WORKTREE_LOCK_REQUIREMENT).toContain("lockf or flock")

      const nativePath = yield* Path.Path
      const windowsPath: Path.Path = { ...nativePath, sep: "\\" }
      const service = yield* makeWorktreeService().pipe(Effect.provideService(Path.Path, windowsPath))
      const commit = ReadClient.CodeCommitCommitId.make("a".repeat(40))
      const error = yield* Effect.flip(service.checkout({
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make("local-test"),
          region: Domain.AwsRegion.make("eu-west-1")
        }),
        cachePath: "C:\\codecommit\\repositories\\review.git",
        destinationCommit: commit,
        pullRequestId: Domain.PullRequestId.make("77"),
        repositoryName: Domain.RepositoryName.make("review-repository"),
        sourceCommit: commit,
        targetExists: false,
        targetPath: "C:\\codecommit\\worktrees\\review"
      }))

      expect(error).toBeInstanceOf(WorktreeError)
      expect(error.operation).toBe("unsupported-platform")
      expect(error.message).toBe(WORKTREE_LOCK_REQUIREMENT)
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ HOME: "/tmp/codecommit-unsupported-platform" })
      ),
      Effect.provide(NodeServices.layer)
    ))

  it.live("repairs an incomplete cache and converges concurrent exact-head checkouts", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codecommit-worktree-" })
      const home = path.join(root, "home")
      const dataRoot = path.join(root, "codecommit-data")
      const seed = path.join(root, "seed")
      const origin = path.join(root, "origin.git")
      yield* fs.makeDirectory(home, { recursive: true })
      yield* fs.makeDirectory(dataRoot, { recursive: true })
      yield* fs.symlink(dataRoot, path.join(home, ".codecommit"))
      yield* fs.makeDirectory(seed, { recursive: true })

      const runGit = Effect.fn("WorktreeServiceTest.runGit")(function*(
        args: ReadonlyArray<string>,
        cwd?: string
      ) {
        return yield* spawner.string(ChildProcess.make("git", args, {
          ...(cwd === undefined ? {} : { cwd }),
          stderr: "pipe",
          stdout: "pipe"
        })).pipe(Effect.map((output) => output.trim()))
      })

      yield* runGit(["init", "-b", "main"], seed)
      yield* runGit(["config", "user.email", "relay@example.invalid"], seed)
      yield* runGit(["config", "user.name", "Relay Test"], seed)
      yield* fs.writeFileString(path.join(seed, "review.txt"), "shared\n")
      yield* runGit(["add", "review.txt"], seed)
      yield* runGit(["commit", "-m", "base"], seed)
      yield* runGit(["checkout", "-b", "feature"], seed)
      yield* fs.writeFileString(path.join(seed, "feature.txt"), "feature\n")
      yield* runGit(["add", "feature.txt"], seed)
      yield* runGit(["commit", "-m", "feature"], seed)
      const sourceCommit = yield* runGit(["rev-parse", "HEAD"], seed)
      yield* runGit(["checkout", "main"], seed)
      yield* fs.writeFileString(path.join(seed, "destination.txt"), "destination\n")
      yield* runGit(["add", "destination.txt"], seed)
      yield* runGit(["commit", "-m", "destination"], seed)
      const destinationCommit = yield* runGit(["rev-parse", "HEAD"], seed)
      yield* runGit(["clone", "--bare", seed, origin], root)

      const scenario = Effect.gen(function*() {
        const firstService = yield* makeWorktreeService(() => Effect.succeed(origin))
        const secondService = yield* makeWorktreeService(() => Effect.succeed(origin))
        const request = {
          account: new Domain.Account({
            profile: Domain.AwsProfileName.make("local-test"),
            region: Domain.AwsRegion.make("eu-west-1"),
            repoAccountId: "111122223333"
          }),
          destinationCommit: ReadClient.CodeCommitCommitId.make(destinationCommit),
          pullRequestId: Domain.PullRequestId.make("77"),
          repositoryName: Domain.RepositoryName.make("review-repository"),
          sourceCommit: ReadClient.CodeCommitCommitId.make(sourceCommit)
        }
        const plan = yield* firstService.preflight(request)

        const escapedPlan = yield* firstService.preflight({
          ...request,
          pullRequestId: Domain.PullRequestId.make("../../../../../tmp\\escape")
        })
        expect(escapedPlan.targetPath.startsWith(path.join(home, ".codecommit", "worktrees"))).toBe(true)
        expect(path.relative(path.join(home, ".codecommit", "worktrees"), escapedPlan.targetPath)).not.toMatch(/^\.\./u)

        const externalCache = path.join(root, "external-cache")
        const externalWorktree = path.join(root, "external-worktree")
        yield* fs.makeDirectory(externalCache, { recursive: true })
        yield* fs.makeDirectory(externalWorktree, { recursive: true })
        const cacheParent = path.dirname(plan.cachePath)
        yield* fs.makeDirectory(path.dirname(cacheParent), { recursive: true })
        yield* fs.symlink(externalCache, cacheParent)
        const cacheSymlinkError = yield* Effect.flip(firstService.checkout(plan))
        expect(cacheSymlinkError.operation).toBe("validate-cache-parent-before-create")
        expect(yield* fs.readDirectory(externalCache)).toEqual([])
        yield* fs.remove(cacheParent)

        const targetParent = path.dirname(plan.targetPath)
        yield* fs.makeDirectory(path.dirname(targetParent), { recursive: true })
        yield* fs.symlink(externalWorktree, targetParent)
        const worktreeSymlinkError = yield* Effect.flip(firstService.checkout(plan))
        expect(worktreeSymlinkError.operation).toBe("validate-worktree-parent-before-create")
        expect(yield* fs.readDirectory(externalWorktree)).toEqual([])
        yield* fs.remove(targetParent)

        yield* fs.makeDirectory(plan.cachePath, { recursive: true })
        yield* fs.writeFileString(path.join(plan.cachePath, "preserve-me"), "not a confirmed interrupted clone")
        const unconfirmedCacheError = yield* Effect.flip(firstService.checkout(plan))
        expect(unconfirmedCacheError.operation).toBe("validate-cache")
        expect(yield* fs.exists(path.join(plan.cachePath, "preserve-me"))).toBe(true)
        yield* fs.remove(plan.cachePath, { recursive: true })
        const repaired = yield* firstService.checkout(plan)
        expect(repaired.sourceCommit).toBe(sourceCommit)

        yield* fs.writeFileString(path.join(plan.targetPath, "feature.txt"), "locally modified\n")
        yield* fs.writeFileString(path.join(plan.targetPath, "untracked.txt"), "preserve me\n")
        const dirty = yield* secondService.checkout(plan).pipe(Effect.exit)
        expect(Exit.isFailure(dirty)).toBe(true)
        expect(yield* fs.readFileString(path.join(plan.targetPath, "feature.txt"))).toBe("locally modified\n")
        expect(yield* fs.readFileString(path.join(plan.targetPath, "untracked.txt"))).toBe("preserve me\n")
        yield* runGit(["restore", "feature.txt"], plan.targetPath)
        yield* fs.remove(path.join(plan.targetPath, "untracked.txt"))
        expect((yield* secondService.checkout(plan)).reused).toBe(true)

        const missingTarget = `${plan.targetPath}-moved`
        yield* fs.rename(plan.targetPath, missingTarget)
        const recovered = yield* secondService.checkout(plan)
        expect(recovered.path).toBe(plan.targetPath)
        expect(recovered.reused).toBe(false)
        expect(yield* runGit(["rev-parse", "HEAD"], plan.targetPath)).toBe(sourceCommit)

        yield* runGit([
          `--git-dir=${plan.cachePath}`,
          "worktree",
          "remove",
          "--force",
          plan.targetPath
        ])
        const raced = yield* Effect.all([firstService.checkout(plan), secondService.checkout(plan)], {
          concurrency: "unbounded"
        })

        expect(raced[0].path).toBe(plan.targetPath)
        expect(raced[1].path).toBe(plan.targetPath)
        expect(raced.some((result) => result.reused)).toBe(true)
        expect(yield* runGit(["rev-parse", "HEAD"], plan.targetPath)).toBe(sourceCommit)

        const lockPath = repositoryLockPath(plan.cachePath)
        const lockScript = "printf 'test-lock-ready\\n'; exec /bin/sleep 2147483647"
        const spawnHolder = spawner.spawn(ChildProcess.make("lockf", [
          "-k",
          lockPath,
          "/bin/sh",
          "-c",
          lockScript
        ], { stderr: "pipe", stdout: "pipe" })).pipe(
          Effect.catch(() =>
            spawner.spawn(ChildProcess.make("flock", [
              "-F",
              "-x",
              lockPath,
              "/bin/sh",
              "-c",
              lockScript
            ], { stderr: "pipe", stdout: "pipe" }))
          )
        )
        const holder = yield* spawnHolder
        yield* Effect.addFinalizer(() =>
          holder.isRunning.pipe(
            Effect.flatMap((running) => running ? holder.kill({ killSignal: "SIGKILL" }) : Effect.void),
            Effect.ignore
          )
        )
        const holderReady = yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
        expect(Option.getOrUndefined(holderReady)).toBe("test-lock-ready")
        const waitingCheckout = yield* secondService.checkout(plan).pipe(Effect.forkChild({ startImmediately: true }))
        for (let schedulerYield = 0; schedulerYield < 100; schedulerYield += 1) yield* Effect.yieldNow
        expect(waitingCheckout.pollUnsafe()).toBeUndefined()
        yield* holder.kill({ killSignal: "SIGKILL" })
        expect((yield* Fiber.join(waitingCheckout)).reused).toBe(true)

        const otherPlan = yield* firstService.preflight({
          ...request,
          pullRequestId: Domain.PullRequestId.make("78"),
          repositoryName: Domain.RepositoryName.make("review-repository-two")
        })
        const independent = yield* Effect.all([
          firstService.checkout(plan),
          secondService.checkout(otherPlan)
        ], { concurrency: "unbounded" })
        expect(otherPlan.cachePath).not.toBe(plan.cachePath)
        expect(otherPlan.targetPath).not.toBe(plan.targetPath)
        expect(independent[0]).toMatchObject({ path: plan.targetPath, sourceCommit })
        expect(independent[1]).toMatchObject({ path: otherPlan.targetPath, sourceCommit })
        expect(yield* runGit(["rev-parse", "HEAD"], plan.targetPath)).toBe(sourceCommit)
        expect(yield* runGit(["rev-parse", "HEAD"], otherPlan.targetPath)).toBe(sourceCommit)
        for (const cachePath of [plan.cachePath, otherPlan.cachePath]) {
          yield* runGit([`--git-dir=${cachePath}`, "cat-file", "-e", `${destinationCommit}^{commit}`])
          yield* runGit([`--git-dir=${cachePath}`, "cat-file", "-e", `${sourceCommit}^{commit}`])
        }
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: home }))
      )

      yield* scenario
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)
})
