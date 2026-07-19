import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { planPrecommit, type PrecommitCommand } from "./precommit-plan.js"

class PrecommitError extends Data.TaggedError("PrecommitError")<{
  readonly reason: string
}> {}

const runCommand = Effect.fn("controlCenter.runPrecommitCommand")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workspaceRoot: string,
  step: PrecommitCommand,
  index: number,
  total: number
) {
  yield* Console.log(`[pre-commit] ${index}/${total} ${step.label}...`)
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(step.command, step.args, {
      cwd: workspaceRoot,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit"
    })
  ).pipe(Effect.mapError(() => new PrecommitError({ reason: `could not start ${step.label}` })))
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new PrecommitError({ reason: `${step.label} failed with exit code ${exitCode}` })
  }
})

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError(() => new PrecommitError({ reason: "could not resolve the workspace root" }))
  )
  const workspaceRoot = path.dirname(path.dirname(path.dirname(path.dirname(scriptPath))))
  const readStagedPaths = (diffFilter: string) =>
    spawner.string(
      ChildProcess.make("git", ["diff", "--cached", "--name-only", "-z", `--diff-filter=${diffFilter}`, "--"], {
        cwd: workspaceRoot,
        stderr: "inherit"
      })
    ).pipe(Effect.mapError(() => new PrecommitError({ reason: "could not read staged paths" })))
  const stagedOutput = yield* readStagedPaths("ACDMR")
  const formattableOutput = yield* readStagedPaths("ACMR")
  const stagedFiles = stagedOutput.split("\0").filter((file) => file.length > 0)
  const formattableFiles = formattableOutput.split("\0").filter((file) => file.length > 0)
  const plan = planPrecommit(stagedFiles, formattableFiles)

  yield* Console.log(`[pre-commit] mode=${plan.mode}: ${plan.reason}`)
  for (const [index, step] of plan.commands.entries()) {
    yield* runCommand(spawner, workspaceRoot, step, index + 1, plan.commands.length)
  }
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(`[pre-commit] ${error.reason}`)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
