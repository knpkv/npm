import * as Schema from "effect/Schema"

/**
 * Canonical provider identifier accepted at Control Center settings, API, and
 * runtime-registry boundaries.
 */
export const AgentProviderIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u, {
    expected: "a lowercase agent provider identifier"
  })
)
