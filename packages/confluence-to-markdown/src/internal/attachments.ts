/**
 * Confluence Attachment Reference helpers.
 *
 * @internal
 */
import {
  isPreviewableAttachment,
  renderAttachmentMarkdown,
  replaceAttachmentPlaceholder
} from "@knpkv/atlassian-common/attachments"
import type { AttachmentReference } from "../Schemas.js"
import { sanitizeConfluenceMediaAlt } from "./mediaAlt.js"

interface AdfNode {
  readonly type?: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<AdfNode>
  readonly [key: string]: unknown
}

const isAdfNode = (value: unknown): value is AdfNode =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface MediaAttachmentResolution {
  readonly adfJson: string
  readonly unresolvedMediaIds: ReadonlyArray<string>
}

export const resolveMediaAttachmentUrls = (
  adfJson: string,
  attachments: ReadonlyArray<AttachmentReference>
): string => resolveMediaAttachmentReferences(adfJson, attachments).adfJson

export const resolveMediaAttachmentReferences = (
  adfJson: string,
  attachments: ReadonlyArray<AttachmentReference>
): MediaAttachmentResolution => {
  try {
    const parsed = JSON.parse(adfJson)
    if (!isAdfNode(parsed)) return { adfJson, unresolvedMediaIds: [] }
    const unresolvedMediaIds: Array<string> = []
    const resolved = resolveNode(parsed, attachmentLookup(attachments), unresolvedMediaIds)
    return { adfJson: JSON.stringify(resolved), unresolvedMediaIds }
  } catch {
    return { adfJson, unresolvedMediaIds: [] }
  }
}

export const renderConfluenceAttachmentReference = (
  pageId: string,
  attachment: AttachmentReference,
  options?: { readonly label?: string | null | undefined }
): string => {
  if (!attachment.fileId) return renderAttachmentMarkdown(attachment, { label: options?.label })

  const mediaId = attachment.fileId
  const collection = attachment.collectionName ?? `contentId-${pageId}`
  const label = options?.label?.trim()
  const mediaAlt = label ? sanitizeConfluenceMediaAlt(label) : undefined
  const markdownLabel = isPreviewableAttachment(attachment)
    ? sanitizeConfluenceMediaAlt(label || attachment.filename)
    : label
  const mediaSingle = {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [{
      type: "media",
      attrs: {
        id: mediaId,
        type: "file",
        collection,
        ...(mediaAlt ? { alt: mediaAlt } : {})
      }
    }]
  }
  return [
    `<!-- adf:mediaSingle node=${JSON.stringify(mediaSingle)} -->`,
    renderAttachmentMarkdown(attachment, { label: markdownLabel }),
    "<!-- adf:/mediaSingle -->"
  ].join("\n")
}

export const insertConfluenceAttachmentReference = (
  content: string,
  placeholderPath: string,
  pageId: string,
  attachment: AttachmentReference
): { readonly content: string; readonly replacements: number } =>
  replaceAttachmentPlaceholder(
    content,
    placeholderPath,
    ({ label }) => renderConfluenceAttachmentReference(pageId, attachment, { label }),
    { replaceAll: true }
  )

const attachmentLookup = (
  attachments: ReadonlyArray<AttachmentReference>
): ReadonlyMap<string, AttachmentReference> => {
  const map = new Map<string, AttachmentReference>()
  for (const attachment of attachments) {
    if (attachment.fileId) map.set(attachment.fileId, attachment)
    map.set(attachment.id, attachment)
  }
  return map
}

const resolveNode = (
  node: AdfNode,
  attachments: ReadonlyMap<string, AttachmentReference>,
  unresolvedMediaIds: Array<string>
): AdfNode => {
  const attrs = node.attrs ?? {}
  const id = typeof attrs["id"] === "string" ? attrs["id"] : null
  const attachment = node.type === "media" && id ? attachments.get(id) : undefined
  if (node.type === "media" && id && !attachment && typeof attrs["url"] !== "string") {
    unresolvedMediaIds.push(id)
  }
  const nextAttrs = attachment
    ? {
      ...attrs,
      url: attachment.url,
      filename: attachment.filename,
      ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {})
    }
    : attrs
  return {
    ...node,
    ...(Object.keys(nextAttrs).length > 0 ? { attrs: nextAttrs } : {}),
    ...(node.content
      ? { content: node.content.map((child) => resolveNode(child, attachments, unresolvedMediaIds)) }
      : {})
  }
}
