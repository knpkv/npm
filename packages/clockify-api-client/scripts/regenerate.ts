#!/usr/bin/env tsx
/**
 * Fetch, compare, patch, and regenerate the Clockify API client.
 *
 * The committed OpenAPI document is the unmodified upstream document. RFC 6902
 * patches are applied in memory before Effect's OpenAPI generator runs.
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

const SPEC_URL = "https://docs.clockify.me/openapi.json"

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

const SpecInfo = Schema.Struct({
  info: Schema.Struct({ version: Schema.String })
})

interface ScriptPaths {
  readonly packageDir: string
  readonly specFile: string
  readonly patchFile: string
  readonly outputFile: string
  readonly versionFile: string
}

const paths = Effect.gen(function*() {
  const path = yield* Path.Path
  const scriptFile = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not resolve script path", cause }))
  )
  const packageDir = path.join(path.dirname(scriptFile), "..")
  const specsDir = path.join(packageDir, ".specs")
  return {
    packageDir,
    specFile: path.join(specsDir, "clockify-v1.json"),
    patchFile: path.join(specsDir, "clockify-v1.patch.json"),
    outputFile: path.join(packageDir, "src", "generated", "ClockifyApi.ts"),
    versionFile: path.join(specsDir, "VERSION")
  } satisfies ScriptPaths
})

const fetchUpstream = HttpClient.get(SPEC_URL).pipe(
  Effect.flatMap((response) =>
    response.status >= 200 && response.status < 300
      ? response.text.pipe(
        Effect.mapError((cause) => new RegenerateError({ message: "Could not read Clockify response", cause }))
      )
      : Effect.fail(
        new RegenerateError({
          message: `Clockify spec request failed with status ${response.status}`
        })
      )
  ),
  Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
  Effect.mapError((cause) => new RegenerateError({ message: "Could not fetch or decode Clockify spec", cause }))
)

const canonicalJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.map((json) => `${json}\n`),
    Effect.mapError((cause) => new RegenerateError({ message: "Could not encode Clockify spec", cause }))
  )

const formattedJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.flatMap((source) =>
      Effect.tryPromise({
        try: () => formatSource(source, { parser: "json", printWidth: 120, trailingComma: "none", semi: false }),
        catch: (cause) => new RegenerateError({ message: "Could not format Clockify spec", cause })
      })
    ),
    Effect.mapError((cause) => new RegenerateError({ message: "Could not format Clockify spec", cause }))
  )

const stripUnreliableMetadata = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const { default: _default, examples: _examples, ...normalized } = schema
  return normalized
}

const stripTrailingWhitespace = (source: string): string => source.replace(/[ \t]+$/gm, "")

/**
 * beta.97 emits an unused decoder when a spec declares no typed error bodies.
 * Remove only that exact unused block; fail if the generator shape changes.
 */
const removeUnusedErrorDecoder = (source: string): string => {
  const marker = "  const decodeError ="
  if (!source.includes(marker)) return source
  const cleaned = source.replace(/\n {2}const decodeError =[\s\S]*?\n {2}return \{/m, "\n  return {")
  if (cleaned === source || cleaned.includes(marker)) {
    throw new RegenerateError({ message: "Effect generator output changed around decodeError" })
  }
  return cleaned
}

/**
 * The generator currently passes record-shaped multipart payloads to
 * `bodyFormData`, which expects an already-built Web FormData value. Use the
 * record-aware Effect helper so strings and Blob/File values are serialized
 * with a real multipart boundary by the runtime.
 */
const normalizeMultipartBodies = (source: string): string =>
  source.replaceAll("HttpClientRequest.bodyFormData(", "HttpClientRequest.bodyFormDataRecord(")

const generate = Effect.fn("Clockify.regenerate.generate")(function*(
  scriptPaths: ScriptPaths,
  upstream: Schema.Json
) {
  const fs = yield* FileSystem.FileSystem
  const patch = yield* OpenApiPatch.parsePatchInput(scriptPaths.patchFile).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not parse Clockify JSON patch", cause }))
  )
  const patched = yield* OpenApiPatch.applyPatches(
    [{ source: scriptPaths.patchFile, patch }],
    upstream
  ).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not apply Clockify JSON patch", cause }))
  )
  const document = yield* Schema.decodeUnknownEffect(OpenApiDocument)(patched).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Patched Clockify document is not OpenAPI", cause }))
  )
  const generator = yield* OpenApiGenerator.OpenApiGenerator
  const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []
  const generated = yield* generator.generate(document, {
    name: "ClockifyApi",
    format: "httpclient",
    onEnter: stripUnreliableMetadata,
    onWarning: (warning) => warnings.push(warning)
  })
  yield* Effect.forEach(
    warnings,
    (warning) => Console.warn(`[${warning.code}] ${warning.method ?? ""} ${warning.path ?? ""}: ${warning.message}`),
    { discard: true }
  )
  yield* fs.writeFileString(
    scriptPaths.outputFile,
    stripTrailingWhitespace(normalizeMultipartBodies(removeUnusedErrorDecoder(generated)))
  ).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not write generated Clockify client", cause }))
  )
})

const check = Flag.boolean("check").pipe(
  Flag.withDescription("Exit non-zero when the committed upstream spec differs from Clockify")
)

const local = Flag.boolean("local").pipe(
  Flag.withDescription("Regenerate from the committed spec without contacting Clockify")
)

const root = Command.make("clockify-api-regenerate", { check, local }).pipe(
  Command.withHandler(
    Effect.fn("Clockify.regenerate")(function*({ check, local }) {
      const fs = yield* FileSystem.FileSystem
      const scriptPaths = yield* paths
      const upstream = local
        ? yield* fs.readFileString(scriptPaths.specFile).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
          Effect.mapError((cause) => new RegenerateError({ message: "Could not read committed Clockify spec", cause }))
        )
        : yield* fetchUpstream
      const encoded = yield* canonicalJson(upstream)
      const current = yield* fs.readFileString(scriptPaths.specFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
        Effect.flatMap(canonicalJson),
        Effect.orElseSucceed(() => "")
      )

      if (check) {
        if (local) {
          return yield* new RegenerateError({ message: "--check and --local cannot be combined" })
        }
        if (current === encoded) {
          return yield* Console.log("Clockify OpenAPI spec is current.")
        }
        return yield* new RegenerateError({
          message: "Clockify OpenAPI spec changed; run `pnpm --filter @knpkv/clockify-api-client regenerate`"
        })
      }

      const { info } = yield* Schema.decodeUnknownEffect(SpecInfo)(upstream).pipe(
        Effect.mapError((cause) => new RegenerateError({ message: "Clockify spec has no version", cause }))
      )
      yield* fs.writeFileString(scriptPaths.specFile, yield* formattedJson(upstream))
      yield* fs.writeFileString(scriptPaths.versionFile, `${info.version}\n`)
      yield* generate(scriptPaths, upstream)
      yield* Console.log(`Generated Clockify ${info.version} client from ${SPEC_URL}`)
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
