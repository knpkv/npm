/**
 * Deep interface around provider-specific local agent implementations.
 * The runtime validates the terminal-event invariant while interruption remains
 * the cancellation mechanism for the underlying provider stream.
 *
 * @module
 */
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect"

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
    ? failure
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
    Stream.catch((failure) => Stream.fail(normalizeAdapterFailure(request.providerId, failure))),
    Stream.mapEffect((event) =>
      decodeAgentRuntimeEvent(event).pipe(
        Effect.mapError((cause) => new AgentRuntimeProtocolError({ reason: "invalid-event", cause }))
      )
    )
  )

const guardTerminalEvent = (
  events: Stream.Stream<AgentRuntimeEvent, AgentRuntimeError>
): Stream.Stream<AgentRuntimeEvent, AgentRuntimeError> =>
  Stream.unwrap(
    Ref.make<boolean>(false).pipe(
      Effect.map((terminalSeen): Stream.Stream<AgentRuntimeEvent, AgentRuntimeError> => {
        const source = events.pipe(
          Stream.catchCause((cause) =>
            Stream.unwrap(
              Ref.get(terminalSeen).pipe(
                Effect.map((seen) =>
                  seen
                    ? Stream.fail(
                      new AgentRuntimeProtocolError({
                        reason: "failure-after-terminal",
                        cause
                      })
                    )
                    : Stream.failCause(cause)
                )
              )
            )
          )
        )
        const checked = source.pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function*(): Effect.fn.Return<AgentRuntimeEvent, AgentRuntimeProtocolError> {
              const seen = yield* Ref.get(terminalSeen)
              if (seen) {
                return yield* new AgentRuntimeProtocolError({
                  reason: event._tag === "completed" ? "duplicate-terminal-event" : "event-after-terminal"
                })
              }
              if (event._tag === "completed") yield* Ref.set(terminalSeen, true)
              return event
            })
          )
        )
        const verifyTerminal = Ref.get(terminalSeen).pipe(
          Effect.flatMap((seen) =>
            seen
              ? Effect.void
              : Effect.fail(new AgentRuntimeProtocolError({ reason: "missing-terminal-event" }))
          )
        )
        return checked.pipe(Stream.concat(Stream.fromEffect(verifyTerminal).pipe(Stream.drain)))
      })
    )
  )

/** Constructs the runtime implementation around a provider adapter. */
export const makeAgentRuntime = (adapter: AgentAdapter): AgentRuntimeService => ({
  run: (request) => {
    const snapshot = captureAgentRunRequest(request)
    return Stream.suspend(() =>
      snapshot.continuation._tag === "resume" &&
        snapshot.continuation.contextFingerprint !== snapshot.context.fingerprint
        ? Stream.fail(new AgentContextMismatchError())
        : guardTerminalEvent(validateAdapterStream(snapshot, adapter.run(snapshot)))
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
