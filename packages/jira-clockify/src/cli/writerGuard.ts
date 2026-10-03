/** One live machine writer lease shared by every provider mutation in this process. */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import type { ConfigService } from "../services/ConfigService.js"
import * as WatchLease from "./watchLease.js"

/**
 * Why a provider write could not run: `taken` means another JCF writer (usually `jcf watch`)
 * holds the machine guard, `unavailable` that the guard could not be acquired, `lost` that the
 * held guard stopped standing mid-operation, and `missing` that a mutation ran outside a guard.
 */
export class WriterGuardError extends Data.TaggedError("WriterGuardError")<{
  readonly reason: "taken" | "unavailable" | "lost" | "missing"
  readonly message: string
}> {}

export const isWriterGuardError = Predicate.isTagged("WriterGuardError")

interface WriterScopeState {
  readonly active: Ref.Ref<boolean>
  readonly admission: Semaphore.Semaphore
  readonly fibers: FiberSet.FiberSet<unknown, unknown>
  readonly lease: Extract<WatchLease.LeaseOutcome, { readonly _tag: "Held" }>
  readonly mutations: Semaphore.Semaphore
}

class WriterScope extends Context.Service<WriterScope, WriterScopeState>()("jcf/WriterScope") {}

interface MutationScopeState {
  readonly ownerFiber: number
}

class MutationScope extends Context.Service<MutationScope, MutationScopeState>()("jcf/WriterMutationScope") {}

const standingError = (reason: string) =>
  new WriterGuardError({ reason: "lost", message: `Machine writer guard lost: ${reason}` })

type GuardRequirements = ConfigService | FileSystem.FileSystem | Path.Path

const verifyStanding = (scope: WriterScopeState): Effect.Effect<void, WriterGuardError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const standing = yield* WatchLease.refresh({ path: scope.lease.path, owner: scope.lease.owner })
    if (standing._tag !== "Mine") return yield* standingError(standing.reason)
  })

const verify = (scope: WriterScopeState): Effect.Effect<void, WriterGuardError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (!(yield* Ref.get(scope.active))) {
      return yield* standingError("the owning operation already released it")
    }
    yield* verifyStanding(scope)
  })

/** Provide an already-held lease to nested writer services without acquiring it again. */
export const withExistingWriterGuard = <A, E, R>(
  lease: Extract<WatchLease.LeaseOutcome, { readonly _tag: "Held" }>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function*() {
      const fibers = yield* FiberSet.make<unknown, unknown>()
      const cancelAndJoin = FiberSet.clear(fibers)
      const drain = FiberSet.awaitEmpty(fibers).pipe(
        Effect.interruptible,
        Effect.onInterrupt(() => cancelAndJoin)
      )
      return yield* Effect.acquireUseRelease(
        Effect.all({ active: Ref.make(true), admission: Semaphore.make(1), mutations: Semaphore.make(1) }),
        ({ active, admission, mutations }) =>
          effect.pipe(
            Effect.provideService(WriterScope, { active, admission, fibers, lease, mutations })
          ),
        ({ active, admission }, exit) =>
          Ref.set(active, false).pipe(
            // Flush any admission already between the active check and FiberSet registration.
            Effect.andThen(admission.withPermit(Effect.void)),
            Effect.andThen(Exit.isSuccess(exit) ? drain : cancelAndJoin)
          )
      )
    })
  )

/** Acquire the machine guard, or reuse the live guard already enclosing this operation. */
export const withWriterGuard = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | WriterGuardError, R | GuardRequirements> =>
  Effect.gen(function*() {
    const current = yield* Effect.serviceOption(WriterScope)
    if (Option.isSome(current)) {
      yield* verify(current.value)
      return yield* effect
    }
    return yield* Effect.acquireUseRelease(
      WatchLease.acquire({ intervalSeconds: 300 }),
      (lease) =>
        Effect.gen(function*() {
          if (lease._tag === "Taken") {
            return yield* new WriterGuardError({
              reason: "taken",
              message: "Another JCF writer holds the machine guard"
            })
          }
          if (lease._tag === "Unavailable") {
            return yield* new WriterGuardError({ reason: "unavailable", message: lease.reason })
          }
          return yield* withExistingWriterGuard(lease, effect)
        }),
      (lease) => lease._tag === "Held" ? WatchLease.releaseGuard(lease) : Effect.void
    )
  })

/**
 * Serialize one provider mutation inside the live guard.
 *
 * Same-fiber nesting reuses the permit. A fork gets a different fiber id and must wait for the
 * shared semaphore; after the owning guard releases, the live-lease check fails closed.
 */
export const mutate = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | WriterGuardError, R | GuardRequirements> =>
  Effect.gen(function*() {
    const ownerFiber = yield* Effect.fiberId
    const mutation = yield* Effect.serviceOption(MutationScope)
    const writer = yield* Effect.serviceOption(WriterScope)
    if (Option.isSome(mutation) && mutation.value.ownerFiber === ownerFiber) {
      if (Option.isNone(writer)) {
        return yield* new WriterGuardError({ reason: "missing", message: "Writer authority is missing" })
      }
      yield* verifyStanding(writer.value)
      return yield* effect
    }
    if (Option.isNone(writer)) return yield* withWriterGuard(mutate(effect))
    const fiber = yield* writer.value.admission.withPermit(
      verify(writer.value).pipe(
        Effect.andThen(FiberSet.run(
          writer.value.fibers,
          writer.value.mutations.withPermit(
            Effect.gen(function*() {
              yield* verifyStanding(writer.value)
              const mutationFiber = yield* Effect.fiberId
              return yield* effect.pipe(Effect.provideService(MutationScope, { ownerFiber: mutationFiber }))
            })
          )
        ))
      )
    )
    return yield* Fiber.join(fiber)
  })
