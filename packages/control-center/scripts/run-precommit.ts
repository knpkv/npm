// Local gates default to staged checks; shared inputs or PRECOMMIT_MODE=full select every repository check.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { availableParallelism } from "node:os"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { assertStagedInputs, crossPackageInputs } from "../../../scripts/staged-inputs.js"
import { parseStagedNameStatus, planPrecommit, type PrecommitCommand, precommitMaxWorkers } from "./precommit-plan.js"

class PrecommitError extends Data.TaggedError("PrecommitError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const runCommand = Effect.fn("controlCenter.runPrecommitCommand")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workspaceRoot: string,
  step: PrecommitCommand,
  index: number,
  total: number,
  maxWorkers: number
) {
  yield* Console.log(`[pre-commit] ${index}/${total} ${step.label}...`)
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(step.command, step.args, {
      cwd: workspaceRoot,
      env: { VITEST_MAX_WORKERS: String(maxWorkers) },
      extendEnv: true,
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
  yield* assertStagedInputs(spawner, workspaceRoot)
  const stagedOutput = yield* spawner.string(
    ChildProcess.make(
      "git",
      ["diff", "--cached", "--name-status", "-z", "--diff-filter=ACDMRT", "--"],
      { cwd: workspaceRoot, stderr: "inherit" }
    )
  ).pipe(Effect.mapError(() => new PrecommitError({ reason: "could not read staged paths" })))
  const staged = parseStagedNameStatus(stagedOutput)
  if (staged === null) return yield* new PrecommitError({ reason: "could not decode staged paths" })
  const mode = Option.getOrUndefined(
    yield* Config.option(Config.String("PRECOMMIT_MODE")).pipe(
      Effect.mapError((cause) => new PrecommitError({ reason: "could not read PRECOMMIT_MODE", cause }))
    )
  )
  if (mode !== undefined && mode !== "changed" && mode !== "full") {
    return yield* new PrecommitError({ reason: "PRECOMMIT_MODE must be changed or full" })
  }
  const workersOverride = Option.getOrUndefined(
    yield* Config.option(Config.String("PRECOMMIT_MAX_WORKERS")).pipe(
      Effect.mapError((cause) => new PrecommitError({ reason: "could not read PRECOMMIT_MAX_WORKERS", cause }))
    )
  )
  const maxWorkers = precommitMaxWorkers(yield* Effect.sync(availableParallelism), workersOverride)
  if (maxWorkers === null) {
    return yield* new PrecommitError({ reason: "PRECOMMIT_MAX_WORKERS must be a positive integer" })
  }
  const initialPlan = planPrecommit(staged.stagedFiles, { PRECOMMIT_MODE: mode }, maxWorkers)
  const plan = initialPlan.mode === "changed"
    ? planPrecommit(
      staged.stagedFiles,
      { PRECOMMIT_MODE: mode },
      maxWorkers,
      yield* crossPackageInputs(spawner, workspaceRoot)
    )
    : initialPlan

  yield* Console.log(`[pre-commit] mode=${plan.mode}: ${plan.reason}`)
  for (const [index, step] of plan.commands.entries()) {
    yield* runCommand(spawner, workspaceRoot, step, index + 1, plan.commands.length, maxWorkers)
  }
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) =>
      Console.error(
        `[pre-commit] ${
          error._tag === "StagedInputsError" || error._tag === "PrecommitError" ? error.reason : String(error)
        }`
      )
    ),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
