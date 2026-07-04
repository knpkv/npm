#!/usr/bin/env tsx
/**
 * Regeneration script for Confluence API clients.
 *
 * Fetches OpenAPI specs from Atlassian, compares versions, and regenerates types if needed.
 */
import { Command, Flag as Options } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { HttpClient } from "effect/unstable/http"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import pkg from "../package.json" with { type: "json" }

const SPEC_URLS = {
  v1: "https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json",
  v2: "https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json"
} as const

interface SpecInfo {
  version: string
  title: string
}

interface ScriptPaths {
  readonly packageDir: string
  readonly specsDir: string
  readonly versionV1File: string
  readonly versionV2File: string
  readonly generatedV1Dir: string
  readonly generatedV2Dir: string
}

class RegenerateError extends Data.TaggedError("RegenerateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const JsonString = Schema.fromJsonString(Schema.Json)

const SpecInfoResponse = Schema.Struct({
  info: Schema.Struct({
    version: Schema.String,
    title: Schema.String
  })
})

const fetchText = (url: string): Effect.Effect<string, RegenerateError, HttpClient.HttpClient> =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.text
        : Effect.fail(new RegenerateError({ message: `Failed to fetch ${url}`, cause: { status: response.status } }))
    ),
    Effect.mapError((cause) => new RegenerateError({ message: `Fetch failed: ${url}`, cause }))
  )

const fetchSpecInfo = (url: string): Effect.Effect<SpecInfo, RegenerateError, HttpClient.HttpClient> =>
  fetchText(url).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SpecInfoResponse))),
    Effect.map(({ info }) => ({ version: info.version, title: info.title })),
    Effect.mapError((cause) => new RegenerateError({ message: "JSON decode failed", cause }))
  )

const formatJson = (text: string): Effect.Effect<string, RegenerateError> =>
  Schema.decodeUnknownEffect(JsonString)(text).pipe(
    Effect.flatMap(Schema.encodeEffect(JsonString)),
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => new RegenerateError({ message: "JSON format failed", cause }))
  )

const scriptPaths: Effect.Effect<ScriptPaths, RegenerateError, Path.Path> = Effect.gen(function*() {
  const path = yield* Path.Path
  const scriptFile = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Script path resolution failed", cause }))
  )
  const scriptDir = path.dirname(scriptFile)
  const packageDir = path.join(scriptDir, "..")
  const specsDir = path.join(packageDir, ".specs")

  return {
    packageDir,
    specsDir,
    versionV1File: path.join(specsDir, "VERSION_V1"),
    versionV2File: path.join(specsDir, "VERSION_V2"),
    generatedV1Dir: path.join(packageDir, "src", "generated", "v1"),
    generatedV2Dir: path.join(packageDir, "src", "generated", "v2")
  }
})

const fetchAndSaveSpec = (
  packageDir: string,
  url: string,
  outputPath: string
): Effect.Effect<
  void,
  RegenerateError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spec = yield* fetchText(url)
    const formattedSpec = yield* formatJson(spec)
    yield* fs.writeFileString(outputPath, formattedSpec).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Save failed", cause }))
    )
    yield* formatFile(packageDir, outputPath)
  })

const readVersion = (file: string): Effect.Effect<string | null, RegenerateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Version lookup failed", cause }))
    )
    if (!exists) return null

    return yield* fs.readFileString(file).pipe(
      Effect.map((version) => version.trim()),
      Effect.mapError((cause) => new RegenerateError({ message: "Version read failed", cause }))
    )
  })

const writeVersion = (file: string, version: string): Effect.Effect<void, RegenerateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(file, version).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Version write failed", cause }))
    )
  })

const ensureDir = (dir: string): Effect.Effect<void, RegenerateError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Directory creation failed", cause }))
    )
  })

interface GenerateTypesOptions {
  readonly packageDir: string
  readonly specPath: string
  readonly outputDir: string
}

const commandExitCode = (
  command: ChildProcess.Command
): Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.exitCode(command))
  )

