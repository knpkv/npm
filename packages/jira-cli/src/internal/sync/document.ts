/**
 * Parser and serializer for strict Jira Markdown Sync Issue Documents.
 *
 * @internal
 */
import matter from "gray-matter"
import * as yaml from "js-yaml"
import { SyncValidationError } from "../../JiraCliError.js"
import type {
  AcceptedComment,
  AttachmentReference,
  CommentDraft,
  IssueDocument,
  IssueDocumentFrontMatter
} from "./types.js"

const yamlEngine = {
  parse: (str: string): object => (yaml.load(str) as object) ?? {},
  stringify: (data: object): string => yaml.dump(data)
}

export const DESCRIPTION_SECTION = "Description"
export const NEW_COMMENTS_SECTION = "New Comments"
export const COMMENTS_SECTION = "Comments"
export const ATTACHMENTS_SECTION = "Attachments"
export const LOCAL_NOTES_SECTION = "Local Notes"

const BUILT_IN_SECTIONS = new Set([
  DESCRIPTION_SECTION,
  NEW_COMMENTS_SECTION,
  COMMENTS_SECTION,
  ATTACHMENTS_SECTION,
  LOCAL_NOTES_SECTION
])

export const serializeIssueDocument = (document: IssueDocument): string => {
  const body = [
    `# ${document.frontMatter.issueKey}: ${document.frontMatter.summary}`,
    "",
    section(DESCRIPTION_SECTION, document.description),
    ...Object.entries(document.multilineCustomFields).map(([name, content]) => section(name, content)),
    section(NEW_COMMENTS_SECTION, serializeCommentDrafts(document.commentDrafts)),
    section(COMMENTS_SECTION, serializeAcceptedComments(document.acceptedComments)),
    section(ATTACHMENTS_SECTION, serializeAttachments(document.attachments)),
    section(LOCAL_NOTES_SECTION, document.localNotes)
  ].filter((part) => part.length > 0).join("\n")

  return matter.stringify(body, document.frontMatter, { engines: { yaml: yamlEngine } })
}

export const parseIssueDocument = (path: string, content: string): IssueDocument => {
  const parsed = matter(content, { engines: { yaml: yamlEngine } })
  const frontMatter = parseFrontMatter(path, parsed.data)
  const sections = parseSections(path, parsed.content)

  const description = sections.get(DESCRIPTION_SECTION) ?? fail(path, `Missing ${DESCRIPTION_SECTION} section`)
  const localNotes = sections.get(LOCAL_NOTES_SECTION) ?? ""
  const multilineCustomFields = Object.fromEntries(
    [...sections.entries()].filter(([name]) => !BUILT_IN_SECTIONS.has(name))
  )

  return {
    frontMatter,
    description,
    multilineCustomFields,
    commentDrafts: parseCommentDrafts(path, sections.get(NEW_COMMENTS_SECTION) ?? ""),
    acceptedComments: parseAcceptedComments(sections.get(COMMENTS_SECTION) ?? ""),
    attachments: parseAttachments(sections.get(ATTACHMENTS_SECTION) ?? ""),
    localNotes
  }
}

const section = (name: string, content: string): string => {
  const normalized = content.trim()
  return normalized.length > 0 ? `## ${name}\n\n${normalized}\n` : `## ${name}\n`
}

