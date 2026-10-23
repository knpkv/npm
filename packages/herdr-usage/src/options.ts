/**
 * The `herdr-usage` executable's options, read from its environment. `HERDR_USAGE_LIMITS_COMMAND` (a JSON array)
 * overrides the agent-usage command a standalone run reads this machine with. Unset, it is the installed
 * `@knpkv/agent-usage` run by the same node: no PATH lookup and no `.cmd` shim, which Windows can't spawn without a
 * shell. Set but malformed, it is refused rather than quietly replaced by the default.
 *
 * @module
 */
import { Result, Schema } from "effect"
import type { UsageAppOptions } from "./app.js"

/** `HERDR_USAGE_LIMITS_COMMAND` is set but isn't a non-empty JSON array of strings. */
export class UsageLimitsCommandInvalid extends Schema.TaggedError<UsageLimitsCommandInvalid>()(
  "UsageLimitsCommandInvalid",
  { message: Schema.String }
) {}

/** Where the default command comes from: the running node and a module resolver next to this package. */
export interface UsageRuntime {
  readonly execPath: string
  readonly resolve: (specifier: string) => string
}

const LimitsCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String))

export const readUsageOptions = (
  env: Readonly<Record<string, string | undefined>>,
  runtime: UsageRuntime
): Result.Result<UsageAppOptions, UsageLimitsCommandInvalid> => {
  const configured = env.HERDR_USAGE_LIMITS_COMMAND
  if (configured === undefined) {
    return Result.succeed({
      limitsCommand: [runtime.execPath, runtime.resolve("@knpkv/agent-usage/main.js"), "limits"]
    })
  }
  return Result.mapBoth(Schema.decodeUnknownResult(LimitsCommand)(configured), {
    onFailure: () =>
      new UsageLimitsCommandInvalid({
        message: "HERDR_USAGE_LIMITS_COMMAND must be a JSON array of strings, like [\"agent-usage\",\"limits\"]."
      }),
    onSuccess: (limitsCommand) => ({ limitsCommand })
  })
}
