/** A disconnected controller retains its reservation only while bounded cleanup is awaited. */
import { ConnectAgent, type TerminalSelection } from "@knpkv/herdr-connect"
import { Clock, Duration, Effect, Exit, Fiber, Option, Schema, Scope } from "effect"

export const terminalReleaseTimeout = Duration.seconds(10)

export class TerminalReleaseTimeout extends Schema.TaggedError<TerminalReleaseTimeout>()("TerminalReleaseTimeout", {
  host: ConnectAgent.fields.host,
  agentId: ConnectAgent.fields.id,
  elapsed: Schema.Number
}) {}

/** Late finalizers stay owned by the hub; the reservation wait ends after ten seconds. */
export const releaseTerminalScope = Effect.fn("HostHttp.releaseTerminalScope")(function*(
  scope: Scope.Closeable,
  owner: Scope.Scope,
  selection: TerminalSelection
) {
  const started = yield* Clock.currentTimeMillis
  const closing = yield* Effect.forkIn(Scope.close(scope, Exit.void), owner)
  const result = yield* Fiber.await(closing).pipe(Effect.timeoutOption(terminalReleaseTimeout))
  if (Option.isSome(result)) {
    if (Exit.isFailure(result.value)) return yield* Effect.failCause(result.value.cause)
    return
  }
  yield* Effect.sync(() => closing.interruptUnsafe())
  const warning = new TerminalReleaseTimeout({
    host: selection.host,
    agentId: selection.agentId,
    elapsed: (yield* Clock.currentTimeMillis) - started
  })
  // Log the typed fields, not the error's stack or any connector payload.
  yield* Effect.logWarning({
    _tag: warning._tag,
    host: warning.host,
    agentId: warning.agentId,
    elapsed: warning.elapsed
  })
})
