import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { type BuildPhase, controlCenterBuildPhases } from "./build-phases.js"

class BuildPhaseError extends Data.TaggedError("BuildPhaseError")<{
  readonly exitCode: number
  readonly label: string
}> {}

const seconds = (milliseconds: number): string => `${(milliseconds / 1_000).toFixed(2)}s`

const runPhase = Effect.fn("controlCenter.runBuildPhase")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  phase: BuildPhase,
  index: number,
  total: number
) {
  yield* Console.log(`[control-center build] ${index}/${total} ${phase.label}...`)
  const startedAt = yield* Clock.currentTimeMillis
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(phase.command, phase.args, {
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit"
    })
  ).pipe(Effect.mapError(() => new BuildPhaseError({ exitCode: -1, label: phase.label })))
  const finishedAt = yield* Clock.currentTimeMillis
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new BuildPhaseError({ exitCode, label: phase.label })
  }
  yield* Console.log(
    `[control-center build] ${index}/${total} ${phase.label} done (${seconds(finishedAt - startedAt)})`
  )
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const startedAt = yield* Clock.currentTimeMillis

  for (const [index, phase] of controlCenterBuildPhases.entries()) {
    yield* runPhase(spawner, phase, index + 1, controlCenterBuildPhases.length)
  }

  const finishedAt = yield* Clock.currentTimeMillis
  yield* Console.log(`[control-center build] complete (${seconds(finishedAt - startedAt)})`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) =>
      Console.error(`Control Center build failed during ${error.label} (exit ${error.exitCode})`)
    ),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
