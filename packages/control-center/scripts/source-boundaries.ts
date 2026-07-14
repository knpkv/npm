import * as ts from "typescript"

export type SourceBoundaryViolation = {
  readonly importPath: string
  readonly reason: string
  readonly sourcePath: string
}

const isRlyImport = (importPath: string): boolean => importPath === "@knpkv/rly" || importPath.startsWith("@knpkv/rly/")

const isPrototypeImport = (importPath: string): boolean =>
  importPath.split(/[/?#]/).includes("prototypes") ||
  importPath.includes("prototype/control-center") ||
  importPath === "@knpkv/codecommit-web" ||
  importPath.startsWith("@knpkv/codecommit-web/")

const NON_LITERAL_DYNAMIC_IMPORT = "<non-literal dynamic import>"
const UNCLASSIFIED_SOURCE = "<unclassified source>"
const PROTOTYPE_RUNTIME_REASON = "production code cannot import prototype runtime"
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/iu

const scriptKindForSourcePath = (sourcePath: string): ts.ScriptKind => {
  const normalizedSourcePath = sourcePath.toLowerCase()
  if (normalizedSourcePath.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (normalizedSourcePath.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (
    normalizedSourcePath.endsWith(".ts") ||
    normalizedSourcePath.endsWith(".mts") ||
    normalizedSourcePath.endsWith(".cts")
  ) {
    return ts.ScriptKind.TS
  }
  if (
    normalizedSourcePath.endsWith(".js") ||
    normalizedSourcePath.endsWith(".mjs") ||
    normalizedSourcePath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.Unknown
}

const withoutOuterExpressions = (expression: ts.Expression): ts.Expression => {
  let current = expression

  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isPartiallyEmittedExpression(current) ||
      ts.isExpressionWithTypeArguments(current)
    ) {
      current = current.expression
      continue
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right
      continue
    }
    if (ts.isCommaListExpression(current)) {
      const finalExpression = current.elements[current.elements.length - 1]
      if (finalExpression !== undefined) {
        current = finalExpression
        continue
      }
    }
    return current
  }
}

const isDirectRequire = (expression: ts.Expression): boolean => {
  const candidate = withoutOuterExpressions(expression)
  return ts.isIdentifier(candidate) && candidate.text === "require"
}

const isDirectRequireMember = (expression: ts.Expression, memberName: string): boolean => {
  const candidate = withoutOuterExpressions(expression)
  if (ts.isPropertyAccessExpression(candidate)) {
    return candidate.name.text === memberName && isDirectRequire(candidate.expression)
  }
  if (ts.isElementAccessExpression(candidate)) {
    const member = candidate.argumentExpression
    return ts.isStringLiteralLike(member) && member.text === memberName && isDirectRequire(candidate.expression)
  }
  return false
}

type RequireSpecifier =
  | { readonly kind: "expression"; readonly expression: ts.Expression }
  | { readonly kind: "non-literal" }
  | { readonly kind: "none" }

const expressionSpecifier = (expression: ts.Expression | undefined): RequireSpecifier =>
  expression === undefined ? { kind: "none" } : { expression, kind: "expression" }

const appliedRequireSpecifier = (argumentsExpression: ts.Expression | undefined): RequireSpecifier => {
  if (argumentsExpression === undefined) return { kind: "none" }
  const candidate = withoutOuterExpressions(argumentsExpression)
  if (!ts.isArrayLiteralExpression(candidate)) return { kind: "non-literal" }
  const firstArgument = candidate.elements[0]
  if (firstArgument === undefined) return { kind: "none" }
  if (ts.isOmittedExpression(firstArgument) || ts.isSpreadElement(firstArgument)) return { kind: "non-literal" }
  return { expression: firstArgument, kind: "expression" }
}

// This intentionally recognizes only syntactic compositions rooted at the named direct loader.
const requireSpecifier = (node: ts.CallExpression): RequireSpecifier => {
  const callee = withoutOuterExpressions(node.expression)
  if (isDirectRequire(callee)) return expressionSpecifier(node.arguments[0])
  if (isDirectRequireMember(callee, "call")) return expressionSpecifier(node.arguments[1])
  if (isDirectRequireMember(callee, "apply")) return appliedRequireSpecifier(node.arguments[1])

  if (ts.isCallExpression(callee) && isDirectRequireMember(callee.expression, "bind")) {
    const boundSpecifier = callee.arguments[1]
    return expressionSpecifier(boundSpecifier ?? node.arguments[0])
  }

  return { kind: "none" }
}

const withoutQuery = (importPath: string): string => importPath.split(/[?#]/, 1)[0] ?? importPath

const normalizedTarget = (sourcePath: string, importPath: string): string | undefined => {
  const cleanImportPath = withoutQuery(importPath)
  if (cleanImportPath === "@knpkv/control-center") return "src/index"
  if (cleanImportPath.startsWith("@knpkv/control-center/")) {
    return `src/${cleanImportPath.slice("@knpkv/control-center/".length)}`
  }
  if (!cleanImportPath.startsWith(".")) return undefined
  const sourceParts = sourcePath.replaceAll("\\", "/").split("/")
  sourceParts.pop()
  const targetParts = [...sourceParts, ...cleanImportPath.split("/")]
  const normalized: Array<string> = []

  for (const part of targetParts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      normalized.pop()
      continue
    }
    normalized.push(part)
  }

  return normalized.join("/").replace(SCRIPT_EXTENSION, "")
}

const isWithin = (sourcePath: string, directory: string): boolean =>
  sourcePath === directory || sourcePath.startsWith(`${directory}/`)

const mayImportPluginExecutionInternals = (sourcePath: string): boolean =>
  sourcePath === "src/server/plugins/PluginDefinition" ||
  isWithin(sourcePath, "src/server/plugins/internal") ||
  isWithin(sourcePath, "src/server/governance")

const reasonForImport = (sourcePath: string, importPath: string): string | undefined => {
  const normalizedSource = sourcePath.replaceAll("\\", "/").replace(SCRIPT_EXTENSION, "")
  const target = normalizedTarget(normalizedSource, importPath)
  const isClient = isWithin(normalizedSource, "src/client")
  const isApi = isWithin(normalizedSource, "src/api")
  const isDomain = isWithin(normalizedSource, "src/domain")
  const isServer = isWithin(normalizedSource, "src/server")

  if (isPrototypeImport(importPath)) return PROTOTYPE_RUNTIME_REASON
  if (importPath === NON_LITERAL_DYNAMIC_IMPORT) return "production dynamic imports must use a literal module path"
  if (
    target !== undefined &&
    isWithin(target, "src/server/plugins/internal") &&
    !mayImportPluginExecutionInternals(normalizedSource)
  ) {
    return "only internal plugin composition and the governed engine can import live plugin execution services"
  }
  if (isClient && target !== undefined && isWithin(target, "src/server")) {
    return "client code cannot import server code"
  }
  if (
    isApi &&
    target !== undefined &&
    (isWithin(target, "src/client") || isWithin(target, "src/server") || target === "src/index")
  ) {
    return "API code can import only API or domain code"
  }
  if (isServer && target !== undefined && (isWithin(target, "src/client") || target === "src/index")) {
    return "server code can import only server, API, or domain code"
  }
  if (isDomain && target !== undefined && !isWithin(target, "src/domain")) {
    return "domain code cannot import other application boundaries"
  }
  if (
    normalizedSource === "src/index" &&
    target !== undefined &&
    (isWithin(target, "src/client") || isWithin(target, "src/server"))
  ) {
    return "the package root must remain browser-safe"
  }
  if ((isApi || isDomain || isServer || normalizedSource === "src/index") && isRlyImport(importPath)) {
    return "API, domain, and server code cannot import the presentation system"
  }
  return undefined
}

/** Inspect all static, exported, and dynamic module specifiers in one source file. */
export const inspectModuleImports = (sourcePath: string, source: string): ReadonlyArray<string> => {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForSourcePath(sourcePath)
  )
  const imports: Array<string> = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const argument = node.arguments[0]
      imports.push(
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : NON_LITERAL_DYNAMIC_IMPORT
      )
    } else if (ts.isCallExpression(node)) {
      const specifier = requireSpecifier(node)
      if (specifier.kind === "non-literal") {
        imports.push(NON_LITERAL_DYNAMIC_IMPORT)
      } else if (specifier.kind === "expression") {
        imports.push(
          ts.isStringLiteralLike(specifier.expression) ? specifier.expression.text : NON_LITERAL_DYNAMIC_IMPORT
        )
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal
      if (ts.isStringLiteralLike(literal)) imports.push(literal.text)
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const argument = node.arguments?.[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument) && argument.text.startsWith(".")) {
        imports.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

type StylesheetReference = {
  readonly index: number
  readonly value: string
}

const stylesheetReferences = (source: string): ReadonlyArray<string> => {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => " ".repeat(comment.length))
  const references: Array<StylesheetReference> = []
  const directImports = /@import\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/giu
  const urls = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^"')]*?))\s*\)/giu
  const moduleCompositions = /\bcomposes\s*:[^;{}]*?\bfrom\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s;{}]+))/giu
  const icssValues = /@value\b[^;{}]*?\bfrom\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s;{}]+))/giu
  const icssImports = /:import\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"')]+))\s*\)/giu

  for (const match of withoutComments.matchAll(directImports)) {
    const value = match[1] ?? match[2]
    if (value !== undefined) references.push({ index: match.index, value })
  }
  for (const match of withoutComments.matchAll(urls)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim()
    if (value !== undefined && value.length > 0) references.push({ index: match.index, value })
  }
  for (const match of withoutComments.matchAll(moduleCompositions)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim()
    if (value !== undefined && value.length > 0) references.push({ index: match.index, value })
  }
  for (const match of withoutComments.matchAll(icssValues)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim()
    if (value !== undefined && value.length > 0) references.push({ index: match.index, value })
  }
  for (const match of withoutComments.matchAll(icssImports)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim()
    if (value !== undefined && value.length > 0) references.push({ index: match.index, value })
  }

  return references.sort((left, right) => left.index - right.index).map(({ value }) => value)
}

