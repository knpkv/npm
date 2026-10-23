/** The executable's options: the limits command from the environment, or the installed agent-usage. */
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { createRequire } from "node:module"
import { readUsageOptions, UsageLimitsCommandInvalid } from "../src/options.js"

const require = createRequire(import.meta.url)
const runtime = { execPath: "/opt/node/bin/node", resolve: require.resolve }

describe("readUsageOptions", () => {
  it("defaults to the installed agent-usage, run by this node", () => {
    const options = readUsageOptions({}, runtime)
    expect(Result.isSuccess(options)).toBe(true)
    if (Result.isFailure(options)) return
    const [node, script, ...rest] = options.success.limitsCommand ?? []
    expect([node, rest]).toEqual([runtime.execPath, ["limits"]])
    // Resolved through the package's `./*.js` export to the built entry, not looked up on PATH.
    expect(script).toMatch(/agent-usage[\\/]dist[\\/]main\.js$/u)
  })

  it("takes a JSON array from HERDR_USAGE_LIMITS_COMMAND", () => {
    expect(readUsageOptions({ HERDR_USAGE_LIMITS_COMMAND: "[\"agent-usage\",\"limits\"]" }, runtime))
      .toEqual(Result.succeed({ limitsCommand: ["agent-usage", "limits"] }))
  })

  it("refuses a set but malformed HERDR_USAGE_LIMITS_COMMAND instead of falling back", () => {
    for (const value of ["agent-usage limits", "[1,2]", "{}", ""]) {
      const options = readUsageOptions({ HERDR_USAGE_LIMITS_COMMAND: value }, runtime)
      expect(Result.isFailure(options) && options.failure).toBeInstanceOf(UsageLimitsCommandInvalid)
    }
  })
})
