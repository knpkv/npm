import assert from "node:assert/strict"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

const directEnvironmentAssignment = /(?:^|&&|\|\||;)\s*[A-Za-z_][A-Za-z0-9_]*=/u
const isBuildScript = (name) => name.split(":").includes("build")

class PackageScriptPortabilityError extends Data.TaggedError("PackageScriptPortabilityError") {
  get message() {
    return this.reason
  }
}

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
)

export const findNonPortableBuildScripts = (manifestPath, scripts) =>
  Object.entries(scripts ?? {})
    .filter(
      ([name, command]) =>
        isBuildScript(name) && Predicate.isString(command) && directEnvironmentAssignment.test(command)
    )
    .map(([name]) => `${manifestPath}: scripts.${name} uses a POSIX-only environment assignment`)

assert.deepEqual(
  findNonPortableBuildScripts("invalid/package.json", {
    "storybook:build": "NODE_OPTIONS=--disable-warning=DEP0205 storybook build"
  }),
  ["invalid/package.json: scripts.storybook:build uses a POSIX-only environment assignment"]
)
assert.deepEqual(
  findNonPortableBuildScripts("valid/package.json", {
    "storybook:build": "tsx scripts/build-storybook.ts"
  }),
  []
)

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const packagesRoot = path.join(repositoryRoot, "packages")
  const manifestPaths = [path.join(repositoryRoot, "package.json")]

  for (const entry of (yield* fileSystem.readDirectory(packagesRoot)).toSorted()) {
    const packageDirectory = path.join(packagesRoot, entry)
    if ((yield* fileSystem.stat(packageDirectory)).type !== "Directory") continue
    manifestPaths.push(path.join(packageDirectory, "package.json"))
  }

  const diagnostics = []
  let checked = 0
  for (const manifestPath of manifestPaths) {
    if (!(yield* fileSystem.exists(manifestPath))) continue
    const location = path.relative(repositoryRoot, manifestPath)
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(
      yield* fileSystem.readFileString(manifestPath)
    ).pipe(
      Effect.mapError(
        (cause) => new PackageScriptPortabilityError({ cause, reason: `${location}: invalid package manifest` })
      )
    )
    diagnostics.push(...findNonPortableBuildScripts(location, manifest.scripts))
    checked += 1
  }

  if (diagnostics.length > 0) {
    return yield* Effect.fail(new PackageScriptPortabilityError({ reason: diagnostics.join("\n") }))
  }
  yield* Console.log(`Package-script portability checked ${checked} manifests`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)), { disableErrorReporting: true })
