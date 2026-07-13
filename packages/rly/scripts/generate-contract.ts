import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import { componentManifest } from "../component-manifest.js"
import { findSourceDrift, renderContract, renderPackageJson } from "./contract.js"

class GenerateContractError extends Data.TaggedError("GenerateContractError")<{
  readonly reason: string
}> {}

const PackageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const listFiles: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listFiles")(
  function*(fs, path, root, directory) {
    const files: Array<string> = []
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* listFiles(fs, path, root, absolute)) files.push(file)
      } else if (info.type === "File") {
        files.push(path.relative(root, absolute).replaceAll("\\", "/"))
      }
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const mode = args.find((argument) => argument === "write" || argument === "check")
  if (mode !== "write" && mode !== "check") {
    return yield* Effect.fail(new GenerateContractError({ reason: "Usage: generate-contract.ts [write|check]" }))
  }

  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const expected = renderContract(componentManifest)
  const failures: Array<string> = []

  const sourceFiles = yield* listFiles(fs, path, packageRoot, path.join(packageRoot, "src"))
  const sourceDrift = findSourceDrift(componentManifest, sourceFiles)
  for (const file of sourceDrift.missing) failures.push(`missing ${file}`)
  for (const file of sourceDrift.unexpected) failures.push(`undeclared component source ${file}`)

  for (const [relative, content] of expected) {
    const target = path.join(packageRoot, relative)
    if (mode === "write") {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      const temporary = `${target}.tmp`
      yield* fs.writeFileString(temporary, content)
      yield* fs.rename(temporary, target)
      continue
    }

    if (!(yield* fs.exists(target))) {
      failures.push(`missing ${relative}`)
      continue
    }
    const actual = yield* fs.readFileString(target)
    if (actual !== content) failures.push(`drifted ${relative}`)
  }

  const generatedDirectory = path.join(packageRoot, "generated")
  if (yield* fs.exists(generatedDirectory)) {
    const expectedGenerated = new Set(
      [...expected.keys()].filter((relative) => relative.startsWith("generated/")).map((relative) =>
        path.basename(relative)
      )
    )
    for (const entry of yield* fs.readDirectory(generatedDirectory)) {
      if (!expectedGenerated.has(entry)) failures.push(`unexpected generated/${entry}`)
    }
  }

  const packagePath = path.join(packageRoot, "package.json")
  const packageSource = yield* fs.readFileString(packagePath)
  const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(packageSource).pipe(
    Effect.mapError(() => new GenerateContractError({ reason: "package.json is not a valid export manifest" }))
  )
  const expectedPackageSource = renderPackageJson(componentManifest, packageJson)
  if (mode === "write" && packageSource !== expectedPackageSource) {
    const temporary = `${packagePath}.tmp`
    yield* fs.writeFileString(temporary, expectedPackageSource)
    yield* fs.rename(temporary, packagePath)
  } else if (mode === "check" && packageSource !== expectedPackageSource) {
    failures.push("package.json exports differ from manifest; run pnpm codegen")
  }

  if (failures.length > 0) {
    return yield* Effect.fail(new GenerateContractError({ reason: failures.join(", ") }))
  }

  yield* Console.log(mode === "write" ? `generated ${expected.size} contract files` : "rly contract is current")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
