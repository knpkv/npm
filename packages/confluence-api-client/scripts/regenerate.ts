#!/usr/bin/env tsx
/**
 * Fetch, compare, patch, and regenerate the Confluence API clients.
 *
 * The committed OpenAPI documents are unmodified upstream documents. RFC 6902
 * patches and OpenAPI-to-JSON-Schema normalization are applied only in memory.
 */
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import * as OpenApiPatch from "@effect/openapi-generator/OpenApiPatch"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi"
import { format as formatSource } from "prettier"

type ApiVersion = "v1" | "v2"

const SPEC_URLS: Readonly<Record<ApiVersion, string>> = {
  v1: "https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json",
  v2: "https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json"
}

class RegenerateError extends Data.TaggedError("RegenerateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const JsonString = Schema.fromJsonString(Schema.Json)

const OpenApiDocument = Schema.declare<OpenAPISpec>(
  (value): value is OpenAPISpec =>
    Predicate.hasProperty(value, "paths") &&
    Predicate.isObject(value.paths) &&
    (Predicate.hasProperty(value, "openapi") || Predicate.hasProperty(value, "swagger")),
  { identifier: "OpenApiDocument" }
)

const SpecInfo = Schema.Struct({ info: Schema.Struct({ version: Schema.String }) })

interface VersionPaths {
  readonly specFile: string
  readonly patchFile: string
  readonly outputFile: string
  readonly versionFile: string
}

interface ScriptPaths {
  readonly packageDir: string
  readonly versions: Readonly<Record<ApiVersion, VersionPaths>>
}

const paths = Effect.gen(function*() {
  const path = yield* Path.Path
  const scriptFile = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not resolve script path", cause }))
  )
  const packageDir = path.join(path.dirname(scriptFile), "..")
  const specsDir = path.join(packageDir, ".specs")
  const generatedDir = path.join(packageDir, "src", "generated")
  return {
    packageDir,
    versions: {
      v1: {
        specFile: path.join(specsDir, "confluence-v1.json"),
        patchFile: path.join(specsDir, "confluence-v1.patch.json"),
        outputFile: path.join(generatedDir, "ConfluenceV1Api.ts"),
        versionFile: path.join(specsDir, "VERSION_V1")
      },
      v2: {
        specFile: path.join(specsDir, "confluence-v2.json"),
        patchFile: path.join(specsDir, "confluence-v2.patch.json"),
        outputFile: path.join(generatedDir, "ConfluenceV2Api.ts"),
        versionFile: path.join(specsDir, "VERSION_V2")
      }
    }
  } satisfies ScriptPaths
})

const fetchUpstream = (version: ApiVersion) =>
  HttpClient.get(SPEC_URLS[version]).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.text.pipe(
          Effect.mapError((cause) =>
            new RegenerateError({
              message: `Could not read Confluence ${version} response`,
              cause
            })
          )
        )
        : Effect.fail(
          new RegenerateError({
            message: `Confluence ${version} spec request failed with status ${response.status}`
          })
        )
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
    Effect.mapError((cause) =>
      new RegenerateError({
        message: `Could not fetch or decode Confluence ${version} spec`,
        cause
      })
    )
  )

const canonicalJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.map((json) => `${json}\n`),
    Effect.mapError((cause) => new RegenerateError({ message: "Could not encode Confluence spec", cause }))
  )

const formattedJson = (value: Schema.Json, version: ApiVersion) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.flatMap((source) =>
      Effect.tryPromise({
        try: () => formatSource(source, { parser: "json", printWidth: 120, trailingComma: "none", semi: false }),
        catch: (cause) => new RegenerateError({ message: `Could not format Confluence ${version} spec`, cause })
      })
    ),
    Effect.mapError((cause) => new RegenerateError({ message: `Could not format Confluence ${version} spec`, cause }))
  )

/** Convert OpenAPI 3.0 nullable metadata into JSON Schema understood by Effect. */
const normalizeSchema = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const { default: _default, examples: _examples, ...withoutMetadata } = schema
  if (!Predicate.hasProperty(withoutMetadata, "nullable")) return withoutMetadata
  const { nullable, ...normalized } = withoutMetadata
  return nullable === true ? { anyOf: [normalized, { type: "null" }] } : normalized
}

const stripTrailingWhitespace = (source: string): string => source.replace(/[ \t]+$/gm, "")

const isJsonObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } => Predicate.isObject(value)

const hasJsonSchema = (response: Schema.Json): boolean => {
  if (!isJsonObject(response)) return false
  const content = response["content"]
  if (content === undefined || !isJsonObject(content)) return false
  const json = content["application/json"]
  return json !== undefined && isJsonObject(json) && json["schema"] !== undefined
}

/**
 * Empty error responses contain no value to decode. Removing them makes the
 * generated client reject those statuses through its unexpected-status path
 * instead of incorrectly treating them as successful `void` responses.
 */
const removeUntypedErrorResponses = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(removeUntypedErrorResponses)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "responses" || !isJsonObject(child)) {
        return [key, removeUntypedErrorResponses(child)]
      }
      return [
        key,
        Object.fromEntries(
          Object.entries(child)
            .filter(([status, response]) =>
              Number(status) < 400 || Number.isNaN(Number(status)) || hasJsonSchema(response)
            )
            .map(([status, response]) => [status, removeUntypedErrorResponses(response)])
        )
      ]
    })
  )
}

