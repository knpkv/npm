/**
 * A small lexical scan of TypeScript and JavaScript for the canvas: module specifiers, and top-level functions,
 * function-valued constants and classes with their 1-based line ranges. It masks comments, strings and template
 * literals first, so text inside them never becomes an import or a brace. It is not a parser: a regular
 * expression literal holding a quote or brace can confuse it, and then a declaration's range may be wrong; no
 * import is ever invented from code that is not an import statement or call.
 * @module
 */

export interface ScriptDeclaration {
  readonly name: string
  readonly start: number
  readonly end: number
}

export interface ScriptScan {
  /** Specifiers of static imports, re-exports, `import()` and `require()`, in source order. */
  readonly specifiers: ReadonlyArray<string>
  readonly declarations: ReadonlyArray<ScriptDeclaration>
}

interface Literal {
  readonly start: number
  readonly value: string
}

interface Masked {
  readonly code: string
  readonly literals: ReadonlyArray<Literal>
}

/** Replace comment and literal contents with spaces, keeping newlines and offsets. */
const mask = (text: string): Masked => {
  const out = text.split("")
  const literals: Array<Literal> = []
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (out[index] !== "\n") out[index] = " "
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index)
      const stop = end === -1 ? text.length : end
      blank(index, stop)
      index = stop
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(index, stop)
      index = stop
    } else if (char === "\"" || char === "'" || char === "`") {
      let end = index + 1
      while (end < text.length && text[end] !== char) {
        if (text[end] === "\\") end += 1
        else if (char !== "`" && text[end] === "\n") break
        end += 1
      }
      if (char !== "`") literals.push({ start: index, value: text.slice(index + 1, end) })
      blank(index + 1, end)
      index = end + 1
    } else index += 1
  }
  return { code: out.join(""), literals }
}

const importBefore = /(?:\bfrom|(?:^|[\n;{}])\s*import|\bimport\s*\(|\brequire\s*\()\s*$/u

type DeclarationKind = "function" | "class" | "variable"

const declarationPatterns: ReadonlyArray<{ readonly pattern: RegExp; readonly kind: DeclarationKind }> = [
  {
    pattern: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u,
    kind: "function"
  },
  { pattern: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u, kind: "variable" },
  { pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u, kind: "class" }
]

/** The initializer of a variable statement: the text after its first `=` that is not part of `=>`, `==` or `<=`. */
const initializerOf = (statement: string): string | null => {
  const match = /(?<![=!<>])=(?![=>])/u.exec(statement)
  return match === null ? null : statement.slice(match.index + 1)
}

/** Overload signatures and their implementation are one part: merge same-name ranges, keeping first-seen order. */
const merge = (declarations: ReadonlyArray<ScriptDeclaration>): ReadonlyArray<ScriptDeclaration> => {
  const byName = new Map<string, ScriptDeclaration>()
  for (const declaration of declarations) {
    const known = byName.get(declaration.name)
    byName.set(
      declaration.name,
      known === undefined
        ? declaration
        : {
          name: declaration.name,
          start: Math.min(known.start, declaration.start),
          end: Math.max(known.end, declaration.end)
        }
    )
  }
  return Array.from(byName.values())
}

/**
 * A variable is a part only when its initializer holds a function: an arrow, a function expression, or a call such
 * as `Effect.fn("name")(function*() {...})` that wraps one. `const total = (a + b) * 2` is not a part.
 */
export const scanScript = (text: string): ScriptScan => {
  const { code, literals } = mask(text)
  const specifiers = literals.flatMap((literal) =>
    importBefore.test(code.slice(Math.max(0, literal.start - 200), literal.start)) ? [literal.value] : []
  )
  const lines = code.split("\n")
  const declarations: Array<ScriptDeclaration> = []
  let depth = 0
  let name: string | null = null
  let kind: DeclarationKind = "function"
  let start = 0
  let opened = false
  let bracket = 0
  for (const [index, line] of lines.entries()) {
    const number = index + 1
    if (name === null && depth === 0) {
      for (const candidate of declarationPatterns) {
        const match = candidate.pattern.exec(line)
        if (match?.[1] !== undefined) {
          name = match[1]
          kind = candidate.kind
          start = number
          opened = false
          bracket = 0
          break
        }
      }
    }
    for (const char of line) {
      if (char === "{") {
        depth += 1
        opened = true
      } else if (char === "}") depth = Math.max(0, depth - 1)
      else if (char === "(" || char === "[") bracket += 1
      else if (char === ")" || char === "]") bracket -= 1
    }
    if (name === null || depth > 0 || bracket > 0) continue
    // A body that opened and closed ends here; an expression body ends with its statement.
    if (opened || !/(?:=>|[=(,+\-*/?:&|<])$/u.test(line.trimEnd())) {
      const initializer = kind === "variable" ? initializerOf(lines.slice(start - 1, number).join("\n")) : null
      if (kind !== "variable" || (initializer !== null && /=>|\bfunction\b/u.test(initializer))) {
        declarations.push({ name: kind === "class" ? name : `${name}()`, start, end: number })
      }
      name = null
    }
  }
  return { specifiers, declarations: merge(declarations) }
}
