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
  MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH,
  MAXIMUM_AGENT_RUNTIME_EVENT_BYTES
} from "./model.js"
import type { AgentAdapter } from "./runtime.js"
import {
  ToolAgentArtifactRequiredError,
  ToolAgentConfigurationError,
  type ToolAgentEvent,
  ToolAgentInvalidResponseError,
  ToolAgentTimeoutError,
  ToolAgentToolProtocolError
} from "./toolAgent.js"

const JsonString = Schema.fromJsonString(Schema.Json)
const encodeJsonString = Schema.encodeUnknownEffect(JsonString)
const isTimeout = Schema.is(ToolAgentTimeoutError)
const isConfigurationError = Schema.is(ToolAgentConfigurationError)
const isInvalidResponse = Schema.is(ToolAgentInvalidResponseError)
const isToolProtocolError = Schema.is(ToolAgentToolProtocolError)
const isArtifactRequired = Schema.is(ToolAgentArtifactRequiredError)
const isAgentProviderError = Schema.is(AgentProviderError)
const textEncoder = new TextEncoder()

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
    const tool = failure.toolName === undefined ? "" : ` for ${failure.toolName}`
    return new AgentProviderError({
      message: boundedMessage(
        `Structured tool-agent configuration${tool} is invalid: ${failure.reason}.`
      ),
      phase: "configuration",
      providerId: request.providerId,
      retryable: false
    })
  }
  if (isInvalidResponse(failure)) {
    return new AgentProviderError({
      message: `Structured tool-agent response was invalid at ${failure.stage}.`,
      phase: "protocol",
      providerId: request.providerId,
      retryable: false
    })
  }
  if (isToolProtocolError(failure)) {
    return new AgentProviderError({
      message: boundedMessage(
        `Tool ${failure.toolName} violated the result protocol: ${failure.reason}.`
      ),
      phase: "protocol",
      providerId: request.providerId,
      retryable: false
    })
  }
  if (isArtifactRequired(failure)) {
    return new AgentProviderError({
      message: boundedMessage(
        `Tool ${failure.toolName} produced ${failure.byteLength} bytes without an artifact sink.`
      ),
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

const codePointBoundary = (text: string, offset: number): number => {
  if (offset <= 0 || offset >= text.length) return offset
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    ? offset - 1
    : offset
}

const outputEvents = Effect.fn("ToolAgentAdapter.outputEvents")(function*(
  providerId: AgentRunRequest["providerId"],
  channel: "assistant" | "progress",
  text: string
) {
  const output: Array<AgentRuntimeEvent> = []
  let offset = 0
  while (offset < text.length) {
    let lower = offset + 1
    let upper = Math.min(
      text.length,
      offset + MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH
    )
    let best = offset
    while (lower <= upper) {
      const probe = Math.floor((lower + upper) / 2)
      const midpoint = codePointBoundary(
        text,
        probe
      )
      if (midpoint <= offset) {
        lower = probe + 1
        continue
      }
      const event: AgentRuntimeEvent = {
        _tag: "output",
        channel,
        text: text.slice(offset, midpoint)
      }
      const encoded = yield* encodeJsonString(event).pipe(
        Effect.mapError(() =>
          new AgentProviderError({
            message: "Tool-agent output could not be encoded for durable persistence.",
            phase: "protocol",
            providerId,
            retryable: false
          })
        )
      )
      if (
        textEncoder.encode(encoded).byteLength <=
          MAXIMUM_AGENT_RUNTIME_EVENT_BYTES
      ) {
        best = midpoint
        lower = probe + 1
      } else {
        upper = probe - 1
      }
    }
    if (best === offset) {
      return yield* new AgentProviderError({
        message: "One tool-agent output code point exceeds the durable event limit.",
        phase: "protocol",
        providerId,
        retryable: false
      })
    }
    output.push({
      _tag: "output",
      channel,
      text: text.slice(offset, best)
    })
    offset = best
  }
  return output
})

const isAvailableUsage = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0

const mapEvent = Effect.fn("ToolAgentAdapter.mapEvent")(function*<Output>(
  providerId: AgentRunRequest["providerId"],
  event: ToolAgentEvent<Output>
): Effect.fn.Return<ReadonlyArray<AgentRuntimeEvent>, AgentProviderError> {
  switch (event._tag) {
    case "run-started":
      return [{ _tag: "started", providerRunRef: null, sessionRef: null }]
    case "model-progress":
      return yield* outputEvents(providerId, "progress", event.text)
    case "tool-requested":
      return yield* outputEvents(
        providerId,
        "progress",
        `Tool requested: ${event.name} (${event.callId}).`
      )
    case "tool-completed":
      return yield* outputEvents(
        providerId,
        "progress",
        event.result.truncated
          ? `Tool completed: ${event.name}; full result retained as ${event.result.artifactId}.`
          : `Tool completed: ${event.name}.`
      )
    case "tool-failed":
      return yield* outputEvents(
        providerId,
        "progress",
        `Tool failed: ${event.name} (${event.callId}).`
      )
    case "usage":
      if (
        !isAvailableUsage(event.inputTokens) ||
        !isAvailableUsage(event.outputTokens)
      ) {
        return []
      }
      return [{
        _tag: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens
      }]
    case "repair-requested":
      return yield* outputEvents(
        providerId,
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
      return yield* outputEvents(providerId, "assistant", encoded)
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
