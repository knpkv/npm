import { FleetValidationError, type HostConfiguration } from "@knpkv/herdr-fleet"
import { WorkGoalCheckpoint } from "@knpkv/herdr-work/model"
import { Effect, Schema } from "effect"

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

export const workCheckpointHubUrl = Effect.fn("Fleetctl.workCheckpointHubUrl")(function*(
  config: HostConfiguration,
  target: string
) {
  const known = config.machines.find(({ host }) => host.toLowerCase() === target.toLowerCase())
  if (known === undefined) {
    return yield* new FleetValidationError({ detail: `unknown host: ${target}` })
  }
  if (
    !config.crossHost ||
    known.host.toLowerCase() !== config.approvalHub.host.toLowerCase()
  ) {
    return yield* new FleetValidationError({
      detail: "work checkpoints can only be recorded on the canonical approval hub"
    })
  }
  return new URL(workCheckpointPath, config.approvalHub.url).href
})
