/**
 * Stateless, provider-neutral structured tool loop for Effect AI models.
 *
 * Tool definitions and handlers remain Effect AI `Tool` / `Toolkit` values.
 * This module owns orchestration, event streaming, result bounds, repair, and
 * final-output validation without owning provider selection or persistence.
 *
 * @module
 */
import { Duration, Effect, Option, Predicate, Queue, Result, Schema, Stream } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import type * as Tool from "effect/unstable/ai/Tool"
import type * as Toolkit from "effect/unstable/ai/Toolkit"

/** Maximum UTF-8 bytes from one tool result exposed directly to the model. */
export const MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES = 64 * 1024

const MODEL_RESULT_EXCERPT_BYTES = MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES - 4 * 1024
const DEFAULT_MAXIMUM_TOOL_AGENT_STEPS = 64
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const JsonString = Schema.fromJsonString(Schema.Json)
const encodeJsonString = Schema.encodeUnknownEffect(JsonString)
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** Opaque caller-owned reference to a retained complete tool result. */
export const ToolAgentArtifactId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
).pipe(Schema.brand("ToolAgentArtifactId"))
export type ToolAgentArtifactId = typeof ToolAgentArtifactId.Type

/** Storage seam used only when a complete tool result exceeds 64 KiB. */
export interface ToolAgentArtifactSink<Error = never, Requirements = never> {
  readonly persist: (
    content: string
  ) => Effect.Effect<ToolAgentArtifactId, Error, Requirements>
}

/** Result material visible in activity events and the next model turn. */
export interface ToolAgentResultMaterial {
  readonly artifactId: ToolAgentArtifactId | null
  readonly byteLength: number
  readonly modelValue: Schema.Json
  readonly truncated: boolean
}

export type ToolAgentEvent<Output> =
  | {
    readonly _tag: "run-started"
    readonly budgetMillis: number
    readonly maximumSteps: number
  }
  | {
    readonly _tag: "model-progress"
    readonly step: number
    readonly text: string
  }
  | {
    readonly _tag: "tool-requested"
    readonly callId: string
    readonly name: string
    readonly step: number
  }
  | {
    readonly _tag: "tool-completed"
    readonly callId: string
    readonly name: string
    readonly result: ToolAgentResultMaterial
    readonly step: number
  }
  | {
    readonly _tag: "tool-failed"
    readonly callId: string
    readonly name: string
    readonly result: ToolAgentResultMaterial
    readonly step: number
  }
  | {
    readonly _tag: "usage"
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly step: number
  }
  | {
    readonly _tag: "repair-requested"
    readonly reason: string
    readonly stage: "final-output" | "tool-call"
    readonly step: number
  }
  | {
    readonly _tag: "output-validated"
    readonly output: Output
    readonly step: number
  }
  | {
    readonly _tag: "completed"
    readonly outcome: "max-steps" | "success"
    readonly steps: number
  }