const generateVersion = Effect.fn("Confluence.regenerate.generateVersion")(function*(
  version: ApiVersion,
  versionPaths: VersionPaths,
  upstream: Schema.Json
) {
  const fs = yield* FileSystem.FileSystem
  const patch = yield* OpenApiPatch.parsePatchInput(versionPaths.patchFile).pipe(
    Effect.mapError((cause) =>
      new RegenerateError({
        message: `Could not parse Confluence ${version} JSON patch`,
        cause
      })
    )
  )
  const patched = yield* OpenApiPatch.applyPatches(
    [{ source: versionPaths.patchFile, patch }],
    upstream
  ).pipe(
    Effect.mapError((cause) =>
      new RegenerateError({
        message: `Could not apply Confluence ${version} JSON patch`,
        cause
      })
    )
  )
  const document = yield* Schema.decodeUnknownEffect(OpenApiDocument)(removeUntypedErrorResponses(patched)).pipe(
    Effect.mapError((cause) =>
      new RegenerateError({
        message: `Patched Confluence ${version} document is not OpenAPI`,
        cause
      })
    )
  )
  const generator = yield* OpenApiGenerator.OpenApiGenerator
  const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []
  const generated = yield* generator.generate(document, {
    name: version === "v1" ? "ConfluenceV1Api" : "ConfluenceV2Api",
    format: "httpclient",
    onEnter: normalizeSchema,
    onWarning: (warning) => warnings.push(warning)
  })
  yield* Effect.forEach(
    warnings,
    (warning) =>
      Console.warn(
        `[${version}] [${warning.code}] ${warning.method ?? ""} ${warning.path ?? ""}: ${warning.message}`
      ),
    { discard: true }
  )
  yield* fs.writeFileString(versionPaths.outputFile, stripTrailingWhitespace(generated)).pipe(
    Effect.mapError((cause) =>
      new RegenerateError({
        message: `Could not write generated Confluence ${version} client`,
        cause
      })
    )
  )
})

const check = Flag.boolean("check").pipe(
  Flag.withDescription("Exit non-zero when either committed upstream spec differs from Confluence")
)

const local = Flag.boolean("local").pipe(
  Flag.withDescription("Regenerate both clients from the committed specs without contacting Confluence")
)

const readCommitted = (version: ApiVersion, versionPaths: VersionPaths) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(versionPaths.specFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
      Effect.mapError((cause) =>
        new RegenerateError({
          message: `Could not read committed Confluence ${version} spec`,
          cause
        })
      )
    )
  })

const root = Command.make("confluence-api-regenerate", { check, local }).pipe(
  Command.withHandler(
    Effect.fn("Confluence.regenerate")(function*({ check, local }) {
      if (check && local) {
        return yield* new RegenerateError({ message: "--check and --local cannot be combined" })
      }

      const fs = yield* FileSystem.FileSystem
      const scriptPaths = yield* paths
      const versions: ReadonlyArray<ApiVersion> = ["v1", "v2"]
      const upstream = local
        ? yield* Effect.all({
          v1: readCommitted("v1", scriptPaths.versions.v1),
          v2: readCommitted("v2", scriptPaths.versions.v2)
        })
        : yield* Effect.all({ v1: fetchUpstream("v1"), v2: fetchUpstream("v2") })

      if (check) {
        const changed = yield* Effect.forEach(versions, (version) =>
          Effect.gen(function*() {
            const versionPaths = scriptPaths.versions[version]
            const remote = yield* canonicalJson(upstream[version])
            const current = yield* readCommitted(version, versionPaths).pipe(
              Effect.flatMap(canonicalJson),
              Effect.orElseSucceed(() => "")
            )
            return current === remote ? undefined : version
          })).pipe(Effect.map((results) => results.filter(Predicate.isNotUndefined)))

        if (changed.length === 0) {
          return yield* Console.log("Confluence OpenAPI specs are current.")
        }
        return yield* new RegenerateError({
          message: `Confluence ${
            changed.join(" and ")
          } spec changed; run \`pnpm --filter @knpkv/confluence-api-client regenerate\``
        })
      }

      yield* Effect.forEach(versions, (version) =>
        Effect.gen(function*() {
          const versionPaths = scriptPaths.versions[version]
          const document = upstream[version]
          const { info } = yield* Schema.decodeUnknownEffect(SpecInfo)(document).pipe(
            Effect.mapError((cause) =>
              new RegenerateError({
                message: `Confluence ${version} spec has no version`,
                cause
              })
            )
          )
          yield* fs.writeFileString(versionPaths.specFile, yield* formattedJson(document, version))
          yield* fs.writeFileString(versionPaths.versionFile, `${info.version}\n`)
          yield* generateVersion(version, versionPaths, document)
          yield* Console.log(`Generated Confluence ${version} ${info.version} client from ${SPEC_URLS[version]}`)
        }), { discard: true })
    })
  )
)

const MainLayer = Layer.mergeAll(
  OpenApiGenerator.layerTransformerSchema,
  NodeHttpClient.layerFetch,
  NodeServices.layer
)

Command.run(root, { version: "1.0.0" }).pipe(
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
