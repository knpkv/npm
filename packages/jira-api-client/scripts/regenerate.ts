#!/usr/bin/env tsx
/**
 * Regeneration script for Jira API types.
 *
 * Fetches OpenAPI specs from Atlassian and regenerates openapi-typescript types.
 */
import { Command, Flag as Options } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import pkg from "../package.json" with { type: "json" }

const SPEC_URLS = {
  v3: "https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json"
} as const

interface SpecInfo {
  version: string
  title: string
}

interface ScriptPaths {
  readonly packageDir: string
  readonly specsDir: string
  readonly versionV3File: string
  readonly generatedDir: string
}

const scriptPaths: Effect.Effect<ScriptPaths, Error, Path.Path> = Effect.gen(function*() {
  const path = yield* Path.Path
  const scriptFile = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError((e) => new Error(`Script path resolution failed: ${e.message}`))
  )
  const scriptDir = path.dirname(scriptFile)
  const packageDir = path.join(scriptDir, "..")
  const specsDir = path.join(packageDir, ".specs")

  return {
    packageDir,
    specsDir,
    versionV3File: path.join(specsDir, "VERSION_V3"),
    generatedDir: path.join(packageDir, "src", "generated", "v3")
  }
})

const fetchSpecInfo = (url: string): Effect.Effect<SpecInfo, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`)
      }
      const spec = await response.json() as { info: { version: string; title: string } }
      return { version: spec.info.version, title: spec.info.title }
    },
    catch: (e) => new Error(`Fetch failed: ${e}`)
  })

const fetchAndSaveSpec = (url: string, outputPath: string): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spec = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`Failed to fetch ${url}: ${response.status}`)
        }
        return await response.text()
      },
      catch: (e) => new Error(`Fetch failed: ${e}`)
    })
    yield* fs.writeFileString(outputPath, spec).pipe(
      Effect.mapError((e) => new Error(`Save failed: ${e.message}`))
    )
  })

const readVersion = (file: string): Effect.Effect<string | null, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((e) => new Error(`Version lookup failed: ${e.message}`))
    )
    if (!exists) return null

    return yield* fs.readFileString(file).pipe(
      Effect.map((version) => version.trim()),
      Effect.mapError((e) => new Error(`Version read failed: ${e.message}`))
    )
  })

const writeVersion = (file: string, version: string): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(file, version).pipe(
      Effect.mapError((e) => new Error(`Version write failed: ${e.message}`))
    )
  })

const ensureDir = (dir: string): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError((e) => new Error(`Directory creation failed: ${e.message}`))
    )
  })

const generateTypes = (
  packageDir: string,
  generatedDir: string,
  specPath: string
): Effect.Effect<void, Error, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const outputFile = path.join(generatedDir, "schema.d.ts")
    const command = ChildProcess.make("pnpm", ["exec", "openapi-typescript", specPath, "-o", outputFile], {
      cwd: packageDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
    const exitCode = yield* commandExitCode(command).pipe(
      Effect.mapError((e) => new Error(`Type generation failed: ${e.message}`))
    )

    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`Type generation failed with exit code ${exitCode}`))
    }
  })

const commandExitCode = (
  command: ChildProcess.Command
): Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.exitCode(command))
  )

const readArgv: Effect.Effect<ReadonlyArray<string>, never, Stdio.Stdio> = Stdio.Stdio.pipe(
  Effect.flatMap((stdio) => stdio.args)
)

const checkOnly = Options.boolean("check").pipe(
  Options.withDescription("Check only, exit 1 if outdated"),
  Options.withDefault(false)
)

const regenerate = Command.make("regenerate", { checkOnly }, ({ checkOnly }) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const paths = yield* scriptPaths

    yield* Console.log("Fetching Jira API spec version...")

    const v3Info = yield* fetchSpecInfo(SPEC_URLS.v3)
    const currentV3 = yield* readVersion(paths.versionV3File)

    yield* Console.log(`V3: current=${currentV3 ?? "none"}, remote=${v3Info.version}`)

    const v3Changed = currentV3 !== v3Info.version

    if (!v3Changed) {
      yield* Console.log("Spec is up to date.")
      return
    }

    if (checkOnly) {
      yield* Console.log("Spec is outdated!")
      yield* Console.log(`  V3: ${currentV3} -> ${v3Info.version}`)
      return yield* Effect.fail(new Error("Spec outdated"))
    }

    yield* ensureDir(paths.specsDir)
    yield* ensureDir(paths.generatedDir)

    const specPath = path.join(paths.specsDir, `jira-v3-${v3Info.version}.json`)

    yield* Console.log(`Fetching V3 spec (${v3Info.version})...`)
    yield* fetchAndSaveSpec(SPEC_URLS.v3, specPath)
    yield* Console.log(`Saved: ${specPath}`)

    yield* Console.log("Generating types...")
    yield* generateTypes(paths.packageDir, paths.generatedDir, specPath)
    yield* Console.log(`Generated: src/generated/v3/schema.d.ts`)

    yield* writeVersion(paths.versionV3File, v3Info.version)
    yield* Console.log("Done!")
  })
).pipe(Command.withDescription("Regenerate Jira API types from OpenAPI specs"))

const cli = Command.run(regenerate, {
  name: pkg.name,
  version: pkg.version
})

Effect.gen(function*() {
  const argv = yield* readArgv
  yield* cli(argv)
}).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