/** The tool-agent configuration is not executable as supplied. */
export class ToolAgentConfigurationError extends Schema.TaggedErrorClass<ToolAgentConfigurationError>()(
  "ToolAgentConfigurationError",
  {
    reason: Schema.Literals([
      "empty-instructions",
      "invalid-budget",
      "invalid-maximum-steps",
      "invalid-output-schema"
    ]),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** The model failed to repair a malformed tool call or final response. */
export class ToolAgentInvalidResponseError extends Schema.TaggedErrorClass<ToolAgentInvalidResponseError>()(
  "ToolAgentInvalidResponseError",
  {
    stage: Schema.Literals(["tool-call", "final-output"]),
    cause: Schema.Defect()
  }
) {}

/** A tool completed without one encodable final result. */
export class ToolAgentToolProtocolError extends Schema.TaggedErrorClass<ToolAgentToolProtocolError>()(
  "ToolAgentToolProtocolError",
  {
    toolName: Schema.String,
    reason: Schema.Literals(["empty-result", "invalid-result"])
  }
) {}

/** A large result could not be retained, so it cannot safely reach the model. */
export class ToolAgentArtifactRequiredError extends Schema.TaggedErrorClass<ToolAgentArtifactRequiredError>()(
  "ToolAgentArtifactRequiredError",
  {
    byteLength: Schema.Int,
    toolName: Schema.String
  }
) {}

/** The run exhausted its visible wall-clock budget. */
export class ToolAgentTimeoutError extends Schema.TaggedErrorClass<ToolAgentTimeoutError>()(
  "ToolAgentTimeoutError",
  {
    budgetMillis: Schema.Number
  }
) {}

export type ToolAgentError =
  | AiError.AiError
  | ToolAgentArtifactRequiredError
  | ToolAgentConfigurationError
  | ToolAgentInvalidResponseError
  | ToolAgentTimeoutError
  | ToolAgentToolProtocolError

export interface ToolAgentRunOptions<
  Tools extends Record<string, Tool.Any>,
  OutputSchema extends Schema.Top,
  ArtifactError = never,
  ArtifactRequirements = never
> {
  readonly artifactSink?: ToolAgentArtifactSink<ArtifactError, ArtifactRequirements>
  readonly budget: Duration.Input
  readonly context: Schema.Json
  readonly instructions: string
  readonly maximumSteps?: number
  readonly model: LanguageModel.Service
  readonly outputSchema: OutputSchema
  readonly toolkit: Toolkit.WithHandler<Tools>
}

interface ExecutedToolCall {
  readonly promptPart: Prompt.ToolResultPart
}

const decodeBudget = (
  input: Duration.Input
): Effect.Effect<Duration.Duration, ToolAgentConfigurationError> =>
  Duration.fromInput(input).pipe(
    Option.filter((duration) => {
      const millis = Duration.toMillis(duration)
      return Number.isFinite(millis) && millis > 0
    }),
    Option.match({
      onNone: () =>
        Effect.fail(
          new ToolAgentConfigurationError({ reason: "invalid-budget" })
        ),
      onSome: Effect.succeed
    })
  )

const failureDescription = (failure: unknown): string =>
  Predicate.isError(failure) && failure.message.length > 0
    ? failure.message
    : "The tool failed in its typed error channel."

const repairInstruction = (stage: "final-output" | "tool-call", reason: string): string =>
  [
    "Your previous response did not satisfy the required protocol.",
    `Invalid stage: ${stage}.`,
    `Validation error: ${reason}`,
    "Correct the response once. Use only available tools with schema-valid arguments,",
    "or return only one JSON value conforming to the requested final output schema."
  ].join("\n")

const initialPrompt = Effect.fn("ToolAgent.initialPrompt")(function*(
  instructions: string,
  context: Schema.Json,
  outputSchema: Schema.Top
) {
  const schemaDocument = yield* Effect.try({
    try: () => Schema.toJsonSchemaDocument(outputSchema),
    catch: (cause) =>
      new ToolAgentConfigurationError({
        cause,
        reason: "invalid-output-schema"
      })
  })
  const outputSchemaJson = yield* encodeJsonString({
    $defs: schemaDocument.definitions,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schemaDocument.schema
  }).pipe(
    Effect.mapError((cause) =>
      new ToolAgentConfigurationError({
        cause,
        reason: "invalid-output-schema"
      })
    )
  )
  const contextJson = yield* encodeJsonString({ context }).pipe(
    Effect.mapError((cause) =>
      new ToolAgentConfigurationError({
        cause,
        reason: "invalid-output-schema"
      })
    )
  )
  return Prompt.make([
    {
      role: "system",
      content: [
        instructions,
        "Explore with the supplied tools as needed.",
        "When finished, return only one JSON value matching this final output JSON Schema:",
        outputSchemaJson
      ].join("\n\n")
    },
    {
      role: "user",
      content: [{
        type: "text",
        text: contextJson
      }]
    }
  ])
})

const truncateJson = (
  encoded: string,
  artifactId: ToolAgentArtifactId
): ToolAgentResultMaterial => {
  const bytes = textEncoder.encode(encoded)
  const excerptBytes = Math.floor(MODEL_RESULT_EXCERPT_BYTES / 2)
  const head = textDecoder.decode(bytes.slice(0, excerptBytes))
  const tail = textDecoder.decode(bytes.slice(Math.max(0, bytes.byteLength - excerptBytes)))
  const modelValue = {
    artifactId,
    byteLength: bytes.byteLength,
    head,
    omittedBytes: Math.max(
      0,
      bytes.byteLength - textEncoder.encode(head).byteLength - textEncoder.encode(tail).byteLength
    ),
    tail,
    truncated: true
  }
  return {
    artifactId,
    byteLength: bytes.byteLength,
    modelValue,
    truncated: true
  }
}

const boundToolResult = Effect.fn("ToolAgent.boundToolResult")(function*<
  Error,
  Requirements
>(
  toolName: string,
  value: Schema.Json,
  artifactSink: ToolAgentArtifactSink<Error, Requirements> | undefined
) {
  const encoded = yield* encodeJsonString(value).pipe(
    Effect.mapError(() =>
      new ToolAgentToolProtocolError({
        reason: "invalid-result",
        toolName
      })
    )
  )
  const byteLength = textEncoder.encode(encoded).byteLength
  if (byteLength <= MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES) {
    return {
      artifactId: null,
      byteLength,
      modelValue: value,
      truncated: false
    } satisfies ToolAgentResultMaterial
  }
  if (artifactSink === undefined) {
    return yield* new ToolAgentArtifactRequiredError({ byteLength, toolName })
  }
  const artifactId = yield* artifactSink.persist(encoded)
  return truncateJson(encoded, artifactId)
})

const encodedToolFailure = (failure: unknown): Schema.Json => ({
  error: failureDescription(failure)
})

const executeToolCall = Effect.fn("ToolAgent.executeToolCall")(function*<
  Tools extends Record<string, Tool.Any>,
  Output,
  ArtifactError,
  ArtifactRequirements
>(
  toolkit: Toolkit.WithHandler<Tools>,
  call: Response.ToolCallParts<Tools>,
  step: number,
  artifactSink: ToolAgentArtifactSink<ArtifactError, ArtifactRequirements> | undefined,
  emit: (event: ToolAgentEvent<Output>) => Effect.Effect<void>
): Effect.fn.Return<
  ExecutedToolCall,
  AiError.AiError | ArtifactError | ToolAgentArtifactRequiredError | ToolAgentToolProtocolError,
  ArtifactRequirements | Tool.HandlerServices<Tools[keyof Tools]>
> {
  yield* emit({
    _tag: "tool-requested",
    callId: call.id,
    name: call.name,
    step
  })

  const handled = yield* Effect.result(
    toolkit.handle(call.name, call.params).pipe(Effect.flatMap(Stream.runLast))
  )
  if (Result.isFailure(handled)) {
    const failure = encodedToolFailure(handled.failure)
    const material = yield* boundToolResult(call.name, failure, artifactSink)
    yield* emit({
      _tag: "tool-failed",
      callId: call.id,
      name: call.name,
      result: material,
      step
    })
    return {
      promptPart: Prompt.makePart("tool-result", {
        id: call.id,
        isFailure: true,
        name: call.name,
        result: material.modelValue
      })
    }
  }

  const finalResult = Option.getOrUndefined(handled.success)
  if (finalResult === undefined) {
    return yield* new ToolAgentToolProtocolError({
      reason: "empty-result",
      toolName: call.name
    })
  }
  const result = yield* decodeJson(finalResult.encodedResult).pipe(
    Effect.mapError(() =>
      new ToolAgentToolProtocolError({
        reason: "invalid-result",
        toolName: call.name
      })
    )
  )
  const material = yield* boundToolResult(call.name, result, artifactSink)
  yield* emit({
    _tag: finalResult.isFailure ? "tool-failed" : "tool-completed",
    callId: call.id,
    name: call.name,
    result: material,
    step
  })
  return {
    promptPart: Prompt.makePart("tool-result", {
      id: call.id,
      isFailure: finalResult.isFailure,
      name: call.name,
      result: material.modelValue
    })
  }
})

const isRepairableModelFailure = (failure: AiError.AiError): boolean =>
  failure.reason._tag === "InvalidOutputError" ||
  failure.reason._tag === "StructuredOutputError" ||
  failure.reason._tag === "ToolNotFoundError" ||
  failure.reason._tag === "ToolParameterValidationError"

const runLoop = Effect.fn("ToolAgent.runLoop")(function*<
  Tools extends Record<string, Tool.Any>,
  OutputSchema extends Schema.Top,
  ArtifactError,
  ArtifactRequirements
>(
  options: ToolAgentRunOptions<Tools, OutputSchema, ArtifactError, ArtifactRequirements>,
  emit: (event: ToolAgentEvent<OutputSchema["Type"]>) => Effect.Effect<void>
): Effect.fn.Return<
  void,
  ToolAgentError | ArtifactError,
  | ArtifactRequirements
  | OutputSchema["DecodingServices"]
  | Tool.HandlerServices<Tools[keyof Tools]>
> {
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_TOOL_AGENT_STEPS
  const budgetMillis = Duration.toMillis(options.budget)
  if (options.instructions.trim().length === 0) {
    return yield* new ToolAgentConfigurationError({ reason: "empty-instructions" })
  }
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps <= 0) {
    return yield* new ToolAgentConfigurationError({ reason: "invalid-maximum-steps" })
  }

  yield* emit({ _tag: "run-started", budgetMillis, maximumSteps })

  let prompt = yield* initialPrompt(options.instructions, options.context, options.outputSchema)
  let repairUsed = false

  for (let step = 1; step <= maximumSteps; step += 1) {
    const generated = yield* Effect.result(options.model.generateText({
      disableToolCallResolution: true,
      prompt,
      toolkit: options.toolkit
    }))

    if (Result.isFailure(generated)) {
      if (isRepairableModelFailure(generated.failure) && !repairUsed) {
        repairUsed = true
        const reason = generated.failure.reason.message
        yield* emit({ _tag: "repair-requested", reason, stage: "tool-call", step })
        prompt = Prompt.concat(prompt, repairInstruction("tool-call", reason))
        continue
      }
      if (isRepairableModelFailure(generated.failure)) {
        return yield* new ToolAgentInvalidResponseError({
          cause: generated.failure,
          stage: "tool-call"
        })
      }
      return yield* generated.failure
    }

    const response = generated.success
    yield* emit({
      _tag: "usage",
      inputTokens: response.usage.inputTokens.total ?? null,
      outputTokens: response.usage.outputTokens.total ?? null,
      step
    })

    if (response.toolCalls.length > 0) {
      if (response.text.length > 0) {
        yield* emit({ _tag: "model-progress", step, text: response.text })
      }
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content))
      const toolParts: Array<Prompt.ToolResultPart> = []
      for (const call of response.toolCalls) {
        const executed = yield* executeToolCall(
          options.toolkit,
          call,
          step,
          options.artifactSink,
          emit
        )
        toolParts.push(executed.promptPart)
      }
      prompt = Prompt.concat(
        prompt,
        Prompt.fromMessages([Prompt.makeMessage("tool", { content: toolParts })])
      )
      continue
    }

    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(Schema.fromJsonString(options.outputSchema))(response.text)
    )
    if (Result.isFailure(decoded)) {
      if (repairUsed) {
        return yield* new ToolAgentInvalidResponseError({
          cause: decoded.failure,
          stage: "final-output"
        })
      }
      repairUsed = true
      const reason = decoded.failure.message
      yield* emit({ _tag: "repair-requested", reason, stage: "final-output", step })
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content))
      prompt = Prompt.concat(prompt, repairInstruction("final-output", reason))
      continue
    }

    yield* emit({ _tag: "output-validated", output: decoded.success, step })
    yield* emit({ _tag: "completed", outcome: "success", steps: step })
    return
  }

  yield* emit({ _tag: "completed", outcome: "max-steps", steps: maximumSteps })
})

