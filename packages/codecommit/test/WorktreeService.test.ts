import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { ConfigProvider, Effect, Exit } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { makeWorktreeService } from "../src/WorktreeService.js"

describe("WorktreeService", () => {
  it.live("repairs an incomplete cache and converges concurrent exact-head checkouts", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codecommit-worktree-" })
      const home = path.join(root, "home")
      const seed = path.join(root, "seed")
      const origin = path.join(root, "origin.git")
      yield* fs.makeDirectory(home, { recursive: true })
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
        const service = yield* makeWorktreeService(() => origin)
        const plan = yield* service.preflight({
          account: new Domain.Account({
            profile: Domain.AwsProfileName.make("local-test"),
            region: Domain.AwsRegion.make("eu-west-1")
          }),
          destinationCommit: ReadClient.CodeCommitCommitId.make(destinationCommit),
          pullRequestId: Domain.PullRequestId.make("77"),
          repositoryName: Domain.RepositoryName.make("review-repository"),
          sourceCommit: ReadClient.CodeCommitCommitId.make(sourceCommit)
        })

        yield* fs.makeDirectory(plan.cachePath, { recursive: true })
        yield* fs.writeFileString(path.join(plan.cachePath, "preserve-me"), "not a confirmed interrupted clone")
        const preserved = yield* service.checkout(plan).pipe(Effect.exit)
        expect(Exit.isFailure(preserved)).toBe(true)
        expect(yield* fs.exists(path.join(plan.cachePath, "preserve-me"))).toBe(true)
        yield* fs.remove(plan.cachePath, { recursive: true })
        const repaired = yield* service.checkout(plan)
        expect(repaired.sourceCommit).toBe(sourceCommit)

        const missingTarget = `${plan.targetPath}-moved`
        yield* fs.rename(plan.targetPath, missingTarget)
        const recovered = yield* service.checkout(plan)
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
        const raced = yield* Effect.all([service.checkout(plan), service.checkout(plan)], { concurrency: "unbounded" })

        expect(raced[0].path).toBe(plan.targetPath)
        expect(raced[1].path).toBe(plan.targetPath)
        expect(raced.some((result) => result.reused)).toBe(true)
        expect(yield* runGit(["rev-parse", "HEAD"], plan.targetPath)).toBe(sourceCommit)
        yield* runGit([`--git-dir=${plan.cachePath}`, "cat-file", "-e", `${destinationCommit}^{commit}`])
        yield* runGit([`--git-dir=${plan.cachePath}`, "cat-file", "-e", `${sourceCommit}^{commit}`])
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: home }))
      )

      yield* scenario
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000)
})
