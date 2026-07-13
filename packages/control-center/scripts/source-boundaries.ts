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

  return normalized.join("/").replace(/\.(?:js|jsx|ts|tsx)$/, "")
}

const isWithin = (sourcePath: string, directory: string): boolean =>
  sourcePath === directory || sourcePath.startsWith(`${directory}/`)

const reasonForImport = (sourcePath: string, importPath: string): string | undefined => {
  const normalizedSource = sourcePath.replaceAll("\\", "/").replace(/\.(?:js|jsx|ts|tsx)$/, "")
  const target = normalizedTarget(normalizedSource, importPath)
  const isClient = isWithin(normalizedSource, "src/client")
  const isApi = isWithin(normalizedSource, "src/api")
  const isDomain = isWithin(normalizedSource, "src/domain")
  const isServer = isWithin(normalizedSource, "src/server")

  if (isPrototypeImport(importPath)) return "production code cannot import prototype runtime"
  if (importPath === NON_LITERAL_DYNAMIC_IMPORT) return "production dynamic imports must use a literal module path"
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
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports: Array<string> = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      imports.push(
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : NON_LITERAL_DYNAMIC_IMPORT
      )
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      imports.push(
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : NON_LITERAL_DYNAMIC_IMPORT
      )
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

/** Return every package-boundary violation found in one production source file. */
export const inspectSourceBoundaries = (sourcePath: string, source: string): ReadonlyArray<SourceBoundaryViolation> =>
  (() => {
    const normalizedSource = sourcePath.replaceAll("\\", "/").replace(/\.(?:js|jsx|ts|tsx)$/, "")
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
