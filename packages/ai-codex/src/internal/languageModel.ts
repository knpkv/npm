import { Effect, Predicate, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type { CodexModelOptions } from "../model.js"
import { makeArguments, normalizeOptions, validatePrompt } from "./configuration.js"
import { invalidRequest, transportToAiError } from "./errors.js"
import { makeOutputSchemaFile } from "./outputSchema.js"
import { resolvePromptOnlyDisabledFeatures, runCodex } from "./process.js"
import { renderPrompt } from "./prompt.js"
import { type CodexTurn, decodeTranscript } from "./protocol.js"

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
  yield* validatePrompt(prompt, options.maxPromptBytes, method)

  return yield* Effect.scoped(Effect.gen(function*() {
    const promptOnlyDisabledFeatures = yield* resolvePromptOnlyDisabledFeatures(
      options,
      dependencies.spawner,
      dependencies.fileSystem,
      method
    )
    const schemaFile = providerOptions.responseFormat.type === "json"
      ? yield* makeOutputSchemaFile(dependencies.fileSystem, providerOptions.responseFormat.schema)
      : undefined
    const stdout = yield* runCodex({
      args: makeArguments(options, schemaFile, promptOnlyDisabledFeatures),
      cwd: options.cwd,
      environment: options.environment,
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
