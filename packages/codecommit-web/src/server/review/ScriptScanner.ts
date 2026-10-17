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

/**
 * The index just past the bracket that closes the one at `start`, or -1. A `>` that ends `=>` is not a closing angle.
 */
const closing = (text: string, start: number, open: string, close: string): number => {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === open) depth += 1
    else if (char === close && !(close === ">" && text[index - 1] === "=")) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

/** Whether `text` starts with an arrow: optional type parameters, a parameter list or name, an optional return type. */
const startsWithArrow = (text: string): boolean => {
  if (/^[A-Za-z_$][\w$]*\s*=>/u.test(text)) return true
  const params = text.startsWith("<") ? closing(text, 0, "<", ">") : 0
  if (params < 0 || text[params] === undefined) return false
  const rest = text.slice(params).trimStart()
  if (!rest.startsWith("(")) return false
  const end = closing(rest, 0, "(", ")")
  if (end < 0) return false
  const after = rest.slice(end).trimStart()
  return after.startsWith("=>") || (after.startsWith(":") && after.includes("=>"))
}

/**
 * Wrappers that return a function built from the one they are called with. Any other call that takes a callback
 * (`Effect.sync`, `rows.findLast`, `setTimeout`) is taken to return data, so its line stays in the module part.
 */
const functionWrappers = new Set(["fn", "fnUntraced", "memo", "forwardRef", "useCallback", "pipe", "flow"])

const isFunctionLiteral = (text: string): boolean => {
  const body = text.trimStart().replace(/^async\b\s*/u, "")
  return /^function\b/u.test(body) || startsWithArrow(body)
}

/**
 * Whether a variable's initializer is a function value: a function expression, an arrow (plain, generic, typed or
 * async), a known wrapper called with one (`memo((props) => ...)`, `Effect.fn(function* () {...})`), or a call
 * whose result is called with one (`Effect.fn("name")(function* () {...})`). Data that only holds callbacks, like
 * `{ retry: () => 3 }`, `rows.map((row) => row.id)` or `Effect.gen(function* () {...})`, is not a function.
 */
const holdsFunction = (initializer: string): boolean => {
  const text = initializer.trim()
  if (isFunctionLiteral(text)) return true
  const callee = /^[A-Za-z_$][\w$.]*/u.exec(text)
  if (callee === null) return false
  // Type arguments, as in `forwardRef<H, P>(...)`, sit between the callee and its arguments.
  const after = callee[0].length + (/^\s*/u.exec(text.slice(callee[0].length))?.[0].length ?? 0)
  const open = text[after] === "<" ? closing(text, after, "<", ">") : after
  if (open < 0 || text[open] !== "(") return false
  const method = callee[0].split(".").at(-1) ?? ""
  if (functionWrappers.has(method) && isFunctionLiteral(text.slice(open + 1))) return true
  const first = closing(text, open, "(", ")")
  if (first < 0) return false
  const next = text.slice(first).trimStart()
  return next.startsWith("(") && isFunctionLiteral(next.slice(1))
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
 * Top-level functions, classes and function-valued variables (see `holdsFunction`) with their line ranges, and the
 * module specifiers the file imports. `const total = (a + b) * 2` and `const config = { retry: () => 3 }` are not parts.
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
      if (kind !== "variable" || (initializer !== null && holdsFunction(initializer))) {
        declarations.push({ name: kind === "class" ? name : `${name}()`, start, end: number })
      }
      name = null
    }
  }
  return { specifiers, declarations: merge(declarations) }
}
