import * as Schema from "effect/Schema"

export const JIRA_RELEASE_VERSION_NAME_MAX_CHARACTERS = 255
export const JIRA_RELEASE_VERSION_DESCRIPTION_MAX_BYTES = 16_384

export const utf8ByteLength = (value: string): number => {
  let length = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return length
}

export const jiraReleaseVersionDescriptionWithinLimit = (value: string): boolean =>
  utf8ByteLength(value) <= JIRA_RELEASE_VERSION_DESCRIPTION_MAX_BYTES

export const JiraReleaseVersionName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(JIRA_RELEASE_VERSION_NAME_MAX_CHARACTERS)
)

export const JiraReleaseVersionDescription = Schema.NullOr(
  Schema.String.check(
    Schema.makeFilter(jiraReleaseVersionDescriptionWithinLimit, {
      expected: `at most ${JIRA_RELEASE_VERSION_DESCRIPTION_MAX_BYTES} UTF-8 bytes`
    })
  )
)
