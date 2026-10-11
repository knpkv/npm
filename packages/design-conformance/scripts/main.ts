import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"

import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { writeReport } from "../src/report.js"
import { runConformance } from "../src/runner.js"
import { Name, RunnerFailure } from "../src/schema.js"
import { loadProduct } from "./product.js"

const Args = Schema.Struct({
  product: Name,
  output: Schema.String,
  base: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  captureOnly: Schema.Boolean
})

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const stdio = yield* Stdio.Stdio
  const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const parameters = new Map<string, string | boolean>([
    ["output", path.join(repository, "test-results/design-conformance/current")],
    ["captureOnly", false]
  ])
  const args = yield* stdio.args
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--capture-only") {
      parameters.set("captureOnly", true)
      continue
    }
    const key = argument === "--product"
      ? "product"
      : argument === "--output"
      ? "output"
      : argument === "--base"
      ? "base"
      : argument === "--state"
      ? "state"
      : undefined
    const value = args[++index]
    if (key === undefined || value === undefined) {
      return yield* new RunnerFailure({
        detail: "Expected --product <name> [--state screen/state] [--output dir] [--base dir] [--capture-only]"
      })
    }
    parameters.set(key, value)
  }
  const options = yield* Schema.decodeUnknownEffect(Args)(Object.fromEntries(parameters))
  yield* fs.makeDirectory(options.output, { recursive: true })
  const refs = yield* loadReferences(path.join(repository, "design-refs", options.product)).pipe(
    Effect.tapError((error) =>
      writeReport(options.output, {
        product: options.product,
        passed: false,
        shots: [],
        findings: [{
          screen: "contract",
          state: "invalid",
          viewport: 390,
          theme: "light",
          region: "*",
          rule: "integrity",
          disposition: "required",
          detail: error._tag === "ReferenceFailure"
            ? `${error.file}: ${error.detail}`
            : `Reference loading failed: ${error._tag}`
        }]
      })
    )
  )
  if (refs.manifest.product !== options.product) {
    return yield* new RunnerFailure({ detail: "Manifest product differs from directory" })
  }
  const adapter = yield* loadProduct(repository, refs.manifest.live.adapter)
  const live = yield* adapter.start(refs.fixture, repository)
  const result = yield* runConformance(refs, options).pipe(Effect.provideService(LiveProduct, live))
  if (result !== undefined) {
    yield* Console.log(
      `${result.product}: ${result.passed ? "PASS" : "FAIL"}; ${
        result.findings.filter((finding) => finding.disposition === "required").length
      } required, ${result.findings.filter((finding) => finding.disposition === "report-only").length} report-only`
    )
    if (!result.passed) {
      return yield* new RunnerFailure({ detail: `Design conformance failed; report: ${options.output}/index.html` })
    }
  }
}).pipe(Effect.scoped)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
