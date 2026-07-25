/**
 * Adapter from the structured tool loop to the durable AgentRuntime stream.
 *
 * @module
 */
import { Effect, Schema, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"

import {
  AgentProviderError,
  type AgentRunRequest,
  type AgentRuntimeEvent,
  MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH
} from "./model.js"
import type { AgentAdapter } from "./runtime.js"
import { ToolAgentConfigurationError, type ToolAgentEvent, ToolAgentTimeoutError } from "./toolAgent.js"

const JsonString = Schema.fromJsonString(Schema.Json)
const encodeJsonString = Schema.encodeUnknownEffect(JsonString)
const isTimeout = Schema.is(ToolAgentTimeoutError)
const isConfigurationError = Schema.is(ToolAgentConfigurationError)
const isAgentProviderError = Schema.is(AgentProviderError)

const boundedMessage = (message: string): string => {
  const trimmed = message.trim()
  return (trimmed.length === 0 ? "Structured tool-agent execution failed." : trimmed)
    .slice(0, 1_000)
}

const normalizeFailure = (
  request: AgentRunRequest,
  failure: unknown
): AgentProviderError => {
  if (isTimeout(failure)) {
    return new AgentProviderError({
      message: `Structured tool-agent budget expired after ${failure.budgetMillis}ms.`,
      phase: "timeout",
      providerId: request.providerId,
      retryable: true
    })
  }
  if (isConfigurationError(failure)) {
    return new AgentProviderError({
      message: `Structured tool-agent configuration is invalid: ${failure.reason}.`,
      phase: "configuration",
      providerId: request.providerId,
      retryable: false
    })
  }
  if (AiError.isAiError(failure)) {
    return new AgentProviderError({
      message: boundedMessage(failure.reason.message),
      phase: "execution",
      providerId: request.providerId,
      retryable: failure.isRetryable
    })
  }
  return new AgentProviderError({
    message: "Structured tool-agent execution failed.",
    phase: "execution",
    providerId: request.providerId,
    retryable: false
  })
}

const chunks = (text: string): ReadonlyArray<string> => {
  const output: Array<string> = []
  for (let offset = 0; offset < text.length; offset += MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH) {
    output.push(text.slice(offset, offset + MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH))
  }
  return output
}

const outputEvents = (
  channel: "assistant" | "progress",
  text: string
): ReadonlyArray<AgentRuntimeEvent> =>
  chunks(text).map((chunk) => ({
    _tag: "output",
    channel,
    text: chunk
  }))

const safeUsage = (value: number | null): number =>
  value === null || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.trunc(value))

const mapEvent = Effect.fn("ToolAgentAdapter.mapEvent")(function*<Output>(
  providerId: AgentRunRequest["providerId"],
  event: ToolAgentEvent<Output>
): Effect.fn.Return<ReadonlyArray<AgentRuntimeEvent>, AgentProviderError> {
  switch (event._tag) {
    case "run-started":
      return [{ _tag: "started", providerRunRef: null, sessionRef: null }]
    case "model-progress":
      return outputEvents("progress", event.text)
    case "tool-requested":
      return outputEvents("progress", `Tool requested: ${event.name} (${event.callId}).`)
    case "tool-completed":
      return outputEvents(
        "progress",
        event.result.truncated
          ? `Tool completed: ${event.name}; full result retained as ${event.result.artifactId}.`
          : `Tool completed: ${event.name}.`
      )
    case "tool-failed":
      return outputEvents("progress", `Tool failed: ${event.name} (${event.callId}).`)
    case "usage":
      return [{
        _tag: "usage",
        inputTokens: safeUsage(event.inputTokens),
        outputTokens: safeUsage(event.outputTokens)
      }]
    case "repair-requested":
      return outputEvents(
        "progress",
        `Protocol repair requested for ${event.stage}: ${event.reason}`
      )
    case "output-validated": {
      const encoded = yield* encodeJsonString(event.output).pipe(
        Effect.mapError(() =>
          new AgentProviderError({
            message: "Validated tool-agent output is not persistence-safe JSON.",
            phase: "protocol",
            providerId,
            retryable: false
          })
        )
      )
      return outputEvents("assistant", encoded)
    }
    case "completed":
      return [{
        _tag: "completed",
        outcome: event.outcome,
        sessionRef: null
      }]
  }
})

/**
 * Wraps a configured tool-agent runner behind the existing durable adapter
 * interface. Final JSON is chunked across ordinary assistant output events, so
 * the adapter adds no aggregate output or suggestion-count cap.
 */
export const makeToolAgentAdapter = <Output, Error>(
  run: (
    request: AgentRunRequest
  ) => Stream.Stream<ToolAgentEvent<Output>, Error>
): AgentAdapter => ({
  run: (request) =>
    run(request).pipe(
      Stream.mapEffect((event) => mapEvent(request.providerId, event)),
      Stream.flatMap(Stream.fromIterable),
      Stream.mapError((failure) =>
        isAgentProviderError(failure)
          ? failure
          : normalizeFailure(request, failure)
      )
    )
})
