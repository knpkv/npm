/**
 * @internal
 */

import { Effect } from "effect"
import { ConfigService } from "../ConfigService/index.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"
import type { PRState } from "./internal.js"

export const makeToggleAccount = (
  state: PRState,
  refresh: Effect.Effect<void>
) =>
(profile: AwsProfileName): Effect.Effect<void, never, ConfigService> =>
  Effect.gen(function*() {
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
  }).pipe(Effect.withSpan("PRService.toggleAccount"))
