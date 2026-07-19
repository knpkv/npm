/**
 * Deep interface around provider-specific local agent implementations.
 * The runtime validates the terminal-event invariant while interruption remains
 * the cancellation mechanism for the underlying provider stream.
 *
 * @module
 */
import { Context, Effect, Layer, Ref, Stream } from "effect"

import {
  AgentContextMismatchError,
  type AgentProviderError,
  type AgentRunRequest,
  type AgentRuntimeError,
  type AgentRuntimeEvent,
  AgentRuntimeProtocolError
} from "./model.js"

/** Minimal interface intended for Codex, Claude, and deterministic test adapters. */
export interface AgentAdapter {
  readonly run: (request: AgentRunRequest) => Stream.Stream<AgentRuntimeEvent, AgentProviderError>
}

export interface AgentRuntimeService {
  readonly run: (request: AgentRunRequest) => Stream.Stream<AgentRuntimeEvent, AgentRuntimeError>
}

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
  run: (request) =>
    request.continuation._tag === "resume" &&
      request.continuation.contextFingerprint !== request.context.fingerprint
      ? Stream.fail(new AgentContextMismatchError())
      : guardTerminalEvent(Stream.suspend(() => adapter.run(request)))
})

/** Runtime service consumed by durable workers. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "@knpkv/ai-runtime/AgentRuntime"
) {}

/** Provides one adapter behind the shared runtime service. */
export const layerAgentRuntime = (adapter: AgentAdapter): Layer.Layer<AgentRuntime> =>
  Layer.succeed(AgentRuntime, makeAgentRuntime(adapter))