/**
 * Runs a lazy, interruption-safe tool loop. The first subscription starts the
 * model; interrupting the stream interrupts the active model or tool effect.
 */
export const runToolAgent = <
  Tools extends Record<string, Tool.Any>,
  OutputSchema extends Schema.Top,
  ArtifactError = never,
  ArtifactRequirements = never
>(
  options: ToolAgentRunOptions<Tools, OutputSchema, ArtifactError, ArtifactRequirements>
): Stream.Stream<
  ToolAgentEvent<OutputSchema["Type"]>,
  ToolAgentError | ArtifactError,
  | ArtifactRequirements
  | OutputSchema["DecodingServices"]
  | Tool.HandlerServices<Tools[keyof Tools]>
> =>
  Stream.callback((queue) => {
    const emit = (event: ToolAgentEvent<OutputSchema["Type"]>) => Effect.asVoid(Queue.offer(queue, event))
    return decodeBudget(options.budget).pipe(
      Effect.flatMap((budget) =>
        runLoop({ ...options, budget }, emit).pipe(
          Effect.timeoutOrElse({
            duration: budget,
            orElse: () =>
              Effect.fail(
                new ToolAgentTimeoutError({
                  budgetMillis: Duration.toMillis(budget)
                })
              )
          })
        )
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) => Queue.failCause(queue, cause),
        onSuccess: () => Queue.end(queue)
      })
    )
  })
