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
import {
  decodeClientBuildManifest,
  initialJavaScriptArtifacts,
  inspectClientBuildContract
} from "./clientBuildContract.js"
import { inspectServerDeclarationContract } from "./serverDeclarationContract.js"

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
      "dist/server/server/auth/index.d.ts",
      "dist/server/server/cli.js",
      "dist/server/server/persistence/index.d.ts",
      "dist/server/build-graph.json"
    ]
  ) {
    if (!(yield* fs.exists(path.join(packageRoot, artifact)))) failures.push(`missing ${artifact}`)
  }

  const clientArtifacts = yield* filesWithin(fs, path, clientRoot)
  const serverArtifacts = yield* filesWithin(fs, path, serverRoot)
  const serverFiles = serverArtifacts.map((file) => path.relative(serverRoot, file).replaceAll("\\", "/"))
  if (serverFiles.some((file) => file.startsWith("client/"))) failures.push("server build emitted browser source")

  const clientManifestSource = yield* fs.readFileString(path.join(clientRoot, ".vite/manifest.json"))
  const clientManifestValue = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    clientManifestSource
  ).pipe(Effect.mapError(() => new DistValidationError({ reason: "invalid client manifest JSON" })))
  const clientManifest = decodeClientBuildManifest(clientManifestValue)
  if (clientManifest === undefined) {
    failures.push("invalid client manifest")
  } else {
    const clientArtifactPaths = new Map(
      clientArtifacts.map((file) => [path.relative(clientRoot, file).replaceAll("\\", "/"), file])
    )
    const clientArtifactSizes = new Map<string, number>()
    for (const artifact of initialJavaScriptArtifacts(clientManifest)) {
      const absolute = clientArtifactPaths.get(artifact)
      if (absolute === undefined) continue
      const info = yield* fs.stat(absolute)
      clientArtifactSizes.set(artifact, Number(info.size))
    }
    for (const violation of inspectClientBuildContract(clientManifest, clientArtifactSizes)) failures.push(violation)
  }

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

  const publicServerDeclarationPaths = {
    authIndex: path.join(serverRoot, "server/auth/index.d.ts"),
    persistenceIndex: path.join(serverRoot, "server/persistence/index.d.ts"),
    serverIndex: path.join(serverRoot, "server/index.d.ts")
  }
  if (
    (yield* fs.exists(publicServerDeclarationPaths.authIndex)) &&
    (yield* fs.exists(publicServerDeclarationPaths.persistenceIndex)) &&
    (yield* fs.exists(publicServerDeclarationPaths.serverIndex))
  ) {
    const declarationViolations = inspectServerDeclarationContract({
      authIndex: yield* fs.readFileString(publicServerDeclarationPaths.authIndex),
      persistenceIndex: yield* fs.readFileString(publicServerDeclarationPaths.persistenceIndex),
      serverIndex: yield* fs.readFileString(publicServerDeclarationPaths.serverIndex)
    })
    for (const violation of declarationViolations) failures.push(violation)
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
  const forbiddenFactoryConsumerPath = path.join(packageRoot, "forbidden-server-factory-consumer.mts")
  const forbiddenFactoryConsumerSource = `import { authLayerFromDatabase, persistenceLayerFromDatabase } from ${
    JSON.stringify(path.join(serverRoot, "server/index.js"))
  }\nvoid authLayerFromDatabase\nvoid persistenceLayerFromDatabase\n`
  const virtualSources = new Map([
    [forbiddenFactoryConsumerPath, forbiddenFactoryConsumerSource],
    [packedConsumerPath, packedConsumerSource]
  ])
  const compilerHost: ts.CompilerHost = {
    ...defaultCompilerHost,
    fileExists: (fileName) => virtualSources.has(fileName) || defaultCompilerHost.fileExists(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const virtualSource = virtualSources.get(fileName)
      return virtualSource === undefined
        ? defaultCompilerHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, virtualSource, languageVersion, true, ts.ScriptKind.TS)
    },
    readFile: (fileName) => virtualSources.get(fileName) ?? defaultCompilerHost.readFile(fileName)
  }
  const packedDiagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram({ rootNames: [packedConsumerPath], options: compilerOptions, host: compilerHost })
  )
  for (const diagnostic of packedDiagnostics) {
    failures.push(
      `packed PluginDefinitionV1 consumer typecheck failed: ${formatTypeScriptDiagnostic(diagnostic)}`
    )
  }

  const forbiddenFactoryDiagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram({ rootNames: [forbiddenFactoryConsumerPath], options: compilerOptions, host: compilerHost })
  )
  const forbiddenFactoryNames = ["authLayerFromDatabase", "persistenceLayerFromDatabase"]
  for (const factoryName of forbiddenFactoryNames) {
    const isHidden = forbiddenFactoryDiagnostics.some((diagnostic) => {
      const message = formatTypeScriptDiagnostic(diagnostic)
      return [2305, 2459, 2724].includes(diagnostic.code) && message.includes(factoryName)
    })
    if (!isHidden) failures.push(`public server entry exposes internal factory ${factoryName}`)
  }
  for (const diagnostic of forbiddenFactoryDiagnostics) {
    const message = formatTypeScriptDiagnostic(diagnostic)
    const isExpected = [2305, 2459, 2724].includes(diagnostic.code) &&
      forbiddenFactoryNames.some((factoryName) => message.includes(factoryName))
    if (!isExpected) failures.push(`private server factory consumer typecheck failed: ${message}`)
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
      {
        files: clientArtifacts,
        forbidden: ["/src/server/", "@knpkv/control-center/server"],
        name: "client",
        root: clientRoot
      },
      { files: serverArtifacts, forbidden: ["/src/client/", "@knpkv/rly"], name: "server", root: serverRoot }
    ]
  ) {
    for (const file of contract.files) {
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