const formatFile = (
  packageDir: string,
  file: string
): Effect.Effect<void, RegenerateError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const command = ChildProcess.make("pnpm", ["exec", "prettier", "--write", file], {
      cwd: packageDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
    const exitCode = yield* commandExitCode(command).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Formatting failed", cause }))
    )

    if (exitCode !== 0) {
      return yield* Effect.fail(new RegenerateError({ message: "Formatting failed", cause: { exitCode } }))
    }
  })

const generateTypes = (
  options: GenerateTypesOptions
): Effect.Effect<void, RegenerateError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const outputFile = path.join(options.outputDir, "schema.d.ts")
    const command = ChildProcess.make("pnpm", ["exec", "openapi-typescript", options.specPath, "-o", outputFile], {
      cwd: options.packageDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
    const exitCode = yield* commandExitCode(command).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Type generation failed", cause }))
    )

    if (exitCode !== 0) {
      return yield* Effect.fail(new RegenerateError({ message: "Type generation failed", cause: { exitCode } }))
    }
  })

const checkOnly = Options.boolean("check").pipe(
  Options.withDescription("Check only, exit 1 if outdated"),
  Options.withDefault(false)
)

const regenerate = Command.make("regenerate", { checkOnly }, ({ checkOnly }) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const paths = yield* scriptPaths

    yield* Console.log("Fetching Confluence API spec versions...")

    const [v1Info, v2Info] = yield* Effect.all([
      fetchSpecInfo(SPEC_URLS.v1),
      fetchSpecInfo(SPEC_URLS.v2)
    ])

    const currentV1 = yield* readVersion(paths.versionV1File)
    const currentV2 = yield* readVersion(paths.versionV2File)

    yield* Console.log(`V1: current=${currentV1 ?? "none"}, remote=${v1Info.version}`)
    yield* Console.log(`V2: current=${currentV2 ?? "none"}, remote=${v2Info.version}`)

    const v1Changed = currentV1 !== v1Info.version
    const v2Changed = currentV2 !== v2Info.version

    if (!v1Changed && !v2Changed) {
      yield* Console.log("All specs up to date.")
      return
    }

    if (checkOnly) {
      yield* Console.log("Specs are outdated!")
      if (v1Changed) yield* Console.log(`  V1: ${currentV1} -> ${v1Info.version}`)
      if (v2Changed) yield* Console.log(`  V2: ${currentV2} -> ${v2Info.version}`)
      return yield* Effect.fail(new RegenerateError({ message: "Specs outdated" }))
    }

    yield* ensureDir(paths.specsDir)
    yield* ensureDir(paths.generatedV1Dir)
    yield* ensureDir(paths.generatedV2Dir)

    if (v1Changed) {
      yield* Console.log(`Fetching V1 spec (${v1Info.version})...`)
      const specPath = path.join(paths.specsDir, `confluence-v1-${v1Info.version}.json`)
      yield* fetchAndSaveSpec(paths.packageDir, SPEC_URLS.v1, specPath)
      yield* Console.log(`Saved: ${specPath}`)

      yield* Console.log("Generating V1 types...")
      yield* generateTypes({
        packageDir: paths.packageDir,
        specPath,
        outputDir: paths.generatedV1Dir
      })
      yield* Console.log(`Generated: src/generated/v1/schema.d.ts`)

      yield* writeVersion(paths.versionV1File, v1Info.version)
    }

    if (v2Changed) {
      yield* Console.log(`Fetching V2 spec (${v2Info.version})...`)
      const specPath = path.join(paths.specsDir, `confluence-v2-${v2Info.version}.json`)
      yield* fetchAndSaveSpec(paths.packageDir, SPEC_URLS.v2, specPath)
      yield* Console.log(`Saved: ${specPath}`)

      yield* Console.log("Generating V2 types...")
      yield* generateTypes({
        packageDir: paths.packageDir,
        specPath,
        outputDir: paths.generatedV2Dir
      })
      yield* Console.log(`Generated: src/generated/v2/schema.d.ts`)

      yield* writeVersion(paths.versionV2File, v2Info.version)
    }

    yield* Console.log("Done!")
  })).pipe(Command.withDescription("Regenerate Confluence API types from OpenAPI specs"))

const cli = Command.run(regenerate, {
  name: pkg.name,
  version: pkg.version
})

cli.pipe(
  Effect.provide(NodeHttpClient.layerFetch),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
