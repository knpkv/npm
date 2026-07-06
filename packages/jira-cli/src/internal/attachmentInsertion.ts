/**
 * Local Attachment Insertion helpers for Jira Markdown files.
 *
 * @internal
 */
import { renderAttachmentMarkdown, replaceAttachmentPlaceholder } from "@knpkv/atlassian-common/attachments"
import type { Attachment } from "../IssueService.js"

export interface InsertAttachmentResult {
  readonly content: string
  readonly replacements: number
}

export const renderJiraAttachmentReference = (
  attachment: Attachment,
  options?: { readonly label?: string | null | undefined }
): string =>
  renderAttachmentMarkdown({
    id: attachment.id,
    filename: attachment.filename,
    url: attachment.url,
    mediaType: attachment.mediaType,
    size: attachment.size
  }, {
    label: options?.label,
    metadata: `<!-- jiraAttachment: ${
      JSON.stringify({
        jiraAttachmentId: attachment.id,
        mediaType: attachment.mediaType,
        size: attachment.size
      })
    } -->`
  })

export const insertJiraAttachmentReference = (
  content: string,
  placeholderPath: string,
  attachment: Attachment
): InsertAttachmentResult =>
  replaceAttachmentPlaceholder(
    content,
    placeholderPath,
    ({ label }) => renderJiraAttachmentReference(attachment, { label })
  )
