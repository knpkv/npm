/** Short native waits yield to the hub between complete, idempotent SQLite write attempts. */
import { Duration, Effect, Schedule, Schema, type Semaphore } from "effect"
import { ConnectStoreBusyError } from "../errors.js"

export const connectBusyTimeoutMillis = 100
export const connectWriteTimeoutMillis = 5_000
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

/** Replay an atomic write; keep its permit through completion. The deadline includes acquisition and completion. */
export const connectSqliteWrite = Effect.fn("ConnectStore.sqliteWrite")(function*<A, E, E2 = never, R = never>(
  operation: string,
  run: () => A,
  onOtherFailure: (cause: unknown) => E,
  retryBusy = true,
  transactions?: Semaphore.Semaphore,
  onSuccess?: (value: A) => Effect.Effect<unknown, E2, R>
) {
  let lastBusy: ConnectStoreBusyError | undefined
  const attempt = Effect.try({
    try: run,
    catch: (cause) => {
      if (isSqliteBusy(cause)) {
        lastBusy = new ConnectStoreBusyError({
          operation,
          timeoutMillis: retryBusy ? connectWriteTimeoutMillis : connectBusyTimeoutMillis,
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
  const completed = onSuccess === undefined ? retried : retried.pipe(Effect.tap(onSuccess))
  const guarded = transactions === undefined ? completed : transactions.withPermits(1)(completed)
  return yield* retryBusy ?
    guarded.pipe(Effect.timeoutOrElse({
      duration: connectWriteTimeoutMillis,
      orElse: () =>
        lastBusy ?? new ConnectStoreBusyError({
          operation,
          timeoutMillis: connectWriteTimeoutMillis,
          cause: "SQLite write exceeded its transaction completion deadline"
        })
    })) :
    guarded
})
