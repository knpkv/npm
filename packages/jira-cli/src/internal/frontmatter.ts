/**
 * Front-matter serialization utilities for Jira issues.
 *
 * @module
 */
import matter from "gray-matter"
import type { Issue } from "../IssueService.js"

/**
 * Front-matter data for a Jira issue.
 *
 * @category Types
 */
export interface IssueFrontMatter {
  readonly key: string
  readonly id: string
  readonly summary: string
  readonly status: string
  readonly type: string
  readonly priority: string | null
  readonly assignee: string | null
  readonly reporter: string | null
  readonly created: string
  readonly updated: string
  readonly fixVersions: ReadonlyArray<string>
  readonly labels: ReadonlyArray<string>
  readonly components: ReadonlyArray<string>
  readonly url: string
}

/**
 * Extract front-matter data from an issue.
 *
 * @param issue - The issue to extract from
 * @returns Front-matter object
 *
 * @category Utilities
 */
export const extractFrontMatter = (issue: Issue): IssueFrontMatter => ({
  key: issue.key,
  id: issue.id,
  summary: issue.summary,
  status: issue.status,
  type: issue.type,
  priority: issue.priority,
  assignee: issue.assignee,
  reporter: issue.reporter,
  created: issue.created.toISOString(),
  updated: issue.updated.toISOString(),
  fixVersions: issue.fixVersions,
  labels: issue.labels,
  components: issue.components,
  url: issue.url
})

/**
 * Serialize an issue to markdown with front-matter.
 *
 * @param issue - The issue to serialize
 * @returns Markdown string with YAML front-matter
 *
 * @category Serialization
 */
export const serializeIssue = (issue: Issue): string => {
  const frontMatter = extractFrontMatter(issue)
  const content = buildMarkdownContent(issue)
  return matter.stringify(content, frontMatter)
}

/**
 * Build markdown content for an issue (without front-matter).
 *
 * @param issue - The issue to build content for
 * @returns Markdown content string
 *
 * @category Serialization
 */
export const buildMarkdownContent = (issue: Issue): string => {
  const parts: Array<string> = []

  // Title
  parts.push(`# ${issue.key}: ${issue.summary}`)
  parts.push("")

  // Description
  if (issue.description) {
    parts.push("## Description")
    parts.push("")
    parts.push(issue.description)
    parts.push("")
  }

  // Attachments
  if (issue.attachments.length > 0) {
    parts.push("## Attachments")
    parts.push("")
    for (const attachment of issue.attachments) {
      parts.push(`- [${attachment.filename}](${attachment.url})`)
    }
    parts.push("")
  }

  // Comments
  if (issue.comments.length > 0) {
    parts.push("## Comments")
    parts.push("")
    for (const comment of issue.comments) {
      const date = comment.created.toISOString().split("T")[0]
      parts.push(`### ${comment.author} (${date})`)
      parts.push("")
      parts.push(comment.body)
      parts.push("")
    }
  }

  return parts.join("\n")
}

/**
 * Build a combined markdown file for multiple issues.
 *
 * @param issues - The issues to include
 * @param jql - The JQL query used (for header)
 * @returns Combined markdown string
 *
 * @category Serialization
 */
export const buildCombinedMarkdown = (issues: ReadonlyArray<Issue>, jql: string): string => {
  const parts: Array<string> = []

  // Header
  parts.push("# Jira Export")
  parts.push("")
  parts.push(`Query: \`${jql}\``)
  parts.push(`Exported: ${new Date().toISOString()}`)
  parts.push(`Total: ${issues.length} tickets`)
  parts.push("")
  parts.push("---")
  parts.push("")

  // Issues
  for (const issue of issues) {
    parts.push(`## ${issue.key}: ${issue.summary}`)
    parts.push("")
    parts.push(
      `**Status:** ${issue.status} | **Type:** ${issue.type}${
        issue.priority ? ` | **Priority:** ${issue.priority}` : ""
      }`
    )
    if (issue.assignee) {
      parts.push(`**Assignee:** ${issue.assignee}`)
    }
    parts.push("")

    if (issue.description) {
      parts.push(issue.description)
      parts.push("")
    }

    parts.push("---")
    parts.push("")
  }

  return parts.join("\n")
}
