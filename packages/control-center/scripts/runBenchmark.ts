import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { ControlCenterBenchmarkReport, runControlCenterBenchmark } from "./benchmarkHarness.js"
import { collectControlCenterBenchmarkMachine } from "./benchmarkRuntimeReport.js"

/** Failure to collect or encode benchmark command metadata. */
class BenchmarkCommandError extends Schema.TaggedErrorClass<BenchmarkCommandError>()("BenchmarkCommandError", {
  reason: Schema.String
}) {}

const program = Effect.gen(function*() {
  const machine = yield* collectControlCenterBenchmarkMachine()
  const report = yield* runControlCenterBenchmark({ machine })
  const encoded = yield* Schema.encodeEffect(ControlCenterBenchmarkReport)(report).pipe(
    Effect.mapError(() => new BenchmarkCommandError({ reason: "Benchmark output failed schema encoding." }))
  )
  yield* Console.log(JSON.stringify(encoded, undefined, 2))
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
