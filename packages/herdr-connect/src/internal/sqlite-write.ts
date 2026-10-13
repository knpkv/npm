/** Short native waits yield to the hub between complete, idempotent SQLite write attempts. */
import { Duration, Effect, Schedule, Schema } from "effect"
import { ConnectStoreBusyError } from "../errors.js"

export const connectBusyTimeoutMillis = 100
const connectWriteTimeoutMillis = 5_000
const isSqliteBusy = Schema.is(
  Schema.Struct({
    code: Schema.Literal("ERR_SQLITE_ERROR"),
    errcode: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  }).check(Schema.makeFilter(({ errcode }) => errcode % 256 === 5))
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

/** The callback owns one full IMMEDIATE transaction or one atomic statement; rollback before throwing. */
export const connectSqliteWrite = Effect.fn("ConnectStore.sqliteWrite")(function*<A, E>(
  operation: string,
  run: () => A,
  onOtherFailure: (cause: unknown) => E
) {
  return yield* Effect.try({
    try: run,
    catch: (cause) =>
      isSqliteBusy(cause)
        ? new ConnectStoreBusyError({ operation, timeoutMillis: connectWriteTimeoutMillis, cause })
        : onOtherFailure(cause)
  }).pipe(Effect.retry({
    while: (error): boolean => Schema.is(ConnectStoreBusyError)(error),
    schedule: retrySchedule
  }))
})
