/**
 * CLI version detection and compatibility checking.
 */

import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Command from "@effect/platform/Command"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CliNotFoundError, CliVersionMismatchError } from "./ClaudeCodeCliError.js"

/**
 * Minimum supported CLI version.
 *
 * @category Constants
 */
export const MIN_CLI_VERSION = "0.1.0"

/**
 * Version schema for parsing semver strings.
 *
 * @category Schemas
 */
export const VersionSchema = Schema.Struct({
  major: Schema.Number,
  minor: Schema.Number,
  patch: Schema.Number
})

export type Version = Schema.Schema.Type<typeof VersionSchema>

/**
 * Parse semver string into Version.
 *
 * @param versionString - Semver string like "1.2.3"
 * @returns Parsed version or null if invalid
 *
 * @category Utilities
 * @internal
 */
export const parseVersion = (versionString: string): Version | null => {
  const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match || !match[1] || !match[2] || !match[3]) return null

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  }
}

/**
 * Compare two versions.
 *
 * @param a - First version
 * @param b - Second version
 * @returns Negative if a < b, 0 if equal, positive if a > b
 *
 * @category Utilities
 * @internal
 */
export const compareVersions = (a: Version, b: Version): number => {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

/**
 * Get installed CLI version.
 *
 * Executes `claude --version` and parses the output.
 *
 * @returns Effect with version string or CliNotFoundError
 *
 * @category Version
 * @example
 *   import { getCliVersion } from "@knpkv/effect-ai-claude-code-cli/CliVersion"
 *
 *   const program = getCliVersion()
 */
export const getCliVersion = (): Effect.Effect<string, CliNotFoundError> =>
  Effect.gen(function*() {
    const output = yield* Command.string(Command.make("claude", "--version")).pipe(
      Effect.mapError(() => new CliNotFoundError()),
      Effect.provide(NodeContext.layer)
    )

    // Parse version from output (e.g., "claude-code version 0.1.0")
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/)
    if (!versionMatch || !versionMatch[1]) {
      return yield* Effect.fail(new CliNotFoundError())
    }

    return versionMatch[1]
  })

/**
 * Check if CLI version meets minimum requirements.
 *
 * @param minVersion - Minimum required version string
 * @returns Effect with version check result or error
 *
 * @category Version
 * @example
 *   import { checkCliVersion } from "@knpkv/effect-ai-claude-code-cli/CliVersion"
 *
 *   const program = checkCliVersion("0.1.0")
 */
export const checkCliVersion = (
  minVersion: string = MIN_CLI_VERSION
): Effect.Effect<string, CliNotFoundError | CliVersionMismatchError> =>
  Effect.gen(function*() {
    const installedVersion = yield* getCliVersion()

    const installed = parseVersion(installedVersion)
    const required = parseVersion(minVersion)

    if (!installed || !required) {
      return yield* Effect.fail(
        new CliVersionMismatchError({
          installed: installedVersion,
          required: minVersion,
          message: "Failed to parse version numbers"
        })
      )
    }

    if (compareVersions(installed, required) < 0) {
      return yield* Effect.fail(
        new CliVersionMismatchError({
          installed: installedVersion,
          required: minVersion,
          message: `Claude CLI version ${installedVersion} is below minimum required version ${minVersion}`
        })
      )
    }

    return installedVersion
  })
