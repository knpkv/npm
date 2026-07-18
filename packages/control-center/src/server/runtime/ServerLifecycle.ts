import * as Cause from "effect/Cause"
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

/** Two live subsystems attempted to own the same drain hook identity. */
export class ServerDrainHookConflict extends Schema.TaggedErrorClass<ServerDrainHookConflict>()(
  "ServerDrainHookConflict",
  { hookId: Schema.String }
) {}

/** A secret-free result for the complete work-and-flush drain sequence. */
export type ServerDrainResult =
  | { readonly _tag: "Drained" }
  | { readonly _tag: "DeadlineExceeded" }
  | { readonly _tag: "HooksFailed"; readonly hookIds: ReadonlyArray<string> }

interface ServerDrainHook {
  readonly hookId: string
  readonly run: Effect.Effect<void>
}

interface DrainTransition {
  readonly drainHooks: ReadonlyArray<ServerDrainHook> | null
  readonly mutationBarrierReady: boolean
  readonly streamBarrierReady: boolean
  readonly workBarrierReady: boolean
}

interface ServerLifecycleState {
  readonly activeBackgroundJobs: number
  readonly activeMutationFiberIds: ReadonlySet<number>
  readonly activeMutations: number
  readonly activeStreams: number
  readonly drainHooks: ReadonlyMap<string, ServerDrainHook>
  readonly phase: ServerLifecyclePhase
}

type MutationAdmission = "acquired" | "nested" | "rejected"
type DrainHookRegistration = "conflict" | "draining" | "registered"

interface ServerLifecycleService {
  /** Move to draining exactly once and wake every drain observer. */
  readonly beginDrain: Effect.Effect<void>
  /** Complete when graceful drain has begun. */
  readonly awaitDrain: Effect.Effect<void>
  /** Complete after drain begins and every admitted mutation has finished. */
  readonly awaitMutationsDrained: Effect.Effect<void>
  /** Complete after drain begins and every admitted mutation or background job has finished. */
  readonly awaitWorkDrained: Effect.Effect<void>
  /** Begin drain and report the complete work-and-flush result before the deadline. */
  readonly drainWithin: (duration: Duration.Input) => Effect.Effect<ServerDrainResult>
  /** Current lifecycle phase for diagnostics and deterministic tests. */
  readonly phase: Effect.Effect<ServerLifecyclePhase>
  /** Reject new mutations after drain, while retaining admitted work until it exits. */
  readonly runMutation: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ServerDraining, R>
  /** Reject new background jobs after drain, while retaining admitted jobs until they exit. */
  readonly runBackground: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ServerDraining, R>
  /** Retain one named, infallible flush hook for this server scope. */
  readonly registerDrainHook: (
    hook: ServerDrainHook
  ) => Effect.Effect<void, ServerDrainHookConflict | ServerDraining, Scope.Scope>
  /** Atomically retain a long-lived stream only while the process is accepting work. */
  readonly acquireStream: Effect.Effect<void, ServerDraining, Scope.Scope>
}

