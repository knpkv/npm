import { Effect, FileSystem, Schema } from "effect"
import { FleetValidationError } from "./errors.js"
import { HostConfiguration } from "./model.js"

export const loadConfiguration = Effect.fn("FleetConfiguration.load")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError((cause) =>
        new FleetValidationError({
          detail: `cannot read ${path}: ${String(cause)}`
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
