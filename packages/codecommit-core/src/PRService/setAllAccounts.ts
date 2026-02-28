/**
 * @internal
 */

import { Effect } from "effect"
import { ConfigService } from "../ConfigService/index.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"

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
        regions: existing?.regions ?? [det?.region ?? ("us-east-1" as AwsRegion)],
        enabled
      }
    })

    yield* configService.save({ ...config, accounts: newAccounts }).pipe(Effect.orDie)
    yield* refresh
  })
