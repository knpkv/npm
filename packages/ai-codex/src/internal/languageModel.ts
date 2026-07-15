import { Effect, Predicate, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type { CodexModelOptions } from "../model.js"
import { makeArguments, normalizeOptions } from "./configuration.js"
import { CodexTransportError, invalidRequest, transportToAiError } from "./errors.js"
import { runCodex } from "./process.js"
import { renderPrompt } from "./prompt.js"
import { type CodexTurn, decodeTranscript } from "./protocol.js"

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const makeSchemaFile = Effect.fn("CodexLanguageModel.makeSchemaFile")(function*(
  fileSystem: FileSystem.FileSystem,
  schema: Schema.Top
) {
  const document = yield* Effect.try({
    try: () => Schema.toJsonSchemaDocument(schema),
    catch: (cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to convert the requested output schema to JSON Schema",
        phase: "configuration"
      })
  })
  const schemaFile = yield* fileSystem.makeTempFileScoped({
    prefix: "ai-codex-output-",
    suffix: ".json"
  }).pipe(
    Effect.mapError((cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to create a temporary output schema file",
        phase: "configuration"
      })
    )
  )
  const jsonSchema = {
    $defs: document.definitions,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema
  }
  const encodedSchema = yield* encodeJsonString(jsonSchema).pipe(
    Effect.mapError((cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Unable to encode the requested output schema",
        phase: "configuration"
      })
    )
  )
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

const makeMetadataPart = (turn: CodexTurn, modelId: string | undefined): Response.ResponseMetadataPartEncoded => ({
  id: turn.threadId,
  metadata: { "codex-cli": { threadId: turn.threadId ?? null } },
  modelId,
  request: undefined,
  timestamp: undefined,
  type: "response-metadata"
})

const makeFinishPart = (turn: CodexTurn): Response.FinishPartEncoded => ({
  metadata: {},
  reason: "stop",
  response: undefined,
  type: "finish",
  usage: turn.usage
})

const makeResponseParts = (
  turn: CodexTurn,
  modelId: string | undefined
): Array<Response.PartEncoded> => [
  makeMetadataPart(turn, modelId),
  {
    metadata: {},
    text: turn.text,
    type: "text"
  },
  makeFinishPart(turn)
]

const makeStreamParts = (
  turn: CodexTurn,
  modelId: string | undefined
): Array<Response.StreamPartEncoded> => {
  const id = turn.threadId ?? "codex-output"
  return [
    makeMetadataPart(turn, modelId),
    { id, metadata: {}, type: "text-start" },
    { delta: turn.text, id, metadata: {}, type: "text-delta" },
    { id, metadata: {}, type: "text-end" },
    makeFinishPart(turn)
  ]
}

interface TurnDependencies {
  readonly fileSystem: FileSystem.FileSystem
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}

const executeTurn = Effect.fn("CodexLanguageModel.executeTurn")(function*(
  method: "generateText" | "streamText",
  modelOptions: CodexModelOptions,
  providerOptions: LanguageModel.ProviderOptions,
  dependencies: TurnDependencies
) {
  if (providerOptions.tools.length > 0) {
    return yield* invalidRequest(
      method,
      "toolkit",
      "Effect AI toolkits are not supported by the Codex CLI model"
    )
  }

  const options = yield* normalizeOptions(modelOptions, method)
  const prompt = yield* renderPrompt(method, providerOptions.prompt)

  return yield* Effect.scoped(Effect.gen(function*() {
    const schemaFile = providerOptions.responseFormat.type === "json"
      ? yield* makeSchemaFile(dependencies.fileSystem, providerOptions.responseFormat.schema)
      : undefined
    const stdout = yield* runCodex({
      args: makeArguments(options, schemaFile),
      cwd: options.cwd,
      executable: options.executable,
      maxOutputBytes: options.maxOutputBytes,
      maxStderrBytes: options.maxStderrBytes,
      prompt,
      spawner: dependencies.spawner,
      timeout: options.timeout
    })
    return yield* decodeTranscript(stdout)
  })).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, "CodexTransportError")
        ? transportToAiError(method, error)
        : error
    )
  )
})

export const makeLanguageModel = Effect.fn("CodexLanguageModel.make")(function*(options: CodexModelOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const dependencies = { fileSystem, spawner }

  return yield* LanguageModel.make({
    generateText: (providerOptions) =>
      executeTurn("generateText", options, providerOptions, dependencies).pipe(
        Effect.map((turn) => makeResponseParts(turn, options.model))
      ),
    streamText: (providerOptions) =>
      Stream.unwrap(
        executeTurn("streamText", options, providerOptions, dependencies).pipe(
          Effect.map((turn) => Stream.fromIterable(makeStreamParts(turn, options.model)))
        )
      )
  })
})
