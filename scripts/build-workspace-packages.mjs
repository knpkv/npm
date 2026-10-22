import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class WorkspaceBuildError extends Data.TaggedError("WorkspaceBuildError") {}

/**
 * The root `build`: every package's own build, dependencies first. `KNPKV_SORTED_WORKSPACE_BUILD` tells a package
 * build that its workspace dependencies are already built, so it must not rebuild them beside packages still
 * reading their output (Control Center's dependency step checks it). Set here, not as `FOO=1 pnpm` in the script,
 * which isn't portable.
 */
const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "pnpm",
      [
        "--recursive",
        "--sort",
        "--config.enable-pre-post-scripts=false",
        "--filter",
        "./packages/**/*",
        "run",
        "build"
      ],
      {
        env: { KNPKV_SORTED_WORKSPACE_BUILD: "1" },
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      }
    )
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new WorkspaceBuildError({ reason: `workspace build exited with ${exitCode}` })
  }
})

if (import.meta.main) NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
