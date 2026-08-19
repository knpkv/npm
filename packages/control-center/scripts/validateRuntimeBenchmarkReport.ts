import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  controlCenterRuntimeBenchmarkOutputPath,
  ControlCenterRuntimeBenchmarkReport,
  readControlCenterRuntimeBenchmarkReport,
  validateControlCenterRuntimeBenchmarkCiAcceptance
} from "./benchmarkRuntimeReport.js"

const program = Effect.gen(function*() {
  const outputPath = yield* controlCenterRuntimeBenchmarkOutputPath
  const report = yield* readControlCenterRuntimeBenchmarkReport(outputPath)
  const isCi = yield* Config.boolean("CI").pipe(Config.withDefault(false))
  yield* validateControlCenterRuntimeBenchmarkCiAcceptance(report, isCi)
  const encoded = yield* Schema.encodeEffect(ControlCenterRuntimeBenchmarkReport)(report)
  yield* Console.log(JSON.stringify(encoded, undefined, 2))
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
