import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { WorktreeError } from "../WorktreeService.js"
import { TuiTerminalSession } from "./atoms/applicationScope.js"

export type LocalEditor = "neovim" | "vscode"

export interface OpenEditorInput {
  readonly editor: LocalEditor
  readonly filePath: string
  readonly lineNumber?: number
  readonly requestId: string
  readonly worktreePath: string
}

export interface OpenEditorResult {
  readonly editor: LocalEditor
  readonly filePath: string
  readonly lineNumber: number | undefined
}

const editorFailure = (operation: string, message: string, cause?: unknown) =>
  new WorktreeError({ operation, message, ...(cause === undefined ? {} : { cause }) })

const isOutside = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

const editorExitCode = Effect.fn("EditorLaunch.exitCode")(function*(command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    spawner.spawn(command).pipe(
      Effect.flatMap((handle) => handle.exitCode)
    )
  )
})

/** Opens one verified exact-head file without allowing provider paths or symlinks to escape the worktree. */
export const openLocalEditor = Effect.fn("EditorLaunch.openLocalEditor")(function*(
  input: OpenEditorInput
): Effect.fn.Return<
  OpenEditorResult,
  WorktreeError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | TuiTerminalSession
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const terminalSession = yield* TuiTerminalSession
  const operation = input.editor === "neovim" ? "open-neovim" : "open-vscode"
  const requestedRoot = path.resolve(input.worktreePath)
  const requestedFile = path.resolve(requestedRoot, input.filePath)

  if (isOutside(path, requestedRoot, requestedFile)) {
    return yield* editorFailure(operation, "The selected file path escapes the exact-head worktree")
  }

  const [worktreePath, filePath] = yield* Effect.all([
    fileSystem.realPath(requestedRoot),
    fileSystem.realPath(requestedFile)
  ]).pipe(
    Effect.mapError((cause) => editorFailure(operation, "The selected exact-head file is unavailable", cause))
  )
  if (isOutside(path, worktreePath, filePath)) {
    return yield* editorFailure(operation, "The selected file resolves outside the exact-head worktree")
  }
  const info = yield* fileSystem.stat(filePath).pipe(
    Effect.mapError((cause) => editorFailure(operation, "The selected exact-head file cannot be inspected", cause))
  )
  if (info.type !== "File") {
    return yield* editorFailure(operation, "The selected exact-head path is not a regular file")
  }

  const lineNumber = input.lineNumber !== undefined && Number.isSafeInteger(input.lineNumber) && input.lineNumber > 0
    ? input.lineNumber
    : undefined
  const command = input.editor === "neovim"
    ? ChildProcess.make("nvim", [...(lineNumber === undefined ? [] : [`+${lineNumber}`]), "--", filePath], {
      cwd: worktreePath,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
    : ChildProcess.make(
      "code",
      ["--reuse-window", ...(lineNumber === undefined ? [filePath] : ["--goto", `${filePath}:${lineNumber}`])],
      { cwd: worktreePath, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    )

  const exitCode = yield* (input.editor === "neovim"
    ? terminalSession.suspend.pipe(
      Effect.andThen(editorExitCode(command)),
      Effect.ensuring(terminalSession.resume)
    )
    : editorExitCode(command)).pipe(
      Effect.mapError((cause) =>
        editorFailure(operation, `Unable to start ${input.editor === "neovim" ? "Neovim" : "VS Code"}`, cause)
      )
    )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* editorFailure(
      operation,
      `${input.editor === "neovim" ? "Neovim" : "VS Code"} exited with status ${exitCode}`
    )
  }
  return { editor: input.editor, filePath, lineNumber }
})
