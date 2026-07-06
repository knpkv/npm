#!/usr/bin/env tsx
/**
 * Regeneration script for Clockify API client.
 *
 * 1. Fetches latest OpenAPI spec from Clockify docs
 * 2. Applies local patches (.specs/clockify-v1.patch.json) to fix incomplete DTOs
 * 3. Generates TypeScript types via openapi-typescript
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { HttpClient } from "effect/unstable/http"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

const SPEC_URL = "https://docs.clockify.me/openapi.json"

interface SpecInfo {
  version: string
  title: string
}

interface ScriptPaths {
  readonly packageDir: string
  readonly specsDir: string
  readonly specFile: string
  readonly patchFile: string
  readonly outputFile: string
  readonly versionFile: string
}

interface ClockifySchema {
  properties?: Record<string, unknown>
  required?: unknown
}

interface ClockifySpec {
  components?: {
    schemas?: Record<string, ClockifySchema>
  }
}

interface ClockifySchemaPatch {
  readonly renameProperties?: Record<string, string>
  readonly addProperties?: Record<string, unknown>
  readonly patchProperties?: Record<string, unknown>
  readonly required?: unknown
}

interface ClockifyPatches {
  readonly schemas?: Record<string, ClockifySchemaPatch>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const toStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

const toClockifySpec = (value: unknown): ClockifySpec => {
  const components = isRecord(value) ? value.components : undefined
  const schemas = isRecord(components) && isRecord(components.schemas) ? components.schemas : undefined
  return schemas ? { components: { schemas } } : {}
}

const toClockifyPatches = (value: unknown): ClockifyPatches => {
  const schemas = isRecord(value) && isRecord(value.schemas) ? value.schemas : undefined
  if (!schemas) return {}
  return {
    schemas: Object.fromEntries(
      Object.entries(schemas).flatMap(([schemaName, patch]) => {
        if (!isRecord(patch)) return []
        const renameProperties = toStringRecord(patch.renameProperties)
        const required = Array.isArray(patch.required)
          ? patch.required.filter((item): item is string => typeof item === "string")
          : undefined
        return [[
          schemaName,
          {
            ...(renameProperties ? { renameProperties } : {}),
            ...(isRecord(patch.addProperties) ? { addProperties: patch.addProperties } : {}),
            ...(isRecord(patch.patchProperties) ? { patchProperties: patch.patchProperties } : {}),
            ...(required ? { required } : {})
          } satisfies ClockifySchemaPatch
        ]]
      })
    )
  }
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

const decodeJsonString = (text: string): Effect.Effect<Schema.Json, RegenerateError> =>
  Schema.decodeUnknownEffect(JsonString)(text).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "JSON decode failed", cause }))
  )

const encodeJsonString = (value: unknown): Effect.Effect<string, RegenerateError> =>
  Schema.encodeUnknownEffect(JsonString)(value).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => new RegenerateError({ message: "JSON encode failed", cause }))
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
    specFile: path.join(specsDir, "clockify-v1.json"),
    patchFile: path.join(specsDir, "clockify-v1.patch.json"),
    outputFile: path.join(packageDir, "src", "generated", "schema.d.ts"),
    versionFile: path.join(specsDir, "VERSION")
  }
})

const fetchSpecInfo: Effect.Effect<SpecInfo, RegenerateError, HttpClient.HttpClient> = fetchText(SPEC_URL).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SpecInfoResponse))),
  Effect.map(({ info }) => ({ version: info.version, title: info.title })),
  Effect.mapError((cause) => new RegenerateError({ message: "JSON decode failed", cause }))
)

const fetchAndSaveSpec = (
  packageDir: string,
  outputFile: string
): Effect.Effect<
  void,
  RegenerateError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spec = yield* fetchText(SPEC_URL)
    const encodedSpec = yield* decodeJsonString(spec).pipe(Effect.flatMap(encodeJsonString))
    yield* fs.writeFileString(outputFile, encodedSpec).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Save failed", cause }))
    )
    yield* formatFile(packageDir, outputFile)
  })

/**
 * Apply patches from clockify-v1.patch.json to the spec in-place.
 * Keeps original spec clean — patches add missing fields and required arrays.
 */
