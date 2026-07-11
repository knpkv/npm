#!/usr/bin/env tsx
/**
 * Fetch, compare, patch, normalize, and regenerate the Jira Cloud API client.
 *
 * The committed OpenAPI document is the unmodified upstream document. RFC 6902
 * patches and deterministic compatibility normalizations are applied in memory.
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

const SPEC_URL = "https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json"
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])

class RegenerateError extends Data.TaggedError("RegenerateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const JsonString = Schema.fromJsonString(Schema.Json)

const OpenApiDocument = Schema.declare<OpenAPISpec>(
  (value): value is OpenAPISpec =>
    Predicate.hasProperty(value, "paths") &&
    Predicate.isObject(value.paths) &&
    Predicate.hasProperty(value, "openapi"),
  { identifier: "OpenApiDocument" }
)

const SpecInfo = Schema.Struct({ info: Schema.Struct({ version: Schema.String }) })

interface ScriptPaths {
  readonly specFile: string
  readonly patchFile: string
  readonly outputFile: string
}

const paths = Effect.gen(function*() {
  const path = yield* Path.Path
  const scriptFile = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not resolve script path", cause }))
  )
  const packageDir = path.join(path.dirname(scriptFile), "..")
  const specsDir = path.join(packageDir, ".specs")
  return {
    specFile: path.join(specsDir, "jira-v3.json"),
    patchFile: path.join(specsDir, "jira-v3.patch.json"),
    outputFile: path.join(packageDir, "src", "generated", "JiraApi.ts")
  } satisfies ScriptPaths
})

const fetchUpstream = HttpClient.get(SPEC_URL).pipe(
  Effect.flatMap((response) =>
    response.status >= 200 && response.status < 300
      ? response.text.pipe(
        Effect.mapError((cause) => new RegenerateError({ message: "Could not read Jira response", cause }))
      )
      : Effect.fail(new RegenerateError({ message: `Jira spec request failed with status ${response.status}` }))
  ),
  Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
  Effect.mapError((cause) => new RegenerateError({ message: "Could not fetch or decode Jira spec", cause }))
)

const canonicalJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.map((json) => `${json}\n`),
    Effect.mapError((cause) => new RegenerateError({ message: "Could not encode Jira spec", cause }))
  )

const formattedJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonString)(value).pipe(
    Effect.flatMap((source) =>
      Effect.tryPromise({
        try: () => formatSource(source, { parser: "json", printWidth: 120, trailingComma: "none", semi: false }),
        catch: (cause) => new RegenerateError({ message: "Could not format Jira spec", cause })
      })
    ),
    Effect.mapError((cause) => new RegenerateError({ message: "Could not format Jira spec", cause }))
  )

/**
 * Jira marks mixed objects as open. The generator's intersection type cannot
 * combine an unrestricted JSON index signature with optional known fields, so
 * close only those mixed objects. Pure map schemas such as IssueBean.fields
 * retain their schema-valued additionalProperties and remain dynamic.
 *
 * Jira also publishes defaults that contradict enum/array schemas. Defaults
 * and examples are documentation metadata, not response-validation rules.
 */
const normalizeSchema = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const { default: _default, examples: _examples, ...normalized } = schema
  return normalized.additionalProperties === true && Predicate.isObject(normalized.properties)
    ? { ...normalized, additionalProperties: false }
    : normalized
}

const bodylessErrorContent: Schema.Json = {
  "application/json": { schema: {} }
}

/**
 * A 204 response can never contain a message body, but Jira attaches empty JSON
 * schemas to many of them. Remove that misleading content so the generator
 * emits `void` handlers instead of JSON decoders.
 *
 * Atlassian also omits bodies from many documented 4xx/5xx responses. Without
 * a content schema the generator treats those statuses as successful voids.
 * Give them a permissive JSON body so they remain failures with status-bearing
 * generated JiraApiError values.
 */
