/**
 * @internal
 */

import { Effect } from "effect"
import { ConfigService } from "../ConfigService/index.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"

export const makeToggleAccount = (
  refresh: Effect.Effect<void>
) =>
  Effect.fn("PRService.toggleAccount")(function*(profile: AwsProfileName) {
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.orDie)
    const existingIdx = config.accounts.findIndex((a) => a.profile === profile)

    const newAccounts = [...config.accounts]
    if (existingIdx >= 0) {
      newAccounts[existingIdx] = {
        ...newAccounts[existingIdx]!,
        enabled: !newAccounts[existingIdx]!.enabled
      }
    } else {
      const detected = yield* configService.detectProfiles.pipe(Effect.orDie)
      const p = detected.find((d) => d.name === profile)
      newAccounts.push({
        profile,
        regions: [p?.region ?? ("us-east-1" as AwsRegion)],
        enabled: true
      })
    }

    yield* configService.save({ ...config, accounts: newAccounts }).pipe(Effect.orDie)
    yield* refresh
  })