const parseFrontMatter = (path: string, data: Record<string, unknown>): IssueDocumentFrontMatter => {
  const requiredString = (key: string): string => {
    const value = data[key]
    if (typeof value !== "string") fail(path, `Missing or invalid front matter field "${key}"`)
    return value as string
  }

  const nullableString = (key: string): string | null => {
    const value = data[key]
    if (value === null || value === undefined) return null
    if (typeof value !== "string") fail(path, `Invalid front matter field "${key}"`)
    return value as string
  }

  const userValue = (key: string) => {
    const value = data[key]
    if (value === null || value === undefined) return null
    if (typeof value !== "object") fail(path, `Invalid user field "${key}"`)
    const record = value as Record<string, unknown>
    if (typeof record["accountId"] !== "string" || typeof record["displayName"] !== "string") {
      fail(path, `Invalid user field "${key}"`)
    }
    return {
      accountId: record["accountId"] as string,
      displayName: record["displayName"] as string
    }
  }

  const labels = data["labels"]
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    fail(path, `Missing or invalid front matter field "labels"`)
  }

  const customFields = data["customFields"]
  if (customFields === null || typeof customFields !== "object" || Array.isArray(customFields)) {
    fail(path, `Missing or invalid front matter field "customFields"`)
  }

  return {
    issueId: requiredString("issueId"),
    issueKey: requiredString("issueKey"),
    summary: requiredString("summary"),
    status: requiredString("status"),
    issueType: requiredString("issueType"),
    priority: nullableString("priority"),
    assignee: userValue("assignee"),
    reporter: userValue("reporter"),
    labels: labels as ReadonlyArray<string>,
    customFields: customFields as IssueDocumentFrontMatter["customFields"]
  }
}

const parseSections = (path: string, content: string): Map<string, string> => {
  const lines = content.split(/\r?\n/)
  const sections = new Map<string, Array<string>>()
  let current: string | null = null

  for (const line of lines) {
    const match = /^## (.+)$/.exec(line)
    if (match?.[1]) {
      current = match[1].trim()
      if (sections.has(current)) fail(path, `Duplicate section "${current}"`)
      sections.set(current, [])
    } else if (current) {
      sections.get(current)?.push(line)
    }
  }

  return new Map([...sections.entries()].map(([name, body]) => [name, trimOuterBlankLines(body).join("\n")]))
}

const serializeCommentDrafts = (drafts: ReadonlyArray<CommentDraft>): string =>
  drafts.map((draft) => `<!-- draftId: ${draft.draftId} -->\n${draft.body.trim()}`).join("\n\n")

const parseCommentDrafts = (path: string, content: string): ReadonlyArray<CommentDraft> => {
  if (content.trim().length === 0) return []
  const parts = content.split(/(?=<!-- draftId: )/g).filter((part) => part.trim().length > 0)
  return parts.map((part) => {
    const match = /^<!-- draftId: ([^ ]+) -->\n?([\s\S]*)$/.exec(part.trim())
    const draftId = match?.[1] ?? fail(path, "Malformed comment draft marker")
    return { draftId, body: match?.[2]?.trim() ?? "" }
  })
}

const serializeAcceptedComments = (comments: ReadonlyArray<AcceptedComment>): string =>
  comments.map((comment) =>
    `### ${comment.author} - ${comment.created}\n<!-- jiraCommentId: ${comment.id} -->\n\n${comment.body.trim()}`
  ).join("\n\n")

const parseAcceptedComments = (content: string): ReadonlyArray<AcceptedComment> => {
  if (content.trim().length === 0) return []
  const parts = content.split(/(?=^### )/gm).filter((part) => part.trim().length > 0)
  return parts.flatMap((part) => {
    const match = /^### (.+) - (.+)\n<!-- jiraCommentId: ([^ ]+) -->\n?([\s\S]*)$/.exec(part.trim())
    if (!match?.[1] || !match[2] || !match[3]) return []
    return [{
      author: match[1],
      created: match[2],
      id: match[3],
      body: match[4]?.trim() ?? ""
    }]
  })
}

const serializeAttachments = (attachments: ReadonlyArray<AttachmentReference>): string =>
  attachments.map((attachment) => `- [${attachment.filename}](${attachment.url})`).join("\n")

const parseAttachments = (content: string): ReadonlyArray<AttachmentReference> =>
  content.split(/\r?\n/).flatMap((line) => {
    const match = /^- \[(.+)]\((.+)\)$/.exec(line.trim())
    return match?.[1] && match[2] ? [{ filename: match[1], url: match[2] }] : []
  })

const trimOuterBlankLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === "") start++
  while (end > start && lines[end - 1]?.trim() === "") end--
  return lines.slice(start, end)
}

const fail = (path: string, message: string): never => {
  throw new SyncValidationError({ message, path })
}
