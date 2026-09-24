import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { exportGuide } from "../dist/guide/export.js"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const example = "examples/approval-guide"
  const guide = yield* fs
    .readFileString(`${example}/guide.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))))
  const findings = yield* fs
    .readFileString(`${example}/findings.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))))
  const patch = yield* fs.readFileString(`${example}/guide.patch`)
  const page = yield* exportGuide({ guide, findings, patch })
  yield* fs.writeFileString("example-guide.html", page.html)
  yield* Console.log(`example-guide.html: ${page.chapters} chapters, ${page.anchored} anchored findings`)
})

// Build platform services in the main fiber's scope, then run the finite script.
NodeRuntime.runMain(
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((services) => Effect.provide(program, services)),
    Effect.scoped
  )
)
