/**
 * Shared attachment reference helpers for Atlassian Markdown surfaces.
 *
 * @module
 */

export interface AttachmentPreviewInput {
  readonly id?: string | undefined
  readonly filename: string
  readonly url?: string | undefined
  readonly mediaType?: string | null | undefined
  readonly mimeType?: string | null | undefined
  readonly size?: number | null | undefined
}

export interface AttachmentReferenceInput {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly mediaType: string | null
  readonly size: number | null
}

export interface AttachmentPlaceholderReplacement {
  readonly content: string
  readonly replacements: number
}

export interface AttachmentPlaceholderMatch {
  readonly label: string
  readonly isImage: boolean
}

const IMAGE_EXTENSION_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i

/**
 * Returns true when an attachment should render as a Markdown image preview.
 * SVG is previewable even when the remote API reports a generic content type.
 */
export const isPreviewableAttachment = (attachment: AttachmentPreviewInput): boolean => {
  const type = attachment.mediaType ?? attachment.mimeType ?? ""
  return type.toLowerCase().startsWith("image/") || IMAGE_EXTENSION_RE.test(attachment.filename)
}

export const normalizeAttachmentMediaType = (
  mediaType: string | null | undefined,
  mimeType?: string | null | undefined
): string | null => {
  const value = mediaType ?? mimeType
  return value && value.trim().length > 0 ? value : null
}

export const renderAttachmentMarkdown = (
  attachment: AttachmentReferenceInput,
  options?: { readonly label?: string | null | undefined; readonly metadata?: string | null | undefined }
): string => {
  const label = escapeMarkdownLabel(options?.label?.trim() || attachment.filename)
  const destination = safeMarkdownDestination(attachment.url)
  const reference = isPreviewableAttachment(attachment)
    ? `![${label}](${destination})`
    : `[${label}](${destination})`
  return options?.metadata ? `${options.metadata}\n${reference}` : reference
}

export const replaceAttachmentPlaceholder = (
  content: string,
  placeholderPath: string,
  renderedAttachment: string | ((match: AttachmentPlaceholderMatch) => string),
  options?: { readonly replaceAll?: boolean | undefined }
): AttachmentPlaceholderReplacement => {
  const escapedPath = escapeRegExp(placeholderPath)
  const placeholder = new RegExp(`!?\\[([^\\]]*)\\]\\(${escapedPath}\\)`, "g")
  let replacements = 0
  const replaced = content.replace(placeholder, (match, label: string) => {
    replacements++
    return typeof renderedAttachment === "string"
      ? renderedAttachment
      : renderedAttachment({ isImage: match.startsWith("!"), label })
  })
  if (!options?.replaceAll && replacements > 1) {
    return { content, replacements }
  }
  return { content: replaced, replacements }
}

const escapeMarkdownLabel = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\n+/g, " ")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]")

const safeMarkdownDestination = (value: string): string =>
  /[\s()<>]/.test(value)
    ? `<${value.replace(/\n/g, "%0A").replace(/</g, "%3C").replace(/>/g, "%3E")}>`
    : value

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
