/** Shared Git path quoting for owner and bounded browser patch producers. @module */
const gitPathEscape = (byte: number): string | undefined => {
  switch (byte) {
    case 0x07:
      return "\\a"
    case 0x08:
      return "\\b"
    case 0x09:
      return "\\t"
    case 0x0a:
      return "\\n"
    case 0x0b:
      return "\\v"
    case 0x0c:
      return "\\f"
    case 0x0d:
      return "\\r"
    case 0x22:
      return "\\\""
    case 0x5c:
      return "\\\\"
    default:
      return byte < 0x20 || byte === 0x7f || byte >= 0x80
        ? `\\${byte.toString(8).padStart(3, "0")}`
        : undefined
  }
}

/** Match Git's default C-style path quoting while leaving ordinary paths readable. */
export const quoteGitPath = (path: string): string => {
  let escaped = ""
  let requiresQuotes = false
  for (const byte of new TextEncoder().encode(path)) {
    const replacement = gitPathEscape(byte)
    if (replacement === undefined) {
      escaped += String.fromCharCode(byte)
    } else {
      escaped += replacement
      requiresQuotes = true
    }
  }
  return requiresQuotes ? `"${escaped}"` : escaped
}
