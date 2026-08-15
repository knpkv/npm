import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { assertWarningFreeStorybookOutput } from "./storybook-build-output.js"

class StorybookBuildError extends Data.TaggedError("StorybookBuildError")<{
  readonly cause?: unknown
  readonly reason: string
}> {}

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const stdio = yield* Stdio.Stdio
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const storybookCli = path.join(packageRoot, "node_modules", "storybook", "dist", "bin", "dispatcher.js")
  const command = ChildProcess.make(
    "node",
    [
      "--disable-warning=DEP0205",
      storybookCli,
      "build",
      "--output-dir",
      "storybook-static",
      "--disable-telemetry"
    ],
    { cwd: packageRoot, stderr: "pipe", stdout: "pipe" }
  )
  const handle = yield* spawner.spawn(command)
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )

  yield* Effect.all([
    Stream.make(stdout).pipe(Stream.run(stdio.stdout())),
    Stream.make(stderr).pipe(Stream.run(stdio.stderr()))
  ])

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new StorybookBuildError({ reason: `Storybook build exited with code ${exitCode}` })
  }
  yield* Effect.try({
    try: () => assertWarningFreeStorybookOutput(`${stdout}${stderr}`),
    catch: (cause) => new StorybookBuildError({ cause, reason: "Storybook emitted disallowed diagnostics" })
  })
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { disableErrorReporting: true })
