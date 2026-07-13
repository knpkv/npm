import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { componentManifest } from "../component-manifest.js"
import { entryOutputStem, renderPackageExports } from "./contract.js"

class DistValidationError extends Data.TaggedError("DistValidationError")<{
  readonly reason: string
}> {}

const PackageJson = Schema.fromJsonString(Schema.Struct({
  files: Schema.Array(Schema.String),
  main: Schema.String,
  sideEffects: Schema.Array(Schema.String),
  types: Schema.String
}))

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const failures: Array<string> = []

  for (const entry of componentManifest.entries) {
    const stem = entryOutputStem(entry)
    const artifacts = [
      `dist/${stem}.js`,
      `dist/${stem}.js.map`,
      `dist/dts/${stem}.d.ts`,
      `dist/dts/${stem}.d.ts.map`
    ]
    for (const artifact of artifacts) {
      const target = path.join(packageRoot, artifact)
      if (!(yield* fs.exists(target))) {
        failures.push(`missing ${artifact}`)
        continue
      }
      const info = yield* fs.stat(target)
      if (info.type !== "File") failures.push(`not a file ${artifact}`)
    }
  }

  const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
  const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(packageSource).pipe(
    Effect.mapError(() => new DistValidationError({ reason: "package.json publication fields are invalid" }))
  )
  const exports = renderPackageExports(componentManifest)
  const root = exports["."]
  if (root === undefined) failures.push("root export is missing")
  else {
    if (packageJson.main !== root.import) failures.push("main does not match root import")
    if (packageJson.types !== root.types) failures.push("types does not match root types")
  }
  if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "README.md"])) {
    failures.push("package files must contain only dist and README.md")
  }
  if (JSON.stringify(packageJson.sideEffects) !== JSON.stringify(["*.css", "**/*.css"])) {
    failures.push("only CSS may be declared side-effectful")
  }

  if (failures.length > 0) {
    return yield* Effect.fail(new DistValidationError({ reason: failures.join(", ") }))
  }
  yield* Console.log(`validated ${componentManifest.entries.length} rly package entries`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