const normalizeResponses = (document: Schema.Json): Schema.Json => {
  if (!Predicate.isObject(document)) return document
  const root = document
  const rootPaths = root.paths
  if (!Predicate.isObject(rootPaths)) return document

  const normalizedPaths = Object.fromEntries(
    Object.entries(rootPaths).map(([path, pathItem]) => {
      if (!Predicate.isObject(pathItem)) return [path, pathItem]
      const normalizedPathItem = Object.fromEntries(
        Object.entries(pathItem).map(([key, operation]) => {
          if (!METHODS.has(key) || !Predicate.isObject(operation) || !Predicate.isObject(operation.responses)) {
            return [key, operation]
          }
          const responses = Object.fromEntries(
            Object.entries(operation.responses).map(([status, response]) => {
              const code = Number(status)
              if (code === 204 && Predicate.isObject(response)) {
                return [
                  status,
                  Object.fromEntries(
                    Object.entries(response).filter(([key]) => key !== "content")
                  )
                ]
              }
              if (!Number.isInteger(code) || code < 400 || !Predicate.isObject(response) || "content" in response) {
                return [status, response]
              }
              return [status, { ...response, content: bodylessErrorContent }]
            })
          )
          return [key, { ...operation, responses }]
        })
      )
      return [path, normalizedPathItem]
    })
  )

  return Schema.decodeUnknownSync(Schema.Json)(
    Object.fromEntries([...Object.entries(root), ["paths", normalizedPaths]])
  )
}

const stripTrailingWhitespace = (source: string): string => source.replace(/[ \t]+$/gm, "")

const generate = Effect.fn("Jira.regenerate.generate")(function*(scriptPaths: ScriptPaths, upstream: Schema.Json) {
  const fs = yield* FileSystem.FileSystem
  const patch = yield* OpenApiPatch.parsePatchInput(scriptPaths.patchFile).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not parse Jira JSON patch", cause }))
  )
  const patched = yield* OpenApiPatch.applyPatches(
    [{ source: scriptPaths.patchFile, patch }],
    upstream
  ).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not apply Jira JSON patch", cause }))
  )
  const normalized = normalizeResponses(patched)
  const document = yield* Schema.decodeUnknownEffect(OpenApiDocument)(normalized).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Normalized Jira document is not OpenAPI", cause }))
  )
  const generator = yield* OpenApiGenerator.OpenApiGenerator
  const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []
  const generated = yield* generator.generate(document, {
    name: "JiraApi",
    format: "httpclient",
    onEnter: normalizeSchema,
    onWarning: (warning) => warnings.push(warning)
  })
  yield* Effect.forEach(
    warnings,
    (warning) => Console.warn(`[${warning.code}] ${warning.method ?? ""} ${warning.path ?? ""}: ${warning.message}`),
    { discard: true }
  )
  yield* fs.writeFileString(scriptPaths.outputFile, stripTrailingWhitespace(generated)).pipe(
    Effect.mapError((cause) => new RegenerateError({ message: "Could not write generated Jira client", cause }))
  )
})

const check = Flag.boolean("check").pipe(
  Flag.withDescription("Exit non-zero when the committed upstream spec differs from Jira")
)

const local = Flag.boolean("local").pipe(
  Flag.withDescription("Regenerate from the committed spec without contacting Jira")
)

const root = Command.make("jira-api-regenerate", { check, local }).pipe(
  Command.withHandler(
    Effect.fn("Jira.regenerate")(function*({ check, local }) {
      const fs = yield* FileSystem.FileSystem
      const scriptPaths = yield* paths
      const upstream = local
        ? yield* fs.readFileString(scriptPaths.specFile).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
          Effect.mapError((cause) => new RegenerateError({ message: "Could not read committed Jira spec", cause }))
        )
        : yield* fetchUpstream
      const encoded = yield* canonicalJson(upstream)
      const current = yield* fs.readFileString(scriptPaths.specFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JsonString)),
        Effect.flatMap(canonicalJson),
        Effect.orElseSucceed(() => "")
      )

      if (check) {
        if (local) return yield* new RegenerateError({ message: "--check and --local cannot be combined" })
        if (current === encoded) return yield* Console.log("Jira OpenAPI spec is current.")
        return yield* new RegenerateError({
          message: "Jira OpenAPI spec changed; run `pnpm --filter @knpkv/jira-api-client regenerate`"
        })
      }

      const { info } = yield* Schema.decodeUnknownEffect(SpecInfo)(upstream).pipe(
        Effect.mapError((cause) => new RegenerateError({ message: "Jira spec has no version", cause }))
      )
      yield* fs.writeFileString(scriptPaths.specFile, yield* formattedJson(upstream))
      yield* generate(scriptPaths, upstream)
      yield* Console.log(`Generated Jira ${info.version} client from ${local ? "the committed spec" : SPEC_URL}`)
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
