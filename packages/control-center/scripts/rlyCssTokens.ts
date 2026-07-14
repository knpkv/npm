export interface RlyCssTokenViolation {
  readonly column: number
  readonly line: number
  readonly sourcePath: string
  readonly token: string
}

interface CssBlock {
  readonly close: number
  readonly header: string
  readonly open: number
  readonly parent: number | null
}

const CUSTOM_PROPERTY_DECLARATION = /(?:^|[;{])\s*(--rly-[A-Za-z0-9_-]+)\s*:/gmu
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

const cssBlocks = (source: string): ReadonlyArray<CssBlock> => {
  const blocks: Array<{ close: number; header: string; open: number; parent: number | null }> = []
  const stack: Array<number> = []
  let statementStart = 0

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index)
    if (character === "{") {
      const blockIndex = blocks.length
      blocks.push({
        close: source.length,
        header: source.slice(statementStart, index).trim(),
        open: index,
        parent: stack.at(-1) ?? null
      })
      stack.push(blockIndex)
      statementStart = index + 1
    } else if (character === ";") {
      statementStart = index + 1
    } else if (character === "}") {
      const blockIndex = stack.pop()
      if (blockIndex !== undefined) {
        const block = blocks[blockIndex]
        if (block !== undefined) blocks[blockIndex] = { ...block, close: index }
      }
      statementStart = index + 1
    }
  }

  return blocks
}

const containingBlock = (blocks: ReadonlyArray<CssBlock>, index: number): number | null => {
  let containing: number | null = null
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]
    if (block !== undefined && block.open < index && index < block.close) containing = blockIndex
  }
  return containing
}

const isUnconditionalBlock = (blocks: ReadonlyArray<CssBlock>, block: CssBlock): boolean => {
  let parent = block.parent
  while (parent !== null) {
    const parentBlock = blocks[parent]
    if (parentBlock === undefined || !parentBlock.header.toLowerCase().startsWith("@layer")) return false
    parent = parentBlock.parent
  }
  return true
}

const isGlobalRootRule = (blocks: ReadonlyArray<CssBlock>, block: CssBlock): boolean =>
  block.header === ":root" && isUnconditionalBlock(blocks, block)

const tokenDefinitions = (
  sanitized: string,
  blocks: ReadonlyArray<CssBlock>
): {
  readonly all: ReadonlySet<string>
  readonly global: ReadonlySet<string>
  readonly localByBlock: ReadonlyMap<number, ReadonlySet<string>>
} => {
  const all = new Set<string>()
  const global = new Set<string>()
  const localByBlock = new Map<number, Set<string>>()

  for (const match of sanitized.matchAll(CUSTOM_PROPERTY_DECLARATION)) {
    const token = match[1]
    const index = match.index
    if (token === undefined || index === undefined) continue
    const blockIndex = containingBlock(blocks, index + match[0].length)
    if (blockIndex === null) continue
    const blockTokens = localByBlock.get(blockIndex) ?? new Set<string>()
    blockTokens.add(token)
    localByBlock.set(blockIndex, blockTokens)
    all.add(token)
    const block = blocks[blockIndex]
    if (block !== undefined && isGlobalRootRule(blocks, block)) global.add(token)
  }

  return { all, global, localByBlock }
}

/**
 * Extract literal rly declarations from a stylesheet contract.
 * `@property` registrations are intentionally excluded: this guardrail does not reimplement CSS value grammar.
 */
export const declaredRlyCssTokens = (source: string): ReadonlySet<string> => {
  const sanitized = sanitizeCss(source)
  return tokenDefinitions(sanitized, cssBlocks(sanitized)).all
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

/**
 * Find unresolved rly `var()` references using only generated, unconditional root, same-rule, or fallback definitions.
 * An `@property` registration never suppresses a violation because registration alone provides no contract value.
 */
export const inspectRlyCssTokens = (
  sourcePath: string,
  source: string,
  generatedTokens: ReadonlySet<string>
): ReadonlyArray<RlyCssTokenViolation> => {
  const sanitized = sanitizeCss(source)
  const blocks = cssBlocks(sanitized)
  const definitions = tokenDefinitions(sanitized, blocks)
  const violations: Array<RlyCssTokenViolation> = []

  for (const match of sanitized.matchAll(CUSTOM_PROPERTY_REFERENCE)) {
    const token = match[1]
    const index = match.index
    const blockIndex = index === undefined ? null : containingBlock(blocks, index)
    const isDefinedInSameBlock = blockIndex !== null && token !== undefined &&
      definitions.localByBlock.get(blockIndex)?.has(token) === true
    if (
      token === undefined ||
      index === undefined ||
      generatedTokens.has(token) ||
      definitions.global.has(token) ||
      isDefinedInSameBlock ||
      hasFallback(sanitized, index + match[0].length)
    ) {
      continue
    }
    violations.push({ ...sourcePosition(source, index), sourcePath, token })
  }

  return violations
}
