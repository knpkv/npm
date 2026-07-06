/**
 * @internal
 */

import { Effect, Schema } from "effect"
import { ConfigService } from "../ConfigService/index.js"
import { type AwsProfileName, AwsRegion } from "../Domain.js"

const decodeAwsRegion = Schema.decodeSync(AwsRegion)
const defaultAwsRegion = decodeAwsRegion("us-east-1")

export const makeSetAllAccounts = (
  refresh: Effect.Effect<void>
) =>
  Effect.fn("PRService.setAllAccounts")(function*(enabled: boolean, profiles?: Array<AwsProfileName>) {
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.orDie)
    const detected = yield* configService.detectProfiles.pipe(Effect.orDie)
    const targetProfiles = profiles ?? detected.map((d) => d.name)

    const newAccounts = targetProfiles.map((profile) => {
      const existing = config.accounts.find((a) => a.profile === profile)
      const det = detected.find((d) => d.name === profile)
      return {
        profile,
        regions: existing?.regions ?? [det?.region ?? defaultAwsRegion],
        enabled
      }
    })

    yield* configService.save({ ...config, accounts: newAccounts }).pipe(Effect.orDie)
    yield* refresh
  })
