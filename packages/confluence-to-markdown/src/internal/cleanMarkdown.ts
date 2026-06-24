/**
 * Remove Confluence round-trip metadata from markdown intended for reading.
 */

const ADF_COMMENT_PATTERN = /<!--\s*adf:[\s\S]*?-->/g

export const cleanMarkdown = (markdown: string): string => {
  const cleaned = markdown
    .replace(ADF_COMMENT_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return cleaned.length > 0 ? `${cleaned}\n` : ""
}