const applyPatches = (
  packageDir: string,
  specFile: string,
  patchFile: string
): Effect.Effect<void, RegenerateError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const patchExists = yield* fs.exists(patchFile).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Patch lookup failed", cause }))
    )
    if (!patchExists) return

    const [specText, patchText] = yield* Effect.all([
      fs.readFileString(specFile),
      fs.readFileString(patchFile)
    ]).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Patch read failed", cause }))
    )

    const [specJson, patchJson] = yield* Effect.all([
      decodeJsonString(specText),
      decodeJsonString(patchText)
    ]).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Patch parse failed", cause }))
    )
    const spec = toClockifySpec(specJson)
    const patches = toClockifyPatches(patchJson)

    yield* Effect.try({
      try: () => {
        const schemas = spec.components?.schemas ?? {}

        for (const [schemaName, patch] of Object.entries(patches.schemas ?? {})) {
          const schema = schemas[schemaName]
          if (!schema) continue

          // Rename properties (e.g. get_id -> id)
          if (patch.renameProperties) {
            for (const [from, to] of Object.entries(patch.renameProperties)) {
              if (schema.properties?.[from]) {
                schema.properties[to] = schema.properties[from]
                delete schema.properties[from]
              }
            }
          }

          // Add new properties
          if (patch.addProperties) {
            schema.properties = { ...schema.properties, ...patch.addProperties }
          }

          // Patch existing properties (overwrite)
          if (patch.patchProperties) {
            schema.properties = { ...schema.properties }
            for (const [name, value] of Object.entries(patch.patchProperties)) {
              schema.properties[name] = value
            }
          }

          // Set required fields
          if (patch.required) {
            schema.required = patch.required
          }
        }
      },
      catch: (cause) => new RegenerateError({ message: "Patch failed", cause })
    })

    const encodedSpec = yield* encodeJsonString(spec).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Patch encode failed", cause }))
    )
    yield* fs.writeFileString(specFile, encodedSpec).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Patch write failed", cause }))
    )
    yield* formatFile(packageDir, specFile)
  })

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
  paths: ScriptPaths
): Effect.Effect<void, RegenerateError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const command = ChildProcess.make("pnpm", ["exec", "openapi-typescript", paths.specFile, "-o", paths.outputFile], {
      cwd: paths.packageDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
    const exitCode = yield* commandExitCode(command).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Generation failed", cause }))
    )

    if (exitCode !== 0) {
      return yield* Effect.fail(new RegenerateError({ message: "Generation failed", cause: { exitCode } }))
    }
  })

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* scriptPaths

  yield* Console.log("Fetching Clockify API spec version...")

  const info = yield* fetchSpecInfo
  const current = yield* fs.exists(paths.versionFile).pipe(
    Effect.flatMap((exists) => exists ? fs.readFileString(paths.versionFile) : Effect.succeed(null)),
    Effect.map((content) => content?.trim() ?? null),
    Effect.mapError((cause) => new RegenerateError({ message: "Version read failed", cause }))
  )

  yield* Console.log(`Current: ${current ?? "none"}, Remote: ${info.version}`)

  if (current === info.version) {
    yield* Console.log("Spec up to date, regenerating types...")
  } else {
    yield* fs.makeDirectory(paths.specsDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Spec directory creation failed", cause }))
    )

    yield* Console.log(`Fetching spec (${info.version})...`)
    yield* fetchAndSaveSpec(paths.packageDir, paths.specFile)
    yield* fs.writeFileString(paths.versionFile, info.version).pipe(
      Effect.mapError((cause) => new RegenerateError({ message: "Version write failed", cause }))
    )
  }

  yield* Console.log("Applying patches...")
  yield* applyPatches(paths.packageDir, paths.specFile, paths.patchFile)

  yield* Console.log("Generating types...")
  yield* generateTypes(paths)

  yield* Console.log("Done.")
})

program.pipe(
  Effect.provide(NodeHttpClient.layerFetch),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
