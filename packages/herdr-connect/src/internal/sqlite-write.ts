/** Short native waits yield to the hub between complete, idempotent SQLite write attempts. */
import { Clock, Context, Duration, Effect, Schedule, Schema, type Semaphore } from "effect"
import { ConnectStoreBusyError } from "../errors.js"

export const connectBusyTimeoutMillis = 100
export const connectWriteTimeoutMillis = 5_000

/** Local inventories share a deadline; independent writes retain their ordinary per-operation budget. */
export const ConnectInventoryWriteDeadline = Context.Reference<number | undefined>(
  "@knpkv/herdr-connect/InventoryWriteDeadline",
  { defaultValue: () => undefined }
)
const isSqliteBusy = Schema.is(
  Schema.Struct({
    code: Schema.Literal("ERR_SQLITE_ERROR"),
    errcode: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  }).check(Schema.makeFilter(({ errcode }) => errcode % 256 === 5 || errcode % 256 === 6))
)

const retrySchedule = Schedule.exponential("25 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration, elapsed }) =>
    // A fractional clock must still advance at the deadline rather than retrying with a zero-time sleep.
    Effect.succeed(Duration.max(
      Duration.millis(1),
      Duration.min(duration, Duration.millis(Math.max(0, connectWriteTimeoutMillis - elapsed)))
    ))
  ),
  Schedule.while(({ elapsed }) => elapsed < connectWriteTimeoutMillis)
)

/** Bound acquisition and SQL retries; retain the permit through post-commit finalization outside that timeout. */
export const connectSqliteWrite = Effect.fn("ConnectStore.sqliteWrite")(function*<A, E, E2 = never, R = never>(
  operation: string,
  run: () => A,
  onOtherFailure: (cause: unknown) => E,
  retryBusy = true,
  transactions?: Semaphore.Semaphore,
  onSuccess?: (value: A) => Effect.Effect<unknown, E2, R>,
  lockTimeoutMillis = connectWriteTimeoutMillis
) {
  const deadline = yield* ConnectInventoryWriteDeadline
  const remainingMillis = deadline === undefined
    ? lockTimeoutMillis
    : Math.min(lockTimeoutMillis, deadline - (yield* Clock.currentTimeMillis))
  if (retryBusy && remainingMillis <= 0) {
    return yield* new ConnectStoreBusyError({
      operation,
      timeoutMillis: lockTimeoutMillis,
      cause: "Inventory write acquisition and retry deadline exceeded"
    })
  }
  let lastBusy: ConnectStoreBusyError | undefined
  const attempt = Effect.try({
    try: run,
    catch: (cause) => {
      if (isSqliteBusy(cause)) {
        lastBusy = new ConnectStoreBusyError({
          operation,
          timeoutMillis: retryBusy ? lockTimeoutMillis : connectBusyTimeoutMillis,
          cause
        })
        return lastBusy
      }
      return onOtherFailure(cause)
    }
  })
  const retried = retryBusy ?
    attempt.pipe(Effect.retry({
      while: (error): boolean => Schema.is(ConnectStoreBusyError)(error),
      schedule: retrySchedule
    })) :
    attempt
  const acquire = transactions === undefined ? Effect.void : Effect.acquireRelease(
    transactions.take(1),
    () => transactions.release(1),
    { interruptible: true }
  )
  const write = acquire.pipe(Effect.andThen(retried))
  const value = yield* retryBusy ?
    write.pipe(Effect.timeoutOrElse({
      duration: remainingMillis,
      orElse: () =>
        lastBusy ?? new ConnectStoreBusyError({
          operation,
          timeoutMillis: lockTimeoutMillis,
          cause: "SQLite lock acquisition and retry deadline exceeded"
        })
    })) :
    write
  if (onSuccess !== undefined) yield* onSuccess(value)
  return value
}, Effect.scoped)
