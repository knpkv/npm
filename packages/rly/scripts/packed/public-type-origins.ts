import * as Path from "node:path"
import * as TypeScript from "typescript"

export interface PublicTypeOriginViolation {
  readonly exportName: string
  readonly sourceFile: string
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/")

const packageSourceMarker = (packageName: string): string => `/node_modules/${packageName}/`

const symbolDeclarations = (symbol: TypeScript.Symbol): ReadonlyArray<TypeScript.Declaration> =>
  symbol.declarations ?? []

const forbiddenOrigin = (
  symbol: TypeScript.Symbol,
  forbiddenPackages: ReadonlyArray<string>
): string | undefined =>
  symbolDeclarations(symbol)
    .map((declaration) => normalizePath(declaration.getSourceFile().fileName))
    .find((fileName) => forbiddenPackages.some((packageName) => fileName.includes(packageSourceMarker(packageName))))

const resolveAlias = (checker: TypeScript.TypeChecker, symbol: TypeScript.Symbol): TypeScript.Symbol =>
  (symbol.flags & TypeScript.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)

const declarationRoot = (entryFileName: string): string => {
  const normalized = normalizePath(entryFileName)
  const declarationMarker = "/dist/dts/"
  const markerIndex = normalized.indexOf(declarationMarker)
  return markerIndex === -1 ? normalizePath(Path.dirname(normalized)) : normalized.slice(0, markerIndex)
}

/** Find package exports whose declaration syntax reaches a forbidden implementation dependency. */
export const findForbiddenPublicTypeOrigins = (
  program: TypeScript.Program,
  entryFileName: string,
  forbiddenPackages: ReadonlyArray<string>
): ReadonlyArray<PublicTypeOriginViolation> => {
  const checker = program.getTypeChecker()
  const entry = program.getSourceFile(entryFileName)
  if (entry === undefined) throw new Error(`Declaration entry is not part of the TypeScript program: ${entryFileName}`)
  const moduleSymbol = checker.getSymbolAtLocation(entry)
  if (moduleSymbol === undefined) throw new Error(`Declaration entry is not an external module: ${entryFileName}`)

  const ownedRoot = `${declarationRoot(entryFileName)}/`
  const inspectExport = (exported: TypeScript.Symbol): string | undefined => {
    const visited = new Set<TypeScript.Symbol>()

    const visitSymbol = (candidate: TypeScript.Symbol): string | undefined => {
      const symbol = resolveAlias(checker, candidate)
      if (visited.has(symbol)) return undefined
      visited.add(symbol)

      const directOrigin = forbiddenOrigin(symbol, forbiddenPackages)
      if (directOrigin !== undefined) return directOrigin

      for (const declaration of symbolDeclarations(symbol)) {
        const sourceFile = normalizePath(declaration.getSourceFile().fileName)
        if (!sourceFile.startsWith(ownedRoot)) continue
        const origin = visitNode(declaration)
        if (origin !== undefined) return origin
      }
      return undefined
    }

    const visitNode = (node: TypeScript.Node): string | undefined => {
      const referenced = checker.getSymbolAtLocation(node)
      if (referenced !== undefined) {
        const origin = visitSymbol(referenced)
        if (origin !== undefined) return origin
      }
      let found: string | undefined
      node.forEachChild((child) => {
        if (found === undefined) found = visitNode(child)
      })
      return found
    }

    return visitSymbol(exported)
  }

  const violations: Array<PublicTypeOriginViolation> = []
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const sourceFile = inspectExport(exported)
    if (sourceFile !== undefined) violations.push({ exportName: exported.name, sourceFile })
  }
  return violations.sort((left, right) => left.exportName.localeCompare(right.exportName))
}
