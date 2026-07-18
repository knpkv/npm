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
  readonly activeBackgroundJobs: number
  readonly activeMutationFiberIds: ReadonlySet<number>
  readonly activeMutations: number
  readonly activeStreams: number
  readonly phase: ServerLifecyclePhase
}

type MutationAdmission = "acquired" | "nested" | "rejected"

interface ServerLifecycleService {
  /** Move to draining exactly once and wake every drain observer. */
  readonly beginDrain: Effect.Effect<void>
  /** Complete when graceful drain has begun. */
  readonly awaitDrain: Effect.Effect<void>
  /** Complete after drain begins and every admitted mutation has finished. */
  readonly awaitMutationsDrained: Effect.Effect<void>
  /** Complete after drain begins and every admitted mutation or background job has finished. */
  readonly awaitWorkDrained: Effect.Effect<void>
  /** Begin drain and report whether admitted mutations finished before the deadline. */
  readonly drainWithin: (duration: Duration.Input) => Effect.Effect<boolean>
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
  /** Atomically retain a long-lived stream only while the process is accepting work. */
  readonly acquireStream: Effect.Effect<void, ServerDraining, Scope.Scope>
}

const makeServerLifecycle = Effect.fn("ServerLifecycle.make")(function*() {
  const state = yield* Ref.make<ServerLifecycleState>({
    activeBackgroundJobs: 0,
    activeMutationFiberIds: new Set(),
    activeMutations: 0,
    activeStreams: 0,
    phase: "accepting"
  })
  const drainStarted = yield* Deferred.make<void>()
  const workDrained = yield* Deferred.make<void>()

  const hasActiveWork = (current: ServerLifecycleState): boolean =>
    current.activeMutations > 0 || current.activeBackgroundJobs > 0

  const beginDrain = Ref.modify(state, (current) => {
    if (current.phase === "draining") return [!hasActiveWork(current), current]
    const draining: ServerLifecycleState = { ...current, phase: "draining" }
    return [
      !hasActiveWork(current),
      draining
    ]
  }).pipe(
    Effect.flatMap((alreadyDrained) =>
      Deferred.succeed(drainStarted, undefined).pipe(
        Effect.andThen(alreadyDrained ? Deferred.succeed(workDrained, undefined) : Effect.void)
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
      return [next.phase === "draining" && !hasActiveWork(next), next]
    }).pipe(
      Effect.flatMap((drained) => (drained ? Deferred.succeed(workDrained, undefined) : Effect.void)),
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

  const releaseStream = Ref.update(state, (current) => ({
    ...current,
    activeStreams: current.activeStreams - 1
  }))

  const drainWithin = (duration: Duration.Input) =>
    beginDrain.pipe(
      Effect.andThen(Deferred.await(workDrained).pipe(Effect.timeoutOption(duration))),
      Effect.map(Option.isSome)
    )

  return {
    beginDrain,
    awaitDrain: Deferred.await(drainStarted),
    awaitMutationsDrained: Deferred.await(workDrained),
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
