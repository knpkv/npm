/**
 * Windows starts npm-installed CLIs (`agent-usage`, `claude`, `codex`, `host-coordinator`) through `.cmd`
 * shims, and Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980). This resolves such a
 * command to `node <script>` and wraps the spawner, so every child the hub starts goes through it.
 *
 * **Mental model**
 *
 * - **Windows only.** {@link layer} detects Windows from the path separator; on Linux and macOS it
 *   leaves the spawner exactly as it was.
 * - **PATH lookup as cmd.exe does it.** Each `PATH` directory in order, each `PATHEXT` extension in
 *   order; the first file that exists wins. A command with a directory part is looked up there alone.
 * - **`.exe` and `.com` spawn directly**, by their full path (the native Claude installer is one).
 * - **A `.cmd` must be npm's cmd-shim for a Node script.** Its target runs as
 *   `<node> [node args] <script> [args]`, where `<node>` is this process's own Node. Any other match
 *   (a `.bat`, a hand-written `.cmd`, a shim for a non-Node program) fails with
 *   {@link NodeBinUnresolved}. A shell is never used.
 * - **Not found anywhere:** the command is left as given, so the spawn reports `NotFound` as it does
 *   today and callers keep their "not installed" copy.
 *
 * @module
 */
import { Config, Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { win32 } from "node:path"

/** A Windows command matched a file that is neither a native executable nor an npm Node shim. */
export class NodeBinUnresolved extends Schema.TaggedError<NodeBinUnresolved>()("NodeBinUnresolved", {
  command: Schema.String
}) {}

/** What a Windows lookup searches: the `PATH` and `PATHEXT` values, `;`-separated. */
export interface WindowsSearch {
  readonly path: string
  readonly pathExt: string
}

export interface ResolvedCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * The Node arguments and target script an npm cmd-shim runs, or undefined when `text` is not one.
 * `script` is relative to the shim's own directory, in Windows form.
 */
export const parseCmdShim = (
  text: string
): { readonly nodeArgs: ReadonlyArray<string>; readonly script: string } | undefined => {
  // Only a Node shim prefers a node.exe beside itself; shims for other programs name them directly.
  if (!text.includes(`IF EXIST "%dp0%\\node.exe"`)) return undefined
  const match = /"%_prog%"\s+(.*?)\s*"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/mu.exec(text)
  const between = match?.[1]
  const script = match?.[2]
  if (between === undefined || script === undefined) return undefined
  return { nodeArgs: between.split(/\s+/u).filter((part) => part !== ""), script }
}

const nativeExtensions = new Set([".exe", ".com"])

/**
 * How Windows would run `command`: a native executable by its full path, `<node> <script>` for an npm
 * shim, or `command` unchanged when nothing on the search path matches.
 */
export const resolveNodeBin = Effect.fn("NodeBin.resolve")(function*(
  command: string,
  args: ReadonlyArray<string>,
  search: WindowsSearch,
  nodePath: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const unresolved = () => new NodeBinUnresolved({ command })
  const given = win32.extname(command).toLowerCase()
  const extensions = given !== ""
    ? [""]
    : search.pathExt.split(";").map((extension) => extension.toLowerCase()).filter((extension) => extension !== "")
  const directories = win32.dirname(command) !== "." || win32.isAbsolute(command)
    ? [""]
    : search.path.split(";").filter((directory) => directory !== "")
  const candidates = directories.flatMap((directory) =>
    extensions.map((extension) =>
      directory === "" ? `${command}${extension}` : win32.join(directory, `${command}${extension}`)
    )
  )
  for (const candidate of candidates) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.mapError(unresolved))
    if (!exists) continue
    const extension = win32.extname(candidate).toLowerCase()
    if (nativeExtensions.has(extension)) return { command: candidate, args } satisfies ResolvedCommand
    if (extension !== ".cmd") return yield* unresolved()
    const shim = parseCmdShim(yield* fileSystem.readFileString(candidate).pipe(Effect.mapError(unresolved)))
    if (shim === undefined) return yield* unresolved()
    const script = win32.join(win32.dirname(candidate), shim.script)
    return { command: nodePath, args: [...shim.nodeArgs, script, ...args] } satisfies ResolvedCommand
  }
  return { command, args } satisfies ResolvedCommand
})

const windowsSearch = Config.all({
  // Windows spells it `Path`; the environment provider keeps the spelling it was given.
  path: Config.String("PATH").pipe(Config.orElse(() => Config.String("Path")), Config.withDefault("")),
  pathExt: Config.String("PATHEXT").pipe(Config.withDefault(".COM;.EXE;.BAT;.CMD"))
})

// The spawner reports failures as platform errors; a shim it can't read is reported as not found, with why.
const asPlatformError = (error: NodeBinUnresolved) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: error.command,
    description: `${error.command} is neither a native executable nor an npm shim for a Node script`
  })

/**
 * Wraps the platform's spawner so Windows resolves `.cmd` shims to `<nodePath> <script>`. `nodePath` is
 * the running Node (`process.execPath`), passed in by the executable. POSIX gets the spawner unchanged.
 */
export const layer = (nodePath: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const paths = yield* Path.Path
      if (paths.sep !== "\\") return spawner
      const fileSystem = yield* FileSystem.FileSystem
      const search = yield* windowsSearch
      const resolve = (command: ChildProcess.Command): Effect.Effect<ChildProcess.Command, NodeBinUnresolved> => {
        if (ChildProcess.isPipedCommand(command)) {
          return Effect.map(
            Effect.all([resolve(command.left), resolve(command.right)]),
            ([left, right]) => ChildProcess.pipeTo(left, right, command.options)
          )
        }
        return resolveNodeBin(command.command, command.args, search, nodePath).pipe(
          Effect.map((resolved) => ChildProcess.make(resolved.command, resolved.args, command.options)),
          Effect.provideService(FileSystem.FileSystem, fileSystem)
        )
      }
      return ChildProcessSpawner.make((command) =>
        resolve(command).pipe(
          Effect.mapError(asPlatformError),
          Effect.flatMap((resolved) => spawner.spawn(resolved))
        )
      )
    })
  )
