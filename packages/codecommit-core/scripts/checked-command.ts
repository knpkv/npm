import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class PackedPackageError extends Data.TaggedError("PackedPackageError")<{
  readonly cause?: unknown
  readonly reason: string
}> {}

export const runCheckedCommand = Effect.fn("runCheckedCommand")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
) {
  const invocation = `${command} ${args.join(" ")}`
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { cwd, stderr: "inherit", stdout: "inherit" })
  ).pipe(
    Effect.mapError((cause) => new PackedPackageError({ cause, reason: `${invocation} could not run` }))
  )

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new PackedPackageError({ reason: `${invocation} exited with code ${exitCode}` })
  }
})
