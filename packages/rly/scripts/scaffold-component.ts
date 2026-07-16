import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import type { ComponentManifest } from "../component-manifest.js"
import { componentManifest } from "../component-manifest.js"
import { renderContract } from "./contract.js"
import { createScaffoldComponentPlan, type ScaffoldCategory } from "./scaffolder.js"

class ScaffoldComponentError extends Data.TaggedError("ScaffoldComponentError")<{
  readonly reason: string
}> {}

const isCategory = (value: string | undefined): value is ScaffoldCategory =>
  value === "foundation" || value === "primitive" || value === "pattern" || value === "diff"

const writeAtomic = Effect.fn("rly.writeScaffoldFile")(function*(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  contents: string
) {
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  yield* fs.writeFileString(temporary, contents)
  yield* fs.rename(temporary, target)
})

const collectFiles = Effect.fn("rly.collectScaffoldFiles")(function* collect(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  packageRoot: string,
  existingFiles: Set<string>,
  directory: string
): Effect.fn.Return<void, PlatformError.PlatformError> {
  for (const entry of yield* fs.readDirectory(directory)) {
    const absolute = path.join(directory, entry)
    const info = yield* fs.stat(absolute)
    if (info.type === "Directory") yield* collectFiles(fs, path, packageRoot, existingFiles, absolute)
    else if (info.type === "File") existingFiles.add(path.relative(packageRoot, absolute).replaceAll("\\", "/"))
  }
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const category = args[0]
  const name = args[1]
  const purpose = args.slice(2).join(" ")
  if (!isCategory(category) || name === undefined || purpose.length === 0) {
    return yield* new ScaffoldComponentError({
      reason: "Usage: scaffold-component.ts <foundation|primitive|pattern|diff> <PascalName> <purpose>"
    })
  }
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const manifestPath = path.join(packageRoot, "component-manifest.ts")
  const registryMetadataPath = path.join(packageRoot, "manifest", "registry-metadata.ts")
  const manifestSource = yield* fs.readFileString(manifestPath)
  const registryMetadataSource = yield* fs.readFileString(registryMetadataPath)
  const existingFiles = new Set<string>()
  for (const directory of ["src", "stories", "test"]) {
    yield* collectFiles(fs, path, packageRoot, existingFiles, path.join(packageRoot, directory))
  }
  const plan = yield* Effect.try({
    try: () =>
      createScaffoldComponentPlan({
        category,
        existingFiles,
        manifestSource,
        name,
        purpose,
        registryMetadataSource
      }),
    catch: (cause) => new ScaffoldComponentError({ reason: String(cause) })
  })
  const nextManifest: ComponentManifest = {
    ...componentManifest,
    components: [...componentManifest.components, plan.component],
    registryMetadata: { ...componentManifest.registryMetadata, [plan.component.name]: plan.metadata }
  }
  const generated = renderContract(nextManifest)
  for (const [relative, contents] of plan.files) {
    yield* writeAtomic(fs, path, path.join(packageRoot, relative), contents)
  }
  yield* writeAtomic(fs, path, manifestPath, plan.manifestSource)
  yield* writeAtomic(fs, path, registryMetadataPath, plan.registryMetadataSource)
  for (const [relative, contents] of generated) {
    yield* writeAtomic(fs, path, path.join(packageRoot, relative), contents)
  }
  yield* Console.log(`scaffolded ${plan.component.name} with source, style, story, test, manifest, and public index`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