/** Return prototype-boundary violations found in one production stylesheet. */
export const inspectStylesheetBoundaries = (
  sourcePath: string,
  source: string
): ReadonlyArray<SourceBoundaryViolation> =>
  stylesheetReferences(source).flatMap((importPath) =>
    isPrototypeImport(importPath) ? [{ importPath, reason: PROTOTYPE_RUNTIME_REASON, sourcePath }] : []
  )

/** Return every package-boundary violation found in one production source file. */
export const inspectSourceBoundaries = (sourcePath: string, source: string): ReadonlyArray<SourceBoundaryViolation> =>
  (() => {
    const normalizedSource = sourcePath.replaceAll("\\", "/").replace(SCRIPT_EXTENSION, "")
    const classified = normalizedSource === "src/index" ||
      ["src/api", "src/client", "src/domain", "src/server"].some((directory) => isWithin(normalizedSource, directory))
    const structuralViolations: ReadonlyArray<SourceBoundaryViolation> = classified
      ? []
      : [
        {
          importPath: UNCLASSIFIED_SOURCE,
          reason: "production source must belong to the root, API, client, domain, or server boundary",
          sourcePath
        }
      ]
    return [
      ...structuralViolations,
      ...inspectModuleImports(sourcePath, source).flatMap((importPath) => {
        const reason = reasonForImport(sourcePath, importPath)
        return reason === undefined ? [] : [{ importPath, reason, sourcePath }]
      })
    ]
  })()
