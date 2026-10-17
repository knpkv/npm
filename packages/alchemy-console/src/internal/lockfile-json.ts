/**
 * Turns Bun's text lockfile (JSON that may carry trailing commas and comments) into plain JSON text.
 * Strings are copied untouched; outside them, comments are dropped, then a comma directly before `}`
 * or `]` is removed. The caller decodes the result with a JSON schema, which judges anything left.
 * Kept in-house so bundlers need no CommonJS/UMD JSON parser (hostd bundles this package). @module
 */

/** Rewrites `text` outside string literals with `outside`, which returns what to emit and how far it read. */
const outsideStrings = (
  text: string,
  outside: (index: number) => { readonly emit: string; readonly next: number }
): string => {
  let output = ""
  let index = 0
  while (index < text.length) {
    if (text[index] === "\"") {
      let end = index + 1
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      output += text.slice(index, end + 1)
      index = end + 1
    } else {
      const step = outside(index)
      output += step.emit
      index = step.next
    }
  }
  return output
}

export const lockfileJsonText = (text: string): string => {
  const withoutComments = outsideStrings(text, (index) => {
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index)
      return { emit: "", next: end === -1 ? text.length : end }
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2)
      // An unterminated comment is left in place for the JSON decode to reject.
      return end === -1 ? { emit: text.slice(index), next: text.length } : { emit: " ", next: end + 2 }
    }
    return { emit: text[index] ?? "", next: index + 1 }
  })
  const withoutTrailingCommas = outsideStrings(withoutComments, (index) => {
    if (withoutComments[index] !== ",") return { emit: withoutComments[index] ?? "", next: index + 1 }
    let next = index + 1
    while (next < withoutComments.length && /\s/u.test(withoutComments[next] ?? "")) next += 1
    const closes = withoutComments[next] === "}" || withoutComments[next] === "]"
    return { emit: closes ? "" : ",", next: index + 1 }
  })
  return withoutTrailingCommas
}
