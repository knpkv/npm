/** Canonical Control Center attribution for governed Jira comment payloads. @module */
import type * as Schema from "effect/Schema"

interface JiraDescriptionDocument {
  readonly type: "doc"
  readonly version: 1
  readonly content: ReadonlyArray<Schema.Json>
}

const ControlCenterAttributionParagraph: Schema.Json = {
  type: "paragraph",
  content: [{ type: "text", text: "Posted by Control Center." }]
}

/** Append the attribution paragraph before proposal payload hashing when policy enables it. */
export const withJiraControlCenterAttribution = (
  body: JiraDescriptionDocument,
  enabled: boolean
): JiraDescriptionDocument =>
  enabled
    ? { ...body, content: [...body.content, ControlCenterAttributionParagraph] }
    : body
