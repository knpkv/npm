import { ConfigService, PRService, SandboxService } from "@knpkv/codecommit-core"
import { Cause, Duration, Effect, Layer } from "effect"

const continueAfterNonInterruptFailure = (
  message: string,
  delay: Duration.Duration = Duration.zero
) =>
<Value, Requirements>(
  effect: Effect.Effect<Value, never, Requirements>
): Effect.Effect<Value | void, never, Requirements> =>
  effect.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError(message, cause).pipe(
          Effect.andThen(Duration.isZero(delay) ? Effect.void : Effect.sleep(delay))
        )
    )
  )

/** Auto-refresh worker owned by the server layer scope. @internal */
export const autoRefreshLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const configService = yield* ConfigService.ConfigService
    const defaultRefreshConfig = { autoRefresh: true, refreshIntervalSeconds: 300 }
    const recoverRefreshFailure = continueAfterNonInterruptFailure(
      "Auto-refresh failed",
      Duration.seconds(10)
    )
    const recoverRefreshIterationFailure = continueAfterNonInterruptFailure(
      "Auto-refresh iteration failed",
      Duration.seconds(10)
    )

    const refresh = (successMessage: string) =>
      prService.refresh.pipe(
        Effect.tap(() => Effect.logInfo(successMessage)),
        recoverRefreshFailure
      )

    const refreshIteration = Effect.gen(function*() {
      const config = yield* configService.load.pipe(
        Effect.catch(() => Effect.succeed(defaultRefreshConfig))
      )
      if (config.autoRefresh) {
        yield* Effect.sleep(Duration.seconds(config.refreshIntervalSeconds))
        yield* refresh("Auto-refresh complete")
      } else {
        yield* Effect.sleep(Duration.seconds(30))
      }
    }).pipe(recoverRefreshIterationFailure)

    yield* Effect.forkScoped(
      Effect.gen(function*() {
        yield* refresh("Initial PR refresh complete")
        return yield* Effect.forever(refreshIteration)
      })
    )
  })
)

/** Sandbox reconciliation and GC worker owned by the server layer scope. @internal */
export const sandboxStartupLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const sandboxService = yield* SandboxService.SandboxService
    const docker = yield* SandboxService.DockerService
    const dockerAvailable = () => docker.isAvailable().pipe(Effect.catch(() => Effect.succeed(false)))
    const hasLegacyUnauthenticated = yield* sandboxService.hasLegacyUnauthenticated()
    if (hasLegacyUnauthenticated) {
      let available = false
      while (!available) {
        available = yield* dockerAvailable()
        if (!available) {
          yield* Effect.logWarning("Docker not available — waiting before legacy sandbox reconciliation")
          yield* Effect.sleep(Duration.seconds(1))
        }
      }
      let reconciled = false
      while (!reconciled) {
        reconciled = yield* sandboxService.reconcile()
        if (!reconciled) {
          yield* Effect.sleep(Duration.seconds(1))
        }
      }
    } else if (yield* dockerAvailable()) {
      yield* sandboxService.reconcile()
    } else {
      yield* Effect.logWarning("Docker not available — sandbox maintenance deferred")
    }
    yield* Effect.logInfo("Sandbox service ready")

    const reconciliationPass = Effect.gen(function*() {
      yield* Effect.sleep(Duration.minutes(1))
      if (yield* dockerAvailable()) {
        yield* sandboxService.reconcile()
      }
    }).pipe(continueAfterNonInterruptFailure("Sandbox reconciliation failed"))

    const gcPass = Effect.gen(function*() {
      yield* Effect.sleep(Duration.minutes(5))
      yield* sandboxService.gcIdle()
    }).pipe(
      continueAfterNonInterruptFailure("Sandbox GC failed")
    )

    yield* Effect.forkScoped(Effect.forever(reconciliationPass))
    yield* Effect.forkScoped(Effect.forever(gcPass))
  })
)
