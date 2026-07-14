import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as ts from "typescript"
import { type ControlCenterBuildTarget, decodeBuildGraph, inspectBuildGraph } from "./build-graph.js"

class DistValidationError extends Data.TaggedError("DistValidationError")<{
  readonly reason: string
}> {}

const formatTypeScriptDiagnostic = (diagnostic: ts.Diagnostic): string =>
  ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")

const isKnownEffectDeclarationDiagnostic = (diagnostic: ts.Diagnostic): boolean =>
  diagnostic.code === 2304 &&
  diagnostic.file?.fileName.replaceAll("\\", "/").includes("/effect/dist/internal/schema/schema.d.ts") === true &&
  formatTypeScriptDiagnostic(diagnostic).includes("SchemaErrorTypeId")

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
      "dist/server/server/cli.js",
      "dist/server/build-graph.json"
    ]
  ) {
    if (!(yield* fs.exists(path.join(packageRoot, artifact)))) failures.push(`missing ${artifact}`)
  }

  const serverArtifacts = yield* filesWithin(fs, path, serverRoot)
  const serverFiles = serverArtifacts.map((file) => path.relative(serverRoot, file).replaceAll("\\", "/"))
  if (serverFiles.some((file) => file.startsWith("client/"))) failures.push("server build emitted browser source")

  const pluginDefinitionDeclaration = path.join(
    serverRoot,
    "server/plugins/PluginDefinitionV1.d.ts"
  )
  if (yield* fs.exists(pluginDefinitionDeclaration)) {
    const declaration = yield* fs.readFileString(pluginDefinitionDeclaration)
    if (declaration.includes("internal/") || declaration.includes("AuthorizedPluginExecutor")) {
      failures.push("public PluginDefinitionV1 declaration references live plugin execution internals")
    }
  } else {
    failures.push("missing import-clean PluginDefinitionV1 declaration")
  }

  const packedConsumerPath = path.join(packageRoot, "packed-plugin-definition-consumer.mts")
  const packedConsumerSource = `import type { PluginDefinitionV1 } from ${
    JSON.stringify(
      path.join(serverRoot, "server/index.js")
    )
  }\nexport const descriptor = (definition: PluginDefinitionV1): unknown => definition.rawDescriptor\n`
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true
  }
  const defaultCompilerHost = ts.createCompilerHost(compilerOptions)
  const compilerHost: ts.CompilerHost = {
    ...defaultCompilerHost,
    fileExists: (fileName) => fileName === packedConsumerPath || defaultCompilerHost.fileExists(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === packedConsumerPath
        ? ts.createSourceFile(fileName, packedConsumerSource, languageVersion, true, ts.ScriptKind.TS)
        : defaultCompilerHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
    readFile: (fileName) =>
      fileName === packedConsumerPath
        ? packedConsumerSource
        : defaultCompilerHost.readFile(fileName)
  }
  const packedDiagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram({ rootNames: [packedConsumerPath], options: compilerOptions, host: compilerHost })
  )
  for (const diagnostic of packedDiagnostics) {
    failures.push(
      `packed PluginDefinitionV1 consumer typecheck failed: ${formatTypeScriptDiagnostic(diagnostic)}`
    )
  }

  const declarationCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts", "lib.dom.d.ts"],
    skipLibCheck: false,
    types: ["node"]
  }
  const declarationDiagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram({
      rootNames: serverArtifacts.filter((file) => file.endsWith(".d.ts")),
      options: declarationCompilerOptions
    })
  )
  for (const diagnostic of declarationDiagnostics) {
    if (isKnownEffectDeclarationDiagnostic(diagnostic)) continue
    const diagnosticPath = diagnostic.file?.fileName
    failures.push(
      `emitted declaration integrity failed${
        diagnosticPath === undefined ? "" : ` in ${path.relative(packageRoot, diagnosticPath)}`
      }: ${formatTypeScriptDiagnostic(diagnostic)}`
    )
  }

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
