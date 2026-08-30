import type { JobRecord } from "@knpkv/herdr-fleet"
import { Effect, Schedule } from "effect"

const terminalStatuses = new Set([
  "expired",
  "failed",
  "rejected",
  "succeeded"
])

export const followJob = <E, R>(
  poll: Effect.Effect<JobRecord, E, R>
) =>
  poll.pipe(
    Effect.repeat(
      Schedule.passthrough(
        Schedule.spaced("1 second").pipe(
          Schedule.while(
            ({ input }: { readonly input: JobRecord }) => !terminalStatuses.has(input.status)
          )
        )
      )
    )
  )
