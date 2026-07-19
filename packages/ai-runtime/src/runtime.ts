/**
 * Deep interface around provider-specific local agent implementations.
 * The first terminal event ends runtime ownership immediately. The runtime
 * interrupts the adapter stream at that boundary rather than waiting for its
 * transport to close or inspecting impossible post-terminal output.
 *
 * @module
 */
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect"

import {
  AgentContextMismatchError,
  AgentProviderError,
  type AgentRunRequest,
  type AgentRuntimeError,
  AgentRuntimeEvent,
  AgentRuntimeProtocolError
} from "./model.js"
import { captureAgentRunRequest } from "./requestSnapshot.js"

/** Minimal interface intended for Codex, Claude, and deterministic test adapters. */
export interface AgentAdapter {
  readonly run: (request: AgentRunRequest) => Stream.Stream<AgentRuntimeEvent, AgentProviderError>
}

export interface AgentRuntimeService {
  readonly run: (request: AgentRunRequest) => Stream.Stream<AgentRuntimeEvent, AgentRuntimeError>
}

const decodeAgentRuntimeEvent = Schema.decodeUnknownEffect(AgentRuntimeEvent)
const isAgentProviderError = Schema.is(AgentProviderError)
const isAgentRuntimeProtocolFailure = Schema.is(Schema.Struct({
  _tag: Schema.Literal("AgentRuntimeProtocolError")
}))

const normalizeAdapterFailure = (
  providerId: AgentRunRequest["providerId"],
  failure: unknown
): AgentProviderError =>
  !isAgentRuntimeProtocolFailure(failure) && isAgentProviderError(failure)
    ? new AgentProviderError({
      providerId,
      phase: failure.phase,
      message: failure.message,
      retryable: failure.retryable
    })
    : new AgentProviderError({
      providerId,
      phase: "protocol",
      message: "Agent adapter emitted an invalid failure.",
      retryable: false
    })

const validateAdapterStream = (
  request: AgentRunRequest,
  events: Stream.Stream<AgentRuntimeEvent, AgentProviderError>
): Stream.Stream<AgentRuntimeEvent, AgentProviderError | AgentRuntimeProtocolError> =>
  events.pipe(
    Stream.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Stream.failCause(cause)
      const failure = Cause.hasDies(cause) ? undefined : Option.getOrUndefined(Cause.findErrorOption(cause))
      return Stream.fail(normalizeAdapterFailure(request.providerId, failure))
    }),
    Stream.rechunk(1),
    Stream.mapEffect((event) =>
      decodeAgentRuntimeEvent(event).pipe(
        Effect.mapError((cause) => new AgentRuntimeProtocolError({ reason: "invalid-event", cause }))
      )
    )
  )

const guardTerminalEvent = (
  events: Stream.Stream<AgentRuntimeEvent, AgentRuntimeError>
): Stream.Stream<AgentRuntimeEvent, AgentRuntimeError> =>
  events.pipe(
    Stream.concat(
      Stream.fail(new AgentRuntimeProtocolError({ reason: "missing-terminal-event" }))
    ),
    Stream.takeUntil((event) => event._tag === "completed")
  )

/** Constructs the runtime implementation around a provider adapter. */
export const makeAgentRuntime = (adapter: AgentAdapter): AgentRuntimeService => ({
  run: (request) => {
    const snapshot = captureAgentRunRequest(request)
    return Stream.suspend(() =>
      snapshot.continuation._tag === "resume" &&
        snapshot.continuation.contextFingerprint !== snapshot.context.fingerprint
        ? Stream.fail(new AgentContextMismatchError())
        : guardTerminalEvent(
          Stream.unwrap(
            Effect.try({
              try: () => validateAdapterStream(snapshot, adapter.run(snapshot)),
              catch: (failure) => normalizeAdapterFailure(snapshot.providerId, failure)
            })
          )
        )
    )
  }
})

/** Runtime service consumed by durable workers. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "@knpkv/ai-runtime/AgentRuntime"
) {}

/** Provides one adapter behind the shared runtime service. */
export const layerAgentRuntime = (adapter: AgentAdapter): Layer.Layer<AgentRuntime> =>
  Layer.succeed(AgentRuntime, makeAgentRuntime(adapter))
