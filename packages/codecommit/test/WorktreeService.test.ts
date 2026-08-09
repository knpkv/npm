import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { ConfigProvider, Effect, Exit, Fiber, Option, Sink, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as GitEnvironment from "../src/GitEnvironment.js"
import {
  acquireReadyLockHolder,
  codeCommitRemoteUrl,
  makeCodeCommitGitCommand,
  makeWorktreeService,
  repositoryLockPath,
  WORKTREE_LOCK_REQUIREMENT,
  WorktreeError
} from "../src/WorktreeService.js"

describe("WorktreeService", () => {
  it("owns CodeCommit HTTPS authentication instead of relying on ambient Git helpers", () => {
    const request = {
      account: new Domain.Account({
        profile: Domain.AwsProfileName.make("review-profile"),
        region: Domain.AwsRegion.make("eu-central-1"),
        repoAccountId: "111122223333"
      }),
      destinationCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
      destinationReference: "main",
      pullRequestId: Domain.PullRequestId.make("77"),
      repositoryName: Domain.RepositoryName.make("review-repository"),
      sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
      sourceReference: "feature/review"
    }
    const command = makeCodeCommitGitCommand(request, ["clone", "--bare", "remote", "cache"])

    expect(ChildProcess.isStandardCommand(command)).toBe(true)
    if (!ChildProcess.isStandardCommand(command)) return
    expect(command.args).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.interactive=false",
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!aws codecommit credential-helper $@",
      "-c",
      "credential.UseHttpPath=true",
      "clone",
      "--bare",
      "remote",
      "cache"
    ])
    expect(command.options.extendEnv).toBe(true)
    expect(command.options.env).toMatchObject({
      AWS_PROFILE: "review-profile",
      AWS_REGION: "eu-central-1"
    })
    expect(command.options.env?.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(command.options.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(command.options.env?.AWS_SESSION_TOKEN).toBeUndefined()
  })

  it.effect("falls back when lockf starts but exits before readiness", () =>
    Effect.scoped(Effect.gen(function*() {
      const calls: Array<string> = []
      const makeHandle = (stdoutText: string, running: boolean) =>
        ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(running ? 0 : 1)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(running),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(42),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.make(stdoutText).pipe(Stream.encodeText),
          unref: Effect.succeed(Effect.void)
        })
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected a standard lock command")
        calls.push(command.command)
        return Effect.succeed(
          command.command === "lockf"
            ? makeHandle("", false)
            : makeHandle("knpkv-codecommit-lock-ready\n", true)
        )
      })

      yield* acquireReadyLockHolder(spawner, "/tmp/review.lock")
      expect(calls).toEqual(["lockf", "flock"])
    })))

  it.effect("does not invoke flock after lockf reports readiness", () =>
    Effect.scoped(Effect.gen(function*() {
      const calls: Array<string> = []
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected a standard lock command")
        calls.push(command.command)
        return Effect.succeed(ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(43),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.make("knpkv-codecommit-lock-ready\n").pipe(Stream.encodeText),
          unref: Effect.succeed(Effect.void)
        }))
      })

      yield* acquireReadyLockHolder(spawner, "/tmp/review.lock")
      expect(calls).toEqual(["lockf"])
    })))

  it.live("releases the repository lock when its owner pipe closes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codecommit-owner-lock-" })
      const lockPath = path.join(root, "repository.lock")

      const holder = yield* acquireReadyLockHolder(spawner, lockPath)
      yield* Stream.empty.pipe(Stream.run(holder.stdin))
      expect(yield* holder.exitCode).toBe(ChildProcessSpawner.ExitCode(0))

      const replacement = yield* acquireReadyLockHolder(spawner, lockPath)
      expect(yield* replacement.isRunning).toBe(true)
      yield* replacement.kill()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

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
        destinationReference: "main",
        pullRequestId: Domain.PullRequestId.make("77"),
        repositoryName: Domain.RepositoryName.make("review-repository"),
        sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
        sourceReference: "feature/review"
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

      const firstCollision = yield* service.preflight({
        ...request,
        repositoryName: Domain.RepositoryName.make(
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-12dqrwm0ys00a5"
        )
      })
      const secondCollision = yield* service.preflight({
        ...request,
        repositoryName: Domain.RepositoryName.make(
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0mqk6t416poynr"
        )
      })
      expect(firstCollision.cachePath).not.toBe(secondCollision.cachePath)
      expect(
        (yield* service.preflight({
          ...request,
          repositoryName: firstCollision.repositoryName
        })).cachePath
      ).toBe(firstCollision.cachePath)

      const missingIdentity = yield* service.preflight({
        ...request,
        account: new Domain.Account({
          profile: request.account.profile,
          region: request.account.region
        })
      }).pipe(Effect.flip)
      expect(missingIdentity.operation).toBe("validate-coordinates")

      const invalidReference = yield* service.preflight({
        ...request,
        sourceReference: " feature/review"
      }).pipe(Effect.flip)
      expect(invalidReference.operation).toBe("validate-coordinates")

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
      expect(WORKTREE_LOCK_REQUIREMENT).toContain("/bin/cat")
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
        destinationReference: "main",
        pullRequestId: Domain.PullRequestId.make("77"),
        repositoryName: Domain.RepositoryName.make("review-repository"),
        sourceCommit: commit,
        sourceReference: "feature/review",
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
      const repositoriesRoot = path.join(home, ".codecommit", "repositories")
      const worktreesRoot = path.join(home, ".codecommit", "worktrees")
      yield* fs.makeDirectory(repositoriesRoot, { mode: 0o755, recursive: true })
      yield* fs.chmod(repositoriesRoot, 0o755)
      yield* fs.makeDirectory(seed, { recursive: true })

      const runGit = Effect.fn("WorktreeServiceTest.runGit")(function*(
        args: ReadonlyArray<string>,
        cwd?: string,
        environment: Readonly<Record<string, string | undefined>> = GitEnvironment.isolated()
      ) {
        return yield* spawner.string(ChildProcess.make("git", args, {
          ...(cwd === undefined ? {} : { cwd }),
          env: environment,
          extendEnv: true,
          stderr: "pipe",
          stdout: "pipe"
        })).pipe(Effect.map((output) => output.trim()))
      })

      yield* runGit(["init", "-b", "main"], seed)
      yield* runGit(["config", "user.email", "relay@example.invalid"], seed)
      yield* runGit(["config", "user.name", "Relay Test"], seed)
      yield* fs.writeFileString(path.join(seed, ".gitignore"), ".env\n")
      yield* fs.writeFileString(path.join(seed, "review.txt"), "shared\n")
      yield* runGit(["add", ".gitignore", "review.txt"], seed)
      yield* runGit(["commit", "-m", "base"], seed)
      yield* runGit(["checkout", "-b", "feature"], seed)
      yield* fs.writeFileString(path.join(seed, ".gitattributes"), "* filter=review\n")
      yield* fs.writeFileString(path.join(seed, "feature.txt"), "feature\n")
      yield* runGit(["add", ".gitattributes", "feature.txt"], seed)
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
          destinationReference: "main",
          pullRequestId: Domain.PullRequestId.make("77"),
          repositoryName: Domain.RepositoryName.make("review-repository"),
          sourceCommit: ReadClient.CodeCommitCommitId.make(sourceCommit),
          sourceReference: "feature"
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
        expect((yield* fs.stat(repositoriesRoot)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(worktreesRoot)).mode & 0o777).toBe(0o700)
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

        yield* fs.makeDirectory(plan.cachePath, { recursive: true })
        yield* runGit(["init"], plan.cachePath)
        yield* fs.writeFileString(path.join(plan.cachePath, "preserve-non-bare"), "not a cache")
        const nonBareCacheError = yield* Effect.flip(firstService.checkout(plan))
        expect(nonBareCacheError.operation).toBe("validate-cache")
        expect(yield* fs.exists(path.join(plan.cachePath, "preserve-non-bare"))).toBe(true)
        yield* fs.remove(plan.cachePath, { recursive: true })

        const hooks = path.join(root, "hooks")
        const hookSentinel = path.join(root, "post-checkout-ran")
        const filterSentinel = path.join(root, "smudge-filter-ran")
        const filterScript = path.join(root, "review-smudge")
        yield* fs.makeDirectory(hooks, { recursive: true })
        const postCheckoutHook = path.join(hooks, "post-checkout")
        yield* fs.writeFileString(postCheckoutHook, `#!/bin/sh\nprintf ran > '${hookSentinel}'\n`)
        yield* fs.chmod(postCheckoutHook, 0o700)
        yield* fs.writeFileString(
          filterScript,
          `#!/bin/sh\nprintf ran > '${filterSentinel}'\nexec /bin/cat\n`
        )
        yield* fs.chmod(filterScript, 0o700)
        yield* runGit(["config", "--file", path.join(home, ".gitconfig"), "filter.review.smudge", filterScript])
        yield* runGit(["config", "--file", path.join(home, ".gitconfig"), "filter.review.clean", filterScript])
        yield* runGit(["config", "--file", path.join(home, ".gitconfig"), "filter.review.required", "true"])
        yield* runGit(["clone", "--bare", origin, plan.cachePath], root)
        const filterControl = path.join(root, "filter-control")
        const configuredHome = { ...GitEnvironment.isolated(), HOME: home }
        yield* runGit(
          [
            `--git-dir=${plan.cachePath}`,
            "worktree",
            "add",
            "--detach",
            filterControl,
            sourceCommit
          ],
          root,
          configuredHome
        )
        expect(yield* fs.exists(filterSentinel)).toBe(true)
        yield* runGit([
          `--git-dir=${plan.cachePath}`,
          "worktree",
          "remove",
          "--force",
          filterControl
        ])
        yield* fs.remove(filterSentinel)
        yield* runGit([
          `--git-dir=${plan.cachePath}`,
          "config",
          "core.hooksPath",
          hooks
        ])

        const repaired = yield* firstService.checkout(plan)
        expect(repaired.sourceCommit).toBe(sourceCommit)
        expect(yield* fs.exists(hookSentinel)).toBe(false)
        expect(yield* fs.exists(filterSentinel)).toBe(false)
        expect(yield* fs.readFileString(path.join(plan.targetPath, "feature.txt"))).toBe("feature\n")

        yield* runGit(["switch", "-c", "retained-review-branch"], plan.targetPath)
        const attached = yield* secondService.checkout(plan).pipe(Effect.exit)
        expect(Exit.isFailure(attached)).toBe(true)
        expect(yield* runGit(["symbolic-ref", "HEAD"], plan.targetPath)).toBe("refs/heads/retained-review-branch")
        yield* runGit(["switch", "--detach", sourceCommit], plan.targetPath)
        expect((yield* secondService.checkout(plan)).reused).toBe(true)

        yield* fs.writeFileString(path.join(plan.targetPath, "feature.txt"), "locally modified\n")
        yield* fs.writeFileString(path.join(plan.targetPath, "untracked.txt"), "preserve me\n")
        const dirty = yield* secondService.checkout(plan).pipe(Effect.exit)
        expect(Exit.isFailure(dirty)).toBe(true)
        expect(yield* fs.readFileString(path.join(plan.targetPath, "feature.txt"))).toBe("locally modified\n")
        expect(yield* fs.readFileString(path.join(plan.targetPath, "untracked.txt"))).toBe("preserve me\n")
        yield* runGit(["restore", "feature.txt"], plan.targetPath)
        yield* fs.remove(path.join(plan.targetPath, "untracked.txt"))
        expect((yield* secondService.checkout(plan)).reused).toBe(true)

        yield* fs.writeFileString(path.join(plan.targetPath, ".env"), "LOCAL_SECRET=preserve-me\n")
        const ignored = yield* secondService.checkout(plan).pipe(Effect.exit)
        expect(Exit.isFailure(ignored)).toBe(true)
        expect(yield* fs.readFileString(path.join(plan.targetPath, ".env"))).toBe("LOCAL_SECRET=preserve-me\n")
        yield* fs.remove(path.join(plan.targetPath, ".env"))
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
