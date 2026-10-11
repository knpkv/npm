/** Bound DOM work independently of the provider's wire limit. Large files remain readable in the owner app. */
export const canRenderCodeText = (before: string | null, after: string | null): boolean => {
  let bytes = 0
  let lines = 0
  for (const text of [before, after]) {
    if (text === null) continue
    bytes += new TextEncoder().encode(text).byteLength
    if (bytes > 102_400) return false
    lines += 1
    for (const character of text) {
      if (character === "\n") lines += 1
      if (lines > 2_000) return false
    }
  }
  return true
}
