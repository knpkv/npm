import { Effect, FileSystem, Schema } from "effect"
import { FleetValidationError } from "./errors.js"
import { HostConfiguration } from "./model.js"

export const loadConfiguration = Effect.fn("FleetConfiguration.load")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError((cause) =>
        new FleetValidationError({
          // A first run has no file yet: say where it is looked for and how to point elsewhere.
          detail: cause.reason._tag === "NotFound"
            ? `no fleet configuration at ${path}; create it, or set FLEET_CONFIG_PATH to an existing file`
            : `cannot read ${path}: ${String(cause)}`
        })
      )
    )
    const unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (cause) =>
        new FleetValidationError({
          detail: `invalid JSON in ${path}: ${String(cause)}`
        })
    })
    return yield* Schema.decodeUnknownEffect(HostConfiguration, {
      onExcessProperty: "error"
    })(unknown).pipe(
      Effect.mapError(
        (error) =>
          new FleetValidationError({
            detail: `invalid fleet configuration: ${String(error)}`
          })
      )
    )
  }
)
