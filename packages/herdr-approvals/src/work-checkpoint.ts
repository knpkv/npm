import { FleetValidationError, type HostConfiguration } from "@knpkv/herdr-fleet"
import { WorkGoalCheckpoint } from "@knpkv/herdr-work/model"
import { Effect, Schema } from "effect"

export const workSnapshotPath = "/v1/work"
export const workCheckpointPath = "/v1/work/checkpoints"

export const workCheckpointFromJson = Effect.fn("Fleetctl.workCheckpointFromJson")(function*(text: string) {
  const input = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) =>
      new FleetValidationError({
        detail: `invalid work checkpoint JSON: ${String(cause)}`
      })
  })
  return yield* Schema.decodeUnknownEffect(WorkGoalCheckpoint, {
    onExcessProperty: "error"
  })(input).pipe(
    Effect.mapError(
      (cause) =>
        new FleetValidationError({
          detail: `invalid work checkpoint: ${String(cause)}`
        })
    )
  )
})

const workLocalBaseUrl = Effect.fn("Fleetctl.workLocalBaseUrl")(function*(
  config: HostConfiguration,
  target: string
) {
  const known = config.machines.find(({ host }) => host.toLowerCase() === target.toLowerCase())
  if (known === undefined) {
    return yield* new FleetValidationError({ detail: `unknown host: ${target}` })
  }
  if (known.host.toLowerCase() !== config.host.toLowerCase()) {
    return yield* new FleetValidationError({
      detail: "work commands can only target the local host"
    })
  }
  return `http://127.0.0.1:${config.localPort}`
})

export const workCheckpointUrl = Effect.fn("Fleetctl.workCheckpointUrl")(function*(
  config: HostConfiguration,
  target: string
) {
  return `${yield* workLocalBaseUrl(config, target)}${workCheckpointPath}`
})

export const workSnapshotUrl = Effect.fn("Fleetctl.workSnapshotUrl")(function*(
  config: HostConfiguration,
  target: string
) {
  return `${yield* workLocalBaseUrl(config, target)}${workSnapshotPath}`
})
