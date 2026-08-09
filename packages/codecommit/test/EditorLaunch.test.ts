import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Sink, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { TuiTerminalSession } from "../src/tui/atoms/applicationScope.js"
import { openLocalEditor } from "../src/tui/editor-launch.js"

const successfulHandle = (onExit: () => void) =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.sync(() => {
      onExit()
      return ChildProcessSpawner.ExitCode(0)
    }),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout: Stream.empty,
    unref: Effect.succeed(Effect.void)
  })

describe("local editor launch", () => {
  it.effect("suspends the TUI around Neovim and resumes at the selected review line", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-editor-" })
        const sourceDirectory = path.join(root, "src")
        const filePath = path.join(sourceDirectory, "review.ts")
        yield* fileSystem.makeDirectory(sourceDirectory)
        yield* fileSystem.writeFileString(filePath, "export const reviewed = true\n")
        const canonicalRoot = yield* fileSystem.realPath(root)
        const canonicalFilePath = yield* fileSystem.realPath(filePath)

        const events: Array<string> = []
        const commands: Array<ChildProcess.Command> = []
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command)
          events.push("spawn")
          return Effect.succeed(successfulHandle(() => events.push("exit")))
        })
        const terminal = TuiTerminalSession.of({
          suspend: Effect.sync(() => events.push("suspend")),
          resume: Effect.sync(() => events.push("resume"))
        })

        const result = yield* openLocalEditor({
          editor: "neovim",
          filePath: "src/review.ts",
          lineNumber: 42,
          requestId: "nvim-1",
          worktreePath: root
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(TuiTerminalSession, terminal)
        )

        expect(result).toEqual({ editor: "neovim", filePath: canonicalFilePath, lineNumber: 42 })
        expect(events).toEqual(["suspend", "spawn", "exit", "resume"])
        expect(commands).toHaveLength(1)
        const command = commands[0]
        expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
        if (command === undefined || !ChildProcess.isStandardCommand(command)) return
        expect(command.command).toBe("nvim")
        expect(command.args).toEqual(["+42", "--", canonicalFilePath])
        expect(command.options).toMatchObject({
          cwd: canonicalRoot,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit"
        })
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("opens VS Code externally without suspending the TUI", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-editor-" })
        const filePath = path.join(root, "review.ts")
        yield* fileSystem.writeFileString(filePath, "export const reviewed = true\n")
        const canonicalFilePath = yield* fileSystem.realPath(filePath)

        const terminalEvents: Array<string> = []
        const commands: Array<ChildProcess.Command> = []
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command)
          return Effect.succeed(successfulHandle(() => undefined))
        })
        const terminal = TuiTerminalSession.of({
          suspend: Effect.sync(() => terminalEvents.push("suspend")),
          resume: Effect.sync(() => terminalEvents.push("resume"))
        })

        yield* openLocalEditor({
          editor: "vscode",
          filePath: "review.ts",
          lineNumber: 9,
          requestId: "code-1",
          worktreePath: root
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(TuiTerminalSession, terminal)
        )

        expect(terminalEvents).toEqual([])
        const command = commands[0]
        expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
        if (command === undefined || !ChildProcess.isStandardCommand(command)) return
        expect(command.command).toBe("code")
        expect(command.args).toEqual(["--reuse-window", "--goto", `${canonicalFilePath}:9`])
        expect(command.options).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a selected symlink that resolves outside the exact-head worktree", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-editor-root-" })
        const outside = yield* fileSystem.makeTempFileScoped({ prefix: "codecommit-editor-outside-" })
        yield* fileSystem.writeFileString(outside, "outside\n")
        yield* fileSystem.symlink(outside, path.join(root, "escaped.ts"))
        let spawned = false
        const spawner = ChildProcessSpawner.make(() => {
          spawned = true
          return Effect.succeed(successfulHandle(() => undefined))
        })

        const error = yield* Effect.flip(
          openLocalEditor({
            editor: "neovim",
            filePath: "escaped.ts",
            requestId: "nvim-escape",
            worktreePath: root
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(
              TuiTerminalSession,
              TuiTerminalSession.of({ resume: Effect.void, suspend: Effect.void })
            )
          )
        )

        expect(error.message).toBe("The selected file resolves outside the exact-head worktree")
        expect(spawned).toBe(false)
      })
    ).pipe(Effect.provide(NodeServices.layer)))
})
