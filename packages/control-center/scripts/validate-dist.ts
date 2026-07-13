import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { type ControlCenterBuildTarget, decodeBuildGraph, inspectBuildGraph } from "./build-graph.js"

class DistValidationError extends Data.TaggedError("DistValidationError")<{
  readonly reason: string
}> {}

const filesWithin: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("controlCenter.distFiles")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* filesWithin(fs, path, absolute)) files.push(file)
      } else if (info.type === "File") files.push(absolute)
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const clientRoot = path.join(packageRoot, "dist/client")
  const serverRoot = path.join(packageRoot, "dist/server")
  const failures: Array<string> = []

  for (
    const artifact of [
      "dist/client/build-graph.json",
      "dist/client/.vite/manifest.json",
      "dist/client/index.html",
      "dist/server/index.d.ts",
      "dist/server/index.js",
      "dist/server/api/index.d.ts",
      "dist/server/api/index.js",
      "dist/server/domain/index.d.ts",
      "dist/server/domain/index.js",
      "dist/server/server/index.d.ts",
      "dist/server/server/index.js",
      "dist/server/build-graph.json"
    ]
  ) {
    if (!(yield* fs.exists(path.join(packageRoot, artifact)))) failures.push(`missing ${artifact}`)
  }

  const serverFiles = (yield* filesWithin(fs, path, serverRoot)).map((file) =>
    path.relative(serverRoot, file).replaceAll("\\", "/")
  )
  if (serverFiles.some((file) => file.startsWith("client/"))) failures.push("server build emitted browser source")

  for (
    const contract of [
      { forbidden: ["/src/server/", "@knpkv/control-center/server"], name: "client", root: clientRoot },
      { forbidden: ["/src/client/", "@knpkv/rly"], name: "server", root: serverRoot }
    ]
  ) {
    for (const file of yield* filesWithin(fs, path, contract.root)) {
      if (!/\.(?:css|html|js|json|map)$/.test(file)) continue
      const source = yield* fs.readFileString(file)
      const forbidden = contract.forbidden.find((fragment) => source.includes(fragment))
      if (forbidden !== undefined) {
        failures.push(
          `${contract.name} build contains forbidden fragment ${JSON.stringify(forbidden)} in ${
            path.relative(packageRoot, file)
          }`
        )
      }
    }
  }

  const graphContracts: ReadonlyArray<{
    readonly path: string
    readonly target: ControlCenterBuildTarget
  }> = [
    { path: path.join(clientRoot, "build-graph.json"), target: "client" },
    { path: path.join(serverRoot, "build-graph.json"), target: "server" }
  ]
  for (const contract of graphContracts) {
    const source = yield* fs.readFileString(contract.path)
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
      Effect.mapError(() => new DistValidationError({ reason: `invalid ${contract.target} build graph JSON` }))
    )
    const graph = decodeBuildGraph(value)
    if (graph === undefined || graph.target !== contract.target) {
      failures.push(`invalid ${contract.target} build graph`)
      continue
    }
    for (const violation of inspectBuildGraph(graph)) failures.push(violation)
  }

  if (failures.length > 0) {
    return yield* Effect.fail(new DistValidationError({ reason: failures.join("\n") }))
  }
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
