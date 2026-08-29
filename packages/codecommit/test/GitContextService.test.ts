/**
 * Unit tests for reading a working directory as a checked-out branch.
 *
 * The spawner is stubbed rather than faked at the service tag, because these are
 * the tests that own the `git`-shaped behaviour: which reads run, and how a
 * refusal is told apart from `git` never having run at all.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, PlatformError, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { type GitContextError, GitContextService } from "../src/GitContextService.js"

const handleWith = (stdoutText: string, exitCode = 0, stderrText = "") =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr: Stream.make(stderrText).pipe(Stream.encodeText),
    stdin: Sink.drain,
    stdout: Stream.make(stdoutText).pipe(Stream.encodeText),
    unref: Effect.succeed(Effect.void)
  })

const CODECOMMIT_REMOTE = "https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/identity"

/**
 * A spawner that answers the three `git` reads in order.
 *
 * `resolve` runs `rev-parse --show-toplevel`, `remote get-url` and
 * `rev-parse --abbrev-ref HEAD`, so position is the whole fixture: a shorter
 * list makes every later read answer empty, which is how the refusal cases are
 * expressed.
 */
const answering = (answers: ReadonlyArray<string>): Parameters<typeof ChildProcessSpawner.make>[0] => {
  let call = 0
  return () => Effect.succeed(handleWith(answers[call++] ?? ""))
}

const withSpawner = (spawn: Parameters<typeof ChildProcessSpawner.make>[0]) =>
  GitContextService.live.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)))
  )

const reasonOf = (
  input: { readonly cwd: string; readonly remote: string },
  spawn: Parameters<typeof ChildProcessSpawner.make>[0]
) =>
  Effect.gen(function*() {
    const service = yield* GitContextService
    return yield* service.resolve(input)
  }).pipe(
    Effect.flip,
    Effect.map((error: GitContextError) => error.reason),
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(withSpawner(spawn))
  )

