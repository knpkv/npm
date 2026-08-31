import { Effect, Schema } from "effect"
import type * as FileSystem from "effect/FileSystem"
import * as OpenAiStructuredOutput from "effect/unstable/ai/OpenAiStructuredOutput"

import { CodexTransportError } from "./errors.js"

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const outputSchemaDocument = (schema: Schema.Top, providerCompatible: boolean) =>
  providerCompatible
    ? (() => {
      const transformed = OpenAiStructuredOutput.toCodecOpenAI(schema)
      if (transformed.codec !== schema) {
        throw new Error("Codex native output schemas cannot change the provider wire representation")
      }
      return transformed.jsonSchema
    })()
    : (() => {
      const document = Schema.toJsonSchemaDocument(schema)
      return {
        $defs: document.definitions,
        ...document.schema
      }
    })()

const encodeOutputSchema = Effect.fn("CodexOutputSchema.encode")(function*(
  schema: Schema.Top,
  providerCompatible: boolean
) {
  const jsonSchema = yield* Effect.try({
    try: () => outputSchemaDocument(schema, providerCompatible),
    catch: (cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to convert the requested output schema to JSON Schema",
        phase: "configuration"
      })
  })
  return yield* encodeJsonString({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...jsonSchema
  }).pipe(
    Effect.mapError((cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to encode the requested output schema",
        phase: "configuration"
      })
    )
  )
})

const writeOutputSchema = Effect.fn("CodexOutputSchema.write")(function*(
  fileSystem: FileSystem.FileSystem,
  schemaFile: string,
  schema: Schema.Top,
  providerCompatible: boolean
) {
  const encodedSchema = yield* encodeOutputSchema(schema, providerCompatible)
  yield* fileSystem.writeFileString(schemaFile, encodedSchema, { mode: 0o600 }).pipe(
    Effect.mapError((cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to write the temporary output schema file",
        phase: "configuration"
      })
    )
  )
  return schemaFile
})

const mapTemporaryFileError = (cause: unknown) =>
  new CodexTransportError({
    cause,
    diagnostic: "Unable to create a temporary output schema file",
    phase: "configuration"
  })

/** Materialize one owner-only JSON Schema in the caller's Effect scope. */
export const makeOutputSchemaFile = Effect.fn("CodexOutputSchema.makeScopedFile")(function*(
  fileSystem: FileSystem.FileSystem,
  schema: Schema.Top
) {
  const schemaFile = yield* fileSystem.makeTempFileScoped({
    prefix: "ai-codex-output-",
    suffix: ".json"
  }).pipe(Effect.mapError(mapTemporaryFileError))
  return yield* writeOutputSchema(fileSystem, schemaFile, schema, false)
})

/** Materialize one owner-only JSON Schema whose stream finalizer owns cleanup. */
export const makeStreamOutputSchemaFile = Effect.fn("CodexOutputSchema.makeStreamFile")(function*(
  fileSystem: FileSystem.FileSystem,
  schema: Schema.Top
) {
  const schemaDirectory = yield* fileSystem.makeTempDirectory({
    prefix: "ai-codex-output-"
  }).pipe(Effect.mapError(mapTemporaryFileError))
  const cleanup = fileSystem.remove(schemaDirectory, { recursive: true }).pipe(Effect.ignore)
  const schemaFile = yield* fileSystem.makeTempFile({
    directory: schemaDirectory,
    suffix: ".json"
  }).pipe(
    Effect.mapError(mapTemporaryFileError),
    Effect.onError(() => cleanup)
  )
  yield* writeOutputSchema(fileSystem, schemaFile, schema, true).pipe(Effect.onError(() => cleanup))
  return { cleanup, path: schemaFile }
})
