import * as Schema from "effect/Schema"

/** Atlassian basic-auth account email accepted by first-party provider runtimes. @internal */
export const AtlassianBasicAuthEmail = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, {
    expected: "a valid Atlassian account email address"
  })
)