describe("GitContextService", () => {
  it.effect("blames git, not the directory, when git cannot be run at all", () =>
    Effect.gen(function*() {
      // The spawner's `string` never inspects the exit code, so the error channel
      // is reached only when the spawn itself failed — ENOENT because git is not
      // installed. Calling that "not a git repository" points the caller at the
      // wrong prerequisite.
      const reason = yield* reasonOf(
        { cwd: "/work/identity", remote: "origin" },
        () =>
          Effect.fail(PlatformError.systemError({
            _tag: "NotFound",
            description: "spawn git ENOENT",
            method: "spawn",
            module: "ChildProcess",
            syscall: "spawn"
          }))
      )

      expect(reason).toBe("git-failed")
    }))

  it.effect("still says 'not a git repository' when git ran and answered nothing", () =>
    Effect.gen(function*() {
      // The empty answer is the real not-a-repository signal, and it must keep
      // its own diagnosis now that spawn failures no longer borrow it.
      const reason = yield* reasonOf(
        { cwd: "/tmp", remote: "origin" },
        () =>
          Effect.succeed(handleWith(
            "",
            128,
            "fatal: not a git repository (or any of the parent directories): .git\n"
          ))
      )

      expect(reason).toBe("not-a-git-repository")
    }))

  it.effect("recognizes git's mount-point not-repository diagnostic", () =>
    Effect.gen(function*() {
      const reason = yield* reasonOf(
        { cwd: "/tmp", remote: "origin" },
        () =>
          Effect.succeed(handleWith(
            "",
            128,
            "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n"
          ))
      )

      expect(reason).toBe("not-a-git-repository")
    }))

  it.effect("reports a nonzero git exit as a git failure", () =>
    Effect.gen(function*() {
      const reason = yield* reasonOf(
        { cwd: "/work/identity", remote: "origin" },
        () => Effect.succeed(handleWith("", 128, "fatal: detected dubious ownership in repository\n"))
      )

      expect(reason).toBe("git-failed")
    }))

  it.effect("reports git's missing-remote refusal as no remote", () => {
    let call = 0
    return Effect.gen(function*() {
      const reason = yield* reasonOf(
        { cwd: "/work/identity", remote: "upstream" },
        () =>
          Effect.succeed(
            call++ === 0
              ? handleWith("/work/identity\n")
              : handleWith("", 2, "error: No such remote 'upstream'\n")
          )
      )

      expect(reason).toBe("no-remote")
    })
  })

  it.effect("reports a detached checkout rather than treating HEAD as a branch", () =>
    Effect.gen(function*() {
      // `rev-parse --abbrev-ref HEAD` answers the literal "HEAD" when detached,
      // and no pull request can have that as its source branch.
      const reason = yield* reasonOf(
        { cwd: "/work/identity", remote: "origin" },
        answering(["/work/identity", CODECOMMIT_REMOTE, "HEAD"])
      )

      expect(reason).toBe("detached-head")
    }))

  it.effect("resolves the root, remote and branch of a healthy checkout", () =>
    Effect.gen(function*() {
      const service = yield* GitContextService
      const context = yield* service.resolve({ cwd: "/work/identity", remote: "origin" })

      // Each answer arrives with the newline `git` prints; the trim is what makes
      // the branch usable as a pull request's source reference.
      expect(context).toEqual({
        branch: "feat/RPS-2335-thing",
        remoteUrl: CODECOMMIT_REMOTE,
        repositoryRoot: "/work/identity"
      })
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(
        withSpawner(answering(["/work/identity\n", `${CODECOMMIT_REMOTE}\n`, "feat/RPS-2335-thing\n"]))
      )
    ))

  it.effect("separates a dash-prefixed remote name from git options", () => {
    const commands: Array<ChildProcess.Command> = []
    const answers = ["/work/identity\n", `${CODECOMMIT_REMOTE}\n`, "feat/dash-remote\n"]
    let call = 0
    const spawn: Parameters<typeof ChildProcessSpawner.make>[0] = (command) => {
      commands.push(command)
      return Effect.succeed(handleWith(answers[call++] ?? ""))
    }

    return Effect.gen(function*() {
      const service = yield* GitContextService
      const context = yield* service.resolve({ cwd: "/work/identity", remote: "-x" })

      expect(context.remoteUrl).toBe(CODECOMMIT_REMOTE)
      const remoteCommand = commands[1]
      expect(remoteCommand !== undefined && ChildProcess.isStandardCommand(remoteCommand)).toBe(true)
      if (remoteCommand !== undefined && ChildProcess.isStandardCommand(remoteCommand)) {
        expect(remoteCommand.args).toEqual(["remote", "get-url", "--", "-x"])
      }
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(withSpawner(spawn))
    )
  })

  it.effect("uses the selected remote's upstream source when the local branch was renamed", () =>
    Effect.gen(function*() {
      const service = yield* GitContextService
      const context = yield* service.resolve({ cwd: "/work/identity", remote: "origin" })

      expect(context.branch).toBe("feature/x")
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(
        withSpawner(answering([
          "/work/identity\n",
          `${CODECOMMIT_REMOTE}\n`,
          "review\n",
          "origin\0refs/heads/feature/x\n"
        ]))
      )
    ))

  it.effect("preserves a trailing space in the repository root while removing git's newline", () => {
    const commands: Array<ChildProcess.Command> = []
    const answers = ["/work/identity \n", `${CODECOMMIT_REMOTE}\n`, "feat/space\n"]
    let call = 0
    const spawn: Parameters<typeof ChildProcessSpawner.make>[0] = (command) => {
      commands.push(command)
      return Effect.succeed(handleWith(answers[call++] ?? ""))
    }

    return Effect.gen(function*() {
      const service = yield* GitContextService
      const context = yield* service.resolve({ cwd: "/work/identity ", remote: "origin" })

      expect(context.repositoryRoot).toBe("/work/identity ")
      const remoteCommand = commands[1]
      expect(remoteCommand !== undefined && ChildProcess.isStandardCommand(remoteCommand)).toBe(true)
      if (remoteCommand !== undefined && ChildProcess.isStandardCommand(remoteCommand)) {
        expect(remoteCommand.options.cwd).toBe("/work/identity ")
      }
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(withSpawner(spawn))
    )
  })
})
