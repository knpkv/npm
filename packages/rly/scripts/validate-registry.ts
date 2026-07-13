import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { componentManifest } from "../component-manifest.js"
import { validateComponentsRegistry } from "./registry/registry-validation.js"

class RegistryValidationError extends Data.TaggedError("RegistryValidationError")<{
  readonly reason: string
}> {}

const Json = Schema.fromJsonString(Schema.Unknown)
const SearchRegistry = Schema.fromJsonString(
  Schema.Struct({
    generatedNotice: Schema.String,
    package: Schema.Literal("@knpkv/rly"),
    records: Schema.Array(
      Schema.Struct({
        capabilities: Schema.NonEmptyArray(Schema.String),
        category: Schema.Literals(["foundation", "primitive", "pattern", "diff"]),
        importPath: Schema.String,
        name: Schema.String,
        states: Schema.NonEmptyArray(Schema.String),
        terms: Schema.NonEmptyArray(Schema.String)
      })
    ),
    schemaVersion: Schema.Literal(1)
  })
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const registryRoot = path.join(packageRoot, "registry")
  const schema = yield* Schema.decodeUnknownEffect(Json)(
    yield* fs.readFileString(path.join(registryRoot, "schema.json"))
  )
  const components = yield* Schema.decodeUnknownEffect(Json)(
    yield* fs.readFileString(path.join(registryRoot, "components.json"))
  )
  const schemaFailures = validateComponentsRegistry(schema, components)
  if (schemaFailures.length > 0) {
    return yield* new RegistryValidationError({ reason: schemaFailures.join(", ") })
  }
  const search = yield* Schema.decodeUnknownEffect(SearchRegistry)(
    yield* fs.readFileString(path.join(registryRoot, "search.json"))
  ).pipe(Effect.mapError(() => new RegistryValidationError({ reason: "search.json is malformed" })))
  const expectedNames = componentManifest.components
    .filter(({ registry }) => registry)
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right))
  const searchNames = search.records.map(({ name }) => name).sort((left, right) => left.localeCompare(right))
  if (JSON.stringify(expectedNames) !== JSON.stringify(searchNames)) {
    return yield* new RegistryValidationError({ reason: "search records do not match registry components" })
  }
  const usage = yield* fs.readFileString(path.join(registryRoot, "USAGE.md"))
  if (!usage.includes("documentation and planning input") || !usage.includes("no component implementation")) {
    return yield* new RegistryValidationError({ reason: "USAGE.md must reject registry execution" })
  }
  yield* Console.log(`validated ${expectedNames.length} registry components and four published artifacts`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
