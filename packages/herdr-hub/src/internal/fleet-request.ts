import { FleetOperationError } from "@knpkv/herdr-fleet"
import { Effect } from "effect"

export const withFleetRequestTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new FleetOperationError({
            cause: "10 seconds",
            detail: "fleet request timed out after 10 seconds",
            operation: "fleet.request.timeout"
          })
        )
    })
  )
