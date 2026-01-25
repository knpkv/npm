import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CodeCommitApi } from "../Api.js"
import { ConfigService } from "@knpkv/codecommit-core"

export const ConfigLive = HttpApiBuilder.group(CodeCommitApi, "config", (handlers) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService

    return handlers.handle("list", () =>
      Effect.gen(function* () {
        const config = yield* configService.load.pipe(
          Effect.catchAll(() => Effect.succeed({ accounts: [], autoDetect: true }))
        )
        return {
          accounts: config.accounts.map((a) => ({
            profile: a.profile,
            regions: a.regions,
            enabled: a.enabled
          })),
          autoDetect: config.autoDetect
        }
      })
    )
  })
)
