/** Canonical Control Center attribution for governed Jira comment payloads. @module */
import * as Schema from "effect/Schema"

/** Canonical Jira Atlassian Document Format shape accepted by comment operations. */
export const JiraDescriptionDocument = Schema.Struct({
  type: Schema.Literal("doc"),
  version: Schema.Literal(1),
  content: Schema.Array(Schema.Json)
})

/** Decoded Jira comment document. */
export type JiraDescriptionDocument = typeof JiraDescriptionDocument.Type

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
