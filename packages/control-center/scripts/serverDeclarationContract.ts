import * as ts from "typescript"

/** Emitted declaration barrels that make up the public server export chain. */
export interface ServerDeclarationContractSources {
  readonly authIndex: string
  readonly backupArchive: string
  readonly backupIndex: string
  readonly backupManifest: string
  readonly persistenceIndex: string
  readonly serverIndex: string
}

const containsIdentifier = (source: string, identifier: string): boolean =>
  new RegExp(`\\b${identifier}\\b`, "u").test(source)

const exportsEveryValueFrom = (source: string, moduleName: string): boolean =>
  new RegExp(`\\bexport\\s*\\*\\s*from\\s*["']\\./${moduleName}\\.js["']`, "u").test(source)

const declarationName = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined => {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true

const parameterTypeForExportedFunction = (
  sourceFile: ts.SourceFile,
  functionName: string
): ts.TypeNode | undefined => {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) && hasExportModifier(statement) &&
      declarationName(statement.name) === functionName
    ) {
      return statement.parameters[0]?.type
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declarationName(declaration.name) !== functionName || declaration.type === undefined) continue
      if (ts.isFunctionTypeNode(declaration.type)) return declaration.type.parameters[0]?.type
    }
  }
  return undefined
}

type NamedTypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration

const namedTypeDeclarations = (sourceFile: ts.SourceFile): ReadonlyMap<string, NamedTypeDeclaration> => {
  const declarations = new Map<string, NamedTypeDeclaration>()
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement)
    }
  }
  return declarations
}

const typeContainsProperty = (
  typeNode: ts.TypeNode,
  propertyName: string,
  declarations: ReadonlyMap<string, NamedTypeDeclaration>,
  visited: ReadonlySet<string>
): boolean => {
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeContainsProperty(typeNode.type, propertyName, declarations, visited)
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((member) => typeContainsProperty(member, propertyName, declarations, visited))
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.some((member) =>
      ts.isPropertySignature(member) && declarationName(member.name) === propertyName
    )
  }
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return false

  const typeName = typeNode.typeName.text
  if (visited.has(typeName)) return false
  const declaration = declarations.get(typeName)
  if (declaration === undefined) return false
  const nextVisited = new Set(visited).add(typeName)
  if (ts.isTypeAliasDeclaration(declaration)) {
    return typeContainsProperty(declaration.type, propertyName, declarations, nextVisited)
  }
  if (
    declaration.members.some((member) =>
      ts.isPropertySignature(member) && declarationName(member.name) === propertyName
    )
  ) return true
  return declaration.heritageClauses?.some((clause) =>
    clause.types.some(({ expression }) =>
      ts.isIdentifier(expression) && typeContainsProperty(
        ts.factory.createTypeReferenceNode(expression.text),
        propertyName,
        declarations,
        nextVisited
      )
    )
  ) === true
}

const exportedFunctionParameterContainsProperty = (
  source: string,
  functionName: string,
  propertyName: string
): boolean => {
  const sourceFile = ts.createSourceFile(
    "BackupArchive.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const parameterType = parameterTypeForExportedFunction(sourceFile, functionName)
  return parameterType !== undefined && typeContainsProperty(
    parameterType,
    propertyName,
    namedTypeDeclarations(sourceFile),
    new Set()
  )
}

/** Return internal database-layer factories exposed by the public server declaration chain. */
export const inspectServerDeclarationContract = (
  sources: ServerDeclarationContractSources
): ReadonlyArray<string> => {
  const violations: Array<string> = []

  if (
    containsIdentifier(sources.authIndex, "authLayerFromDatabase") ||
    exportsEveryValueFrom(sources.authIndex, "Auth") ||
    containsIdentifier(sources.serverIndex, "authLayerFromDatabase")
  ) {
    violations.push("public server declarations expose authLayerFromDatabase")
  }

  if (
    containsIdentifier(sources.persistenceIndex, "persistenceLayerFromDatabase") ||
    exportsEveryValueFrom(sources.persistenceIndex, "Persistence") ||
    containsIdentifier(sources.serverIndex, "persistenceLayerFromDatabase")
  ) {
    violations.push("public server declarations expose persistenceLayerFromDatabase")
  }

  if (
    exportedFunctionParameterContainsProperty(
      sources.backupArchive,
      "createVerifiedBackup",
      "databaseSourceFile"
    )
  ) {
    violations.push("public createVerifiedBackup accepts databaseSourceFile")
  }

  const backupSources = [
    sources.backupArchive,
    sources.backupIndex,
    sources.backupManifest,
    sources.persistenceIndex,
    sources.serverIndex
  ]
  const exposesRestoreResult = backupSources.some((source) => containsIdentifier(source, "RestoredBackup"))
  const exposesRestoreOperation = backupSources.some((source) => containsIdentifier(source, "restoreBackup"))
  if (exposesRestoreResult !== exposesRestoreOperation) {
    violations.push("public server declarations must expose restoreBackup and RestoredBackup together")
  }

  return violations
}