const makeServerLifecycle = Effect.fn("ServerLifecycle.make")(function*() {
  const state = yield* Ref.make<ServerLifecycleState>({
    activeBackgroundJobs: 0,
    activeMutationFiberIds: new Set(),
    activeMutations: 0,
    activeStreams: 0,
    drainHooks: new Map(),
    phase: "accepting"
  })
  const drainStarted = yield* Deferred.make<void>()
  const mutationsDrained = yield* Deferred.make<void>()
  const workDrained = yield* Deferred.make<void>()
  const streamsDrained = yield* Deferred.make<void>()
  const drainHookSnapshot = yield* Deferred.make<ReadonlyArray<ServerDrainHook>>()
  const drainHooksCompleted = yield* Deferred.make<ReadonlyArray<string>>()

  const hasActiveWork = (current: ServerLifecycleState): boolean =>
    current.activeMutations > 0 || current.activeBackgroundJobs > 0

  const beginDrain = Ref.modify(state, (current): [DrainTransition, ServerLifecycleState] => {
    const barriers = {
      mutationBarrierReady: current.activeMutations === 0,
      streamBarrierReady: current.activeStreams === 0,
      workBarrierReady: !hasActiveWork(current)
    }
    if (current.phase === "draining") return [{ ...barriers, drainHooks: null }, current]
    const draining: ServerLifecycleState = { ...current, phase: "draining" }
    return [{ ...barriers, drainHooks: [...current.drainHooks.values()] }, draining]
  }).pipe(
    Effect.flatMap(({ drainHooks, mutationBarrierReady, streamBarrierReady, workBarrierReady }) =>
      Deferred.succeed(drainStarted, undefined).pipe(
        Effect.andThen(
          drainHooks === null
            ? Effect.void
            : Deferred.succeed(drainHookSnapshot, drainHooks)
        ),
        Effect.andThen(mutationBarrierReady ? Deferred.succeed(mutationsDrained, undefined) : Effect.void),
        Effect.andThen(streamBarrierReady ? Deferred.succeed(streamsDrained, undefined) : Effect.void),
        Effect.andThen(workBarrierReady ? Deferred.succeed(workDrained, undefined) : Effect.void)
      )
    ),
    Effect.asVoid
  )

  const acquireMutation = (fiberId: number) =>
    Ref.modify(state, (current): [MutationAdmission, ServerLifecycleState] => {
      if (current.activeMutationFiberIds.has(fiberId)) return ["nested", current]
      if (current.phase === "draining") return ["rejected", current]
      return [
        "acquired",
        {
          ...current,
          activeMutationFiberIds: new Set(current.activeMutationFiberIds).add(fiberId),
          activeMutations: current.activeMutations + 1
        }
      ]
    }).pipe(
      Effect.flatMap((admission) =>
        admission === "rejected" ? Effect.fail(new ServerDraining()) : Effect.succeed(admission === "acquired")
      )
    )

  const releaseMutation = (fiberId: number) =>
    Ref.modify(state, (current) => {
      const activeMutationFiberIds = new Set(current.activeMutationFiberIds)
      activeMutationFiberIds.delete(fiberId)
      const next = {
        ...current,
        activeMutationFiberIds,
        activeMutations: current.activeMutations - 1
      }
      return [{
        mutationBarrierReady: next.phase === "draining" && next.activeMutations === 0,
        workBarrierReady: next.phase === "draining" && !hasActiveWork(next)
      }, next]
    }).pipe(
      Effect.flatMap(({ mutationBarrierReady, workBarrierReady }) =>
        (mutationBarrierReady ? Deferred.succeed(mutationsDrained, undefined) : Effect.void).pipe(
          Effect.andThen(workBarrierReady ? Deferred.succeed(workDrained, undefined) : Effect.void)
        )
      ),
      Effect.asVoid
    )

  const acquireBackgroundJob = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [false, current]
    return [true, { ...current, activeBackgroundJobs: current.activeBackgroundJobs + 1 }]
  }).pipe(
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new ServerDraining()))
  )

  const releaseBackgroundJob = Ref.modify(state, (current) => {
    const next = {
      ...current,
      activeBackgroundJobs: current.activeBackgroundJobs - 1
    }
    return [next.phase === "draining" && !hasActiveWork(next), next]
  }).pipe(
    Effect.flatMap((drained) => drained ? Deferred.succeed(workDrained, undefined) : Effect.void),
    Effect.asVoid
  )

  const acquireStreamPermit = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [false, current]
    return [true, { ...current, activeStreams: current.activeStreams + 1 }]
  }).pipe(
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(new ServerDraining()))
  )

  const releaseStream = Ref.modify(state, (current) => {
    const next = { ...current, activeStreams: current.activeStreams - 1 }
    return [next.phase === "draining" && next.activeStreams === 0, next]
  }).pipe(
    Effect.flatMap((drained) => drained ? Deferred.succeed(streamsDrained, undefined) : Effect.void),
    Effect.asVoid
  )

  const drainWithin = (duration: Duration.Input) =>
    beginDrain.pipe(
      Effect.andThen(Deferred.await(drainHooksCompleted).pipe(Effect.timeoutOption(duration))),
      Effect.map(Option.match({
        onNone: (): ServerDrainResult => ({ _tag: "DeadlineExceeded" }),
        onSome: (hookIds): ServerDrainResult =>
          hookIds.length === 0 ? { _tag: "Drained" } : { _tag: "HooksFailed", hookIds }
      }))
    )

  const registerDrainHook = (
    hook: ServerDrainHook
  ): Effect.Effect<void, ServerDrainHookConflict | ServerDraining, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function*() {
        const result = yield* Ref.modify(state, (current): [DrainHookRegistration, ServerLifecycleState] => {
          if (current.phase === "draining") return ["draining", current]
          if (current.drainHooks.has(hook.hookId)) return ["conflict", current]
          const drainHooks = new Map(current.drainHooks)
          drainHooks.set(hook.hookId, hook)
          return ["registered", { ...current, drainHooks }]
        })
        switch (result) {
          case "registered":
            return
          case "conflict":
            return yield* new ServerDrainHookConflict({ hookId: hook.hookId })
          case "draining":
            return yield* new ServerDraining()
        }
      }),
      () =>
        Ref.update(state, (current) => {
          if (current.phase === "draining") return current
          const drainHooks = new Map(current.drainHooks)
          drainHooks.delete(hook.hookId)
          return { ...current, drainHooks }
        })
    )

  yield* Deferred.await(drainStarted).pipe(
    Effect.andThen(Deferred.await(workDrained)),
    Effect.andThen(Deferred.await(streamsDrained)),
    Effect.andThen(Deferred.await(drainHookSnapshot)),
    Effect.flatMap((hooks) =>
      Effect.forEach(
        Array.from(hooks).sort((left, right) => left.hookId.localeCompare(right.hookId)),
        (hook) =>
          hook.run.pipe(
            Effect.as(null),
            Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(hook.hookId))
          ),
        { concurrency: 1 }
      )
    ),
    Effect.map((results) => results.filter((hookId): hookId is string => hookId !== null)),
    Effect.flatMap((hookIds) => Deferred.succeed(drainHooksCompleted, hookIds)),
    Effect.forkScoped
  )

  return {
    beginDrain,
    awaitDrain: Deferred.await(drainStarted),
    awaitMutationsDrained: Deferred.await(mutationsDrained),
    awaitWorkDrained: Deferred.await(workDrained),
    drainWithin,
    phase: Ref.get(state).pipe(Effect.map((current) => current.phase)),
    runMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.withFiber((fiber) =>
        Effect.acquireUseRelease(
          acquireMutation(fiber.id),
          () => effect,
          (acquired) => (acquired ? releaseMutation(fiber.id) : Effect.void)
        )
      ),
    runBackground: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquireBackgroundJob,
        () => effect,
        () => releaseBackgroundJob
      ),
    registerDrainHook,
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
