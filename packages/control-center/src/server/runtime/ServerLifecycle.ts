import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

/** Whether this process still accepts work that can change durable state. */
export type ServerLifecyclePhase = "accepting" | "draining"

/** New work reached the process after graceful drain had begun. */
export class ServerDraining extends Schema.TaggedErrorClass<ServerDraining>()(
  "ServerDraining",
  {}
) {}

interface ServerLifecycleState {
  readonly activeMutations: number
  readonly activeStreams: number
  readonly phase: ServerLifecyclePhase
}

interface ServerLifecycleService {
  /** Move to draining exactly once and wake every drain observer. */
  readonly beginDrain: Effect.Effect<void>
  /** Complete when graceful drain has begun. */
  readonly awaitDrain: Effect.Effect<void>
  /** Complete after drain begins and every admitted mutation has finished. */
  readonly awaitMutationsDrained: Effect.Effect<void>
  /** Begin drain and report whether admitted mutations finished before the deadline. */
  readonly drainWithin: (duration: Duration.Input) => Effect.Effect<boolean>
  /** Current lifecycle phase for diagnostics and deterministic tests. */
  readonly phase: Effect.Effect<ServerLifecyclePhase>
  /** Reject new mutations after drain, while retaining admitted work until it exits. */
  readonly runMutation: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ServerDraining, R>
  /** Atomically retain a long-lived stream only while the process is accepting work. */
  readonly acquireStream: Effect.Effect<void, ServerDraining, Scope.Scope>
}

const makeServerLifecycle = Effect.fn("ServerLifecycle.make")(function*() {
  const state = yield* Ref.make<ServerLifecycleState>({
    activeMutations: 0,
    activeStreams: 0,
    phase: "accepting"
  })
  const drainStarted = yield* Deferred.make<void>()
  const mutationsDrained = yield* Deferred.make<void>()

  const beginDrain = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [current.activeMutations === 0, current]
    const draining: ServerLifecycleState = { ...current, phase: "draining" }
    return [
      current.activeMutations === 0,
      draining
    ]
  }).pipe(
    Effect.flatMap((alreadyDrained) =>
      Deferred.succeed(drainStarted, undefined).pipe(
        Effect.andThen(alreadyDrained ? Deferred.succeed(mutationsDrained, undefined) : Effect.void)
      )
    ),
    Effect.asVoid
  )

  const acquireMutation = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [false, current]
    return [true, { ...current, activeMutations: current.activeMutations + 1 }]
  }).pipe(
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new ServerDraining()))
  )

  const releaseMutation = Ref.modify(state, (current) => {
    const next = {
      ...current,
      activeMutations: current.activeMutations - 1
    }
    return [next.phase === "draining" && next.activeMutations === 0, next]
  }).pipe(
    Effect.flatMap((drained) => drained ? Deferred.succeed(mutationsDrained, undefined) : Effect.void),
    Effect.asVoid
  )

  const acquireStreamPermit = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [false, current]
    return [true, { ...current, activeStreams: current.activeStreams + 1 }]
  }).pipe(
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new ServerDraining()))
  )

  const releaseStream = Ref.update(state, (current) => ({
    ...current,
    activeStreams: current.activeStreams - 1
  }))

  const drainWithin = (duration: Duration.Input) =>
    beginDrain.pipe(
      Effect.andThen(Deferred.await(mutationsDrained).pipe(Effect.timeoutOption(duration))),
      Effect.map(Option.isSome)
    )

  return {
    beginDrain,
    awaitDrain: Deferred.await(drainStarted),
    awaitMutationsDrained: Deferred.await(mutationsDrained),
    drainWithin,
    phase: Ref.get(state).pipe(Effect.map((current) => current.phase)),
    runMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquireMutation,
        () => effect,
        () => releaseMutation
      ),
    acquireStream: Effect.acquireRelease(acquireStreamPermit, () => releaseStream)
  } satisfies ServerLifecycleService
})

/** Shared lifecycle boundary for HTTP mutations, streams, and background work. */
export class ServerLifecycle extends Context.Service<ServerLifecycle, ServerLifecycleService>()(
  "@knpkv/control-center/server/runtime/ServerLifecycle"
) {
  /** Construct an isolated lifecycle for tests and explicit embedding. */
  static readonly make = makeServerLifecycle()

  static readonly layer = Layer.effect(ServerLifecycle, ServerLifecycle.make)
}
