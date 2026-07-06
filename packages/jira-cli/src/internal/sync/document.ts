/**
 * Parser and serializer for strict Jira Markdown Sync Issue Documents.
 *
 * @internal
 */
import { isPreviewableAttachment } from "@knpkv/atlassian-common/attachments"
import matter from "gray-matter"
import * as yaml from "js-yaml"
import { SyncValidationError } from "../../JiraCliError.js"
import type {
  AcceptedComment,
  AttachmentReference,
  CommentDraft,
  IssueDocument,
  IssueDocumentFrontMatter,
  UserFieldValue
} from "./types.js"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isFrontMatterCustomFields = (
  value: unknown
): value is IssueDocumentFrontMatter["customFields"] => isRecord(value)

const yamlEngine = {
  parse: (str: string): object => {
    const value = yaml.load(str)
    return isRecord(value) ? value : {}
  },
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
    if (typeof value === "string") return value
    return fail(path, `Missing or invalid front matter field "${key}"`)
  }

  const nullableString = (key: string): string | null => {
    const value = data[key]
    if (value === null || value === undefined) return null
    if (typeof value === "string") return value
    return fail(path, `Invalid front matter field "${key}"`)
  }

  const userValue = (key: string): UserFieldValue | null => {
    const value = data[key]
    if (value === null || value === undefined) return null
    const record = isRecord(value) ? value : fail(path, `Invalid user field "${key}"`)
    const accountId = record["accountId"]
    const displayName = record["displayName"]
    if (typeof accountId === "string" && typeof displayName === "string") {
      return {
        accountId,
        displayName
      }
    }
    return fail(path, `Invalid user field "${key}"`)
  }

  const labels = data["labels"]
  const parsedLabels = isStringArray(labels)
    ? labels
    : fail(path, `Missing or invalid front matter field "labels"`)

  const customFields = data["customFields"]
  const parsedCustomFields = isFrontMatterCustomFields(customFields)
    ? customFields
    : fail(path, `Missing or invalid front matter field "customFields"`)

  return {
    issueId: requiredString("issueId"),
    issueKey: requiredString("issueKey"),
    summary: requiredString("summary"),
    status: requiredString("status"),
    issueType: requiredString("issueType"),
    priority: nullableString("priority"),
    assignee: userValue("assignee"),
    reporter: userValue("reporter"),
    labels: parsedLabels,
    customFields: parsedCustomFields
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
  attachments.map((attachment) => {
    const metadata = {
      jiraAttachmentId: attachment.id,
      mediaType: attachment.mediaType,
      size: attachment.size
    }
    const reference = isPreviewableAttachment(attachment)
      ? `![${attachment.filename}](${attachment.url})`
      : `[${attachment.filename}](${attachment.url})`
    return `<!-- jiraAttachment: ${JSON.stringify(metadata)} -->\n${reference}`
  }).join("\n\n")

const parseAttachments = (content: string): ReadonlyArray<AttachmentReference> => {
  const lines = content.split(/\r?\n/)
  const attachments: Array<AttachmentReference> = []
  let pendingMetadata: Partial<Pick<AttachmentReference, "id" | "mediaType" | "size">> = {}

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    const metadataMatch = /^<!--\s*jiraAttachment:\s*(\{.*})\s*-->$/.exec(line)
    if (metadataMatch?.[1]) {
      pendingMetadata = parseAttachmentMetadata(metadataMatch[1])
      continue
    }

    const markdownMatch = /^(?:-\s*)?!?\[(.+)]\((.+)\)$/.exec(line)
    if (markdownMatch?.[1] && markdownMatch[2]) {
      attachments.push({
        id: pendingMetadata.id ?? "",
        filename: markdownMatch[1],
        url: markdownMatch[2],
        mediaType: pendingMetadata.mediaType ?? null,
        size: pendingMetadata.size ?? null
      })
      pendingMetadata = {}
    }
  }

  return attachments
}

const parseAttachmentMetadata = (
  raw: string
): Partial<Pick<AttachmentReference, "id" | "mediaType" | "size">> => {
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    return {
      id: typeof parsed["jiraAttachmentId"] === "string"
        ? parsed["jiraAttachmentId"]
        : typeof parsed["id"] === "string"
        ? parsed["id"]
        : "",
      mediaType: typeof parsed["mediaType"] === "string" ? parsed["mediaType"] : null,
      size: typeof parsed["size"] === "number" ? parsed["size"] : null
    }
  } catch {
    return {}
  }
}

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
