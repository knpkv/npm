export interface RlyCssTokenViolation {
  readonly column: number
  readonly line: number
  readonly sourcePath: string
  readonly token: string
}

const CUSTOM_PROPERTY_DECLARATION = /(?:^|[;{])\s*(--rly-[A-Za-z0-9_-]+)\s*:/gmu
const CUSTOM_PROPERTY_REGISTRATION = /@property\s+(--rly-[A-Za-z0-9_-]+)\s*\{/giu
const CUSTOM_PROPERTY_REFERENCE = /\bvar\s*\(\s*(--rly-[A-Za-z0-9_-]+)/giu

const sanitizeCss = (source: string): string => {
  let isComment = false
  let quote: "\"" | "'" | null = null
  let sanitized = ""

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index)
    const nextCharacter = source.charAt(index + 1)

    if (isComment) {
      if (character === "*" && nextCharacter === "/") {
        sanitized += "  "
        index += 1
        isComment = false
      } else {
        sanitized += character === "\n" ? "\n" : " "
      }
      continue
    }

    if (quote !== null) {
      if (character === "\\") {
        sanitized += " "
        if (nextCharacter !== "") {
          sanitized += nextCharacter === "\n" ? "\n" : " "
          index += 1
        }
      } else if (character === quote) {
        sanitized += " "
        quote = null
      } else {
        sanitized += character === "\n" ? "\n" : " "
      }
      continue
    }

    if (character === "/" && nextCharacter === "*") {
      sanitized += "  "
      index += 1
      isComment = true
    } else if (character === "\"" || character === "'") {
      sanitized += " "
      quote = character
    } else {
      sanitized += character
    }
  }

  return sanitized
}

const collectMatches = (source: string, pattern: RegExp): ReadonlySet<string> => {
  const matches = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    const token = match[1]
    if (token !== undefined) matches.add(token)
  }
  return matches
}

/** Extract rly custom properties declared or registered by one stylesheet. */
export const declaredRlyCssTokens = (source: string): ReadonlySet<string> => {
  const sanitized = sanitizeCss(source)
  return new Set([
    ...collectMatches(sanitized, CUSTOM_PROPERTY_DECLARATION),
    ...collectMatches(sanitized, CUSTOM_PROPERTY_REGISTRATION)
  ])
}

const hasFallback = (source: string, tokenEnd: number): boolean => {
  let nestedParentheses = 0
  for (let index = tokenEnd; index < source.length; index += 1) {
    const character = source.charAt(index)
    if (character === "(") {
      nestedParentheses += 1
    } else if (character === ")") {
      if (nestedParentheses === 0) return false
      nestedParentheses -= 1
    } else if (character === "," && nestedParentheses === 0) {
      return true
    }
  }
  return false
}

const sourcePosition = (source: string, index: number): { readonly column: number; readonly line: number } => {
  const lineStart = source.lastIndexOf("\n", index - 1)
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charAt(cursor) === "\n") line += 1
  }
  return { column: index - lineStart, line }
}

/** Find unresolved rly `var()` references while allowing local declarations and explicit fallbacks. */
export const inspectRlyCssTokens = (
  sourcePath: string,
  source: string,
  generatedTokens: ReadonlySet<string>
): ReadonlyArray<RlyCssTokenViolation> => {
  const sanitized = sanitizeCss(source)
  const localTokens = declaredRlyCssTokens(source)
  const violations: Array<RlyCssTokenViolation> = []

  for (const match of sanitized.matchAll(CUSTOM_PROPERTY_REFERENCE)) {
    const token = match[1]
    const index = match.index
    if (
      token === undefined ||
      index === undefined ||
      generatedTokens.has(token) ||
      localTokens.has(token) ||
      hasFallback(sanitized, index + match[0].length)
    ) {
      continue
    }
    violations.push({ ...sourcePosition(source, index), sourcePath, token })
  }

  return violations
}
