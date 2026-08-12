import { describe, expect, it } from "@effect/vitest"
import { CacheService, ChildEnv } from "@knpkv/codecommit-core"
import { Effect, Exit, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { TuiTerminalSession } from "../src/tui/atoms/applicationScope.js"
import { openAssumeConsole, openConsoleAfterClipboard } from "../src/tui/console-launch.js"

const handleWithExit = (exitCode: number, onExit: () => void) =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.sync(() => {
      onExit()
      return ChildProcessSpawner.ExitCode(exitCode)
    }),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(7),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout: Stream.empty,
    unref: Effect.succeed(Effect.void)
  })

const terminalRecording = (events: Array<string>) =>
  TuiTerminalSession.of({
    resume: Effect.sync(() => events.push("resume")),
    suspend: Effect.sync(() => events.push("suspend"))
  })

/** The shape the Node spawner produces when the executable does not exist on PATH. */
const missingExecutableFailure = Effect.fail(
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: "spawn assume ENOENT"
    })
  )
)

describe("console launch", () => {
  it.effect("suspends the TUI around assume and pins the profile against ambient credentials", () => {
    const events: Array<string> = []
    const commands: Array<ChildProcess.Command> = []
    const spawner = ChildProcessSpawner.make((command) => {
      commands.push(command)
      events.push("spawn")
      return Effect.succeed(handleWithExit(0, () => events.push("exit")))
    })

    return Effect.gen(function*() {
      const result = yield* openAssumeConsole({
        link: "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/x",
        profile: "dev-admin",
        requestId: "console-1"
      })

      expect(result).toEqual({
        link: "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/x",
        profile: "dev-admin"
      })
      expect(events).toEqual(["suspend", "spawn", "exit", "resume"])
      const command = commands[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command === undefined || !ChildProcess.isStandardCommand(command)) return
      expect(command.command).toBe("assume")
      expect(command.args).toEqual([
        "--cd",
        "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/x",
        "dev-admin"
      ])
      // In the terminal's foreground process group, so Ctrl-C at the sign-in prompt
      // reaches `assume` instead of only this process.
      expect(command.options).toMatchObject({ detached: false, extendEnv: true, stdin: "inherit" })
      expect(command.options.env).toMatchObject({
        GRANTED_ALIAS_CONFIGURED: "true",
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SESSION_TOKEN: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
        AWS_REGION: undefined,
        AWS_DEFAULT_REGION: undefined
      })
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })

  it.effect("classifies a missing assume executable as the install prerequisite and restores the TUI", () => {
    const events: Array<string> = []
    const spawner = ChildProcessSpawner.make(() => missingExecutableFailure)

    return Effect.gen(function*() {
      const error = yield* Effect.flip(
        openAssumeConsole({ link: "https://console", profile: "dev-admin", requestId: "console-missing" })
      )

      expect(error.reason).toBe("assume-missing")
      expect(error.operation).toBe("open-codecommit")
      expect(error.message).toBe("Granted's assume executable was not found on PATH")
      expect(events).toEqual(["suspend", "resume"])
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })

  it.effect("opens the console even when the clipboard step fails, and still names the prerequisite", () => {
    const events: Array<string> = []
    const spawned: Array<string> = []
    const spawner = ChildProcessSpawner.make((command) => {
      spawned.push(ChildProcess.isStandardCommand(command) ? command.command : "unknown")
      return Effect.succeed(handleWithExit(0, () => undefined))
    })
    // The copy reports its own failures through a notification, and that write can
    // fail too; neither may decide whether the console opens.
    const failedCopy = Effect.fail(new CacheService.CacheError({ operation: "addSystem", cause: "SQLITE_BUSY" }))

    return Effect.gen(function*() {
      const opened = yield* openConsoleAfterClipboard(failedCopy, {
        link: "https://console",
        profile: "dev-admin",
        requestId: "console-no-clipboard"
      })
      expect(opened.profile).toBe("dev-admin")
      expect(spawned).toEqual(["assume"])

      const error = yield* Effect.flip(
        openConsoleAfterClipboard(failedCopy, {
          link: "https://console",
          profile: "dev-admin",
          requestId: "console-no-clipboard-missing"
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => missingExecutableFailure)
          )
        )
      )
      expect(error.reason).toBe("assume-missing")
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })

  it.effect("does not hand the terminal to assume when the clipboard step is interrupted", () => {
    const events: Array<string> = []
    const spawned: Array<string> = []
    const spawner = ChildProcessSpawner.make((command) => {
      spawned.push(ChildProcess.isStandardCommand(command) ? command.command : "unknown")
      return Effect.succeed(handleWithExit(0, () => undefined))
    })

    return Effect.gen(function*() {
      // Cancelling the action, or shutting the application scope down, must abandon the
      // launch: discarding the interrupt here would take over the terminal after the
      // fact and hold exit open until the child finished.
      const exit = yield* Effect.exit(
        openConsoleAfterClipboard(Effect.interrupt, {
          link: "https://console",
          profile: "dev-admin",
          requestId: "console-interrupted-copy"
        })
      )

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(spawned).toEqual([])
      expect(events).toEqual([])
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })

  it.effect("reports a signal-ended sign-in as interrupted rather than as a failure to start", () => {
    const events: Array<string> = []
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          // The spawner turns a signal exit into an `exitCode` failure; this is the
          // shape Ctrl-C produces now that the child shares the foreground group.
          exitCode: Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                description: "Process interrupted due to receipt of signal: 'SIGINT'"
              })
            )
          ),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(7),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      )
    )

    return Effect.gen(function*() {
      const error = yield* Effect.flip(
        openAssumeConsole({ link: "https://console", profile: "dev-admin", requestId: "console-interrupted" })
      )

      expect(error.reason).toBe("assume-interrupted")
      expect(error.message).toBe("Console sign-in ended before completing")
      // The renderer must come back even when the child was killed.
      expect(events).toEqual(["suspend", "resume"])
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })

  it.effect("keeps a refused assume run separate from the missing-executable prerequisite", () => {
    const events: Array<string> = []
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(handleWithExit(1, () => undefined)))

    return Effect.gen(function*() {
      const error = yield* Effect.flip(
        openAssumeConsole({ link: "https://console", profile: "dev-admin", requestId: "console-refused" })
      )

      expect(error.reason).toBe("assume-failed")
      expect(error.message).toBe("assume exited with status 1")
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(TuiTerminalSession, terminalRecording(events)),
      Effect.provideService(ChildEnv.HostEnvironment, { variables: { PATH: "/usr/bin" } })
    )
  })
})
