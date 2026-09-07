import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { URL } from "node:url"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as TypeScript from "typescript"
import { parse } from "yaml"

const releaseTypes = new Set(["major", "minor", "patch"])
const releasePrecedence = new Map([
  ["patch", 0],
  ["minor", 1],
  ["major", 2]
])
const publicManifestFields = ["bin", "browser", "exports", "files", "main", "module", "types", "typesVersions"]
const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"]
const releaseManifestFields = [...publicManifestFields, ...runtimeDependencyFields]

const mergeReleaseType = (current, incoming) =>
  current === undefined || releasePrecedence.get(incoming) > releasePrecedence.get(current) ? incoming : current

const sourceFileFor = (source, filePath) =>
  TypeScript.createSourceFile(
    filePath,
    source,
    TypeScript.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? TypeScript.ScriptKind.TSX : TypeScript.ScriptKind.TS
  )

const hasExportModifier = (node) =>
  node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ExportKeyword) === true

const hasDefaultModifier = (node) =>
  node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.DefaultKeyword) === true

const hasNonPublicModifier = (node) =>
  node.modifiers?.some(
    ({ kind }) => kind === TypeScript.SyntaxKind.PrivateKeyword || kind === TypeScript.SyntaxKind.ProtectedKeyword
  ) === true

const canonicalPrintSourceFile = TypeScript.createSourceFile(
  "/__herdr_changeset_canonical__.ts",
  "",
  TypeScript.ScriptTarget.Latest,
  true,
  TypeScript.ScriptKind.TS
)
const canonicalPrinter = TypeScript.createPrinter()
const normalizeTypeText = (typeNode) => {
  const sourceFile = typeNode.getSourceFile?.()
  const text =
    sourceFile === undefined
      ? canonicalPrinter.printNode(TypeScript.EmitHint.Unspecified, typeNode, canonicalPrintSourceFile)
      : typeNode.getText(sourceFile)
  return text.replace(/\s+/gu, " ").trim()
}

class ChangesetCoverageError extends Data.TaggedError("ChangesetCoverageError") {
  get message() {
    return this.reason
  }
}

const hasReadonlyModifier = (node) =>
  node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ReadonlyKeyword) === true

const hasStaticModifier = (node) =>
  node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.StaticKeyword) === true

const isParameterProperty = (parameter) =>
  parameter.modifiers?.some(
    ({ kind }) =>
      kind === TypeScript.SyntaxKind.PublicKeyword ||
      kind === TypeScript.SyntaxKind.PrivateKeyword ||
      kind === TypeScript.SyntaxKind.ProtectedKeyword ||
      kind === TypeScript.SyntaxKind.ReadonlyKeyword
  ) === true

const sourceAnalysisCache = new WeakMap()

const isLexicalScopeNode = (node) => TypeScript.isBlock(node) || TypeScript.isModuleBlock(node)

const defaultCompilerOptions = {
  allowJs: false,
  exactOptionalPropertyTypes: true,
  jsx: TypeScript.JsxEmit.Preserve,
  module: TypeScript.ModuleKind.CommonJS,
  moduleResolution: TypeScript.ModuleResolutionKind.NodeJs,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  strict: true,
  target: TypeScript.ScriptTarget.Latest
}

const configDiagnosticsText = (diagnostics) =>
  diagnostics.map(({ messageText }) => TypeScript.flattenDiagnosticMessageText(messageText, " ")).join("; ")

const compilerOptionsFromConfig = (configPath, configText, configFiles = new Map()) => {
  const config = TypeScript.parseConfigFileTextToJson(configPath, configText)
  if (config.error !== undefined) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: invalid compiler configuration: ${configDiagnosticsText([config.error])}`
    })
  }
  const normalizedConfigFiles = new Map(
    [...configFiles].map(([fileName, content]) => [fileName.replaceAll("\\", "/"), content])
  )
  const configHost = {
    ...TypeScript.sys,
    fileExists: (fileName) =>
      normalizedConfigFiles.has(fileName.replaceAll("\\", "/")) || TypeScript.sys.fileExists(fileName),
    readFile: (fileName) =>
      normalizedConfigFiles.get(fileName.replaceAll("\\", "/")) ?? TypeScript.sys.readFile(fileName)
  }
  const parsed = TypeScript.parseJsonConfigFileContent(
    config.config,
    configHost,
    TypeScript.getDirectoryPath(configPath),
    undefined,
    configPath
  )
  if (parsed.errors.length > 0) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: invalid compiler configuration: ${configDiagnosticsText(parsed.errors)}`
    })
  }
  return {
    ...defaultCompilerOptions,
    ...parsed.options,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true
  }
}

const normalizeRepositoryPath = (filePath) => {
  const segments = []
  for (const segment of filePath.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return (filePath.startsWith("/") ? "/" : "") + segments.join("/")
}

const localCompilerConfigPath = (configPath, referencePath) => {
  if (!referencePath.startsWith(".")) return undefined
  const directory = configPath.slice(0, configPath.lastIndexOf("/"))
  const resolved = normalizeRepositoryPath(`${directory}/${referencePath}`)
  return /\.(?:json|jsonc)$/u.test(resolved) ? resolved : `${resolved}/tsconfig.json`
}

const compilerConfigurationReferences = (configPath, configText) => {
  const config = TypeScript.parseConfigFileTextToJson(configPath, configText)
  if (config.error !== undefined) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: invalid compiler configuration: ${configDiagnosticsText([config.error])}`
    })
  }
  const references = config.config.references
  const extendsPath = config.config.extends
  const paths = []
  if (extendsPath !== undefined) {
    const extendsPaths = Array.isArray(extendsPath) ? extendsPath : [extendsPath]
    if (extendsPaths.some((value) => !Predicate.isString(value))) {
      throw new ChangesetCoverageError({
        reason: `${configPath}: compiler configuration extends must contain only strings`
      })
    }
    for (const extendsEntry of extendsPaths) {
      const localPath = localCompilerConfigPath(configPath, extendsEntry)
      if (localPath !== undefined) paths.push(localPath)
    }
  }
  if (references !== undefined) {
    if (!Array.isArray(references)) {
      throw new ChangesetCoverageError({ reason: `${configPath}: compiler configuration references must be an array` })
    }
    for (const reference of references) {
      if (!Predicate.isObjectOrArray(reference) || Array.isArray(reference) || !Predicate.isString(reference.path)) {
        throw new ChangesetCoverageError({ reason: `${configPath}: compiler configuration reference path is invalid` })
      }
      const localPath = localCompilerConfigPath(configPath, reference.path)
      if (localPath === undefined) {
        throw new ChangesetCoverageError({ reason: `${configPath}: compiler configuration reference must be local` })
      }
      paths.push(localPath)
    }
  }
  return paths
}

const collectCompilerConfigurationFiles = Effect.fn("ChangesetCoverage.collectCompilerConfigurationFiles")(
  function* (rootPath, rootText, readConfigText) {
    const files = new Map([[rootPath, rootText]])
    const visiting = new Set()
    const visit = function* (configPath) {
      if (visiting.has(configPath)) {
        return yield* fail(`${configPath}: cyclic compiler configuration reference`)
      }
      if (files.has(configPath) && configPath !== rootPath) return
      const configText = files.get(configPath) ?? (yield* readConfigText(configPath))
      files.set(configPath, configText)
      visiting.add(configPath)
      for (const referencePath of compilerConfigurationReferences(configPath, configText)) {
        yield* visit(referencePath)
      }
      visiting.delete(configPath)
    }
    visiting.add(rootPath)
    for (const referencePath of compilerConfigurationReferences(rootPath, rootText)) {
      yield* visit(referencePath)
    }
    visiting.delete(rootPath)
    return files
  }
)

const configFileNames = (configPath, configText, configFiles) => {
  const config = TypeScript.parseConfigFileTextToJson(configPath, configText)
  if (config.error !== undefined) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: invalid compiler configuration: ${configDiagnosticsText([config.error])}`
    })
  }
  const normalizedConfigFiles = new Map(
    [...configFiles].map(([fileName, content]) => [fileName.replaceAll("\\", "/"), content])
  )
  const configHost = {
    ...TypeScript.sys,
    fileExists: (fileName) =>
      normalizedConfigFiles.has(fileName.replaceAll("\\", "/")) || TypeScript.sys.fileExists(fileName),
    readFile: (fileName) =>
      normalizedConfigFiles.get(fileName.replaceAll("\\", "/")) ?? TypeScript.sys.readFile(fileName)
  }
  const parsed = TypeScript.parseJsonConfigFileContent(
    config.config,
    configHost,
    TypeScript.getDirectoryPath(configPath),
    undefined,
    configPath
  )
  if (parsed.errors.length > 0) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: invalid compiler configuration: ${configDiagnosticsText(parsed.errors)}`
    })
  }
  return parsed.fileNames.map((fileName) => fileName.replaceAll("\\", "/"))
}

const packageCompilerOptions = (
  sources,
  repositoryRoot,
  { configText, configFiles = new Map(), configurationPaths = [], entryPoints = [], entryPointSourcePath } = {}
) => {
  if (repositoryRoot === undefined) return defaultCompilerOptions
  const sourcePath = [...sources.keys()][0]
  if (sourcePath === undefined) return defaultCompilerOptions
  const packageMatch = /^(packages\/[^/]+)\/src\//u.exec(sourcePath)
  if (packageMatch === null) {
    throw new ChangesetCoverageError({
      reason: `${sourcePath}: cannot resolve package tsconfig for inferred return analysis`
    })
  }
  const configPath = `${repositoryRoot}/${packageMatch[1]}/tsconfig.json`
  const text = configText ?? TypeScript.sys.readFile(configPath)
  if (text === undefined) {
    throw new ChangesetCoverageError({
      reason: `${configPath}: compiler configuration is unavailable`
    })
  }
  const normalizedConfigFiles = new Map(
    [...configFiles].map(([fileName, content]) => [fileName.replaceAll("\\", "/"), content])
  )
  const candidatePaths = [configPath, ...configurationPaths, ...normalizedConfigFiles.keys()].filter(
    (candidate, index, candidates) =>
      candidate.startsWith(`${repositoryRoot}/${packageMatch[1]}/`) && candidates.indexOf(candidate) === index
  )
  const sourcePathsForConfig = [
    ...(entryPointSourcePath === undefined
      ? new Set([...entryPoints.map(({ sourcePath: entrySourcePath }) => entrySourcePath), ...sources.keys()])
      : [entryPointSourcePath])
  ].map((source) => `${repositoryRoot}/${source}`)
  const configScore = (candidate) => {
    const candidateText =
      candidate === configPath ? text : (normalizedConfigFiles.get(candidate) ?? TypeScript.sys.readFile(candidate))
    if (candidateText === undefined) return -1
    const fileNames = configFileNames(candidate, candidateText, normalizedConfigFiles)
    return sourcePathsForConfig.filter((source) => fileNames.includes(source)).length
  }
  const selectedConfigPath = candidatePaths.find((candidate) => configScore(candidate) > 0) ?? configPath
  const selectedConfigText = selectedConfigPath === configPath ? text : normalizedConfigFiles.get(selectedConfigPath)
  if (selectedConfigText === undefined) {
    throw new ChangesetCoverageError({
      reason: `${selectedConfigPath}: compiler configuration is unavailable`
    })
  }
  return compilerOptionsFromConfig(selectedConfigPath, selectedConfigText, normalizedConfigFiles)
}

const analyzeSources = (
  sources,
  recursiveDeclarations = new Set(),
  { compilerOptions = defaultCompilerOptions, programFactory = TypeScript.createProgram } = {}
) => {
  const cachedByFactory = sourceAnalysisCache.get(sources)
  const cachedByOptions = cachedByFactory?.get(programFactory)
  const cached = cachedByOptions?.get(compilerOptions)
  if (cached !== undefined) {
    return cached.recursiveDeclarations === recursiveDeclarations ? cached : { ...cached, recursiveDeclarations }
  }
  const modules = new Map()
  for (const [filePath, source] of sources) {
    const sourceFile = sourceFileFor(source, filePath)
    const local = new Set()
    const aliases = new Map()
    const stars = []
    const imports = new Map()
    const declarations = new Map()
    const declarationGroups = new Map()
    const declarationsByScope = new Map()
    const declarationGroupsByScope = new Map()
    const exportedTypes = new Set()
    const runtimeDeclarations = new Set()
    let defaultExportName
    const scopeByNode = new WeakMap()
    const scopeParents = new Map()
    const moduleScope = filePath + "\u0000module"
    const visit = (node, parentScope) => {
      const scope = isLexicalScopeNode(node) ? filePath + "\u0000scope:" + node.pos + ":" + node.end : parentScope
      scopeByNode.set(node, scope)
      if (scope !== parentScope) scopeParents.set(scope, parentScope)
      if (
        TypeScript.isTypeAliasDeclaration(node) ||
        TypeScript.isInterfaceDeclaration(node) ||
        TypeScript.isClassDeclaration(node) ||
        TypeScript.isEnumDeclaration(node)
      ) {
        const declarationName = node.name?.text
        if (declarationName !== undefined) {
          const scopedDeclarations = declarationsByScope.get(scope) ?? new Map()
          if (!scopedDeclarations.has(declarationName)) scopedDeclarations.set(declarationName, node)
          declarationsByScope.set(scope, scopedDeclarations)
          const scopedGroups = declarationGroupsByScope.get(scope) ?? new Map()
          const group = scopedGroups.get(declarationName) ?? []
          group.push(node)
          scopedGroups.set(declarationName, group)
          declarationGroupsByScope.set(scope, scopedGroups)
          if (scope === moduleScope) {
            if (!declarations.has(declarationName)) declarations.set(declarationName, node)
            declarationGroups.set(declarationName, group)
          }
        }
        if (scope === moduleScope && hasExportModifier(node) && declarationName !== undefined) {
          exportedTypes.add(declarationName)
        }
      }
      if ((TypeScript.isVariableStatement(node) || TypeScript.isFunctionDeclaration(node)) && scope === moduleScope) {
        if (TypeScript.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            if (TypeScript.isIdentifier(declaration.name)) {
              runtimeDeclarations.add(declaration.name.text)
              if (hasExportModifier(node)) local.add(declaration.name.text)
            }
          }
        } else if (node.name !== undefined) {
          runtimeDeclarations.add(node.name.text)
          if (hasExportModifier(node) && !hasDefaultModifier(node)) local.add(node.name.text)
          if (hasExportModifier(node) && hasDefaultModifier(node)) defaultExportName = node.name.text
        } else if (hasExportModifier(node) && hasDefaultModifier(node)) {
          defaultExportName = "default"
        }
      }
      if (TypeScript.isImportDeclaration(node) && TypeScript.isStringLiteral(node.moduleSpecifier)) {
        const sourceSpecifier = node.moduleSpecifier.text
        const clause = node.importClause
        if (clause?.name !== undefined) {
          imports.set(clause.name.text, { importedName: "default", sourceSpecifier })
        }
        const namedBindings = clause?.namedBindings
        if (namedBindings !== undefined && TypeScript.isNamespaceImport(namedBindings)) {
          imports.set(namedBindings.name.text, { importedName: "*", sourceSpecifier })
        } else if (namedBindings !== undefined && TypeScript.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            imports.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              sourceSpecifier
            })
          }
        }
      }
      if (TypeScript.isExportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier
        const sourceSpecifier =
          moduleSpecifier !== undefined && TypeScript.isStringLiteral(moduleSpecifier)
            ? moduleSpecifier.text
            : undefined
        const clause = node.exportClause
        if (clause === undefined) {
          if (sourceSpecifier !== undefined) stars.push(sourceSpecifier)
        } else if (TypeScript.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (node.isTypeOnly || element.isTypeOnly) continue
            aliases.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              sourceSpecifier
            })
          }
        }
      }
      if (TypeScript.isExportAssignment(node) && !node.isExportEquals) defaultExportName = "default"
      TypeScript.forEachChild(node, (child) => visit(child, scope))
    }
    visit(sourceFile, moduleScope)
    modules.set(filePath, {
      aliases,
      declarationGroups,
      declarationGroupsByScope,
      declarations,
      declarationsByScope,
      defaultExportName,
      exportedTypes,
      imports,
      local,
      moduleScope,
      runtimeDeclarations,
      scopeByNode,
      scopeParents,
      sourceFile,
      stars
    })
  }
  const sourceFilesByPath = new Map([...modules].map(([filePath, module]) => [filePath, module.sourceFile]))
  const compilerHost = TypeScript.createCompilerHost(compilerOptions)
  const sourceFileForCompilerPath = (fileName) => {
    const normalized = fileName.replaceAll("\\\\", "/")
    const direct = sourceFilesByPath.get(normalized)
    if (direct !== undefined) return direct
    return [...sourceFilesByPath.entries()].find(([sourcePath]) => normalized.endsWith(`/${sourcePath}`))?.[1]
  }
  const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost)
  compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    sourceFileForCompilerPath(fileName) ??
    defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  const defaultFileExists = compilerHost.fileExists.bind(compilerHost)
  compilerHost.fileExists = (fileName) =>
    sourceFileForCompilerPath(fileName) !== undefined || defaultFileExists(fileName)
  const defaultReadFile = compilerHost.readFile.bind(compilerHost)
  compilerHost.readFile = (fileName) => {
    const sourceFile = sourceFileForCompilerPath(fileName)
    return sourceFile === undefined ? defaultReadFile(fileName) : sourceFile.getFullText()
  }
  let checker
  const getChecker = () => {
    if (checker === undefined) {
      checker = programFactory([...sources.keys()], compilerOptions, compilerHost).getTypeChecker()
    }
    return checker
  }
  const releaseChecker = () => {
    checker = undefined
  }
  const analysis = { getChecker, modules, recursiveDeclarations, releaseChecker, sources }
  const analyses = cachedByFactory ?? new Map()
  const analysesByOptions = cachedByOptions ?? new Map()
  analysesByOptions.set(compilerOptions, analysis)
  analyses.set(programFactory, analysesByOptions)
  sourceAnalysisCache.set(sources, analyses)
  return analysis
}

const declarationsInScope = (module, name, referenceNode) => {
  let scope =
    referenceNode === undefined ? module.moduleScope : (module.scopeByNode.get(referenceNode) ?? module.moduleScope)
  while (scope !== undefined) {
    const declaration = module.declarationsByScope.get(scope)?.get(name)
    if (declaration !== undefined) return declaration
    scope = module.scopeParents.get(scope)
  }
  return undefined
}

const resolveTypeDeclaration = (analysis, filePath, name, seen = new Set(), referenceNode) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return undefined
  const local = declarationsInScope(module, name, referenceNode)
  if (local !== undefined) return { filePath, node: local }
  const key = `${filePath}\u0000${name}`
  if (seen.has(key)) return undefined
  const nextSeen = new Set(seen).add(key)
  const imported = module.imports.get(name)
  if (imported === undefined || imported.importedName === "*") return undefined
  const target = resolveLocalModule(filePath, imported.sourceSpecifier, analysis.sources)
  return target === undefined ? undefined : resolveExportedType(analysis, target, imported.importedName, nextSeen)
}

const resolveExportedType = (analysis, filePath, name, seen = new Set()) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return undefined
  const local = module.declarations.get(name)
  if (local !== undefined && module.exportedTypes.has(name)) return { filePath, node: local }
  const key = `${filePath}\u0000${name}`
  if (seen.has(key)) return undefined
  const nextSeen = new Set(seen).add(key)
  const alias = module.aliases.get(name)
  if (alias === undefined) return undefined
  if (alias.sourceSpecifier !== undefined) {
    const target = resolveLocalModule(filePath, alias.sourceSpecifier, analysis.sources)
    return target === undefined ? undefined : resolveExportedType(analysis, target, alias.importedName, nextSeen)
  }
  const imported = module.imports.get(alias.importedName)
  if (imported !== undefined && imported.importedName !== "*") {
    const target = resolveLocalModule(filePath, imported.sourceSpecifier, analysis.sources)
    return target === undefined ? undefined : resolveExportedType(analysis, target, imported.importedName, nextSeen)
  }
  const localAlias = module.declarations.get(alias.importedName)
  return localAlias === undefined ? undefined : { filePath, node: localAlias }
}

const resolvedDeclarationNodes = (analysis, declaration) => {
  const module = analysis.modules.get(declaration.filePath)
  if (module === undefined) return [declaration.node]
  const scope = module.scopeByNode.get(declaration.node) ?? module.moduleScope
  return module.declarationGroupsByScope.get(scope)?.get(declaration.node.name.text) ?? [declaration.node]
}

const instanceHeritageTypes = (declarationNode) =>
  (declarationNode.heritageClauses ?? [])
    .filter(
      (clause) =>
        !TypeScript.isClassDeclaration(declarationNode) || clause.token === TypeScript.SyntaxKind.ExtendsKeyword
    )
    .flatMap((clause) => clause.types)

const canonicalTypeMaxDepth = 128

const typeSubstitutionTag = Symbol("type substitution")

const makeTypeSubstitution = (typeNode, substitutions, filePath) => ({
  [typeSubstitutionTag]: true,
  filePath,
  substitutions,
  typeNode
})

const isTypeSubstitution = (value) => value?.[typeSubstitutionTag] === true

const rawTypeSubstitutionBindings = new WeakMap()

const typeSubstitutionBinding = (value, substitutions, filePath) => {
  if (isTypeSubstitution(value)) return value
  const bindings = rawTypeSubstitutionBindings.get(substitutions) ?? new Map()
  const existing = bindings.get(value)
  if (existing !== undefined) return existing
  const binding = makeTypeSubstitution(value, substitutions, filePath)
  bindings.set(value, binding)
  rawTypeSubstitutionBindings.set(substitutions, bindings)
  return binding
}

const declarationSubstitutions = (declaration, typeArguments, substitutions, filePath) => {
  const nextSubstitutions = new Map(substitutions)
  for (const [index, parameter] of (declaration.node.typeParameters ?? []).entries()) {
    const explicitArgument = typeArguments[index]
    const argument = explicitArgument ?? parameter.default
    if (argument === undefined) continue
    const argumentSubstitutions = explicitArgument === undefined ? nextSubstitutions : substitutions
    const argumentFilePath = explicitArgument === undefined ? declaration.filePath : filePath
    nextSubstitutions.set(parameter.name.text, makeTypeSubstitution(argument, argumentSubstitutions, argumentFilePath))
  }
  return nextSubstitutions
}

const declarationEffectiveTypeArguments = (declaration, typeArguments) => {
  const typeParameters = declaration.typeParameters ?? []
  if (typeParameters.length === 0 || typeArguments.length === 0) return []
  const parameterIndexes = new Map(typeParameters.map((parameter, index) => [parameter.name.text, index]))
  const usedIndexes = new Set()
  const inferParameterNames = (node) => {
    const names = new Set()
    const collect = (child) => {
      if (TypeScript.isInferTypeNode(child)) names.add(child.typeParameter.name.text)
      TypeScript.forEachChild(child, collect)
    }
    collect(node)
    return names
  }
  const visit = (node, shadowed, targetIndexes = usedIndexes) => {
    if (TypeScript.isTypeReferenceNode(node) && TypeScript.isIdentifier(node.typeName)) {
      const index = parameterIndexes.get(node.typeName.text)
      if (index !== undefined && !shadowed.has(node.typeName.text)) targetIndexes.add(index)
    }
    if (TypeScript.isMappedTypeNode(node)) {
      TypeScript.forEachChild(node.typeParameter, (child) => visit(child, shadowed, targetIndexes))
      const mappedShadowed = new Set([...shadowed, node.typeParameter.name.text])
      if (node.nameType !== undefined) visit(node.nameType, mappedShadowed, targetIndexes)
      if (node.type !== undefined) visit(node.type, mappedShadowed, targetIndexes)
      return
    }
    if (TypeScript.isConditionalTypeNode(node)) {
      visit(node.checkType, shadowed, targetIndexes)
      visit(node.extendsType, shadowed, targetIndexes)
      const conditionalShadowed = new Set([...shadowed, ...inferParameterNames(node.extendsType)])
      visit(node.trueType, conditionalShadowed, targetIndexes)
      visit(node.falseType, shadowed, targetIndexes)
      return
    }
    const nestedTypeParameters =
      TypeScript.isFunctionTypeNode(node) ||
      TypeScript.isMethodSignature(node) ||
      TypeScript.isCallSignatureDeclaration(node) ||
      TypeScript.isConstructSignatureDeclaration(node) ||
      TypeScript.isConstructorTypeNode(node)
        ? (node.typeParameters ?? [])
        : []
    const nextShadowed =
      nestedTypeParameters.length === 0
        ? shadowed
        : new Set([...shadowed, ...nestedTypeParameters.map((parameter) => parameter.name.text)])
    TypeScript.forEachChild(node, (child) => visit(child, nextShadowed, targetIndexes))
  }
  const body = TypeScript.isTypeAliasDeclaration(declaration) ? declaration.type : declaration
  visit(body, new Set())
  const defaultDependencies = typeParameters.map((parameter) => {
    const dependencies = new Set()
    if (parameter.default !== undefined) visit(parameter.default, new Set(), dependencies)
    return dependencies
  })
  const effectiveIndexes = new Set(usedIndexes)
  let changed = true
  while (changed) {
    changed = false
    for (const index of effectiveIndexes) {
      if (typeArguments[index] !== undefined) continue
      for (const dependency of defaultDependencies[index] ?? []) {
        if (!effectiveIndexes.has(dependency)) {
          effectiveIndexes.add(dependency)
          changed = true
        }
      }
    }
  }
  return typeArguments.filter((_, index) => effectiveIndexes.has(index))
}

const nextCanonicalTypeContext = (context, substitutionPath = context.substitutionPath) => ({
  ...context,
  depth: context.depth + 1,
  substitutionPath
})

const unchangedDeclarationKeys = (previousSources, currentSources) => {
  const previous = analyzeSources(previousSources)
  const current = analyzeSources(currentSources)
  const unchanged = new Set()
  for (const [filePath, currentModule] of current.modules) {
    const previousModule = previous.modules.get(filePath)
    if (previousModule === undefined) continue
    for (const [name, currentDeclaration] of currentModule.declarations) {
      const previousDeclaration = previousModule.declarations.get(name)
      if (previousDeclaration !== undefined && previousDeclaration.getText() === currentDeclaration.getText()) {
        unchanged.add(`${filePath}\u0000${name}`)
      }
    }
  }
  return unchanged
}

const failCanonicalType = (filePath, typeNode, reason) => {
  throw new ChangesetCoverageError({
    reason: `${filePath}: ${reason} while canonicalizing ${normalizeTypeText(typeNode)}`
  })
}

const resolveNamespaceQualifiedTypeDeclaration = (analysis, filePath, typeName, seen, typeNode) => {
  if (!TypeScript.isQualifiedName(typeName)) return undefined
  let root = typeName
  while (TypeScript.isQualifiedName(root)) root = root.left
  if (!TypeScript.isIdentifier(root)) return undefined
  const imported = analysis.modules.get(filePath)?.imports.get(root.text)
  if (imported?.importedName !== "*") return undefined
  if (!TypeScript.isIdentifier(typeName.left) || !TypeScript.isIdentifier(typeName.right)) {
    failCanonicalType(filePath, typeNode, "unsupported nested namespace-qualified type")
  }
  if (!imported.sourceSpecifier.startsWith(".")) return undefined
  const target = resolveLocalModule(filePath, imported.sourceSpecifier, analysis.sources)
  if (target === undefined) failCanonicalType(filePath, typeNode, "unresolved namespace-qualified type")
  const declaration = resolveExportedType(analysis, target, typeName.right.text, seen)
  if (declaration === undefined) failCanonicalType(filePath, typeNode, "unresolved namespace-qualified type")
  return declaration
}

const hasNominalClassIdentity = (declaration, analysis, seen = new Set()) => {
  if (!TypeScript.isClassDeclaration(declaration.node)) return false
  const key = `${declaration.filePath}\u0000${declaration.node.name.text}`
  if (seen.has(key)) return false
  const nextSeen = new Set(seen).add(key)
  if (
    declaration.node.members.some(
      (member) =>
        hasNonPublicModifier(member) || (member.name !== undefined && TypeScript.isPrivateIdentifier(member.name))
    )
  ) {
    return true
  }
  return instanceHeritageTypes(declaration.node).some((heritageType) => {
    const base =
      TypeScript.isExpressionWithTypeArguments(heritageType) && TypeScript.isIdentifier(heritageType.expression)
        ? resolveTypeDeclaration(analysis, declaration.filePath, heritageType.expression.text, new Set(), heritageType)
        : TypeScript.isExpressionWithTypeArguments(heritageType) && TypeScript.isQualifiedName(heritageType.expression)
          ? resolveNamespaceQualifiedTypeDeclaration(
              analysis,
              declaration.filePath,
              heritageType.expression,
              new Set(),
              heritageType
            )
          : undefined
    return base === undefined ? false : hasNominalClassIdentity(base, analysis, nextSeen)
  })
}

const resolvedTypeDeclarationNodes = (analysis, declaration) => {
  if (TypeScript.isTypeLiteralNode(declaration.node)) return [declaration.node]
  return resolvedDeclarationNodes(analysis, declaration)
}

const conditionalPrimitiveCategory = (typeNode, substitutions) => {
  if (TypeScript.isParenthesizedTypeNode(typeNode)) return conditionalPrimitiveCategory(typeNode.type, substitutions)
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined && !Predicate.isString(substituted)) {
      return conditionalPrimitiveCategory(substituted.typeNode, substituted.substitutions)
    }
  }
  if (TypeScript.isLiteralTypeNode(typeNode)) {
    if (TypeScript.isStringLiteral(typeNode.literal) || TypeScript.isNoSubstitutionTemplateLiteral(typeNode.literal)) {
      return "string"
    }
    if (TypeScript.isNumericLiteral(typeNode.literal)) return "number"
    if (typeNode.literal.kind === TypeScript.SyntaxKind.BigIntLiteral) return "bigint"
    if (
      typeNode.literal.kind === TypeScript.SyntaxKind.TrueKeyword ||
      typeNode.literal.kind === TypeScript.SyntaxKind.FalseKeyword
    ) {
      return "boolean"
    }
  }
  const categories = new Map([
    [TypeScript.SyntaxKind.StringKeyword, "string"],
    [TypeScript.SyntaxKind.NumberKeyword, "number"],
    [TypeScript.SyntaxKind.BigIntKeyword, "bigint"],
    [TypeScript.SyntaxKind.BooleanKeyword, "boolean"],
    [TypeScript.SyntaxKind.ESSymbolKeyword, "symbol"],
    [TypeScript.SyntaxKind.AnyKeyword, "any"],
    [TypeScript.SyntaxKind.UnknownKeyword, "unknown"],
    [TypeScript.SyntaxKind.NeverKeyword, "never"]
  ])
  return categories.get(typeNode.kind)
}

const conditionalPrimitiveLiteral = (typeNode, substitutions) => {
  if (TypeScript.isParenthesizedTypeNode(typeNode)) return conditionalPrimitiveLiteral(typeNode.type, substitutions)
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined && !Predicate.isString(substituted)) {
      return conditionalPrimitiveLiteral(substituted.typeNode, substituted.substitutions)
    }
  }
  return TypeScript.isLiteralTypeNode(typeNode) ? normalizeTypeText(typeNode) : undefined
}

const inferSubstitutions = (typeNode, substitutions) => {
  const result = new Map(substitutions)
  const names = []
  const visit = (node) => {
    if (TypeScript.isInferTypeNode(node) && !names.includes(node.typeParameter.name.text)) {
      names.push(node.typeParameter.name.text)
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(typeNode)
  const nextToken = [...substitutions.values()]
    .filter(Predicate.isString)
    .map((value) => /^infer#(\d+)$/u.exec(value)?.[1])
    .filter((value) => value !== undefined)
    .map(Number)
    .reduce((maximum, value) => Math.max(maximum, value + 1), 0)
  for (const [index, name] of names.entries()) result.set(name, `infer#${nextToken + index}`)
  return result
}

const canonicalConditionalTypeText = (typeNode, analysis, filePath, substitutions, seen, context) => {
  const extendsSubstitutions = inferSubstitutions(typeNode.extendsType, substitutions)
  const checkCategory = conditionalPrimitiveCategory(typeNode.checkType, substitutions)
  const extendsCategory = conditionalPrimitiveCategory(typeNode.extendsType, substitutions)
  const checkLiteral = conditionalPrimitiveLiteral(typeNode.checkType, substitutions)
  const extendsLiteral = conditionalPrimitiveLiteral(typeNode.extendsType, extendsSubstitutions)
  const literalsMatch =
    checkLiteral === undefined && extendsLiteral === undefined
      ? true
      : checkLiteral === undefined
        ? false
        : extendsLiteral === undefined || checkLiteral === extendsLiteral
  const branch =
    checkCategory !== undefined && extendsCategory !== undefined
      ? checkCategory === "never"
        ? undefined
        : (checkCategory === extendsCategory && literalsMatch) || extendsCategory === "any"
          ? typeNode.trueType
          : checkCategory === "any" || checkCategory === "unknown"
            ? undefined
            : typeNode.falseType
      : undefined
  if (branch !== undefined) {
    return canonicalTypeText(
      branch,
      analysis,
      filePath,
      branch === typeNode.trueType ? extendsSubstitutions : substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
  }
  return `conditional(${canonicalTypeText(
    typeNode.checkType,
    analysis,
    filePath,
    substitutions,
    seen,
    nextCanonicalTypeContext(context)
  )} extends ${canonicalTypeText(
    typeNode.extendsType,
    analysis,
    filePath,
    extendsSubstitutions,
    seen,
    nextCanonicalTypeContext(context)
  )}?${canonicalTypeText(
    typeNode.trueType,
    analysis,
    filePath,
    extendsSubstitutions,
    seen,
    nextCanonicalTypeContext(context)
  )}:${canonicalTypeText(
    typeNode.falseType,
    analysis,
    filePath,
    substitutions,
    seen,
    nextCanonicalTypeContext(context)
  )})`
}

const canonicalTupleElementText = (element, analysis, filePath, substitutions, seen, context) => {
  const namedMember = TypeScript.isNamedTupleMember(element)
  const elementText = canonicalTypeText(
    namedMember ? element.type : element,
    analysis,
    filePath,
    substitutions,
    seen,
    nextCanonicalTypeContext(context)
  )
  if (!namedMember) return elementText
  if (element.dotDotDotToken !== undefined) return `...${elementText}`
  return element.questionToken === undefined ? elementText : `${elementText}?`
}

const canonicalClassValueText = (declaration, analysis, filePath, substitutions, seen, context) => {
  const staticMembers = new Map()
  const constructors = []
  const typeMembersMemo = context.typeMembersMemo ?? new Map()
  const visitedClasses = new Set()
  const valueNominalOrigins = new Set()
  const abstractClass =
    declaration.node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.AbstractKeyword) === true
  const visitClass = (classDeclaration, classFilePath, classSubstitutions, classSeen, isRoot) => {
    const classKey = `${classFilePath}\u0000${classDeclaration.name.text}`
    if (visitedClasses.has(classKey)) return
    visitedClasses.add(classKey)
    const declarationNodes = resolvedDeclarationNodes(analysis, { filePath: classFilePath, node: classDeclaration })
    for (const declarationNode of declarationNodes) {
      if (!TypeScript.isClassDeclaration(declarationNode)) continue
      for (const heritageType of instanceHeritageTypes(declarationNode)) {
        const base =
          TypeScript.isExpressionWithTypeArguments(heritageType) && TypeScript.isIdentifier(heritageType.expression)
            ? resolveTypeDeclaration(analysis, classFilePath, heritageType.expression.text, classSeen, heritageType)
            : TypeScript.isExpressionWithTypeArguments(heritageType) &&
                TypeScript.isQualifiedName(heritageType.expression)
              ? resolveNamespaceQualifiedTypeDeclaration(
                  analysis,
                  classFilePath,
                  heritageType.expression,
                  classSeen,
                  heritageType
                )
              : undefined
        if (base === undefined || !TypeScript.isClassDeclaration(base.node)) continue
        const baseKey = `${base.filePath}\u0000${base.node.name.text}`
        if (classSeen.has(baseKey)) failCanonicalType(classFilePath, heritageType, "recursive class heritage")
        visitClass(
          base.node,
          base.filePath,
          declarationSubstitutions(base, heritageType.typeArguments ?? [], classSubstitutions, classFilePath),
          new Set(classSeen).add(baseKey),
          false
        )
      }
    }
    const ownStaticMembers = new Map()
    const overloadedStaticMethodNames = new Set(
      declarationNodes.flatMap((declarationNode) =>
        declarationNode.members
          .filter(
            (member) => TypeScript.isMethodDeclaration(member) && member.body === undefined && hasStaticModifier(member)
          )
          .map((member) => canonicalPropertyKeyText(member.name))
          .filter((name) => name !== undefined)
      )
    )
    const hasConstructorOverloads =
      isRoot &&
      declarationNodes.some((declarationNode) =>
        declarationNode.members.some(
          (member) => TypeScript.isConstructorDeclaration(member) && member.body === undefined
        )
      ) &&
      declarationNodes.some((declarationNode) =>
        declarationNode.members.some(
          (member) => TypeScript.isConstructorDeclaration(member) && member.body !== undefined
        )
      )
    const addOwnMember = (name, descriptor) => {
      const existing = ownStaticMembers.get(name)
      ownStaticMembers.set(name, existing === undefined ? descriptor : mergeMemberContract(existing, descriptor))
    }
    for (const declarationNode of declarationNodes) {
      if (!TypeScript.isClassDeclaration(declarationNode)) continue
      for (const member of declarationNode.members) {
        if (
          hasStaticModifier(member) &&
          (hasNonPublicModifier(member) || (member.name !== undefined && TypeScript.isPrivateIdentifier(member.name)))
        ) {
          valueNominalOrigins.add(`${classFilePath}#${classDeclaration.name.text}`)
        }
        if (TypeScript.isConstructorDeclaration(member)) {
          if (!isRoot) continue
          if (hasNonPublicModifier(member)) {
            const visibility =
              member.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.PrivateKeyword) === true
                ? "private"
                : "protected"
            constructors.push(`construct:${visibility}`)
            continue
          }
          if (hasConstructorOverloads && member.body !== undefined) continue
          constructors.push(
            `construct(${member.parameters
              .map((parameter) =>
                parameterDescriptor(parameter, analysis, classFilePath, classSubstitutions, classSeen, context)
              )
              .join(",")})`
          )
          continue
        }
        if (hasNonPublicModifier(member)) continue
        if (!hasStaticModifier(member)) continue
        const name = member.name === undefined ? undefined : canonicalPropertyKeyText(member.name)
        if (name === undefined) continue
        if (
          TypeScript.isMethodDeclaration(member) &&
          member.body !== undefined &&
          overloadedStaticMethodNames.has(name)
        ) {
          continue
        }
        if (
          !TypeScript.isPropertyDeclaration(member) &&
          !TypeScript.isMethodDeclaration(member) &&
          !TypeScript.isGetAccessorDeclaration(member) &&
          !TypeScript.isSetAccessorDeclaration(member)
        ) {
          continue
        }
        addOwnMember(
          name,
          memberDescriptor(
            member,
            analysis,
            classFilePath,
            classSubstitutions,
            classSeen,
            { ...context, typeMembersMemo },
            typeMembersMemo,
            context.substitutionPath
          ).descriptor
        )
      }
    }
    for (const [name, descriptor] of ownStaticMembers) staticMembers.set(name, descriptor)
  }
  visitClass(declaration.node, declaration.filePath, substitutions, seen, true)
  if (constructors.length === 0) constructors.push("construct()")
  const identity = [
    abstractClass ? "abstract" : undefined,
    valueNominalOrigins.size === 0 ? undefined : `nominal(${[...valueNominalOrigins].toSorted().join("|")})`
  ]
    .filter((value) => value !== undefined)
    .join(";")
  return `value(${identity}${identity.length === 0 ? "" : ";"}${[
    ...[...staticMembers].map(([name, descriptor]) => `${name}:${descriptor}`),
    ...constructors.map((descriptor, index) => `construct#${index}:${descriptor}`)
  ]
    .toSorted()
    .join(";")})`
}

const canonicalEnumText = (declaration, analysis, filePath) => {
  const members = []
  for (const declarationNode of resolvedDeclarationNodes(analysis, declaration)) {
    for (const [index, member] of declarationNode.members.entries()) {
      const name = canonicalPropertyKeyText(member.name)
      if (name === undefined) failCanonicalType(filePath, member.name, "unsupported enum member name")
      const value = analysis.getChecker().getConstantValue(member)
      const valueText =
        Predicate.isString(value) || Predicate.isNumber(value)
          ? `${Predicate.isString(value) ? "string" : "number"}:${JSON.stringify(value)}`
          : member.initializer === undefined
            ? `auto:${index}`
            : failCanonicalType(filePath, member.initializer, "unsupported enum initializer")
      members.push(`${name}:${valueText}`)
    }
  }
  return `enum(${declaration.filePath}|${declaration.node.name.text}|${members.toSorted().join(";")})`
}

const canonicalTypeMembersTextCache = new WeakMap()
const canonicalStructuralDigest = (text) => createHash("sha256").update(text).digest("hex")
const canonicalTypeMembersText = (typeNode, analysis, filePath, substitutions, seen, context) => {
  const result = typeMembers(
    typeNode,
    analysis,
    filePath,
    seen,
    substitutions,
    context.typeMembersMemo ?? new Map(),
    context.substitutionPath,
    context.genericScope ?? "",
    context.recursiveDeclarations
  )
  const cached = canonicalTypeMembersTextCache.get(result)
  if (cached !== undefined) return cached
  const text = `object#${canonicalStructuralDigest(
    [...result.canonicalMembers]
      .map(([name, descriptor]) => `${name}:${descriptor}`)
      .toSorted()
      .join(";")
  )}`
  canonicalTypeMembersTextCache.set(result, text)
  return text
}

function canonicalResolvedTypeDeclaration(typeNode, declaration, analysis, filePath, substitutions, seen, context) {
  const declarationName = declaration.node.name.text
  const key = declaration.filePath + "\u0000" + declarationName
  if (seen.has(key)) {
    if (context.recursiveDeclarations.has(key)) return normalizeTypeText(typeNode)
    failCanonicalType(filePath, typeNode, "recursive type declaration")
  }
  const nextSeen = new Set(seen).add(key)
  const nextSubstitutions = declarationSubstitutions(declaration, typeNode.typeArguments ?? [], substitutions, filePath)
  if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
    if (TypeScript.isTypeLiteralNode(declaration.node.type)) {
      return canonicalTypeMembersText(typeNode, analysis, filePath, substitutions, seen, {
        ...nextCanonicalTypeContext(context),
        typeMembersMemo: context.typeMembersMemo
      })
    }
    return canonicalTypeText(
      declaration.node.type,
      analysis,
      declaration.filePath,
      nextSubstitutions,
      nextSeen,
      nextCanonicalTypeContext(context)
    )
  }
  if (TypeScript.isInterfaceDeclaration(declaration.node) || TypeScript.isClassDeclaration(declaration.node)) {
    return canonicalResolvedDeclarationText(
      declaration,
      analysis,
      filePath,
      nextSubstitutions,
      nextSeen,
      nextCanonicalTypeContext(context)
    )
  }
  if (TypeScript.isEnumDeclaration(declaration.node)) return canonicalEnumText(declaration, analysis, filePath)
  return normalizeTypeText(typeNode)
}

const canonicalTypeText = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set(), recursiveDeclarations: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isQualifiedName(typeNode.typeName)) {
    const declaration = resolveNamespaceQualifiedTypeDeclaration(analysis, filePath, typeNode.typeName, seen, typeNode)
    if (declaration !== undefined) {
      return canonicalResolvedTypeDeclaration(typeNode, declaration, analysis, filePath, substitutions, seen, context)
    }
    if (typeNode.typeArguments !== undefined) {
      const wrapper = normalizeTypeText(typeNode.typeName)
      const argumentsText = typeNode.typeArguments
        .map((argument) =>
          canonicalTypeText(argument, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
        )
        .join(",")
      return wrapper + "<" + argumentsText + ">"
    }
  }
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return canonicalTypeText(typeNode.type, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
  }
  if (TypeScript.isImportTypeNode(typeNode) && !typeNode.isTypeOf) {
    const argument = typeNode.argument
    if (!TypeScript.isLiteralTypeNode(argument) || !TypeScript.isStringLiteral(argument.literal)) {
      failCanonicalType(filePath, typeNode, "unsupported import type module specifier")
    }
    const sourceSpecifier = argument.literal.text
    const target = resolveLocalModule(filePath, sourceSpecifier, analysis.sources)
    if (target !== undefined) {
      const qualifier = typeNode.qualifier
      if (qualifier === undefined || !TypeScript.isIdentifier(qualifier)) {
        failCanonicalType(filePath, typeNode, "unsupported local import type qualifier")
      }
      const declaration = resolveExportedType(analysis, target, qualifier.text)
      if (declaration === undefined) failCanonicalType(filePath, typeNode, "unresolved local import type")
      return canonicalResolvedTypeDeclaration(typeNode, declaration, analysis, filePath, substitutions, seen, context)
    }
  }
  if (TypeScript.isTypeQueryNode(typeNode)) {
    const declaration = TypeScript.isIdentifier(typeNode.exprName)
      ? resolveTypeDeclaration(analysis, filePath, typeNode.exprName.text, seen, typeNode)
      : resolveNamespaceQualifiedTypeDeclaration(analysis, filePath, typeNode.exprName, seen, typeNode)
    if (declaration !== undefined && TypeScript.isClassDeclaration(declaration.node)) {
      const declarationKey = `${declaration.filePath}\u0000${declaration.node.name.text}`
      if (seen.has(declarationKey)) failCanonicalType(filePath, typeNode, "recursive type declaration")
      return canonicalClassValueText(
        declaration,
        analysis,
        filePath,
        substitutions,
        new Set(seen).add(declarationKey),
        nextCanonicalTypeContext(context)
      )
    }
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text
    const substituted = substitutions.get(typeName)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return substituted
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) {
        failCanonicalType(filePath, typeNode, "recursive type substitution")
      }
      const substitutionPath = new Set(context.substitutionPath).add(binding)
      return canonicalTypeText(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, substitutionPath)
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeName, seen, context.referenceNode ?? typeNode)
    if (declaration !== undefined) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) {
        if (context.recursiveDeclarations.has(key)) return normalizeTypeText(typeNode)
        failCanonicalType(filePath, typeNode, "recursive type declaration")
      }
      const nextSeen = new Set(seen).add(key)
      const nextSubstitutions = declarationSubstitutions(
        declaration,
        typeNode.typeArguments ?? [],
        substitutions,
        filePath
      )
      if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
        if (TypeScript.isTypeLiteralNode(declaration.node.type)) {
          return canonicalTypeMembersText(typeNode, analysis, filePath, substitutions, seen, {
            ...nextCanonicalTypeContext(context),
            typeMembersMemo: context.typeMembersMemo
          })
        }
        return canonicalTypeText(
          declaration.node.type,
          analysis,
          declaration.filePath,
          nextSubstitutions,
          nextSeen,
          nextCanonicalTypeContext(context)
        )
      }
      if (TypeScript.isInterfaceDeclaration(declaration.node) || TypeScript.isClassDeclaration(declaration.node)) {
        return canonicalResolvedDeclarationText(
          declaration,
          analysis,
          filePath,
          nextSubstitutions,
          nextSeen,
          nextCanonicalTypeContext(context)
        )
      }
      if (TypeScript.isEnumDeclaration(declaration.node)) {
        return canonicalEnumText(declaration, analysis, filePath)
      }
    }
    if (typeNode.typeArguments !== undefined) {
      const wrapper = normalizeTypeText(typeNode.typeName)
      const argumentsText = typeNode.typeArguments
        .map((argument) =>
          canonicalTypeText(argument, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
        )
        .join(",")
      return `${wrapper}<${argumentsText}>`
    }
  }
  if (TypeScript.isArrayTypeNode(typeNode)) {
    return `${canonicalTypeText(
      typeNode.elementType,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )}[]`
  }
  if (TypeScript.isTupleTypeNode(typeNode)) {
    return `[${typeNode.elements
      .map((element) => canonicalTupleElementText(element, analysis, filePath, substitutions, seen, context))
      .join(",")}]`
  }
  if (TypeScript.isTypeOperatorNode(typeNode)) {
    const operator =
      typeNode.operator === TypeScript.SyntaxKind.KeyOfKeyword
        ? "keyof"
        : typeNode.operator === TypeScript.SyntaxKind.ReadonlyKeyword
          ? "readonly"
          : typeNode.operator === TypeScript.SyntaxKind.UniqueKeyword
            ? "unique"
            : undefined
    if (operator !== undefined) {
      const operand =
        operator === "keyof"
          ? canonicalKeyofOperandText(
              typeNode.type,
              analysis,
              filePath,
              substitutions,
              seen,
              nextCanonicalTypeContext(context)
            )
          : canonicalTypeText(typeNode.type, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
      return operator === "keyof" && operand === "primitive(any)"
        ? "union(number|string|symbol)"
        : `${operator} ${operand}`
    }
  }
  if (TypeScript.isOptionalTypeNode(typeNode)) {
    return `${canonicalTypeText(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )}?`
  }
  if (TypeScript.isRestTypeNode(typeNode)) {
    return `...${canonicalTypeText(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )}`
  }
  if (TypeScript.isInferTypeNode(typeNode)) {
    const binder = substitutions.get(typeNode.typeParameter.name.text)
    return `infer ${Predicate.isString(binder) ? binder : typeNode.typeParameter.name.text}`
  }
  if (TypeScript.isIndexedAccessTypeNode(typeNode)) {
    const resolved = canonicalIndexedAccessTypeText(typeNode, analysis, filePath, substitutions, seen, context)
    if (resolved !== undefined) return resolved
    return `indexed(${canonicalTypeText(
      typeNode.objectType,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )}[${canonicalTypeText(
      typeNode.indexType,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )}])`
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && typeNode.typeArguments !== undefined) {
    const wrapper = normalizeTypeText(typeNode.typeName)
    const argumentsText = typeNode.typeArguments
      .map((argument) =>
        canonicalTypeText(argument, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
      )
      .join(",")
    return `${wrapper}<${argumentsText}>`
  }
  if (TypeScript.isUnionTypeNode(typeNode)) {
    return `union(${typeNode.types
      .map((member) =>
        canonicalTypeText(member, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
      )
      .toSorted()
      .join("|")})`
  }
  if (TypeScript.isIntersectionTypeNode(typeNode)) {
    return `intersection(${typeNode.types
      .map((member) =>
        canonicalTypeText(member, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
      )
      .toSorted()
      .join("&")})`
  }
  if (TypeScript.isConditionalTypeNode(typeNode)) {
    return canonicalConditionalTypeText(typeNode, analysis, filePath, substitutions, seen, context)
  }
  if (TypeScript.isTemplateLiteralTypeNode(typeNode)) {
    return `template(${JSON.stringify(typeNode.head.text)}${typeNode.templateSpans
      .map(
        (span) =>
          `${canonicalTypeText(
            span.type,
            analysis,
            filePath,
            substitutions,
            seen,
            nextCanonicalTypeContext(context)
          )}${JSON.stringify(span.literal.text)}`
      )
      .join("|")})`
  }
  if (TypeScript.isFunctionTypeNode(typeNode)) {
    const generic = genericDescriptor(typeNode.typeParameters, analysis, filePath, substitutions, context)
    const genericContext = { ...context, genericScope: generic.childGenericScope }
    return `function<${generic.descriptor}>(${typeNode.parameters
      .map((parameter) =>
        parameterDescriptor(
          parameter,
          analysis,
          filePath,
          generic.substitutions,
          seen,
          nextCanonicalTypeContext(genericContext)
        )
      )
      .join(",")}):${
      typeNode.type === undefined
        ? "unknown"
        : canonicalTypeText(
            typeNode.type,
            analysis,
            filePath,
            generic.substitutions,
            seen,
            nextCanonicalTypeContext(genericContext)
          )
    }`
  }
  if (TypeScript.isTypeLiteralNode(typeNode)) {
    if (typeNode.getSourceFile?.() === undefined) return normalizeTypeText(typeNode)
    return canonicalTypeMembersText(typeNode, analysis, filePath, substitutions, seen, context)
  }
  return normalizeTypeText(typeNode)
}

const canonicalLiteralKeyText = (node) => {
  if (TypeScript.isLiteralTypeNode(node)) return canonicalLiteralKeyText(node.literal)
  if (TypeScript.isStringLiteral(node) || TypeScript.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(["string", node.text])
  }
  if (TypeScript.isNumericLiteral(node)) return JSON.stringify(["number", node.text])
  return undefined
}

const canonicalNumericIndexText = (node) => {
  const literal = TypeScript.isLiteralTypeNode(node) ? node.literal : node
  if (TypeScript.isNumericLiteral(literal)) return literal.text
  if (TypeScript.isStringLiteral(literal) || TypeScript.isNoSubstitutionTemplateLiteral(literal)) {
    return /^(?:0|[1-9]\d*)$/u.test(literal.text) ? literal.text : undefined
  }
  return undefined
}

const canonicalIndexedAccessDomains = (node) => {
  const numericIndexText = canonicalNumericIndexText(node)
  if (numericIndexText !== undefined) return ["number", "string"]
  const literal = TypeScript.isLiteralTypeNode(node) ? node.literal : node
  return TypeScript.isStringLiteral(literal) || TypeScript.isNoSubstitutionTemplateLiteral(literal) ? ["string"] : []
}

const canonicalPrimitiveKeyofCategory = (node) => {
  const kind = TypeScript.isLiteralTypeNode(node) ? node.literal.kind : node.kind
  if (kind === TypeScript.SyntaxKind.StringLiteral || kind === TypeScript.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return "string"
  }
  if (kind === TypeScript.SyntaxKind.NumericLiteral) return "number"
  if (kind === TypeScript.SyntaxKind.BigIntLiteral) return "bigint"
  if (kind === TypeScript.SyntaxKind.TrueKeyword || kind === TypeScript.SyntaxKind.FalseKeyword) return "boolean"
  if (kind === TypeScript.SyntaxKind.StringKeyword) return "string"
  if (kind === TypeScript.SyntaxKind.NumberKeyword) return "number"
  if (kind === TypeScript.SyntaxKind.BigIntKeyword) return "bigint"
  if (kind === TypeScript.SyntaxKind.BooleanKeyword) return "boolean"
  if (kind === TypeScript.SyntaxKind.ESSymbolKeyword) return "symbol"
  if (kind === TypeScript.SyntaxKind.ObjectKeyword) return "object"
  if (kind === TypeScript.SyntaxKind.AnyKeyword) return "any"
  if (kind === TypeScript.SyntaxKind.UnknownKeyword) return "unknown"
  if (kind === TypeScript.SyntaxKind.NeverKeyword) return "any"
  if (
    kind === TypeScript.SyntaxKind.UnknownKeyword ||
    kind === TypeScript.SyntaxKind.ObjectKeyword ||
    kind === TypeScript.SyntaxKind.NullKeyword ||
    kind === TypeScript.SyntaxKind.UndefinedKeyword ||
    kind === TypeScript.SyntaxKind.VoidKeyword
  ) {
    return "unknown"
  }
  return undefined
}

const canonicalPrimitiveKeyofOperandText = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return canonicalPrimitiveKeyofOperandText(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
  }
  const category = canonicalPrimitiveKeyofCategory(typeNode)
  if (category !== undefined) return `primitive(${category})`
  if (TypeScript.isUnionTypeNode(typeNode)) {
    const categories = typeNode.types.map((member) =>
      canonicalPrimitiveKeyofOperandText(
        member,
        analysis,
        filePath,
        substitutions,
        seen,
        nextCanonicalTypeContext(context)
      )
    )
    if (categories.some((member) => member === undefined)) return undefined
    const uniqueCategories = [...new Set(categories)]
    return uniqueCategories.length === 1
      ? uniqueCategories[0]
      : `primitive-union(${uniqueCategories.toSorted().join("|")})`
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return undefined
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) failCanonicalType(filePath, typeNode, "recursive type substitution")
      return canonicalPrimitiveKeyofOperandText(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, new Set(context.substitutionPath).add(binding))
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen, typeNode)
    if (declaration !== undefined && TypeScript.isTypeAliasDeclaration(declaration.node)) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) {
        if (context.recursiveDeclarations?.has(key) === true) return normalizeTypeText(typeNode)
        failCanonicalType(filePath, typeNode, "recursive type declaration")
      }
      const nextSubstitutions = declarationSubstitutions(
        declaration,
        typeNode.typeArguments ?? [],
        substitutions,
        filePath
      )
      return canonicalPrimitiveKeyofOperandText(
        declaration.node.type,
        analysis,
        declaration.filePath,
        nextSubstitutions,
        new Set(seen).add(key),
        nextCanonicalTypeContext(context)
      )
    }
  }
  return undefined
}

const canonicalPropertyKeyText = (name) => {
  if (TypeScript.isIdentifier(name)) return JSON.stringify(["string", name.text])
  if (TypeScript.isStringLiteral(name)) return JSON.stringify(["string", name.text])
  if (TypeScript.isNumericLiteral(name)) return JSON.stringify(["number", name.text])
  if (TypeScript.isComputedPropertyName(name)) return canonicalLiteralKeyText(name.expression)
  return undefined
}

const canonicalIndexSignatureDomain = (typeNode, analysis, filePath, substitutions, seen, context) => {
  const node = TypeScript.isParenthesizedTypeNode(typeNode) ? typeNode.type : typeNode
  if (node.kind === TypeScript.SyntaxKind.StringKeyword) return "string"
  if (node.kind === TypeScript.SyntaxKind.NumberKeyword) return "number"
  if (TypeScript.isUnionTypeNode(node)) {
    const domains = node.types.map((member) =>
      canonicalIndexSignatureDomain(member, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
    )
    if (domains.every((domain) => domain === "string" || domain === "number")) {
      return domains.includes("string") ? "string" : "number"
    }
    if (domains.every((domain) => domain !== undefined)) return `union(${domains.toSorted().join("|")})`
  }
  if (TypeScript.isTypeReferenceNode(node) && TypeScript.isIdentifier(node.typeName)) {
    const substituted = substitutions.get(node.typeName.text)
    if (substituted !== undefined && !Predicate.isString(substituted)) {
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) {
        failCanonicalType(filePath, node, "recursive type substitution")
      }
      return canonicalIndexSignatureDomain(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, new Set(context.substitutionPath).add(binding))
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, node.typeName.text, seen, node)
    if (declaration !== undefined && TypeScript.isTypeAliasDeclaration(declaration.node)) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) failCanonicalType(filePath, node, "recursive type declaration")
      return canonicalIndexSignatureDomain(
        declaration.node.type,
        analysis,
        declaration.filePath,
        declarationSubstitutions(declaration, node.typeArguments ?? [], substitutions, filePath),
        new Set(seen).add(key),
        nextCanonicalTypeContext(context)
      )
    }
  }
  return undefined
}

const canonicalIndexSignatureKey = (member, analysis, filePath, substitutions, seen, context) => {
  const parameterType = member.parameters[0]?.type
  if (parameterType === undefined) failCanonicalType(filePath, member, "unsupported index signature")
  const domain = canonicalIndexSignatureDomain(
    parameterType,
    analysis,
    filePath,
    substitutions,
    seen,
    nextCanonicalTypeContext(context)
  )
  return (
    "index:" +
    (domain ??
      canonicalTypeText(parameterType, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context)))
  )
}

function canonicalIndexedAccessTypeText(typeNode, analysis, filePath, substitutions, seen, context) {
  const indexKey = canonicalLiteralKeyText(typeNode.indexType)
  const numericIndexText = canonicalNumericIndexText(typeNode.indexType)
  const canonicalTarget = (target, targetFilePath, targetSubstitutions, targetSeen, targetContext) => {
    if (TypeScript.isParenthesizedTypeNode(target)) {
      return canonicalTarget(
        target.type,
        targetFilePath,
        targetSubstitutions,
        targetSeen,
        nextCanonicalTypeContext(targetContext)
      )
    }
    if (TypeScript.isUnionTypeNode(target)) {
      const members = target.types.map((member) =>
        canonicalTarget(
          member,
          targetFilePath,
          targetSubstitutions,
          targetSeen,
          nextCanonicalTypeContext(targetContext)
        )
      )
      return members.some((member) => member === undefined) ? undefined : `union(${members.toSorted().join("|")})`
    }
    if (TypeScript.isIntersectionTypeNode(target)) {
      const members = target.types
        .map((member) =>
          canonicalTarget(
            member,
            targetFilePath,
            targetSubstitutions,
            targetSeen,
            nextCanonicalTypeContext(targetContext)
          )
        )
        .filter((member) => member !== undefined)
      const uniqueMembers = [...new Set(members)]
      return uniqueMembers.length === 0 ? undefined : uniqueMembers.reduce(mergeMemberContract)
    }
    if (TypeScript.isArrayTypeNode(target) && numericIndexText !== undefined) {
      return canonicalTypeText(
        target.elementType,
        analysis,
        targetFilePath,
        targetSubstitutions,
        targetSeen,
        nextCanonicalTypeContext(targetContext)
      )
    }
    if (TypeScript.isTypeReferenceNode(target) && TypeScript.isQualifiedName(target.typeName)) {
      const declaration = resolveNamespaceQualifiedTypeDeclaration(
        analysis,
        targetFilePath,
        target.typeName,
        targetSeen,
        target
      )
      if (declaration !== undefined) {
        const declarationKey = `${declaration.filePath}\u0000${declaration.node.name.text}`
        if (targetSeen.has(declarationKey)) failCanonicalType(targetFilePath, target, "recursive type declaration")
        const nextSubstitutions = declarationSubstitutions(
          declaration,
          target.typeArguments ?? [],
          targetSubstitutions,
          targetFilePath
        )
        return canonicalTarget(
          TypeScript.isTypeAliasDeclaration(declaration.node) ? declaration.node.type : declaration.node,
          declaration.filePath,
          nextSubstitutions,
          new Set(targetSeen).add(declarationKey),
          { ...nextCanonicalTypeContext(targetContext), referenceNode: undefined }
        )
      }
    }
    if (TypeScript.isExpressionWithTypeArguments(target) && TypeScript.isIdentifier(target.expression)) {
      const declaration = resolveTypeDeclaration(
        analysis,
        targetFilePath,
        target.expression.text,
        targetSeen,
        targetContext.referenceNode ?? target
      )
      if (declaration !== undefined) {
        const declarationKey = `${declaration.filePath}\u0000${declaration.node.name.text}`
        if (targetSeen.has(declarationKey)) failCanonicalType(targetFilePath, target, "recursive type declaration")
        const nextSubstitutions = declarationSubstitutions(
          declaration,
          target.typeArguments ?? [],
          targetSubstitutions,
          targetFilePath
        )
        return canonicalTarget(
          TypeScript.isTypeAliasDeclaration(declaration.node) ? declaration.node.type : declaration.node,
          declaration.filePath,
          nextSubstitutions,
          new Set(targetSeen).add(declarationKey),
          { ...nextCanonicalTypeContext(targetContext), referenceNode: undefined }
        )
      }
    }
    if (TypeScript.isTupleTypeNode(target)) {
      if (numericIndexText !== undefined) {
        const element = target.elements[Number(numericIndexText)]
        if (element !== undefined) {
          return canonicalTupleElementText(
            element,
            analysis,
            targetFilePath,
            targetSubstitutions,
            targetSeen,
            targetContext
          )
        }
      }
    }
    if (TypeScript.isTypeReferenceNode(target) && TypeScript.isIdentifier(target.typeName)) {
      const substituted = targetSubstitutions.get(target.typeName.text)
      if (substituted !== undefined && !Predicate.isString(substituted)) {
        const binding = typeSubstitutionBinding(substituted, targetSubstitutions, targetFilePath)
        if (targetContext.substitutionPath.has(binding)) {
          failCanonicalType(targetFilePath, target, "recursive type substitution")
        }
        return canonicalTarget(
          binding.typeNode,
          binding.filePath,
          binding.substitutions,
          targetSeen,
          nextCanonicalTypeContext(targetContext, new Set(targetContext.substitutionPath).add(binding))
        )
      }
      const declaration = resolveTypeDeclaration(
        analysis,
        targetFilePath,
        target.typeName.text,
        targetSeen,
        targetContext.referenceNode ?? target
      )
      if (declaration !== undefined) {
        const declarationKey = `${declaration.filePath}\u0000${declaration.node.name.text}`
        if (targetSeen.has(declarationKey)) failCanonicalType(targetFilePath, target, "recursive type declaration")
        const nextSeen = new Set(targetSeen).add(declarationKey)
        const nextSubstitutions = declarationSubstitutions(
          declaration,
          target.typeArguments ?? [],
          targetSubstitutions,
          targetFilePath
        )
        return canonicalTarget(
          TypeScript.isTypeAliasDeclaration(declaration.node) ? declaration.node.type : declaration.node,
          declaration.filePath,
          nextSubstitutions,
          nextSeen,
          { ...nextCanonicalTypeContext(targetContext), referenceNode: undefined }
        )
      }
    }
    if (
      TypeScript.isTypeLiteralNode(target) ||
      TypeScript.isInterfaceDeclaration(target) ||
      TypeScript.isClassDeclaration(target)
    ) {
      const declarationNodes = resolvedTypeDeclarationNodes(analysis, { filePath: targetFilePath, node: target })
      let inheritedSelected
      let localCallableSelected
      let localAccessorSelected
      let localAccessorHasGetter = false
      let localPropertySelected
      const localIndexSelected = new Map()
      const indexedAccessDomains = canonicalIndexedAccessDomains(typeNode.indexType)
      if (indexKey !== undefined) {
        for (const declarationNode of declarationNodes) {
          for (const heritageType of instanceHeritageTypes(declarationNode)) {
            const inherited = canonicalTarget(
              heritageType,
              targetFilePath,
              targetSubstitutions,
              targetSeen,
              nextCanonicalTypeContext(targetContext)
            )
            if (inherited !== undefined) {
              inheritedSelected =
                inheritedSelected === undefined ? inherited : mergeMemberContract(inheritedSelected, inherited)
            }
          }
          for (const member of declarationNode.members) {
            if (hasNonPublicModifier(member) || hasStaticModifier(member)) continue
            if (TypeScript.isIndexSignatureDeclaration(member)) {
              const domain = canonicalIndexSignatureDomain(
                member.parameters[0]?.type,
                analysis,
                targetFilePath,
                targetSubstitutions,
                targetSeen,
                nextCanonicalTypeContext(targetContext)
              )
              if (domain === undefined || !indexedAccessDomains.includes(domain) || member.type === undefined) continue
              const value = canonicalTypeText(
                member.type,
                analysis,
                targetFilePath,
                targetSubstitutions,
                targetSeen,
                nextCanonicalTypeContext(targetContext)
              )
              const existing = localIndexSelected.get(domain)
              localIndexSelected.set(domain, existing === undefined ? value : mergeMemberContract(existing, value))
              continue
            }
            if (
              (!TypeScript.isPropertySignature(member) &&
                !TypeScript.isPropertyDeclaration(member) &&
                !TypeScript.isMethodSignature(member) &&
                !TypeScript.isMethodDeclaration(member) &&
                !TypeScript.isGetAccessorDeclaration(member) &&
                !TypeScript.isSetAccessorDeclaration(member)) ||
              canonicalPropertyKeyText(member.name) !== indexKey
            ) {
              continue
            }
            if (TypeScript.isMethodSignature(member) || TypeScript.isMethodDeclaration(member)) {
              const descriptor = memberDescriptor(
                member,
                analysis,
                targetFilePath,
                targetSubstitutions,
                targetSeen,
                nextCanonicalTypeContext(targetContext),
                targetContext.typeMembersMemo ?? new Map(),
                targetContext.substitutionPath
              ).descriptor
              localCallableSelected =
                localCallableSelected === undefined
                  ? descriptor
                  : mergeMemberContract(localCallableSelected, descriptor)
              continue
            }
            if (TypeScript.isGetAccessorDeclaration(member) || TypeScript.isSetAccessorDeclaration(member)) {
              const accessorType = effectiveAccessorValueTypeNode(member, analysis)
              if (accessorType === undefined) failCanonicalType(targetFilePath, member, "unsupported indexed accessor")
              const value = canonicalTypeText(
                accessorType,
                analysis,
                targetFilePath,
                targetSubstitutions,
                targetSeen,
                nextCanonicalTypeContext(targetContext)
              )
              if (TypeScript.isGetAccessorDeclaration(member)) {
                localAccessorSelected =
                  localAccessorSelected === undefined ? value : mergeMemberContract(localAccessorSelected, value)
                localAccessorHasGetter = true
              } else if (!localAccessorHasGetter) {
                localAccessorSelected =
                  localAccessorSelected === undefined ? value : mergeMemberContract(localAccessorSelected, value)
              }
              continue
            }
            const memberType = effectiveMemberTypeNode(member, analysis)
            if (memberType === undefined) failCanonicalType(targetFilePath, member, "unsupported indexed member")
            const canonicalMemberType = canonicalTypeText(
              memberType,
              analysis,
              targetFilePath,
              targetSubstitutions,
              targetSeen,
              nextCanonicalTypeContext(targetContext)
            )
            const property =
              member.questionToken === undefined
                ? canonicalMemberType
                : `union(${[canonicalMemberType, "undefined"].toSorted().join("|")})`
            localPropertySelected =
              localPropertySelected === undefined ? property : mergeMemberContract(localPropertySelected, property)
          }
        }
      }
      if (localPropertySelected !== undefined) return localPropertySelected
      if (localAccessorSelected !== undefined) {
        return inheritedSelected === undefined || localAccessorHasGetter
          ? localAccessorSelected
          : mergeMemberContract(inheritedSelected, localAccessorSelected)
      }
      if (localCallableSelected !== undefined) {
        return inheritedSelected === undefined
          ? localCallableSelected
          : mergeMemberContract(inheritedSelected, localCallableSelected)
      }
      if (inheritedSelected !== undefined) return inheritedSelected
      return indexedAccessDomains.map((domain) => localIndexSelected.get(domain)).find((value) => value !== undefined)
    }
    return undefined
  }
  return canonicalTarget(typeNode.objectType, filePath, substitutions, seen, context)
}

const canonicalNeverKey = JSON.stringify(["never"])
const canonicalStringKey = JSON.stringify(["string"])
const canonicalNumberKey = JSON.stringify(["number"])
const canonicalSymbolKey = JSON.stringify(["symbol"])

const canonicalBuiltinArrayKeySourcePath = "/__herdr_changeset_array_keys__.ts"
const canonicalBuiltinArrayKeySource = TypeScript.createSourceFile(
  canonicalBuiltinArrayKeySourcePath,
  "type Mutable = keyof Array<string>\ntype Readonly = keyof ReadonlyArray<string>",
  TypeScript.ScriptTarget.Latest,
  true,
  TypeScript.ScriptKind.TS
)
const canonicalBuiltinArrayCompilerOptions = { noEmit: true, target: TypeScript.ScriptTarget.Latest }
const canonicalBuiltinArrayCompilerHost = TypeScript.createCompilerHost(canonicalBuiltinArrayCompilerOptions)
const canonicalBuiltinArrayGetSourceFile = canonicalBuiltinArrayCompilerHost.getSourceFile.bind(
  canonicalBuiltinArrayCompilerHost
)
canonicalBuiltinArrayCompilerHost.getSourceFile = (fileName, languageVersion) =>
  fileName === canonicalBuiltinArrayKeySourcePath
    ? canonicalBuiltinArrayKeySource
    : canonicalBuiltinArrayGetSourceFile(fileName, languageVersion)
const canonicalBuiltinArrayFileExists = canonicalBuiltinArrayCompilerHost.fileExists.bind(
  canonicalBuiltinArrayCompilerHost
)
canonicalBuiltinArrayCompilerHost.fileExists = (fileName) =>
  fileName === canonicalBuiltinArrayKeySourcePath || canonicalBuiltinArrayFileExists(fileName)
const canonicalBuiltinArrayReadFile = canonicalBuiltinArrayCompilerHost.readFile.bind(canonicalBuiltinArrayCompilerHost)
canonicalBuiltinArrayCompilerHost.readFile = (fileName) =>
  fileName === canonicalBuiltinArrayKeySourcePath
    ? canonicalBuiltinArrayKeySource.getFullText()
    : canonicalBuiltinArrayReadFile(fileName)
const canonicalBuiltinArrayProgram = TypeScript.createProgram(
  [canonicalBuiltinArrayKeySourcePath],
  canonicalBuiltinArrayCompilerOptions,
  canonicalBuiltinArrayCompilerHost
)
const canonicalBuiltinArrayChecker = canonicalBuiltinArrayProgram.getTypeChecker()
const canonicalBuiltinArrayKeySets = new Map()
for (const statement of canonicalBuiltinArrayKeySource.statements) {
  if (!TypeScript.isTypeAliasDeclaration(statement)) continue
  const type = canonicalBuiltinArrayChecker.getTypeFromTypeNode(statement.type)
  const members = type.types
  if (members === undefined) {
    throw new ChangesetCoverageError({
      reason: `unable to resolve built-in array keys for ${statement.name.text}`
    })
  }
  const keys = new Set([canonicalNumberKey])
  for (const member of members) {
    if ((member.flags & TypeScript.TypeFlags.StringLiteral) !== 0 && Predicate.isString(member.value)) {
      keys.add(JSON.stringify(["string", member.value]))
    }
  }
  canonicalBuiltinArrayKeySets.set(statement.name.text, keys)
}

const canonicalArrayKeySet = (kind, readonly) => {
  const arrayKeys = canonicalBuiltinArrayKeySets.get(readonly ? "Readonly" : "Mutable")
  if (arrayKeys === undefined) {
    throw new ChangesetCoverageError({
      reason: `unable to resolve built-in array keys for ${kind}`
    })
  }
  return new Set([JSON.stringify([kind, readonly ? "readonly" : "mutable"]), ...arrayKeys])
}

const canonicalKeyContains = (container, key) => {
  if (container === key) return true
  if (container === canonicalStringKey) return key.startsWith('["string",')
  if (container === canonicalNumberKey) return key.startsWith('["number",')
  if (container === canonicalSymbolKey) return key.startsWith('["symbol",')
  return false
}

const canonicalKeySetUnion = (left, right) => {
  const result = new Set()
  for (const key of [...left, ...right]) {
    if ([...result].some((existing) => canonicalKeyContains(existing, key))) continue
    for (const existing of result) {
      if (canonicalKeyContains(key, existing)) result.delete(existing)
    }
    result.add(key)
  }
  return result
}

const canonicalKeySetIntersection = (left, right) => {
  const result = new Set()
  for (const leftKey of left) {
    for (const rightKey of right) {
      if (canonicalKeyContains(leftKey, rightKey)) result.add(rightKey)
      else if (canonicalKeyContains(rightKey, leftKey)) result.add(leftKey)
    }
  }
  return result
}

const canonicalLiteralTypeValue = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return canonicalLiteralTypeValue(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
  }
  if (TypeScript.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal
    if (TypeScript.isStringLiteral(literal) || TypeScript.isNoSubstitutionTemplateLiteral(literal)) {
      return `string:${literal.text}`
    }
    if (TypeScript.isNumericLiteral(literal)) return `number:${literal.text}`
    if (literal.kind === TypeScript.SyntaxKind.BigIntLiteral) return `bigint:${literal.text}`
    if (literal.kind === TypeScript.SyntaxKind.TrueKeyword) return "boolean:true"
    if (literal.kind === TypeScript.SyntaxKind.FalseKeyword) return "boolean:false"
    return undefined
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text
    const substituted = substitutions.get(typeName)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return undefined
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) failCanonicalType(filePath, typeNode, "recursive type substitution")
      return canonicalLiteralTypeValue(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, new Set(context.substitutionPath).add(binding))
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeName, seen, typeNode)
    if (declaration !== undefined && TypeScript.isTypeAliasDeclaration(declaration.node)) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) {
        if (context.recursiveDeclarations?.has(key) === true) return undefined
        failCanonicalType(filePath, typeNode, "recursive type declaration")
      }
      const nextSubstitutions = declarationSubstitutions(
        declaration,
        typeNode.typeArguments ?? [],
        substitutions,
        filePath
      )
      return canonicalLiteralTypeValue(
        declaration.node.type,
        analysis,
        declaration.filePath,
        nextSubstitutions,
        new Set(seen).add(key),
        nextCanonicalTypeContext(context)
      )
    }
  }
  return undefined
}

const mergeCanonicalLiteralProperties = (target, source) => {
  let contradictory = false
  for (const [key, value] of source) {
    const previous = target.get(key)
    if (previous !== undefined && previous !== value) contradictory = true
    target.set(key, value)
  }
  return contradictory
}

const canonicalRequiredLiteralProperties = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  const node = TypeScript.isParenthesizedTypeNode(typeNode) ? typeNode.type : typeNode
  if (TypeScript.isIntersectionTypeNode(node)) {
    const properties = new Map()
    let contradictory = false
    for (const member of node.types) {
      const nested = canonicalRequiredLiteralProperties(
        member,
        analysis,
        filePath,
        substitutions,
        seen,
        nextCanonicalTypeContext(context)
      )
      if (nested === undefined) return undefined
      if (nested.contradictory) contradictory = true
      if (mergeCanonicalLiteralProperties(properties, nested.properties)) contradictory = true
    }
    return { properties, contradictory }
  }
  if (TypeScript.isTypeReferenceNode(node) && TypeScript.isIdentifier(node.typeName)) {
    const typeName = node.typeName.text
    const substituted = substitutions.get(typeName)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return undefined
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) failCanonicalType(filePath, node, "recursive type substitution")
      return canonicalRequiredLiteralProperties(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, new Set(context.substitutionPath).add(binding))
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeName, seen, node)
    if (declaration !== undefined) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) failCanonicalType(filePath, node, "recursive type declaration")
      const nextSubstitutions = declarationSubstitutions(declaration, node.typeArguments ?? [], substitutions, filePath)
      const declarationBody = TypeScript.isTypeAliasDeclaration(declaration.node)
        ? declaration.node.type
        : declaration.node
      return canonicalRequiredLiteralProperties(
        declarationBody,
        analysis,
        declaration.filePath,
        nextSubstitutions,
        new Set(seen).add(key),
        nextCanonicalTypeContext(context)
      )
    }
  }
  if (!TypeScript.isTypeLiteralNode(node) && !TypeScript.isInterfaceDeclaration(node)) return undefined
  const properties = new Map()
  let contradictory = false
  if (TypeScript.isInterfaceDeclaration(node)) {
    for (const clause of node.heritageClauses ?? []) {
      for (const heritageType of clause.types) {
        const inherited = canonicalRequiredLiteralProperties(
          heritageType,
          analysis,
          filePath,
          substitutions,
          seen,
          nextCanonicalTypeContext(context)
        )
        if (inherited === undefined) continue
        if (inherited.contradictory) contradictory = true
        if (mergeCanonicalLiteralProperties(properties, inherited.properties)) contradictory = true
      }
    }
  }
  for (const member of node.members) {
    if (!TypeScript.isPropertySignature(member) || member.questionToken !== undefined || member.type === undefined) {
      continue
    }
    const key = canonicalPropertyKeyText(member.name)
    const value = canonicalLiteralTypeValue(
      member.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
    if (key !== undefined && value !== undefined) {
      const previous = properties.get(key)
      if (previous !== undefined && previous !== value) contradictory = true
      properties.set(key, value)
    }
  }
  return { properties, contradictory }
}

const hasContradictoryLiteralIntersection = (members, analysis, filePath, substitutions, seen, context) => {
  const properties = new Map()
  for (const member of members) {
    const literalProperties = canonicalRequiredLiteralProperties(
      member,
      analysis,
      filePath,
      substitutions,
      seen,
      context
    )
    if (literalProperties === undefined) continue
    if (literalProperties.contradictory) return true
    if (mergeCanonicalLiteralProperties(properties, literalProperties.properties)) return true
  }
  return false
}

const canonicalTupleSpreadDomain = (typeNode, analysis, filePath, substitutions, seen, active = new Set()) => {
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return canonicalTupleSpreadDomain(typeNode.type, analysis, filePath, substitutions, seen, active)
  }
  if (TypeScript.isTupleTypeNode(typeNode)) {
    let fixedCount = 0
    let arrayLike = false
    for (const element of typeNode.elements) {
      const restType = TypeScript.isNamedTupleMember(element)
        ? element.dotDotDotToken === undefined
          ? undefined
          : element.type
        : TypeScript.isRestTypeNode(element)
          ? element.type
          : undefined
      if (restType !== undefined) {
        const nested = canonicalTupleSpreadDomain(restType, analysis, filePath, substitutions, seen, active)
        if (nested.kind === "tuple") fixedCount += nested.fixedCount
        else if (nested.kind === "array") arrayLike = true
        else return { fixedCount, kind: "unknown" }
        continue
      }
      fixedCount += 1
    }
    return { fixedCount, kind: arrayLike && fixedCount === 0 ? "array" : "tuple" }
  }
  if (TypeScript.isArrayTypeNode(typeNode)) return { fixedCount: 0, kind: "array" }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined && !Predicate.isString(substituted)) {
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (active.has(binding)) return { fixedCount: 0, kind: "unknown" }
      return canonicalTupleSpreadDomain(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        new Set(active).add(binding)
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen, typeNode)
    if (declaration !== undefined && TypeScript.isTypeAliasDeclaration(declaration.node)) {
      const declarationKey = `${declaration.filePath}\u0000${declaration.node.name.text}`
      if (active.has(declarationKey)) return { fixedCount: 0, kind: "unknown" }
      return canonicalTupleSpreadDomain(
        declaration.node.type,
        analysis,
        declaration.filePath,
        declarationSubstitutions(declaration, typeNode.typeArguments ?? [], substitutions, filePath),
        new Set(seen).add(declarationKey),
        new Set(active).add(declarationKey)
      )
    }
  }
  return { fixedCount: 0, kind: "unknown" }
}

const canonicalTupleArrayKeySet = (typeNode, analysis, filePath, substitutions, seen, context) => {
  const readonly = context.readonlyContainer === true
  const domain = canonicalTupleSpreadDomain(typeNode, analysis, filePath, substitutions, seen)
  const kind = domain.kind === "array" ? "array" : "tuple"
  const keys = canonicalArrayKeySet(kind, readonly)
  if (TypeScript.isTupleTypeNode(typeNode)) {
    let index = 0
    for (const element of typeNode.elements) {
      const restType = TypeScript.isNamedTupleMember(element)
        ? element.dotDotDotToken === undefined
          ? undefined
          : element.type
        : TypeScript.isRestTypeNode(element)
          ? element.type
          : undefined
      if (restType !== undefined) {
        const nested = canonicalTupleSpreadDomain(restType, analysis, filePath, substitutions, seen)
        if (nested.kind === "tuple") {
          for (let nestedIndex = 0; nestedIndex < nested.fixedCount; nestedIndex += 1) {
            keys.add(JSON.stringify(["string", String(index + nestedIndex)]))
          }
          index += nested.fixedCount
        }
        continue
      }
      keys.add(JSON.stringify(["string", String(index)]))
      index += 1
    }
  }
  return keys
}

const canonicalKeySetForNode = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return canonicalKeySetForNode(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
  }
  if (TypeScript.isLiteralTypeNode(typeNode)) {
    if (context.keySetMode !== "mapped-domain") return undefined
    const key = canonicalLiteralKeyText(typeNode.literal)
    return key === undefined ? undefined : new Set([key])
  }
  if (TypeScript.isArrayTypeNode(typeNode) || TypeScript.isTupleTypeNode(typeNode)) {
    return canonicalTupleArrayKeySet(typeNode, analysis, filePath, substitutions, seen, context)
  }
  if (TypeScript.isFunctionTypeNode(typeNode) || TypeScript.isConstructorTypeNode(typeNode)) {
    return new Set()
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return undefined
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (context.substitutionPath.has(binding)) {
        failCanonicalType(filePath, typeNode, "recursive type substitution")
      }
      return canonicalKeySetForNode(
        binding.typeNode,
        analysis,
        binding.filePath,
        binding.substitutions,
        seen,
        nextCanonicalTypeContext(context, new Set(context.substitutionPath).add(binding))
      )
    }
  }
  const reference =
    TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)
      ? { name: typeNode.typeName.text, typeArguments: typeNode.typeArguments }
      : TypeScript.isExpressionWithTypeArguments(typeNode) && TypeScript.isIdentifier(typeNode.expression)
        ? { name: typeNode.expression.text, typeArguments: typeNode.typeArguments }
        : undefined
  if (reference !== undefined) {
    const declaration = resolveTypeDeclaration(analysis, filePath, reference.name, seen, typeNode)
    const module = analysis.modules.get(filePath)
    const locallyBound =
      module?.declarations.has(reference.name) === true ||
      module?.imports.has(reference.name) === true ||
      module?.aliases.has(reference.name) === true
    if (reference.name === "Record" && !locallyBound && reference.typeArguments?.[0] !== undefined) {
      return canonicalKeySetForNode(reference.typeArguments[0], analysis, filePath, substitutions, seen, {
        ...nextCanonicalTypeContext(context),
        keySetMode: "mapped-domain"
      })
    }
    if (declaration !== undefined) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) {
        if (context.recursiveDeclarations?.has(key) === true) return undefined
        failCanonicalType(filePath, typeNode, "recursive type declaration")
      }
      const nextSeen = new Set(seen).add(key)
      const nextSubstitutions = declarationSubstitutions(
        declaration,
        reference.typeArguments ?? [],
        substitutions,
        filePath
      )
      const declarationBody = TypeScript.isTypeAliasDeclaration(declaration.node)
        ? declaration.node.type
        : declaration.node
      return canonicalKeySetForNode(
        declarationBody,
        analysis,
        declaration.filePath,
        nextSubstitutions,
        nextSeen,
        nextCanonicalTypeContext(context)
      )
    }
    if (reference.name === "Array" || reference.name === "ReadonlyArray") {
      const readonly = reference.name === "ReadonlyArray" || context.readonlyContainer === true
      return canonicalArrayKeySet("array", readonly)
    }
  }
  if (
    TypeScript.isTypeLiteralNode(typeNode) ||
    TypeScript.isInterfaceDeclaration(typeNode) ||
    TypeScript.isClassDeclaration(typeNode)
  ) {
    const keys = new Set()
    const declarationNodes = TypeScript.isTypeLiteralNode(typeNode)
      ? [typeNode]
      : (analysis.modules.get(filePath)?.declarationGroups.get(typeNode.name.text) ?? [typeNode])
    for (const declarationNode of declarationNodes) {
      if (TypeScript.isInterfaceDeclaration(declarationNode) || TypeScript.isClassDeclaration(declarationNode)) {
        for (const heritageType of instanceHeritageTypes(declarationNode)) {
          const inherited = canonicalKeySetForNode(
            heritageType,
            analysis,
            filePath,
            substitutions,
            seen,
            nextCanonicalTypeContext(context)
          )
          if (inherited === undefined) continue
          for (const key of inherited) keys.add(key)
        }
      }
      for (const member of declarationNode.members) {
        if (TypeScript.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (
              !isParameterProperty(parameter) ||
              hasNonPublicModifier(parameter) ||
              !TypeScript.isIdentifier(parameter.name)
            ) {
              continue
            }
            const descriptor = parameterPropertyDescriptor(parameter, analysis, filePath, substitutions, seen, {
              depth: 0,
              genericScope,
              substitutionPath,
              recursiveDeclarations,
              typeMembersMemo: memo
            })
            const existing = result.members.get(parameter.name.text)
            result.members.set(
              parameter.name.text,
              existing === undefined ? descriptor : `overloads(${existing}|${descriptor})`
            )
            const canonicalName = canonicalPropertyKeyText(parameter.name)
            if (canonicalName !== undefined) {
              const existingCanonical = result.canonicalMembers.get(canonicalName)
              result.canonicalMembers.set(
                canonicalName,
                existingCanonical === undefined ? descriptor : mergeMemberContract(existingCanonical, descriptor)
              )
            }
          }
          continue
        }
        if (hasNonPublicModifier(member) || hasStaticModifier(member)) continue
        if (
          TypeScript.isPropertySignature(member) ||
          TypeScript.isMethodSignature(member) ||
          TypeScript.isPropertyDeclaration(member) ||
          TypeScript.isMethodDeclaration(member) ||
          TypeScript.isGetAccessorDeclaration(member) ||
          TypeScript.isSetAccessorDeclaration(member)
        ) {
          const key = canonicalPropertyKeyText(member.name)
          if (key === undefined) return undefined
          keys.add(key)
          continue
        }
        if (TypeScript.isIndexSignatureDeclaration(member)) {
          const parameter = member.parameters[0]
          const parameterType = parameter?.type
          if (parameterType === undefined) return undefined
          if (parameterType.kind === TypeScript.SyntaxKind.StringKeyword) {
            keys.add(canonicalStringKey)
            keys.add(canonicalNumberKey)
            continue
          }
          if (parameterType.kind === TypeScript.SyntaxKind.NumberKeyword) {
            keys.add(canonicalNumberKey)
            continue
          }
          if (parameterType.kind === TypeScript.SyntaxKind.ESSymbolKeyword) {
            keys.add(canonicalSymbolKey)
            continue
          }
          return undefined
        }
      }
    }
    return keys
  }
  if (TypeScript.isMappedTypeNode(typeNode)) {
    const constraint = typeNode.typeParameter.constraint
    if (constraint === undefined) return undefined
    const sourceKeys = canonicalKeySetForNode(constraint, analysis, filePath, substitutions, seen, {
      ...nextCanonicalTypeContext(context),
      keySetMode: "mapped-domain"
    })
    if (sourceKeys !== undefined && sourceKeys.size === 0) return sourceKeys
    if (sourceKeys === undefined || typeNode.nameType === undefined) return sourceKeys
    if (typeNode.nameType.kind === TypeScript.SyntaxKind.NeverKeyword) return new Set()
    const remappedKey = canonicalLiteralKeyText(typeNode.nameType)
    if (remappedKey !== undefined) return new Set([remappedKey])
    if (TypeScript.isTypeReferenceNode(typeNode.nameType) && TypeScript.isIdentifier(typeNode.nameType.typeName)) {
      if (typeNode.nameType.typeName.text === typeNode.typeParameter.name.text) return sourceKeys
    }
    return undefined
  }
  if (TypeScript.isTypeOperatorNode(typeNode)) {
    if (typeNode.operator === TypeScript.SyntaxKind.KeyOfKeyword) return undefined
    if (
      typeNode.operator === TypeScript.SyntaxKind.ReadonlyKeyword ||
      typeNode.operator === TypeScript.SyntaxKind.UniqueKeyword
    ) {
      const operandContext =
        typeNode.operator === TypeScript.SyntaxKind.ReadonlyKeyword
          ? { ...nextCanonicalTypeContext(context), readonlyContainer: true }
          : nextCanonicalTypeContext(context)
      return canonicalKeySetForNode(typeNode.type, analysis, filePath, substitutions, seen, operandContext)
    }
  }
  if (TypeScript.isUnionTypeNode(typeNode)) {
    const memberSets = typeNode.types.map((member) =>
      canonicalKeySetForNode(member, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
    )
    if (memberSets.some((keys) => keys === undefined)) return undefined
    if (context.keySetMode === "mapped-domain") {
      return memberSets.reduce((keys, memberKeys) => canonicalKeySetUnion(keys, memberKeys ?? new Set()), new Set())
    }
    const nonNeverMemberSets = memberSets.filter((keys) => keys?.has(canonicalNeverKey) !== true)
    if (nonNeverMemberSets.length === 0) return new Set([canonicalNeverKey])
    const [first, ...rest] = nonNeverMemberSets
    if (first === undefined) return undefined
    return rest.reduce(canonicalKeySetIntersection, first)
  }
  if (TypeScript.isIntersectionTypeNode(typeNode)) {
    if (
      context.keySetMode !== "mapped-domain" &&
      hasContradictoryLiteralIntersection(typeNode.types, analysis, filePath, substitutions, seen, context)
    ) {
      return new Set([canonicalNeverKey])
    }
    const memberSets = typeNode.types.map((member) =>
      canonicalKeySetForNode(member, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
    )
    if (memberSets.some((keys) => keys === undefined)) return undefined
    if (context.keySetMode === "mapped-domain") {
      const [first, ...rest] = memberSets
      if (first === undefined) return undefined
      return rest.reduce(canonicalKeySetIntersection, first)
    }
    if (memberSets.some((keys) => keys?.has(canonicalNeverKey) === true)) return new Set([canonicalNeverKey])
    return memberSets.reduce((keys, memberKeys) => canonicalKeySetUnion(keys, memberKeys ?? new Set()), new Set())
  }
  return undefined
}

const canonicalMappedTypeText = (typeNode, analysis, filePath, substitutions, seen, context) => {
  const mappedSubstitutions = new Map(substitutions)
  mappedSubstitutions.set(typeNode.typeParameter.name.text, "mapped#0")
  const constraint = typeNode.typeParameter.constraint
  const constraintText =
    constraint === undefined
      ? "unknown"
      : canonicalTypeText(constraint, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
  const nameType =
    typeNode.nameType === undefined
      ? ""
      : `;as:${canonicalTypeText(
          typeNode.nameType,
          analysis,
          filePath,
          mappedSubstitutions,
          seen,
          nextCanonicalTypeContext(context)
        )}`
  return `mapped(${constraintText}${nameType})`
}

const canonicalMappedTypeReferenceText = (typeNode, analysis, filePath, substitutions, seen, context) => {
  if (!TypeScript.isTypeReferenceNode(typeNode) || !TypeScript.isIdentifier(typeNode.typeName)) return undefined
  const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen, typeNode)
  if (declaration === undefined || !TypeScript.isTypeAliasDeclaration(declaration.node)) return undefined
  const declarationName = declaration.node.name.text
  const key = `${declaration.filePath}\u0000${declarationName}`
  if (seen.has(key)) failCanonicalType(filePath, typeNode, "recursive type declaration")
  const nextSeen = new Set(seen).add(key)
  const nextSubstitutions = declarationSubstitutions(declaration, typeNode.typeArguments ?? [], substitutions, filePath)
  const declarationType = TypeScript.isParenthesizedTypeNode(declaration.node.type)
    ? declaration.node.type.type
    : declaration.node.type
  if (TypeScript.isMappedTypeNode(declarationType)) {
    return canonicalMappedTypeText(
      declarationType,
      analysis,
      declaration.filePath,
      nextSubstitutions,
      nextSeen,
      nextCanonicalTypeContext(context)
    )
  }
  if (TypeScript.isTypeReferenceNode(declarationType)) {
    return canonicalMappedTypeReferenceText(
      declarationType,
      analysis,
      declaration.filePath,
      nextSubstitutions,
      nextSeen,
      nextCanonicalTypeContext(context)
    )
  }
  return undefined
}

const canonicalKeyofOperandText = (
  typeNode,
  analysis,
  filePath,
  substitutions = new Map(),
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set() }
) => {
  if (context.depth > canonicalTypeMaxDepth) {
    failCanonicalType(filePath, typeNode, `type depth exceeded ${canonicalTypeMaxDepth}`)
  }
  const keySetText = (keys) =>
    keys.has(canonicalNeverKey) ? "primitive(any)" : `keys(${[...keys].toSorted().join("|")})`
  const keySetToKeyofOperand = (keys) => {
    if (keys.has(canonicalNeverKey) || keys.size === 0) return "primitive(any)"
    const categories = new Set()
    for (const key of keys) {
      if (key.startsWith('["string",')) categories.add("string")
      else if (key.startsWith('["number",')) categories.add("number")
      else if (key.startsWith('["symbol",')) categories.add("symbol")
    }
    if (categories.size === 0) return "primitive(any)"
    const values = [...categories].toSorted()
    return values.length === 1 ? `primitive(${values[0]})` : `primitive-union(${values.join("|")})`
  }
  if (TypeScript.isTypeOperatorNode(typeNode) && typeNode.operator === TypeScript.SyntaxKind.KeyOfKeyword) {
    const nestedKeys = canonicalKeySetForNode(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
    if (nestedKeys !== undefined) return keySetToKeyofOperand(nestedKeys)
    const nested = canonicalKeyofOperandText(
      typeNode.type,
      analysis,
      filePath,
      substitutions,
      seen,
      nextCanonicalTypeContext(context)
    )
    if (nested === "never" || nested === "primitive(any)") return "primitive(any)"
    if (nested === "primitive(unknown)") return "primitive(any)"
    return `nested-keyof(${nested})`
  }
  const primitive = canonicalPrimitiveKeyofOperandText(typeNode, analysis, filePath, substitutions, seen, context)
  if (primitive === "primitive(unknown)" || primitive === "primitive(object)") return "never"
  if (primitive !== undefined) return primitive
  if (TypeScript.isMappedTypeNode(typeNode)) {
    const mapped = canonicalKeySetForNode(typeNode, analysis, filePath, substitutions, seen, context)
    return mapped === undefined
      ? canonicalMappedTypeText(typeNode, analysis, filePath, substitutions, seen, context)
      : keySetText(mapped)
  }
  const keySet = canonicalKeySetForNode(typeNode, analysis, filePath, substitutions, seen, context)
  if (keySet !== undefined) return keySetText(keySet)
  const mappedReference = canonicalMappedTypeReferenceText(typeNode, analysis, filePath, substitutions, seen, context)
  if (mappedReference !== undefined) return mappedReference
  return canonicalTypeText(typeNode, analysis, filePath, substitutions, seen, context)
}

const genericDescriptor = (
  typeParameters,
  analysis,
  filePath,
  substitutions,
  context = { depth: 0, substitutionPath: new Set(), recursiveDeclarations: new Set() }
) => {
  const genericScope = context.genericScope ?? ""
  const childGenericScope = genericScope === "" ? "0" : `${genericScope}.0`
  const nextSubstitutions = new Map(substitutions)
  for (const [index, parameter] of (typeParameters ?? []).entries()) {
    nextSubstitutions.set(
      parameter.name.text,
      genericScope === "" ? `generic#${index}` : `generic#${genericScope}.${index}`
    )
  }
  const descriptor = (typeParameters ?? [])
    .map((parameter, index) => {
      const constModifier =
        parameter.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ConstKeyword) === true ? "const:" : ""
      const constraintContext = { ...context, genericScope: childGenericScope }
      const constraint =
        parameter.constraint === undefined
          ? ""
          : `extends:${canonicalTypeText(
              parameter.constraint,
              analysis,
              filePath,
              nextSubstitutions,
              new Set(),
              nextCanonicalTypeContext(constraintContext)
            )}`
      const defaultType =
        parameter.default === undefined
          ? ""
          : `default:${canonicalTypeText(
              parameter.default,
              analysis,
              filePath,
              nextSubstitutions,
              new Set(),
              nextCanonicalTypeContext(constraintContext)
            )}`
      return `${index}:${constModifier}${constraint}:${defaultType}`
    })
    .join(",")
  return { childGenericScope, descriptor, substitutions: nextSubstitutions }
}

const parameterDescriptor = (
  parameter,
  analysis,
  filePath,
  substitutions,
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set(), recursiveDeclarations: new Set() }
) => {
  const marker = parameter.dotDotDotToken === undefined ? "" : "..."
  const optional = parameter.questionToken === undefined && parameter.initializer === undefined ? "" : "?"
  const type =
    parameter.type === undefined
      ? "unknown"
      : canonicalTypeText(parameter.type, analysis, filePath, substitutions, seen, context)
  return `${marker}${optional}:${type}`
}

const effectiveMemberTypeNode = (member, analysis) => {
  if (member.type !== undefined) return member.type
  if (TypeScript.isPropertyDeclaration(member) && member.initializer !== undefined) {
    const checker = analysis.getChecker()
    return checker.typeToTypeNode(checker.getTypeAtLocation(member), member, TypeScript.NodeBuilderFlags.NoTruncation)
  }
  return undefined
}

const effectiveParameterTypeNode = (parameter, analysis) => {
  if (parameter.type !== undefined) return parameter.type
  const checker = analysis.getChecker()
  return checker.typeToTypeNode(
    checker.getTypeAtLocation(parameter),
    parameter,
    TypeScript.NodeBuilderFlags.NoTruncation
  )
}

const effectiveAccessorValueTypeNode = (member, analysis) => {
  if (TypeScript.isGetAccessorDeclaration(member)) {
    if (member.type !== undefined) return member.type
    const signature = analysis.getChecker().getSignatureFromDeclaration(member)
    return signature === undefined
      ? undefined
      : analysis
          .getChecker()
          .typeToTypeNode(signature.getReturnType(), member, TypeScript.NodeBuilderFlags.NoTruncation)
  }
  if (TypeScript.isSetAccessorDeclaration(member)) {
    const parameter = member.parameters[0]
    return parameter === undefined ? undefined : effectiveParameterTypeNode(parameter, analysis)
  }
  return undefined
}

const parameterPropertyDescriptor = (parameter, analysis, filePath, substitutions, seen, context) => {
  const type = effectiveParameterTypeNode(parameter, analysis)
  if (type === undefined) failCanonicalType(filePath, parameter, "unsupported parameter property")
  const readonly = hasReadonlyModifier(parameter) ? "readonly:" : ""
  const optional =
    parameter.questionToken !== undefined || parameter.initializer !== undefined ? "optional" : "required"
  return `${readonly}${optional}:${canonicalTypeText(type, analysis, filePath, substitutions, seen, context)}`
}

const memberDescriptor = (
  member,
  analysis,
  filePath,
  substitutions,
  seen = new Set(),
  context = { depth: 0, substitutionPath: new Set(), recursiveDeclarations: new Set() },
  memo = new Map(),
  substitutionPath = new Set()
) => {
  const optional = member.questionToken === undefined ? "required" : "optional"
  const readonly = hasReadonlyModifier(member) ? "readonly:" : ""
  const dependencies = { declarationDependencies: new Set(), substitutionDependencies: new Set() }
  const collectDependencies = (result) => {
    for (const dependency of result.declarationDependencies) dependencies.declarationDependencies.add(dependency)
    for (const dependency of result.substitutionDependencies) dependencies.substitutionDependencies.add(dependency)
  }
  if (TypeScript.isIndexSignatureDeclaration(member)) {
    const parameterType = member.parameters[0]?.type
    if (parameterType === undefined || member.type === undefined) {
      failCanonicalType(filePath, member, "unsupported index signature")
    }
    const parameter =
      canonicalIndexSignatureDomain(
        parameterType,
        analysis,
        filePath,
        substitutions,
        seen,
        nextCanonicalTypeContext(context)
      ) ?? canonicalTypeText(parameterType, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
    const value = canonicalTypeText(member.type, analysis, filePath, substitutions, seen, context)
    collectDependencies(
      typeMembers(
        parameterType,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        context.genericScope ?? "",
        context.recursiveDeclarations
      )
    )
    collectDependencies(
      typeMembers(
        member.type,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        context.genericScope ?? "",
        context.recursiveDeclarations
      )
    )
    return { descriptor: readonly + "index(" + parameter + "):" + value, ...dependencies }
  }
  if (TypeScript.isGetAccessorDeclaration(member)) {
    const returnType =
      member.type === undefined
        ? "unknown"
        : canonicalTypeText(member.type, analysis, filePath, substitutions, seen, context)
    if (member.type !== undefined) {
      collectDependencies(
        typeMembers(
          member.type,
          analysis,
          filePath,
          seen,
          substitutions,
          memo,
          substitutionPath,
          context.genericScope ?? "",
          context.recursiveDeclarations
        )
      )
    }
    return { descriptor: `${readonly}${optional}:get():${returnType}`, ...dependencies }
  }
  if (TypeScript.isSetAccessorDeclaration(member)) {
    const parameters = member.parameters
      .map((parameter) => parameterDescriptor(parameter, analysis, filePath, substitutions, seen, context))
      .join(",")
    for (const parameter of member.parameters) {
      if (parameter.type !== undefined) {
        collectDependencies(
          typeMembers(
            parameter.type,
            analysis,
            filePath,
            seen,
            substitutions,
            memo,
            substitutionPath,
            context.genericScope ?? "",
            context.recursiveDeclarations
          )
        )
      }
    }
    return { descriptor: `${readonly}${optional}:set(${parameters})`, ...dependencies }
  }
  if (TypeScript.isMethodSignature(member) || TypeScript.isMethodDeclaration(member)) {
    const generic = genericDescriptor(member.typeParameters, analysis, filePath, substitutions, context)
    const genericContext = { ...context, genericScope: generic.childGenericScope }
    const parameters = member.parameters
      .map((parameter) =>
        parameterDescriptor(
          parameter,
          analysis,
          filePath,
          generic.substitutions,
          seen,
          nextCanonicalTypeContext(genericContext)
        )
      )
      .join(",")
    const returnType =
      member.type === undefined
        ? "unknown"
        : canonicalTypeText(
            member.type,
            analysis,
            filePath,
            generic.substitutions,
            seen,
            nextCanonicalTypeContext(genericContext)
          )
    for (const parameter of member.parameters) {
      if (parameter.type !== undefined) {
        collectDependencies(
          typeMembers(
            parameter.type,
            analysis,
            filePath,
            seen,
            generic.substitutions,
            memo,
            substitutionPath,
            generic.childGenericScope,
            context.recursiveDeclarations
          )
        )
      }
    }
    if (member.type !== undefined) {
      collectDependencies(
        typeMembers(
          member.type,
          analysis,
          filePath,
          seen,
          generic.substitutions,
          memo,
          substitutionPath,
          generic.childGenericScope,
          context.recursiveDeclarations
        )
      )
    }
    return {
      descriptor: `${readonly}${optional}:method<${generic.descriptor}>(${parameters}):${returnType}`,
      ...dependencies
    }
  }
  if (TypeScript.isCallSignatureDeclaration(member) || TypeScript.isConstructSignatureDeclaration(member)) {
    const generic = genericDescriptor(member.typeParameters, analysis, filePath, substitutions, context)
    const genericContext = { ...context, genericScope: generic.childGenericScope }
    const parameters = member.parameters
      .map((parameter) =>
        parameterDescriptor(
          parameter,
          analysis,
          filePath,
          generic.substitutions,
          seen,
          nextCanonicalTypeContext(genericContext)
        )
      )
      .join(",")
    const returnType =
      member.type === undefined
        ? "unknown"
        : canonicalTypeText(
            member.type,
            analysis,
            filePath,
            generic.substitutions,
            seen,
            nextCanonicalTypeContext(genericContext)
          )
    for (const parameter of member.parameters) {
      if (parameter.type !== undefined) {
        collectDependencies(
          typeMembers(
            parameter.type,
            analysis,
            filePath,
            seen,
            generic.substitutions,
            memo,
            substitutionPath,
            generic.childGenericScope,
            context.recursiveDeclarations
          )
        )
      }
    }
    if (member.type !== undefined) {
      collectDependencies(
        typeMembers(
          member.type,
          analysis,
          filePath,
          seen,
          generic.substitutions,
          memo,
          substitutionPath,
          generic.childGenericScope,
          context.recursiveDeclarations
        )
      )
    }
    const kind = TypeScript.isConstructSignatureDeclaration(member) ? "construct" : "call"
    return { descriptor: `${kind}<${generic.descriptor}>(${parameters}):${returnType}`, ...dependencies }
  }
  const memberType = effectiveMemberTypeNode(member, analysis)
  const type =
    memberType === undefined
      ? "unknown"
      : canonicalTypeText(memberType, analysis, filePath, substitutions, seen, context)
  if (memberType !== undefined) {
    collectDependencies(
      typeMembers(
        memberType,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        context.genericScope ?? "",
        context.recursiveDeclarations
      )
    )
  }
  return { descriptor: `${readonly}${optional}:${type}`, ...dependencies }
}

const typeMembersResult = (members = new Map(), resolved = false, canonicalMembers = new Map()) => ({
  canonicalMembers,
  declarationDependencies: new Set(),
  members,
  resolved,
  substitutionDependencies: new Set()
})

const mergeMemberContract = (left, right) => {
  if (left === right) return left
  return `overloads(${[left, right].toSorted().join("|")})`
}

const addIndexSignatureContract = (members, key, descriptor) => {
  const redundantNumberKey = "index:number"
  const stringKey = "index:string"
  const withoutDomain = (value) => value.replace(/^(readonly:)?index\((?:string|number)\):/u, "$1index:")
  const equivalent = (left, right) => withoutDomain(left) === withoutDomain(right)
  if (key === redundantNumberKey && equivalent(members.get(stringKey) ?? "", descriptor)) return
  if (key === stringKey && equivalent(members.get(redundantNumberKey) ?? "", descriptor)) {
    members.delete(redundantNumberKey)
  }
  const existing = members.get(key)
  members.set(key, existing === undefined ? descriptor : mergeMemberContract(existing, descriptor))
}

const addCanonicalIndexSignatureContract = (result, key, descriptor) => {
  addIndexSignatureContract(result.members, key, descriptor)
  addIndexSignatureContract(result.canonicalMembers, key, descriptor)
}

const collectTypeMembersResult = (target, result, includeMembers = true) => {
  if (!result.resolved) target.resolved = false
  if (includeMembers) {
    for (const [name, type] of result.members) {
      if (name.startsWith("index:")) addIndexSignatureContract(target.members, name, type)
      else {
        const existing = target.members.get(name)
        target.members.set(name, existing === undefined ? type : mergeMemberContract(existing, type))
      }
    }
    for (const [name, type] of result.canonicalMembers) {
      if (name.startsWith("index:")) addIndexSignatureContract(target.canonicalMembers, name, type)
      else {
        const existing = target.canonicalMembers.get(name)
        target.canonicalMembers.set(name, existing === undefined ? type : mergeMemberContract(existing, type))
      }
    }
  }
  for (const dependency of result.declarationDependencies) target.declarationDependencies.add(dependency)
  for (const dependency of result.substitutionDependencies) target.substitutionDependencies.add(dependency)
}

const withDeclarationDependency = (result, dependency) => ({
  ...result,
  declarationDependencies: new Set([...result.declarationDependencies, dependency])
})

const withSubstitutionDependency = (result, dependency) => ({
  ...result,
  substitutionDependencies: new Set([...result.substitutionDependencies, dependency])
})

const canonicalMemoEnvironmentKey = (
  analysis,
  filePath,
  substitutions,
  typeArguments,
  includeSubstitutions = true,
  recursiveDeclarations = new Set()
) => {
  const canonicalSubstitutions = includeSubstitutions
    ? [...substitutions]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
          if (Predicate.isString(value)) return [name, value]
          if (!isTypeSubstitution(value)) {
            throw new ChangesetCoverageError({
              reason: `${filePath}: invalid type substitution while canonicalizing memo environment`
            })
          }
          return [
            name,
            canonicalTypeText(value.typeNode, analysis, value.filePath, value.substitutions, new Set(), {
              depth: 0,
              substitutionPath: new Set(),
              recursiveDeclarations
            })
          ]
        })
    : []
  const canonicalArguments = typeArguments.map((argument) =>
    isTypeSubstitution(argument)
      ? canonicalTypeText(argument.typeNode, analysis, argument.filePath, argument.substitutions, new Set(), {
          depth: 0,
          substitutionPath: new Set(),
          recursiveDeclarations
        })
      : canonicalTypeText(argument, analysis, filePath, substitutions, new Set(), {
          depth: 0,
          substitutionPath: new Set(),
          recursiveDeclarations
        })
  )
  return JSON.stringify({ arguments: canonicalArguments, substitutions: canonicalSubstitutions })
}

const canonicalMemoReferenceArguments = (typeArguments, filePath, substitutions) =>
  typeArguments.map((argument) => makeTypeSubstitution(argument, substitutions, filePath))

const readTypeMembersMemo = (
  memo,
  memoKey,
  substitutions,
  seen,
  substitutionPath,
  filePath,
  typeArguments = [],
  contextNode = memoKey,
  analysis,
  declarationEnvironment = false,
  recursiveDeclarations = new Set()
) => {
  const entries = memo.get(memoKey)
  if (entries === undefined) return undefined
  const environmentKey = canonicalMemoEnvironmentKey(
    analysis,
    filePath,
    substitutions,
    typeArguments,
    !declarationEnvironment,
    recursiveDeclarations
  )
  const entry = entries.find(
    ({ referenceArguments, substitutionEntries }) =>
      canonicalMemoEnvironmentKey(
        analysis,
        filePath,
        new Map(substitutionEntries),
        referenceArguments,
        !declarationEnvironment,
        recursiveDeclarations
      ) === environmentKey
  )
  if (entry === undefined) return undefined
  if (
    [...entry.result.declarationDependencies].some(
      (dependency) => seen.has(dependency) && !recursiveDeclarations.has(dependency)
    )
  ) {
    failCanonicalType(filePath, contextNode, "recursive type declaration")
  }
  if ([...entry.result.substitutionDependencies].some((dependency) => substitutionPath.has(dependency))) {
    failCanonicalType(filePath, contextNode, "recursive type substitution")
  }
  return entry.result
}

const writeTypeMembersMemo = (memo, memoKey, substitutions, result, typeArguments = []) => {
  const entries = memo.get(memoKey) ?? []
  const substitutionEntries = [...substitutions]
  const entry = { referenceArguments: typeArguments, result, substitutionEntries }
  entries.push(entry)
  memo.set(memoKey, entries)
  return result
}

const typeMembers = (
  typeNode,
  analysis,
  filePath,
  seen = new Set(),
  substitutions = new Map(),
  memo = new Map(),
  substitutionPath = new Set(),
  genericScope = "",
  recursiveDeclarations = analysis.recursiveDeclarations
) => {
  const reference =
    (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) ||
    (TypeScript.isExpressionWithTypeArguments(typeNode) && TypeScript.isIdentifier(typeNode.expression))
  if (!reference) {
    const cached = readTypeMembersMemo(
      memo,
      typeNode,
      substitutions,
      seen,
      substitutionPath,
      filePath,
      [],
      typeNode,
      analysis,
      false,
      recursiveDeclarations
    )
    if (cached !== undefined) return cached
  }
  if (TypeScript.isParenthesizedTypeNode(typeNode)) {
    return writeTypeMembersMemo(
      memo,
      typeNode,
      substitutions,
      typeMembers(
        typeNode.type,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        genericScope,
        recursiveDeclarations
      )
    )
  }
  if (TypeScript.isTypeOperatorNode(typeNode) && typeNode.operator === TypeScript.SyntaxKind.ReadonlyKeyword) {
    return writeTypeMembersMemo(
      memo,
      typeNode,
      substitutions,
      typeMembers(
        typeNode.type,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        genericScope,
        recursiveDeclarations
      )
    )
  }
  if (TypeScript.isArrayTypeNode(typeNode)) {
    const result = typeMembersResult()
    collectTypeMembersResult(
      result,
      typeMembers(
        typeNode.elementType,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        genericScope,
        recursiveDeclarations
      ),
      false
    )
    result.resolved = false
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (TypeScript.isTupleTypeNode(typeNode)) {
    const result = typeMembersResult()
    for (const element of typeNode.elements) {
      let elementType = TypeScript.isNamedTupleMember(element) ? element.type : element
      if (TypeScript.isOptionalTypeNode(elementType) || TypeScript.isRestTypeNode(elementType)) {
        elementType = elementType.type
      }
      collectTypeMembersResult(
        result,
        typeMembers(
          elementType,
          analysis,
          filePath,
          seen,
          substitutions,
          memo,
          substitutionPath,
          genericScope,
          recursiveDeclarations
        ),
        false
      )
    }
    result.resolved = false
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (TypeScript.isUnionTypeNode(typeNode)) {
    const result = typeMembersResult(new Map(), true)
    for (const member of typeNode.types) {
      collectTypeMembersResult(
        result,
        typeMembers(
          member,
          analysis,
          filePath,
          seen,
          substitutions,
          memo,
          substitutionPath,
          genericScope,
          recursiveDeclarations
        ),
        true
      )
    }
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (TypeScript.isFunctionTypeNode(typeNode)) {
    const generic = genericDescriptor(typeNode.typeParameters, analysis, filePath, substitutions, {
      depth: 0,
      genericScope,
      substitutionPath,
      recursiveDeclarations
    })
    const result = typeMembersResult()
    for (const parameter of typeNode.parameters) {
      if (parameter.type !== undefined) {
        collectTypeMembersResult(
          result,
          typeMembers(
            parameter.type,
            analysis,
            filePath,
            seen,
            generic.substitutions,
            memo,
            substitutionPath,
            generic.childGenericScope,
            recursiveDeclarations
          ),
          false
        )
      }
    }
    if (typeNode.type !== undefined) {
      collectTypeMembersResult(
        result,
        typeMembers(
          typeNode.type,
          analysis,
          filePath,
          seen,
          generic.substitutions,
          memo,
          substitutionPath,
          generic.childGenericScope,
          recursiveDeclarations
        ),
        false
      )
    }
    result.resolved = false
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (TypeScript.isIntersectionTypeNode(typeNode)) {
    const result = typeMembersResult(new Map(), true)
    let hasResolvedMember = false
    for (const member of typeNode.types) {
      const memberResult = typeMembers(
        member,
        analysis,
        filePath,
        seen,
        substitutions,
        memo,
        substitutionPath,
        genericScope,
        recursiveDeclarations
      )
      if (memberResult.resolved) hasResolvedMember = true
      collectTypeMembersResult(result, memberResult)
    }
    result.resolved = hasResolvedMember
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (
    TypeScript.isTypeLiteralNode(typeNode) ||
    TypeScript.isInterfaceDeclaration(typeNode) ||
    TypeScript.isClassDeclaration(typeNode)
  ) {
    const result = typeMembersResult(new Map(), true)
    const declarationNodes = resolvedTypeDeclarationNodes(analysis, { filePath, node: typeNode })
    let callSignatureIndex = 0
    for (const declarationNode of declarationNodes) {
      if (TypeScript.isInterfaceDeclaration(declarationNode) || TypeScript.isClassDeclaration(declarationNode)) {
        for (const heritageType of instanceHeritageTypes(declarationNode)) {
          collectTypeMembersResult(
            result,
            typeMembers(
              heritageType,
              analysis,
              filePath,
              seen,
              substitutions,
              memo,
              substitutionPath,
              genericScope,
              recursiveDeclarations
            )
          )
        }
      }
      for (const member of declarationNode.members) {
        if (hasNonPublicModifier(member) || hasStaticModifier(member)) continue
        if (
          !TypeScript.isPropertySignature(member) &&
          !TypeScript.isMethodSignature(member) &&
          !TypeScript.isPropertyDeclaration(member) &&
          !TypeScript.isMethodDeclaration(member) &&
          !TypeScript.isGetAccessorDeclaration(member) &&
          !TypeScript.isSetAccessorDeclaration(member) &&
          !TypeScript.isIndexSignatureDeclaration(member) &&
          !TypeScript.isCallSignatureDeclaration(member) &&
          !TypeScript.isConstructSignatureDeclaration(member)
        ) {
          continue
        }
        if (TypeScript.isIndexSignatureDeclaration(member)) {
          const descriptor = memberDescriptor(
            member,
            analysis,
            filePath,
            substitutions,
            seen,
            { depth: 0, genericScope, substitutionPath, recursiveDeclarations, typeMembersMemo: memo },
            memo,
            substitutionPath
          )
          const canonicalName = canonicalIndexSignatureKey(member, analysis, filePath, substitutions, seen, {
            depth: 0,
            genericScope,
            substitutionPath,
            recursiveDeclarations,
            typeMembersMemo: memo
          })
          addCanonicalIndexSignatureContract(result, canonicalName, descriptor.descriptor)
          for (const dependency of descriptor.declarationDependencies) result.declarationDependencies.add(dependency)
          for (const dependency of descriptor.substitutionDependencies) result.substitutionDependencies.add(dependency)
          continue
        }
        if (TypeScript.isCallSignatureDeclaration(member) || TypeScript.isConstructSignatureDeclaration(member)) {
          const descriptor = memberDescriptor(
            member,
            analysis,
            filePath,
            substitutions,
            seen,
            { depth: 0, genericScope, substitutionPath, recursiveDeclarations, typeMembersMemo: memo },
            memo,
            substitutionPath
          )
          const canonicalName = `call#${callSignatureIndex}:${descriptor.descriptor}`
          result.canonicalMembers.set(canonicalName, descriptor.descriptor)
          result.members.set(canonicalName, descriptor.descriptor)
          callSignatureIndex += 1
          for (const dependency of descriptor.declarationDependencies) result.declarationDependencies.add(dependency)
          for (const dependency of descriptor.substitutionDependencies) result.substitutionDependencies.add(dependency)
          continue
        }
        const name = member.name
        if (!TypeScript.isIdentifier(name) && !TypeScript.isStringLiteral(name) && !TypeScript.isNumericLiteral(name)) {
          continue
        }
        const descriptor = memberDescriptor(
          member,
          analysis,
          filePath,
          substitutions,
          seen,
          { depth: 0, genericScope, substitutionPath, recursiveDeclarations, typeMembersMemo: memo },
          memo,
          substitutionPath
        )
        const existing = result.members.get(name.text)
        result.members.set(
          name.text,
          existing === undefined ? descriptor.descriptor : `overloads(${existing}|${descriptor.descriptor})`
        )
        const canonicalName = canonicalPropertyKeyText(name)
        if (canonicalName !== undefined) {
          const existingCanonical = result.canonicalMembers.get(canonicalName)
          result.canonicalMembers.set(
            canonicalName,
            existingCanonical === undefined
              ? descriptor.descriptor
              : mergeMemberContract(existingCanonical, descriptor.descriptor)
          )
        }
        for (const dependency of descriptor.declarationDependencies) result.declarationDependencies.add(dependency)
        for (const dependency of descriptor.substitutionDependencies) result.substitutionDependencies.add(dependency)
      }
    }
    return writeTypeMembersMemo(memo, typeNode, substitutions, result)
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const substituted = substitutions.get(typeNode.typeName.text)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return typeMembersResult()
      const binding = typeSubstitutionBinding(substituted, substitutions, filePath)
      if (substitutionPath.has(binding)) failCanonicalType(filePath, typeNode, "recursive type substitution")
      const result = typeMembers(
        binding.typeNode,
        analysis,
        binding.filePath,
        seen,
        binding.substitutions,
        memo,
        new Set(substitutionPath).add(binding),
        genericScope,
        recursiveDeclarations
      )
      return writeTypeMembersMemo(memo, typeNode, substitutions, withSubstitutionDependency(result, binding))
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen, typeNode)
    if (declaration === undefined) {
      const result = typeMembersResult(new Map(), false)
      for (const argument of typeNode.typeArguments ?? []) {
        const argumentResult = typeMembers(
          argument,
          analysis,
          filePath,
          seen,
          substitutions,
          memo,
          substitutionPath,
          genericScope,
          recursiveDeclarations
        )
        collectTypeMembersResult(result, argumentResult, false)
      }
      result.resolved = false
      return writeTypeMembersMemo(memo, typeNode, substitutions, result)
    }
    const declarationName = declaration.node.name.text
    const declarationKey = `${declaration.filePath}\u0000${declarationName}`
    if (seen.has(declarationKey)) {
      if (recursiveDeclarations.has(declarationKey)) return typeMembersResult(new Map(), false)
      failCanonicalType(filePath, typeNode, "recursive type declaration")
    }
    const typeArguments = typeNode.typeArguments ?? []
    const effectiveTypeArguments = declarationEffectiveTypeArguments(declaration.node, typeArguments)
    const cached = readTypeMembersMemo(
      memo,
      declarationKey,
      substitutions,
      seen,
      substitutionPath,
      filePath,
      effectiveTypeArguments,
      typeNode,
      analysis,
      true,
      recursiveDeclarations
    )
    if (cached !== undefined) return cached
    const nextSeen = new Set(seen).add(declarationKey)
    const nextSubstitutions = declarationSubstitutions(
      declaration,
      typeNode.typeArguments ?? [],
      substitutions,
      filePath
    )
    if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
      return writeTypeMembersMemo(
        memo,
        declarationKey,
        substitutions,
        withDeclarationDependency(
          typeMembers(
            declaration.node.type,
            analysis,
            declaration.filePath,
            nextSeen,
            nextSubstitutions,
            memo,
            substitutionPath,
            genericScope,
            recursiveDeclarations
          ),
          declarationKey
        ),
        canonicalMemoReferenceArguments(effectiveTypeArguments, filePath, substitutions)
      )
    }
    if (TypeScript.isInterfaceDeclaration(declaration.node) || TypeScript.isClassDeclaration(declaration.node)) {
      return writeTypeMembersMemo(
        memo,
        declarationKey,
        substitutions,
        withDeclarationDependency(
          typeMembers(
            declaration.node,
            analysis,
            declaration.filePath,
            nextSeen,
            nextSubstitutions,
            memo,
            substitutionPath,
            genericScope,
            recursiveDeclarations
          ),
          declarationKey
        ),
        canonicalMemoReferenceArguments(effectiveTypeArguments, filePath, substitutions)
      )
    }
  }
  if (TypeScript.isExpressionWithTypeArguments(typeNode) && TypeScript.isIdentifier(typeNode.expression)) {
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.expression.text, seen, typeNode)
    if (declaration === undefined) {
      const result = typeMembersResult(new Map(), false)
      for (const argument of typeNode.typeArguments ?? []) {
        const argumentResult = typeMembers(
          argument,
          analysis,
          filePath,
          seen,
          substitutions,
          memo,
          substitutionPath,
          genericScope,
          recursiveDeclarations
        )
        collectTypeMembersResult(result, argumentResult, false)
      }
      result.resolved = false
      return writeTypeMembersMemo(memo, typeNode, substitutions, result)
    }
    const declarationName = declaration.node.name.text
    const declarationKey = `${declaration.filePath}\u0000${declarationName}`
    if (seen.has(declarationKey)) {
      if (recursiveDeclarations.has(declarationKey)) return typeMembersResult(new Map(), false)
      failCanonicalType(filePath, typeNode, "recursive type declaration")
    }
    const typeArguments = typeNode.typeArguments ?? []
    const effectiveTypeArguments = declarationEffectiveTypeArguments(declaration.node, typeArguments)
    const cached = readTypeMembersMemo(
      memo,
      declarationKey,
      substitutions,
      seen,
      substitutionPath,
      filePath,
      effectiveTypeArguments,
      typeNode,
      analysis,
      true,
      recursiveDeclarations
    )
    if (cached !== undefined) return cached
    const nextSeen = new Set(seen).add(declarationKey)
    const nextSubstitutions = declarationSubstitutions(
      declaration,
      typeNode.typeArguments ?? [],
      substitutions,
      filePath
    )
    if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
      return writeTypeMembersMemo(
        memo,
        declarationKey,
        substitutions,
        withDeclarationDependency(
          typeMembers(
            declaration.node.type,
            analysis,
            declaration.filePath,
            nextSeen,
            nextSubstitutions,
            memo,
            substitutionPath,
            genericScope,
            recursiveDeclarations
          ),
          declarationKey
        ),
        canonicalMemoReferenceArguments(effectiveTypeArguments, filePath, substitutions)
      )
    }
    if (TypeScript.isInterfaceDeclaration(declaration.node) || TypeScript.isClassDeclaration(declaration.node)) {
      return writeTypeMembersMemo(
        memo,
        declarationKey,
        substitutions,
        withDeclarationDependency(
          typeMembers(
            declaration.node,
            analysis,
            declaration.filePath,
            nextSeen,
            nextSubstitutions,
            memo,
            substitutionPath,
            genericScope,
            recursiveDeclarations
          ),
          declarationKey
        ),
        canonicalMemoReferenceArguments(effectiveTypeArguments, filePath, substitutions)
      )
    }
  }
  return writeTypeMembersMemo(memo, typeNode, substitutions, typeMembersResult())
}

function unwrapParenthesizedExpression(node) {
  return TypeScript.isParenthesizedExpression(node) ? unwrapParenthesizedExpression(node.expression) : node
}

function canonicalResolvedDeclarationText(declaration, analysis, filePath, substitutions, seen, context) {
  const declarationNodes = resolvedDeclarationNodes(analysis, declaration)
  const members = new Map()
  const callSignatures = []
  const typeMembersMemo = context.typeMembersMemo ?? new Map()
  const addMember = (name, descriptor) => {
    if (name.startsWith("index:")) {
      addIndexSignatureContract(members, name, descriptor)
      return
    }
    const existing = members.get(name)
    members.set(name, existing === undefined ? descriptor : mergeMemberContract(existing, descriptor))
  }
  const inheritedMemberNames = new Set()
  const overloadedMethodNames = new Set(
    declarationNodes.flatMap((declarationNode) =>
      declarationNode.members
        .filter((member) => TypeScript.isMethodDeclaration(member) && member.body === undefined)
        .map((member) => canonicalPropertyKeyText(member.name))
        .filter((name) => name !== undefined)
    )
  )
  const addInheritedMember = (name, descriptor) => {
    addMember(name, descriptor)
    inheritedMemberNames.add(name)
  }
  for (const declarationNode of declarationNodes) {
    if (TypeScript.isInterfaceDeclaration(declarationNode) || TypeScript.isClassDeclaration(declarationNode)) {
      for (const heritageType of instanceHeritageTypes(declarationNode)) {
        const inherited = typeMembers(
          heritageType,
          analysis,
          declaration.filePath,
          seen,
          substitutions,
          new Map(),
          context.substitutionPath,
          context.genericScope ?? "",
          context.recursiveDeclarations
        )
        if (inherited.resolved) {
          for (const [name, descriptor] of inherited.canonicalMembers) {
            if (name.startsWith("call#")) callSignatures.push(descriptor)
            else addInheritedMember(name, descriptor)
          }
        } else {
          addMember(
            "heritage",
            canonicalTypeText(
              heritageType,
              analysis,
              declaration.filePath,
              substitutions,
              seen,
              nextCanonicalTypeContext(context)
            )
          )
        }
      }
    }
  }
  for (const declarationNode of declarationNodes) {
    for (const member of declarationNode.members) {
      if (hasNonPublicModifier(member) || hasStaticModifier(member)) continue
      if (TypeScript.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          if (
            !isParameterProperty(parameter) ||
            hasNonPublicModifier(parameter) ||
            !TypeScript.isIdentifier(parameter.name)
          ) {
            continue
          }
          const propertyName = canonicalPropertyKeyText(parameter.name)
          if (propertyName === undefined) continue
          const descriptor = parameterPropertyDescriptor(
            parameter,
            analysis,
            declaration.filePath,
            substitutions,
            seen,
            { ...context, typeMembersMemo }
          )
          if (inheritedMemberNames.has(propertyName)) {
            members.set(propertyName, descriptor)
            inheritedMemberNames.delete(propertyName)
          } else {
            addMember(propertyName, descriptor)
          }
        }
        continue
      }
      const memberName = member.name === undefined ? undefined : canonicalPropertyKeyText(member.name)
      if (
        TypeScript.isMethodDeclaration(member) &&
        member.body !== undefined &&
        memberName !== undefined &&
        overloadedMethodNames.has(memberName)
      ) {
        continue
      }
      if (
        !TypeScript.isPropertySignature(member) &&
        !TypeScript.isMethodSignature(member) &&
        !TypeScript.isPropertyDeclaration(member) &&
        !TypeScript.isMethodDeclaration(member) &&
        !TypeScript.isGetAccessorDeclaration(member) &&
        !TypeScript.isSetAccessorDeclaration(member) &&
        !TypeScript.isIndexSignatureDeclaration(member) &&
        !TypeScript.isCallSignatureDeclaration(member) &&
        !TypeScript.isConstructSignatureDeclaration(member)
      ) {
        continue
      }
      if (TypeScript.isIndexSignatureDeclaration(member)) {
        const descriptor = memberDescriptor(
          member,
          analysis,
          declaration.filePath,
          substitutions,
          seen,
          { ...context, typeMembersMemo },
          typeMembersMemo,
          context.substitutionPath
        )
        addIndexSignatureContract(
          members,
          canonicalIndexSignatureKey(member, analysis, declaration.filePath, substitutions, seen, {
            ...context,
            typeMembersMemo
          }),
          descriptor.descriptor
        )
        continue
      }
      if (TypeScript.isCallSignatureDeclaration(member) || TypeScript.isConstructSignatureDeclaration(member)) {
        callSignatures.push(
          memberDescriptor(
            member,
            analysis,
            declaration.filePath,
            substitutions,
            seen,
            { ...context, typeMembersMemo },
            typeMembersMemo,
            context.substitutionPath
          ).descriptor
        )
        continue
      }
      const name = member.name
      const propertyName = canonicalPropertyKeyText(name)
      if (propertyName === undefined) continue
      const descriptor = memberDescriptor(
        member,
        analysis,
        declaration.filePath,
        substitutions,
        seen,
        { ...context, typeMembersMemo },
        typeMembersMemo,
        context.substitutionPath
      )
      if (
        inheritedMemberNames.has(propertyName) &&
        (TypeScript.isPropertySignature(member) || TypeScript.isPropertyDeclaration(member))
      ) {
        members.set(propertyName, descriptor.descriptor)
        inheritedMemberNames.delete(propertyName)
      } else {
        addMember(propertyName, descriptor.descriptor)
      }
    }
  }
  const structuralText = `object(${[
    ...[...members].map(([name, descriptor]) => `${name}:${descriptor}`),
    ...callSignatures.map((descriptor, index) => `call#${index}:${descriptor}`)
  ]
    .toSorted()
    .join(";")})`
  return TypeScript.isClassDeclaration(declaration.node) && hasNominalClassIdentity(declaration, analysis)
    ? `class(${declaration.filePath}#${declaration.node.name.text};${structuralText})`
    : structuralText
}

const callableParameterTypesInSources = (
  sources,
  filePath,
  analysis = analyzeSources(sources),
  recursiveDeclarations = new Set()
) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return new Map()
  const exports = new Map()
  const runtimeParameters = (parameters) =>
    parameters.filter((parameter) => !(TypeScript.isIdentifier(parameter.name) && parameter.name.text === "this"))
  const inferredReturnType = (node) => {
    const checker = analysis.getChecker()
    const type = checker.getTypeAtLocation(node)
    const signature = checker.getSignaturesOfType(type, TypeScript.SignatureKind.Call)[0]
    if (signature === undefined) return undefined
    return checker.typeToTypeNode(signature.getReturnType(), node, TypeScript.NodeBuilderFlags.NoTruncation)
  }
  const addCallable = (
    name,
    parameters,
    returnType,
    contextualType,
    initializerTypeParameters,
    contextualTypeParameters,
    callableNode
  ) => {
    const publicTypeParameters = contextualTypeParameters ?? initializerTypeParameters
    const callableGeneric = genericDescriptor(publicTypeParameters, analysis, filePath, new Map(), {
      depth: 0,
      substitutionPath: new Set(),
      recursiveDeclarations
    })
    const callableSubstitutions = new Map(callableGeneric.substitutions)
    if (contextualTypeParameters !== undefined && initializerTypeParameters !== undefined) {
      for (const [index, parameter] of initializerTypeParameters.entries()) {
        const contextualParameter = contextualTypeParameters[index]
        const canonical =
          contextualParameter === undefined
            ? undefined
            : callableGeneric.substitutions.get(contextualParameter.name.text)
        if (canonical !== undefined) callableSubstitutions.set(parameter.name.text, canonical)
      }
    }
    const contextualParameters = contextualType === undefined ? [] : runtimeParameters(contextualType.parameters)
    const firstParameter = runtimeParameters(parameters)[0]
    const contextualParameter = contextualParameters[0]
    const parameterType = firstParameter?.type ?? contextualParameter?.type
    const properties =
      parameterType === undefined
        ? { members: new Map(), resolved: false }
        : typeMembers(
            parameterType,
            analysis,
            filePath,
            new Set(),
            callableSubstitutions,
            new Map(),
            new Set(),
            callableGeneric.childGenericScope,
            recursiveDeclarations
          )
    const contextualReturnType = contextualType?.type
    const effectiveReturnType =
      returnType ?? contextualReturnType ?? (callableNode === undefined ? undefined : inferredReturnType(callableNode))
    const referenceNode =
      callableNode === undefined
        ? undefined
        : returnType === undefined && contextualReturnType === undefined
          ? (callableNode.body ?? callableNode)
          : callableNode
    const signature = {
      genericDescriptor: callableGeneric.descriptor,
      properties,
      returnType:
        effectiveReturnType === undefined
          ? undefined
          : canonicalTypeText(effectiveReturnType, analysis, filePath, callableSubstitutions, new Set(), {
              depth: 0,
              genericScope: callableGeneric.childGenericScope,
              substitutionPath: new Set(),
              recursiveDeclarations,
              referenceNode
            }),
      returnInferred:
        returnType === undefined && contextualReturnType === undefined && effectiveReturnType !== undefined,
      returnResolved: effectiveReturnType !== undefined
    }
    const existing = exports.get(name)
    if (existing === undefined) {
      exports.set(name, signature)
      return
    }
    const mergedProperties = typeMembersResult(new Map(), existing.properties.resolved && properties.resolved)
    collectTypeMembersResult(mergedProperties, existing.properties)
    collectTypeMembersResult(mergedProperties, properties)
    const returnTypes = [existing.returnType, signature.returnType].filter(Predicate.isString)
    exports.set(name, {
      genericDescriptor:
        existing.genericDescriptor === signature.genericDescriptor
          ? existing.genericDescriptor
          : `overloads(${[existing.genericDescriptor, signature.genericDescriptor].toSorted().join("|")})`,
      properties: mergedProperties,
      returnInferred: existing.returnInferred && signature.returnInferred,
      returnResolved: existing.returnResolved && signature.returnResolved,
      returnType: returnTypes.length === 0 ? undefined : [...new Set(returnTypes)].toSorted().join("|")
    })
  }
  const visit = (node) => {
    if (TypeScript.isExportAssignment(node) && !node.isExportEquals) {
      const expression = unwrapParenthesizedExpression(node.expression)
      if (TypeScript.isArrowFunction(expression) || TypeScript.isFunctionExpression(expression)) {
        addCallable(
          "default",
          expression.parameters,
          expression.type,
          undefined,
          expression.typeParameters,
          undefined,
          expression
        )
      }
    }
    if (
      TypeScript.isVariableStatement(node) &&
      module.scopeByNode.get(node) === module.moduleScope &&
      [...node.declarationList.declarations].some(
        (declaration) =>
          TypeScript.isIdentifier(declaration.name) && module.runtimeDeclarations.has(declaration.name.text)
      )
    ) {
      for (const declaration of node.declarationList.declarations) {
        const initializer =
          declaration.initializer === undefined ? undefined : unwrapParenthesizedExpression(declaration.initializer)
        if (
          !TypeScript.isIdentifier(declaration.name) ||
          initializer === undefined ||
          (!TypeScript.isArrowFunction(initializer) && !TypeScript.isFunctionExpression(initializer))
        ) {
          continue
        }
        const contextualType =
          declaration.type !== undefined && TypeScript.isFunctionTypeNode(declaration.type)
            ? declaration.type
            : undefined
        addCallable(
          declaration.name.text,
          initializer.parameters,
          initializer.type,
          contextualType,
          initializer.typeParameters,
          contextualType?.typeParameters,
          initializer
        )
      }
    }
    if (
      TypeScript.isFunctionDeclaration(node) &&
      module.scopeByNode.get(node) === module.moduleScope &&
      (node.name === undefined || module.runtimeDeclarations.has(node.name.text))
    ) {
      const callableName = node.name?.text ?? (hasDefaultModifier(node) ? "default" : undefined)
      if (callableName !== undefined && (node.body === undefined || !exports.has(callableName))) {
        addCallable(callableName, node.parameters, node.type, undefined, node.typeParameters, undefined, node)
      }
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return exports
}

const callableParameterTypes = (source, filePath) => {
  const detailed = callableParameterTypesInSources(new Map([[filePath, source]]), filePath)
  return new Map(
    [...detailed]
      .filter(([, signature]) => signature.properties.resolved && signature.properties.members.size > 0)
      .map(([name, signature]) => [name, new Set(signature.properties.members.keys())])
  )
}

const publicCallableAdditions = (previousSource, currentSource, filePath, reachableNames) => {
  const previous = callableParameterTypes(previousSource ?? "", filePath)
  const current = callableParameterTypes(currentSource, filePath)
  return [...current].flatMap(([name, properties]) => {
    if (reachableNames === undefined || !reachableNames.has(name)) return []
    const previousProperties = previous.get(name) ?? new Set()
    const added = [...properties].filter((property) => !previousProperties.has(property)).toSorted()
    return added.length === 0 ? [] : [{ filePath, name, properties: added }]
  })
}

const isExcludedSourcePath = (filePath) =>
  filePath.split("/").some((segment) => segment === "generated" || segment === "vendor" || segment === "node_modules")

const resolveLocalModule = (fromPath, specifier, sourceFiles) => {
  if (!specifier.startsWith(".")) return undefined
  const fromSegments = fromPath.split("/")
  fromSegments.pop()
  const targetSegments = []
  for (const segment of [...fromSegments, ...specifier.split("/")]) {
    if (segment === ".") continue
    if (segment === "..") {
      targetSegments.pop()
    } else {
      targetSegments.push(segment)
    }
  }
  const target = targetSegments.join("/")
  const withoutExtension = target.replace(/\.(?:[cm]?js|jsx|tsx?|d\.ts)$/u, "")
  const candidates = [
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`
  ]
  return candidates.find((candidate) => sourceFiles.has(candidate))
}

const normalizeEntryPoints = (entryPoints) =>
  entryPoints.map((entryPoint) =>
    Predicate.isString(entryPoint) ? { identity: entryPoint, sourcePath: entryPoint } : entryPoint
  )

const conditionPathKey = (conditionPath) => (conditionPath ?? []).join("\u0000")

const reachableCallableEntries = (sources, entryPoints, analysis = analyzeSources(sources)) => {
  const info = analysis.modules
  const resolved = new Map()
  const resolving = new Set()
  const exportsFor = (filePath) => {
    const cached = resolved.get(filePath)
    if (cached !== undefined) return cached
    if (resolving.has(filePath)) return new Map()
    const current = info.get(filePath)
    if (current === undefined) return new Map()
    resolving.add(filePath)
    const result = new Map([...current.local].map((name) => [name, { filePath, name }]))
    if (current.defaultExportName !== undefined) {
      result.set("default", { filePath, name: current.defaultExportName })
    }
    for (const [exportedName, alias] of current.aliases) {
      if (alias.sourceSpecifier === undefined) {
        const imported = current.imports.get(alias.importedName)
        if (imported !== undefined && imported.importedName !== "*") {
          const target = resolveLocalModule(filePath, imported.sourceSpecifier, sources)
          const targetExport = target === undefined ? undefined : exportsFor(target).get(imported.importedName)
          if (targetExport !== undefined) result.set(exportedName, targetExport)
        } else {
          result.set(exportedName, { filePath, name: alias.importedName })
        }
        continue
      }
      const target = resolveLocalModule(filePath, alias.sourceSpecifier, sources)
      const targetExport = target === undefined ? undefined : exportsFor(target).get(alias.importedName)
      if (targetExport !== undefined) result.set(exportedName, targetExport)
    }
    for (const sourceSpecifier of current.stars) {
      const target = resolveLocalModule(filePath, sourceSpecifier, sources)
      if (target === undefined) continue
      for (const [name, targetExport] of exportsFor(target)) {
        if (name !== "default" && !result.has(name)) result.set(name, targetExport)
      }
    }
    resolving.delete(filePath)
    resolved.set(filePath, result)
    return result
  }
  return normalizeEntryPoints(entryPoints).flatMap(({ conditionPath, identity, publicSubpath, sourcePath }) =>
    [...exportsFor(sourcePath)].map(([exportedName, target]) => ({
      conditionPath,
      entryPoint: identity,
      exportedName,
      publicSubpath,
      target
    }))
  )
}

const reachableCallableNames = (sources, entryPoints) => {
  const reachable = new Map()
  for (const { target } of reachableCallableEntries(sources, entryPoints)) {
    const names = reachable.get(target.filePath) ?? new Set()
    names.add(target.name)
    reachable.set(target.filePath, names)
  }
  return reachable
}

const publicCallableChanges = (
  previousSources,
  currentSources,
  previousEntryPoints,
  currentEntryPoints = previousEntryPoints,
  {
    compilerOptions,
    compilerOptionsByEntryPoint,
    currentCompilerOptions,
    currentCompilerOptionsByEntryPoint,
    previousCompilerOptions,
    previousCompilerOptionsByEntryPoint,
    programFactory = TypeScript.createProgram,
    recursiveDeclarations = new Set(),
    repositoryRoot
  } = {}
) => {
  const signatures = (sources, entryPoints, revisionCompilerOptions, revisionCompilerOptionsByEntryPoint) => {
    const result = new Map()
    const normalizedEntryPoints = normalizeEntryPoints(entryPoints ?? [])
    for (const entryPointDescriptor of normalizedEntryPoints) {
      const effectiveCompilerOptions =
        revisionCompilerOptionsByEntryPoint?.get(entryPointDescriptor.sourcePath) ??
        revisionCompilerOptions ??
        compilerOptionsByEntryPoint?.get(entryPointDescriptor.sourcePath) ??
        compilerOptions ??
        packageCompilerOptions(sources, repositoryRoot, { entryPointSourcePath: entryPointDescriptor.sourcePath })
      const analysis = analyzeSources(sources, recursiveDeclarations, {
        compilerOptions: effectiveCompilerOptions,
        programFactory
      })
      for (const { conditionPath, entryPoint, exportedName, publicSubpath, target } of reachableCallableEntries(
        sources,
        [entryPointDescriptor],
        analysis
      )) {
        const signature = callableParameterTypesInSources(
          sources,
          target.filePath,
          analysis,
          recursiveDeclarations
        ).get(target.name)
        if (signature === undefined) continue
        const identity = `${entryPoint}\u0000${exportedName}`
        const existing = result.get(identity) ?? []
        if (
          !existing.some(
            ({ conditionPath: existingConditionPath, filePath, name, publicSubpath: existingPublicSubpath }) =>
              filePath === target.filePath &&
              name === target.name &&
              conditionPathKey(existingConditionPath) === conditionPathKey(conditionPath) &&
              existingPublicSubpath === publicSubpath
          )
        ) {
          existing.push({ conditionPath, filePath: target.filePath, name: target.name, publicSubpath, ...signature })
          result.set(identity, existing)
        }
      }
      if (programFactory === TypeScript.createProgram) analysis.releaseChecker()
    }
    return result
  }
  const previous = signatures(
    previousSources,
    previousEntryPoints,
    previousCompilerOptions,
    previousCompilerOptionsByEntryPoint
  )
  const current = signatures(
    currentSources,
    currentEntryPoints,
    currentCompilerOptions,
    currentCompilerOptionsByEntryPoint
  )
  const changes = []
  const signatureContract = (signature) =>
    [
      `generic:${signature.genericDescriptor}`,
      signature.properties.resolved ? "resolved" : "unresolved",
      [...signature.properties.members.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => `${name}:${type}`)
        .join(","),
      signature.returnResolved ? `return:${signature.returnType}` : "return:unresolved"
    ].join("|")
  const signatureTargetKey = (signature) => `${signature.filePath}\u0000${signature.name}`
  const signaturePublicSubpathKey = (signature) => signature.publicSubpath ?? ""
  const signatureOccurrenceKey = (signature) =>
    `${signatureTargetKey(signature)}\u0000${signaturePublicSubpathKey(signature)}\u0000${conditionPathKey(
      signature.conditionPath
    )}`
  const pairSignatures = (previousSignatures, currentSignatures) => {
    const previousBaselines = previousSignatures.filter((signature) => conditionPathKey(signature.conditionPath) === "")
    const currentBaselines = currentSignatures.filter((signature) => conditionPathKey(signature.conditionPath) === "")
    const previousHasConditional = previousSignatures.some(
      (signature) => conditionPathKey(signature.conditionPath) !== ""
    )
    const currentHasConditional = currentSignatures.some(
      (signature) => conditionPathKey(signature.conditionPath) !== ""
    )
    const baselineFor = (baselines, signature, index) =>
      baselines.find(
        (baseline) => baseline.publicSubpath !== undefined && baseline.publicSubpath === signature.publicSubpath
      ) ??
      baselines.find((baseline) => signatureTargetKey(baseline) === signatureTargetKey(signature)) ??
      (baselines.length === 1
        ? baselines[0]
        : (baselines.find((baseline) => signatureContract(baseline) === signatureContract(signature)) ??
          baselines[index % baselines.length]))
    if (previousBaselines.length > 0 && currentHasConditional) {
      return {
        pairs: currentSignatures.map((signature, index) => [
          baselineFor(previousBaselines, signature, index),
          signature
        ]),
        currentOnly: [],
        previousOnly: []
      }
    }
    if (currentBaselines.length > 0 && previousHasConditional) {
      return {
        pairs: previousSignatures.map((signature, index) => [
          signature,
          baselineFor(currentBaselines, signature, index)
        ]),
        currentOnly: [],
        previousOnly: []
      }
    }
    const remainingPrevious = [...previousSignatures]
    const pairs = []
    const unmatchedCurrent = []
    for (const currentSignature of currentSignatures) {
      const index = remainingPrevious.findIndex(
        (previousSignature) =>
          conditionPathKey(previousSignature.conditionPath) === conditionPathKey(currentSignature.conditionPath) &&
          signaturePublicSubpathKey(previousSignature) === signaturePublicSubpathKey(currentSignature)
      )
      if (index === -1) {
        unmatchedCurrent.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const unmatchedAfterPublicSubpath = []
    for (const currentSignature of unmatchedCurrent) {
      const index = remainingPrevious.findIndex(
        (previousSignature) =>
          previousSignature.publicSubpath !== undefined &&
          previousSignature.publicSubpath === currentSignature.publicSubpath
      )
      if (index === -1) {
        unmatchedAfterPublicSubpath.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const unmatchedAfterTarget = []
    for (const currentSignature of unmatchedAfterPublicSubpath) {
      const index = remainingPrevious.findIndex(
        (previousSignature) =>
          previousSignature.filePath === currentSignature.filePath &&
          previousSignature.name === currentSignature.name &&
          conditionPathKey(previousSignature.conditionPath) === conditionPathKey(currentSignature.conditionPath)
      )
      if (index === -1) {
        unmatchedAfterTarget.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const unmatchedAfterContract = []
    for (const currentSignature of unmatchedAfterTarget) {
      const index = remainingPrevious.findIndex(
        (previousSignature) =>
          conditionPathKey(previousSignature.conditionPath) === conditionPathKey(currentSignature.conditionPath) &&
          signatureContract(previousSignature) === signatureContract(currentSignature)
      )
      if (index === -1) {
        unmatchedAfterContract.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const fallbackCurrent = []
    for (const currentSignature of unmatchedAfterContract) {
      const index = remainingPrevious.findIndex(
        (previousSignature) =>
          conditionPathKey(previousSignature.conditionPath) === conditionPathKey(currentSignature.conditionPath)
      )
      if (index === -1) {
        fallbackCurrent.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const pairedTargetKeys = new Set(
      pairs.flatMap(([previousSignature, currentSignature]) => [
        signatureOccurrenceKey(previousSignature),
        signatureOccurrenceKey(currentSignature)
      ])
    )
    const currentOnly = fallbackCurrent.filter(
      (signature) =>
        !previousSignatures.some(
          (previousSignature) =>
            conditionPathKey(previousSignature.conditionPath) === "" &&
            pairedTargetKeys.has(signatureOccurrenceKey(signature))
        )
    )
    const previousOnly = remainingPrevious.filter(
      (signature) =>
        !currentSignatures.some(
          (currentSignature) =>
            conditionPathKey(currentSignature.conditionPath) === "" &&
            pairedTargetKeys.has(signatureOccurrenceKey(signature))
        )
    )
    return {
      pairs,
      currentOnly,
      previousOnly
    }
  }
  const compareSignatures = (previousSignature, currentSignature) => {
    const currentProperties = currentSignature?.properties.members ?? new Map()
    const previousProperties = previousSignature?.properties.members ?? new Map()
    let contractChanged = false
    if (previousSignature === undefined && currentSignature !== undefined && currentProperties.size === 0) {
      changes.push({
        kind: "callable-addition",
        filePath: currentSignature.filePath,
        name: currentSignature.name,
        properties: []
      })
    }
    if (
      previousSignature !== undefined &&
      currentSignature !== undefined &&
      currentSignature.genericDescriptor !== previousSignature.genericDescriptor
    ) {
      contractChanged = true
      changes.push({
        kind: "type-change",
        filePath: currentSignature.filePath,
        name: currentSignature.name,
        properties: []
      })
    }
    if (
      currentSignature !== undefined &&
      currentSignature.properties.resolved &&
      (previousSignature === undefined || previousSignature.properties.resolved)
    ) {
      for (const property of [...currentProperties.keys()].toSorted()) {
        if (!previousProperties.has(property)) {
          contractChanged = true
          changes.push({
            kind: "addition",
            filePath: currentSignature.filePath,
            name: currentSignature.name,
            properties: [property]
          })
        }
      }
      for (const property of [...previousProperties.keys()].toSorted()) {
        if (!currentProperties.has(property)) {
          contractChanged = true
          changes.push({
            kind: "removal",
            filePath: currentSignature.filePath,
            name: currentSignature.name,
            properties: [property]
          })
        }
      }
    }
    if (currentSignature !== undefined) {
      for (const property of [...currentProperties.keys()].toSorted()) {
        const previousType = previousProperties.get(property)
        const currentType = currentProperties.get(property)
        if (previousType !== undefined && currentType !== undefined && previousType !== currentType) {
          contractChanged = true
          changes.push({
            kind: "type-change",
            filePath: currentSignature.filePath,
            name: currentSignature.name,
            properties: [property]
          })
        }
      }
    }
    if (
      previousSignature !== undefined &&
      currentSignature !== undefined &&
      currentSignature.returnResolved &&
      previousSignature.returnResolved &&
      currentSignature.returnType !== previousSignature.returnType &&
      (!contractChanged || currentSignature.returnInferred !== true)
    ) {
      changes.push({
        kind: "return-type-change",
        filePath: currentSignature.filePath,
        name: currentSignature.name,
        properties: []
      })
    }
  }
  const compareIdentity = (currentSignatures, previousSignatures) => {
    const { currentOnly, pairs, previousOnly } = pairSignatures(previousSignatures, currentSignatures)
    const comparedPairs = new Set()
    for (const [previousSignature, currentSignature] of pairs) {
      const pairKey = [
        signatureOccurrenceKey(previousSignature),
        signatureOccurrenceKey(currentSignature),
        conditionPathKey(previousSignature.conditionPath),
        conditionPathKey(currentSignature.conditionPath),
        signatureContract(previousSignature),
        signatureContract(currentSignature)
      ].join("\u0000")
      if (comparedPairs.has(pairKey)) continue
      comparedPairs.add(pairKey)
      compareSignatures(previousSignature, currentSignature)
    }
    const currentTargets = new Set()
    for (const currentSignature of currentOnly) {
      const targetKey = signatureOccurrenceKey(currentSignature)
      if (currentTargets.has(targetKey)) continue
      currentTargets.add(targetKey)
      compareSignatures(undefined, currentSignature)
    }
    const previousTargets = new Set()
    for (const previousSignature of previousOnly) {
      const targetKey = signatureOccurrenceKey(previousSignature)
      if (previousTargets.has(targetKey)) continue
      previousTargets.add(targetKey)
      changes.push({
        kind: "callable-removal",
        filePath: previousSignature.filePath,
        name: previousSignature.name,
        properties: [...previousSignature.properties.members.keys()].toSorted()
      })
    }
  }
  for (const [identity, currentSignatures] of current) {
    compareIdentity(currentSignatures, previous.get(identity) ?? [])
  }
  for (const [identity, previousSignatures] of previous) {
    if (!current.has(identity)) compareIdentity([], previousSignatures)
  }
  const uniqueChanges = new Map()
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.filePath}\u0000${change.name}\u0000${change.properties.join("\u0000")}`
    if (!uniqueChanges.has(key)) uniqueChanges.set(key, change)
  }
  return [...uniqueChanges.values()]
}

const toPublicCallableChangesError = (cause) =>
  cause instanceof ChangesetCoverageError
    ? cause
    : new ChangesetCoverageError({ cause, reason: "Public callable changes analysis failed" })

const publicCallableChangesEffect = (
  previousSources,
  currentSources,
  previousEntryPoints,
  currentEntryPoints = previousEntryPoints
) =>
  Effect.try({
    try: () => publicCallableChanges(previousSources, currentSources, previousEntryPoints, currentEntryPoints),
    catch: toPublicCallableChangesError
  })

const validatePublicCallableReleaseTypes = ({ changes, releaseTypes }) =>
  changes.flatMap(({ filePath, kind = "addition", name, packageName, properties }) => {
    if (releaseTypes.get(packageName) !== "patch") return []
    const action =
      kind === "addition" || kind === "callable-addition"
        ? "add"
        : kind === "removal" || kind === "callable-removal"
          ? "remove"
          : "change"
    const diagnostic = [
      `${packageName}: patch changeset cannot ${action} public callable${kind === "callable-removal" ? "" : " props"}`,
      properties.length === 0 ? undefined : properties.join(", "),
      `(${name} in ${filePath})`
    ]
      .filter((part) => part !== undefined)
      .join(" ")
    return [diagnostic]
  })

const fail = (reason, cause) => Effect.fail(new ChangesetCoverageError({ cause, reason }))

const splitLines = (output) => output.split(/\r?\n/u).filter((line) => line.length > 0)

const parseChangesetFrontmatter = (content, changesetPath) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) throw new ChangesetCoverageError({ reason: `${changesetPath}: changeset frontmatter is missing` })
  const frontmatter = parse(match[1])
  if (frontmatter === null || !Predicate.isObjectOrArray(frontmatter) || Array.isArray(frontmatter)) {
    throw new ChangesetCoverageError({
      reason: `${changesetPath}: changeset frontmatter must be a package-to-release map`
    })
  }
  const packages = new Set()
  for (const [name, releaseType] of Object.entries(frontmatter)) {
    if (!releaseTypes.has(releaseType)) {
      throw new ChangesetCoverageError({
        reason: `${changesetPath}: ${name} has invalid release type ${JSON.stringify(releaseType)}`
      })
    }
    packages.add(name)
  }
  return packages
}

const parseChangesetReleaseTypes = (content, changesetPath) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) throw new ChangesetCoverageError({ reason: `${changesetPath}: changeset frontmatter is missing` })
  const frontmatter = parse(match[1])
  if (frontmatter === null || !Predicate.isObjectOrArray(frontmatter) || Array.isArray(frontmatter)) {
    throw new ChangesetCoverageError({
      reason: `${changesetPath}: changeset frontmatter must be a package-to-release map`
    })
  }
  const releases = new Map()
  for (const [name, releaseType] of Object.entries(frontmatter)) {
    if (!releaseTypes.has(releaseType)) {
      throw new ChangesetCoverageError({
        reason: `${changesetPath}: ${name} has invalid release type ${JSON.stringify(releaseType)}`
      })
    }
    releases.set(name, releaseType)
  }
  return releases
}

const selectedReleaseManifestFields = (manifest) =>
  Object.fromEntries(releaseManifestFields.map((field) => [field, manifest?.[field]]))

const manifestsDifferForRelease = (current, previous) =>
  JSON.stringify(selectedReleaseManifestFields(current)) !== JSON.stringify(selectedReleaseManifestFields(previous))

const releaseBearingPackages = (paths, records) =>
  records.filter(
    ({ changedReleaseManifest, directory, publishable }) =>
      publishable &&
      (changedReleaseManifest || [...paths].some((changedPath) => changedPath.startsWith(`${directory}/src/`)))
  )

const validateCoverage = ({ changedChangesetNames, paths, records }) =>
  releaseBearingPackages(paths, records)
    .filter(({ name }) => !changedChangesetNames.has(name))
    .map(({ name }) => name)
    .toSorted()

const validatePublicCallableChangesets = (changes, releaseTypes) =>
  [
    ...new Set(
      changes
        .map(({ packageName }) => packageName)
        .filter(Predicate.isString)
        .filter((packageName) => !releaseTypes.has(packageName))
    )
  ].toSorted()

const runSelfTest = () => {
  const records = [
    {
      changedReleaseManifest: false,
      directory: "packages/public",
      name: "@fixture/public",
      publishable: true
    },
    {
      changedReleaseManifest: false,
      directory: "packages/private",
      name: "@fixture/private",
      publishable: false
    }
  ]
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/public"]),
      paths: new Set(["packages/public/src/index.ts", ".changeset/current.md"]),
      records
    }),
    []
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/public/src/index.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  // The path set deliberately carries deleted paths too; a deleted public source
  // file in a surviving package must still be covered.
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/public/src/deleted.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/private/src/index.ts", "packages/public/test/index.test.ts"]),
      records
    }),
    []
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/baseline-only"]),
      paths: new Set(["packages/public/src/index.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/public"]),
      paths: new Set(["packages/public/package.json"]),
      records: [{ ...records[0], changedReleaseManifest: true }]
    }),
    []
  )
  assert.equal(shouldAnalyzePublicCallableChanges({ ...records[0], changedReleaseManifest: true }, []), true)
  assert.equal(shouldAnalyzePublicCallableChanges({ ...records[0], changedReleaseManifest: false }, []), false)
  assert.equal(shouldAnalyzePublicCallableChanges({ ...records[0], changedReleaseManifest: false }, [], true), true)
  assert.equal(
    shouldAnalyzePublicCallableChanges({ ...records[0], changedReleaseManifest: false }, [
      "packages/public/src/index.ts"
    ]),
    true
  )
  assert.equal(shouldAnalyzePublicCallableChanges(records[1], ["packages/private/src/index.ts"]), false)
  assert.equal(
    manifestsDifferForRelease(
      { dependencies: { effect: "4.0.0-rc.109" } },
      { dependencies: { effect: "4.0.0-beta.98" } }
    ),
    true
  )
  assert.equal(
    manifestsDifferForRelease(
      { devDependencies: { effect: "4.0.0-rc.109" } },
      { devDependencies: { effect: "4.0.0-beta.98" } }
    ),
    false
  )
  assert.deepEqual(
    [...parseChangesetFrontmatter('---\n"@fixture/public": patch\n---\n\nSummary.\n', ".changeset/valid.md")],
    ["@fixture/public"]
  )
  assert.throws(
    () => parseChangesetFrontmatter('---\n"@fixture/public": invalid\n---\n', ".changeset/invalid.md"),
    /invalid release type/u
  )
  const sourceFiles = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = ({ value }: Props) => value\nexport const Internal = ({ value }: Props) => value"
    ]
  ])
  assert.deepEqual(
    reachableCallableNames(sourceFiles, ["packages/public/src/index.ts"]).get("packages/public/src/view.tsx"),
    new Set(["Public"])
  )
  const refactoredPrevious = "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
  const refactoredCurrent = "type Props = { value: string }\nexport const Public = ({ value }: Props) => value"
  assert.deepEqual(
    publicCallableAdditions(refactoredPrevious, refactoredCurrent, "packages/public/src/view.tsx", new Set(["Public"])),
    []
  )
  assert.deepEqual(publicCallableAdditions(refactoredPrevious, refactoredCurrent, "packages/public/src/view.tsx"), [])
  const previousSource = "type Props = { value: string }\nexport const Public = ({ value }: Props) => value"
  const currentSource =
    "type Props = { value: string; terminalViewportRef?: string }\nexport const Public = ({ value, terminalViewportRef }: Props) => value"
  const additions = publicCallableAdditions(
    previousSource,
    currentSource,
    "packages/public/src/view.tsx",
    new Set(["Public"])
  ).map((addition) => ({ ...addition, packageName: "@fixture/public" }))
  assert.deepEqual(additions, [
    {
      filePath: "packages/public/src/view.tsx",
      name: "Public",
      packageName: "@fixture/public",
      properties: ["terminalViewportRef"]
    }
  ])
  assert.deepEqual(
    validatePublicCallableReleaseTypes({ changes: additions, releaseTypes: new Map([["@fixture/public", "patch"]]) }),
    [
      "@fixture/public: patch changeset cannot add public callable props terminalViewportRef (Public in packages/public/src/view.tsx)"
    ]
  )
  assert.deepEqual(
    validatePublicCallableReleaseTypes({ changes: additions, releaseTypes: new Map([["@fixture/public", "minor"]]) }),
    []
  )
  const releaseOrders = [
    ["major", "minor", "patch"],
    ["major", "patch", "minor"],
    ["minor", "major", "patch"],
    ["minor", "patch", "major"],
    ["patch", "major", "minor"],
    ["patch", "minor", "major"]
  ]
  for (const order of releaseOrders) {
    assert.equal(
      order.reduce((current, incoming) => mergeReleaseType(current, incoming), undefined),
      "major"
    )
  }
  assert.equal(mergeReleaseType("patch", "patch"), "patch")
  assert.deepEqual(
    sourcePaths(
      new Set([
        "packages/public/src/index.ts",
        "packages/public/src/generated/public.ts",
        "packages/public/src/vendor/public.ts",
        "packages/private/src/internal.ts"
      ])
    ),
    ["packages/public/src/index.ts", "packages/private/src/internal.ts"]
  )
  assert.equal(isExcludedSourcePath("packages/public/src/generated/public.ts"), true)
  assert.equal(isExcludedSourcePath("packages/public/src/vendor/public.ts"), true)
  const manifestSources = [
    "packages/public/src/index.ts",
    "packages/public/src/feature/view.ts",
    "packages/public/src/internal.ts",
    "packages/public/src/generated/generated.ts",
    "packages/public/src/vendor/vendor.ts"
  ]
  assert.deepEqual(manifestEntryPoints({ main: "src/index.ts" }, "packages/public", manifestSources), [
    "packages/public/src/index.ts"
  ])
  assert.deepEqual(
    manifestEntryPoints(
      { main: "src/internal.ts", publishConfig: { main: "dist/index.js", types: "dist/dts/index.d.ts" } },
      "packages/public",
      manifestSources
    ),
    ["packages/public/src/index.ts"]
  )
  assert.deepEqual(
    manifestEntryPoints(
      { publishConfig: { exports: { ".": "./dist/index.js", "./*.js": "./dist/*.js" } } },
      "packages/public",
      manifestSources
    ),
    ["packages/public/src/index.ts", "packages/public/src/feature/view.ts", "packages/public/src/internal.ts"]
  )

  const sharedPropsPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'import type { Props } from "./types.js"\nexport const Public = (props: Props) => props.value'
    ],
    ["packages/public/src/types.ts", "export type Props = { value: string }"]
  ])
  const sharedPropsCurrent = new Map([
    ...sharedPropsPrevious,
    ["packages/public/src/types.ts", "export type Props = { value: string; terminalViewportRef?: string }"]
  ])
  assert.deepEqual(publicCallableChanges(sharedPropsPrevious, sharedPropsCurrent, ["packages/public/src/index.ts"]), [
    {
      kind: "addition",
      filePath: "packages/public/src/view.tsx",
      name: "Public",
      properties: ["terminalViewportRef"]
    }
  ])

  const barrelSources = new Map([
    ["packages/public/src/index.ts", 'import { Public } from "./view.js"\nexport { Public }'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = ({ value }: Props) => value"
    ]
  ])
  assert.deepEqual(
    [
      ...(reachableCallableNames(barrelSources, ["packages/public/src/index.ts"]).get("packages/public/src/view.tsx") ??
        [])
    ],
    ["Public"]
  )
  const barrelCurrent = new Map([
    ["packages/public/src/index.ts", 'import { Public } from "./view.js"\nexport { Public }'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string; terminalViewportRef?: string }\nexport const Public = ({ value }: Props) => value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(barrelSources, barrelCurrent, ["packages/public/src/index.ts"]), [
    {
      kind: "addition",
      filePath: "packages/public/src/view.tsx",
      name: "Public",
      properties: ["terminalViewportRef"]
    }
  ])
  const exportListPrevious = new Map([["packages/public/src/index.ts", "const Added = (): void => {}\nexport {}"]])
  const exportListCurrent = new Map([
    ["packages/public/src/index.ts", "const Added = (): void => {}\nexport { Added }"]
  ])
  assert.deepEqual(publicCallableChanges(exportListPrevious, exportListCurrent, ["packages/public/src/index.ts"]), [
    { kind: "callable-addition", filePath: "packages/public/src/index.ts", name: "Added", properties: [] }
  ])
  assert.deepEqual(publicCallableChanges(exportListPrevious, exportListPrevious, ["packages/public/src/index.ts"]), [])

  const incompatiblePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string; label: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const incompatibleCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: number }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(incompatiblePrevious, incompatibleCurrent, ["packages/public/src/index.ts"]), [
    { kind: "removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["label"] },
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])
  assert.deepEqual(
    validatePublicCallableReleaseTypes({
      changes: [
        {
          kind: "removal",
          filePath: "packages/public/src/view.tsx",
          name: "Public",
          packageName: "@fixture/public",
          properties: ["label"]
        },
        {
          kind: "type-change",
          filePath: "packages/public/src/view.tsx",
          name: "Public",
          packageName: "@fixture/public",
          properties: ["value"]
        }
      ],
      releaseTypes: new Map([["@fixture/public", "patch"]])
    }),
    [
      "@fixture/public: patch changeset cannot remove public callable props label (Public in packages/public/src/view.tsx)",
      "@fixture/public: patch changeset cannot change public callable props value (Public in packages/public/src/view.tsx)"
    ]
  )
  const privateTypePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'import type { InternalProps, Props } from "./types.js"\nexport const Public = (props: Props) => props.value\nconst Internal = (props: InternalProps) => props.debug'
    ],
    [
      "packages/public/src/types.ts",
      "export type Props = { value: string }\nexport type InternalProps = { debug: boolean }"
    ]
  ])
  const privateTypeCurrent = new Map([
    ...privateTypePrevious,
    [
      "packages/public/src/types.ts",
      "export type Props = { value: string }\nexport type InternalProps = { debug: string }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(privateTypePrevious, privateTypeCurrent, ["packages/public/src/index.ts"]), [])

  const movedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./old-view.js"'],
    [
      "packages/public/src/old-view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const movedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./new-view.js"'],
    [
      "packages/public/src/new-view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(movedPrevious, movedCurrent, ["packages/public/src/index.ts"]), [])
  const movedWithAdditionCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./new-view.js"'],
    [
      "packages/public/src/new-view.tsx",
      "type Props = { value: string; terminalViewportRef?: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(movedPrevious, movedWithAdditionCurrent, ["packages/public/src/index.ts"]), [
    {
      kind: "addition",
      filePath: "packages/public/src/new-view.tsx",
      name: "Public",
      properties: ["terminalViewportRef"]
    }
  ])

  const optionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { label?: string }\nexport const Public = (props: Props) => props.label"
    ]
  ])
  const optionalCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { label: string }\nexport const Public = (props: Props) => props.label"
    ]
  ])
  assert.deepEqual(publicCallableChanges(optionalPrevious, optionalCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["label"] }
  ])

  const namedTupleOptionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [value?: string] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const namedTupleOptionalMarkerCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [value: string] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleOptionalPrevious, namedTupleOptionalMarkerCurrent, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const namedTupleOptionalLabelCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [renamed?: string] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleOptionalPrevious, namedTupleOptionalLabelCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const unnamedTupleOptionalCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [string?] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleOptionalPrevious, unnamedTupleOptionalCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const namedTupleRestPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [...values: string[]] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const namedTupleRestMarkerCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [values: string[]] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleRestPrevious, namedTupleRestMarkerCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const namedTupleRestLabelCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [...items: string[]] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleRestPrevious, namedTupleRestLabelCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const unnamedTupleRestCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [...string[]] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedTupleRestPrevious, unnamedTupleRestCurrent, ["packages/public/src/index.ts"]),
    []
  )

  const inheritedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface BaseProps { value: string }\ninterface Props extends BaseProps {}\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const inheritedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface BaseProps { value: string; terminalViewportRef?: string }\ninterface Props extends BaseProps {}\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(inheritedPrevious, inheritedCurrent, ["packages/public/src/index.ts"]), [
    {
      kind: "addition",
      filePath: "packages/public/src/view.tsx",
      name: "Public",
      properties: ["terminalViewportRef"]
    }
  ])

  const unionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string; label: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const unionCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type A = { value: string }\ntype B = { label: string }\ntype Props = A | B\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(unionPrevious, unionCurrent, ["packages/public/src/index.ts"]), [
    { kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])

  const removedCurrent = new Map([
    ["packages/public/src/index.ts", "export {}"],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(movedPrevious, removedCurrent, ["packages/public/src/index.ts"]), [
    {
      kind: "callable-removal",
      filePath: "packages/public/src/old-view.tsx",
      name: "Public",
      properties: ["value"]
    }
  ])

  const unresolvedCallablePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type A = { value: string }\ntype B = { label: string }\ntype Props = A | B\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const unresolvedCallableCurrent = new Map([
    ["packages/public/src/index.ts", "export {}"],
    [
      "packages/public/src/view.tsx",
      "type A = { value: string }\ntype B = { label: string }\ntype Props = A | B\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const unresolvedCallableRemoval = publicCallableChanges(unresolvedCallablePrevious, unresolvedCallableCurrent, [
    "packages/public/src/index.ts"
  ]).map((change) => ({ ...change, packageName: "@fixture/public" }))
  assert.deepEqual(unresolvedCallableRemoval, [
    {
      kind: "callable-removal",
      filePath: "packages/public/src/view.tsx",
      name: "Public",
      packageName: "@fixture/public",
      properties: ["label", "value"]
    }
  ])
  assert.deepEqual(
    validatePublicCallableReleaseTypes({
      changes: unresolvedCallableRemoval,
      releaseTypes: new Map([["@fixture/public", "patch"]])
    }),
    [
      "@fixture/public: patch changeset cannot remove public callable label, value (Public in packages/public/src/view.tsx)"
    ]
  )

  const overriddenPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface BaseProps { value: string }\ninterface Props extends BaseProps { value: "a" }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  const overriddenCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface BaseProps { value: string }\ninterface Props extends BaseProps { value: "b" }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.deepEqual(publicCallableChanges(overriddenPrevious, overriddenCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])

  const unresolvedBasePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = ExternalProps & { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const unresolvedBaseCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = ExternalProps & { value: number }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(unresolvedBasePrevious, unresolvedBaseCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const externalNamespaceSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'import * as Effect from "effect/Effect"\ntype Props = { run: Effect.Effect<string> }\nexport const Public = (props: Props) => props.run'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(externalNamespaceSources, externalNamespaceSources, ["packages/public/src/index.ts"]),
    []
  )

  const genericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Base<T> { value: T }\ninterface Props extends Base<string> {}\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const genericCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Base<T> { value: T }\ninterface Props extends Base<number> {}\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(genericPrevious, genericCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])

  const recursiveGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Leaf<T> = { value: T }\ntype Wrapped<T> = Leaf<T>\ntype Props = Wrapped<string>\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const recursiveGenericCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Leaf<T> = { value: T }\ntype Wrapped<T> = Leaf<T>\ntype Props = Wrapped<number>\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(recursiveGenericPrevious, recursiveGenericPrevious, ["packages/public/src/index.ts"]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(recursiveGenericPrevious, recursiveGenericCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const recursiveSubstitutedGenericSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Box<T> = { nested: T; payload: Payload }\nexport type Node = Box<Node[]>"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveSubstitutedGenericSources, recursiveSubstitutedGenericSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const finiteSubstitutedGenericSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Box<T> = { nested: T; payload: Payload }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Box, Payload } from "./types.js"\ntype Props = { value: Box<Payload[]> }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteSubstitutedGenericSources, finiteSubstitutedGenericSources, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const finiteWrappedForwardingSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Box<T> = { value: T }\ntype Props<T> = Box<T[]>\nexport function Public<T>(props: Props<T>) { return props }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteWrappedForwardingSources, finiteWrappedForwardingSources, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const directCyclicSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop = ReadonlyArray<Loop>\ntype Props = { value: Loop }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const unchangedRecursiveDeclarationPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type CommentThread = { replies: CommentThread[] }\nexport type Props = { thread: CommentThread; label: string }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Props } from "./types.js"\nexport const Public = (props: Props) => props.label'
    ]
  ])
  const unchangedRecursiveDeclarationCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type CommentThread = { replies: CommentThread[] }\nexport type Props = { thread: CommentThread; label: number }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Props } from "./types.js"\nexport const Public = (props: Props) => props.label'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(
      unchangedRecursiveDeclarationPrevious,
      unchangedRecursiveDeclarationCurrent,
      ["packages/public/src/index.ts"],
      ["packages/public/src/index.ts"],
      {
        recursiveDeclarations: unchangedDeclarationKeys(
          unchangedRecursiveDeclarationPrevious,
          unchangedRecursiveDeclarationCurrent
        )
      }
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["label"] }]
  )
  assert.throws(
    () => publicCallableChanges(directCyclicSources, directCyclicSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop"
  )
  const recursiveObjectSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; branch: Branch }\nexport type Branch = { payload: Payload; node: Node }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () => publicCallableChanges(recursiveObjectSources, recursiveObjectSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveArraySources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; children: Node[] }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () => publicCallableChanges(recursiveArraySources, recursiveArraySources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveTupleSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; children: [Node] }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () => publicCallableChanges(recursiveTupleSources, recursiveTupleSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveOptionalTupleSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; children: [Node?] }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveOptionalTupleSources, recursiveOptionalTupleSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveRestTupleSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; children: [...Node[]] }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () => publicCallableChanges(recursiveRestTupleSources, recursiveRestTupleSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const finiteOptionalTupleSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Payload = { id: string }\ntype Props = { value: [Payload?] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteOptionalTupleSources, finiteOptionalTupleSources, ["packages/public/src/index.ts"]),
    []
  )
  const finiteRestTupleSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Payload = { id: string }\ntype Props = { value: [...Payload[]] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteRestTupleSources, finiteRestTupleSources, ["packages/public/src/index.ts"]),
    []
  )
  const diamondTypes = ["type Diamond0 = { payload: string }"]
  for (let index = 1; index <= 20; index++) {
    diamondTypes.push(`type Diamond${index} = { left: Diamond${index - 1}; right: Diamond${index - 1} }`)
  }
  const diamondSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `${diamondTypes.join("\n")}\ntype Props = Diamond20\nexport const Public = (props: Props) => props.value`
    ]
  ])
  assert.deepEqual(publicCallableChanges(diamondSources, diamondSources, ["packages/public/src/index.ts"]), [])
  const genericDiamondTypes = ["type Diamond0<T0> = { value: T0 }"]
  for (let index = 1; index <= 20; index++) {
    const parameterName = `T${index}`
    genericDiamondTypes.push(
      `type Diamond${index}<${parameterName}> = { left: Diamond${index - 1}<${parameterName}>; right: Diamond${
        index - 1
      }<${parameterName}> }`
    )
  }
  const genericDiamondSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `${genericDiamondTypes.join(
        "\n"
      )}\ntype Props = { value: Diamond20<string> }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  const genericDiamondAnalysis = analyzeSources(genericDiamondSources)
  const genericDiamondModule = genericDiamondAnalysis.modules.get("packages/public/src/view.tsx")
  assert(genericDiamondModule !== undefined)
  const genericDiamondProps = genericDiamondModule.declarations.get("Props")
  assert(genericDiamondProps !== undefined)
  assert(TypeScript.isTypeAliasDeclaration(genericDiamondProps))
  const genericDiamondMemo = new Map()
  const genericDiamondMembers = typeMembers(
    genericDiamondProps.type,
    genericDiamondAnalysis,
    "packages/public/src/view.tsx",
    new Set(),
    new Map(),
    genericDiamondMemo
  )
  assert.equal(genericDiamondMembers.resolved, true)
  const genericDiamondMemoEntries = [...Array(21).keys()].reduce(
    (count, index) =>
      count + (genericDiamondMemo.get(`packages/public/src/view.tsx\u0000Diamond${index}`)?.length ?? 0),
    0
  )
  assert.equal(genericDiamondMemoEntries, 21)
  const distinctGenericArgumentSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Leaf<T> = { value: T }\ntype Props = { left: Leaf<string>; right: Leaf<number> }\nexport const Public = (props: Props) => props"
    ]
  ])
  const distinctGenericArgumentAnalysis = analyzeSources(distinctGenericArgumentSources)
  const distinctGenericArgumentModule = distinctGenericArgumentAnalysis.modules.get("packages/public/src/view.tsx")
  assert(distinctGenericArgumentModule !== undefined)
  const distinctGenericArgumentProps = distinctGenericArgumentModule.declarations.get("Props")
  assert(distinctGenericArgumentProps !== undefined)
  assert(TypeScript.isTypeAliasDeclaration(distinctGenericArgumentProps))
  const distinctGenericArgumentMemo = new Map()
  typeMembers(
    distinctGenericArgumentProps.type,
    distinctGenericArgumentAnalysis,
    "packages/public/src/view.tsx",
    new Set(),
    new Map(),
    distinctGenericArgumentMemo
  )
  assert.equal(distinctGenericArgumentMemo.get("packages/public/src/view.tsx\u0000Leaf")?.length, 2)
  const crossModuleMemoSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Leaf<T> = { value: T }"],
    [
      "packages/public/src/left.ts",
      'import type { Leaf } from "./types.js"\ntype Local = number\nexport type Left = Leaf<Local>'
    ],
    [
      "packages/public/src/right.ts",
      'import type { Leaf } from "./types.js"\ntype Local = boolean\nexport type Right = Leaf<Local>'
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Left } from "./left.js"\nimport type { Right } from "./right.js"\ntype Props = { left: Left; right: Right }\nexport const Public = (props: Props) => props'
    ]
  ])
  const crossModuleMemoAnalysis = analyzeSources(crossModuleMemoSources)
  const crossModuleMemoModule = crossModuleMemoAnalysis.modules.get("packages/public/src/view.tsx")
  assert(crossModuleMemoModule !== undefined)
  const crossModuleMemoProps = crossModuleMemoModule.declarations.get("Props")
  assert(crossModuleMemoProps !== undefined)
  assert(TypeScript.isTypeAliasDeclaration(crossModuleMemoProps))
  const crossModuleMemo = new Map()
  typeMembers(
    crossModuleMemoProps.type,
    crossModuleMemoAnalysis,
    "packages/public/src/view.tsx",
    new Set(),
    new Map(),
    crossModuleMemo
  )
  const crossModuleMemoEntries = crossModuleMemo.get("packages/public/src/types.ts\u0000Leaf")
  assert.equal(crossModuleMemoEntries?.length, 2)
  assert.deepEqual(
    crossModuleMemoEntries?.map(({ result: { members } }) => members.get("value")),
    ["required:number", "required:boolean"]
  )
  const recursiveReadonlyArraySources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; children: readonly Node[] }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { value: Node }\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveReadonlyArraySources, recursiveReadonlyArraySources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const finiteReadonlyArraySources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Payload = { id: string }\ntype Props = { value: readonly Payload[] }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteReadonlyArraySources, finiteReadonlyArraySources, ["packages/public/src/index.ts"]),
    []
  )
  const recursiveMethodParameterSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { child: Node }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(value: Node): void }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveMethodParameterSources, recursiveMethodParameterSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveMethodReturnSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { child: Node }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(): Node }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveMethodReturnSources, recursiveMethodReturnSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveUnionMethodParameterSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { child: Node }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(value: Node | null): void }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveUnionMethodParameterSources, recursiveUnionMethodParameterSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const recursiveUnionMethodReturnSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { child: Node }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(): Node | null }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveUnionMethodReturnSources, recursiveUnionMethodReturnSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const finiteUnionMethodSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { id: string }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(value: Node | null): Node | null }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteUnionMethodSources, finiteUnionMethodSources, ["packages/public/src/index.ts"]),
    []
  )
  const finiteMethodSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Node = { id: string }"],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit(value: Node): Node }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteMethodSources, finiteMethodSources, ["packages/public/src/index.ts"]),
    []
  )
  const recursiveFunctionPropertySources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/types.ts",
      "export type Payload = { id: string }\nexport type Node = { payload: Payload; child: Node }"
    ],
    [
      "packages/public/src/view.tsx",
      'import type { Node } from "./types.js"\ntype Props = { visit: (node: Node) => void }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(recursiveFunctionPropertySources, recursiveFunctionPropertySources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Node"
  )
  const finiteFunctionPropertySources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Payload = { id: string }"],
    [
      "packages/public/src/view.tsx",
      'import type { Payload } from "./types.js"\ntype Props = { visit: (node: Payload) => void }\nexport const Public = (props: Props) => props.visit'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(finiteFunctionPropertySources, finiteFunctionPropertySources, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const finiteAliasSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Item = ReadonlyArray<string>\ntype Props = { value: Item }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(finiteAliasSources, finiteAliasSources, ["packages/public/src/index.ts"]), [])
  const shadowedGenericSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Alias<Alias> = Alias\ntype Props = { value: Alias<string> }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(shadowedGenericSources, shadowedGenericSources, ["packages/public/src/index.ts"]),
    []
  )
  const renamedFiniteCollisionSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Alias<T> = { value: T }\nexport type Orig<T> = Alias<T>"],
    [
      "packages/public/src/view.tsx",
      'import type { Orig as Alias } from "./types.js"\ntype Props = Alias<string>\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(renamedFiniteCollisionSources, renamedFiniteCollisionSources, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const renamedRecursiveAliasSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Alias<T> = Orig<T>\nexport type Orig<T> = Alias<T>"],
    [
      "packages/public/src/view.tsx",
      'import type { Orig as Alias } from "./types.js"\ntype Props = Alias<string>\nexport const Public = (props: Props) => props.value'
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(renamedRecursiveAliasSources, renamedRecursiveAliasSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/types.ts: recursive type declaration while canonicalizing Orig<T>"
  )
  const directCycleFailure = Effect.runSync(
    publicCallableChangesEffect(directCyclicSources, directCyclicSources, ["packages/public/src/index.ts"]).pipe(
      Effect.flip
    )
  )
  assert(directCycleFailure instanceof ChangesetCoverageError)
  assert.equal(
    directCycleFailure.reason,
    "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop"
  )
  assert.deepEqual(
    Effect.runSync(
      publicCallableChangesEffect(finiteAliasSources, finiteAliasSources, ["packages/public/src/index.ts"])
    ),
    []
  )
  const cyclicSources = new Map([["packages/public/src/cycle.ts", "type Loop = Loop"]])
  const cyclicModule = analyzeSources(cyclicSources).modules.get("packages/public/src/cycle.ts")
  assert(cyclicModule !== undefined)
  const cyclicAlias = cyclicModule.declarations.get("Loop")
  assert(TypeScript.isTypeAliasDeclaration(cyclicAlias))
  assert.throws(
    () =>
      canonicalTypeText(
        cyclicAlias.type,
        analyzeSources(cyclicSources),
        "packages/public/src/cycle.ts",
        new Map([["Loop", cyclicAlias.type]])
      ),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/cycle.ts: recursive type substitution while canonicalizing Loop"
  )
  const deeplyNestedType = (leaf, depth) => `${"Wrap<".repeat(depth)}${leaf}${">".repeat(depth)}`
  const deeplyNestedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `type Props = { value: ${deeplyNestedType(
        "string",
        canonicalTypeMaxDepth
      )} }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  const deeplyNestedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `type Props = { value: ${deeplyNestedType(
        "number",
        canonicalTypeMaxDepth
      )} }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  assert.deepEqual(publicCallableChanges(deeplyNestedPrevious, deeplyNestedCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])
  const deeplyNestedOverflow = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `type Props = { value: ${deeplyNestedType(
        "number",
        canonicalTypeMaxDepth + 1
      )} }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  assert.throws(
    () => publicCallableChanges(deeplyNestedPrevious, deeplyNestedOverflow, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason ===
        `packages/public/src/view.tsx: type depth exceeded ${canonicalTypeMaxDepth} while canonicalizing number`
  )
  const deepOverflowFailure = Effect.runSync(
    publicCallableChangesEffect(deeplyNestedPrevious, deeplyNestedOverflow, ["packages/public/src/index.ts"]).pipe(
      Effect.flip
    )
  )
  assert(deepOverflowFailure instanceof ChangesetCoverageError)
  assert.equal(
    deepOverflowFailure.reason,
    `packages/public/src/view.tsx: type depth exceeded ${canonicalTypeMaxDepth} while canonicalizing number`
  )

  const readonlyArrayGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Identity<T> = T\ntype Props<T> = { value: Identity<readonly T[]> }\nexport const Public = (props: Props<string>) => props.value"
    ]
  ])
  const readonlyArrayGenericCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Identity<T> = T\ntype Props<T> = { value: Identity<readonly T[]> }\nexport const Public = (props: Props<number>) => props.value"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(readonlyArrayGenericPrevious, readonlyArrayGenericCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const aliasPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type ID = string\ntype Props = { value: ID }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const aliasCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type UserID = string\ntype Props = { value: UserID }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(aliasPrevious, aliasCurrent, ["packages/public/src/index.ts"]), [])

  const contextualSource = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public: (props: Props) => string = (props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(contextualSource, contextualSource, ["packages/public/src/index.ts"]), [])
  const contextualChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: number }\nexport const Public: (props: Props) => string = (props) => String(props.value)"
    ]
  ])
  assert.deepEqual(publicCallableChanges(contextualSource, contextualChanged, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])

  const genericCallablePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends string>(value: T) => void }\nexport const Public = (props: Props) => props"
    ]
  ])
  const genericCallableCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends number>(value: T) => void }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(genericCallablePrevious, genericCallableCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["cb"] }]
  )
  const genericCallableRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <U extends string>(value: U) => void }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(genericCallablePrevious, genericCallableRename, ["packages/public/src/index.ts"]),
    []
  )
  const wrappedGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends string>(value: ReadonlyArray<T>) => Promise<T> }\nexport const Public = (props: Props) => props"
    ]
  ])
  const wrappedGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <U extends string>(value: ReadonlyArray<U>) => Promise<U> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(wrappedGenericPrevious, wrappedGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const forwardedGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<T> = { value: T }\nexport function Public<T extends string>(props: Props<T>): T { return props.value }"
    ]
  ])
  const forwardedGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<U> = { value: U }\nexport function Public<U extends string>(props: Props<U>): U { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(forwardedGenericPrevious, forwardedGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const forwardedGenericConstraintChange = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<U> = { value: U }\nexport function Public<U extends number>(props: Props<U>): U { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(forwardedGenericPrevious, forwardedGenericConstraintChange, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const nestedGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export function Public<T>(props: { cb<U>(value: U): T }): void {}"]
  ])
  const nestedGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<Outer>(props: { cb<Inner>(value: Inner): Outer }): void {}"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nestedGenericPrevious, nestedGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const nestedGenericSwap = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export function Public<T>(props: { cb<U>(value: T): U }): void {}"]
  ])
  assert.deepEqual(publicCallableChanges(nestedGenericPrevious, nestedGenericSwap, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["cb"] }
  ])
  const contextualGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<T> = { value: T }\nexport const Public: <T>(props: Props<T>) => void = <T,>(props) => {}"
    ]
  ])
  const contextualGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<T> = { value: T }\nexport const Public: <T>(props: Props<T>) => void = <U,>(props) => {}"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(contextualGenericPrevious, contextualGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const contextualGenericChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props<T> = { value: T }\nexport const Public: <T>(props: Props<string>) => void = <U,>(props) => {}"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(contextualGenericPrevious, contextualGenericChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const nestedConstraintPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T, V extends <U>(value: U) => T>(props: V): V { return props }"
    ]
  ])
  const nestedConstraintRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T, V extends <Inner>(value: Inner) => T>(props: V): V { return props }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nestedConstraintPrevious, nestedConstraintRename, ["packages/public/src/index.ts"]),
    []
  )
  const nestedConstraintSwap = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T, V extends <U>(value: T) => U>(props: V): V { return props }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nestedConstraintPrevious, nestedConstraintSwap, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const constGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<const T extends readonly string[]>(props: { value: T }): T { return props.value }"
    ]
  ])
  const constGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<const U extends readonly string[]>(props: { value: U }): U { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(constGenericPrevious, constGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const nonConstGeneric = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends readonly string[]>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(constGenericPrevious, nonConstGeneric, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const unresolvedWrapperPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = Readonly<{ wrapped: string }> & { label: string }\nexport const Public = (props: Props) => props"
    ]
  ])
  const unresolvedWrapperCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = Readonly<{ wrapped: string }> & { label: string; extra?: boolean }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(unresolvedWrapperPrevious, unresolvedWrapperCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["extra"] }]
  )
  const recursivePhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = { value: string }\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(recursivePhantomSources, recursivePhantomSources, ["packages/public/src/index.ts"]),
    []
  )
  const callSignatureShadowedPhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = { <T>(value: T): string; fixed: string }\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(callSignatureShadowedPhantomSources, callSignatureShadowedPhantomSources, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const callSignatureOuterPhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = { <U>(value: T): string; fixed: string }\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(callSignatureOuterPhantomSources, callSignatureOuterPhantomSources, [
        "packages/public/src/index.ts"
      ]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop<T[]>"
  )
  const wrappedGenericChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends string>(value: ReadonlyArray<string>) => Promise<T> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(wrappedGenericPrevious, wrappedGenericChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["cb"] }]
  )
  const qualifiedGenericPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends string>(value: React.ComponentType<T>, box: NS.Box<T>) => Promise<T> }\nexport const Public = (props: Props) => props"
    ]
  ])
  const qualifiedGenericRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <U extends string>(value: React.ComponentType<U>, box: NS.Box<U>) => Promise<U> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(qualifiedGenericPrevious, qualifiedGenericRename, ["packages/public/src/index.ts"]),
    []
  )
  const qualifiedGenericChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb: <T extends string>(value: React.ComponentType<number>, box: NS.Box<T>) => Promise<T> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(qualifiedGenericPrevious, qualifiedGenericChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["cb"] }]
  )
  const operatorAliasPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { id: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const operatorAliasRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Entity = { id: string }\nexport function Public<T extends keyof Entity>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(operatorAliasPrevious, operatorAliasRename, ["packages/public/src/index.ts"]),
    []
  )
  const operatorAliasChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { id: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(operatorAliasPrevious, operatorAliasChanged, ["packages/public/src/index.ts"]),
    []
  )
  const defaultedAliasPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Local<T = { before: unknown }, U = T> = U\nexport function Public<T extends keyof Local>(props: { value: T }): T { return props.value }"
    ]
  ])
  const defaultedAliasChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Local<T = { after: unknown }, U = T> = U\nexport function Public<T extends keyof Local>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(defaultedAliasPrevious, defaultedAliasChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const defaultedAliasValueChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Local<T = { before: string }, U = T> = U\nexport function Public<T extends keyof Local>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(defaultedAliasPrevious, defaultedAliasValueChanged, ["packages/public/src/index.ts"]),
    []
  )
  const defaultForwardedIntersectionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Box<T, U = T> = { value: U }\ntype Props = Box<string> & Box<string>\nexport const Public = (props: Props) => props"
    ]
  ])
  const defaultForwardedIntersectionChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Box<T, U = T> = { value: U }\ntype Props = Box<string> & Box<number>\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(defaultForwardedIntersectionPrevious, defaultForwardedIntersectionChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(defaultForwardedIntersectionPrevious, defaultForwardedIntersectionPrevious, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const operatorAliasKeyChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { name: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(operatorAliasPrevious, operatorAliasKeyChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const primitiveKeyofPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = "x"\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const primitiveKeyofRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = "y"\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(primitiveKeyofPrevious, primitiveKeyofRename, ["packages/public/src/index.ts"]),
    []
  )
  const primitiveKeyofObject = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { x: unknown }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(primitiveKeyofPrevious, primitiveKeyofObject, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const propertyKeyAny = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof any>(props: { value: T }): T { return props.value }"
    ]
  ])
  const propertyKeyEquivalent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends string | number | symbol>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(propertyKeyAny, propertyKeyEquivalent, ["packages/public/src/index.ts"]), [])
  const propertyKeyNarrowed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends string | number>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(propertyKeyAny, propertyKeyNarrowed, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const nestedKeyofPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { id: string }\nexport function Public<T extends keyof keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const nestedKeyofDirect = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { id: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(nestedKeyofPrevious, nestedKeyofDirect, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const nestedKeyofValueChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { id: number }\nexport function Public<T extends keyof keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nestedKeyofPrevious, nestedKeyofValueChanged, ["packages/public/src/index.ts"]),
    []
  )
  const tupleKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof [string]>(props: { value: T }): T { return props.value }"
    ]
  ])
  const tupleKeyElementChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof [number]>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(tupleKeyPrevious, tupleKeyElementChanged, ["packages/public/src/index.ts"]),
    []
  )
  const tupleKeyExpanded = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof [string, number]>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(tupleKeyPrevious, tupleKeyExpanded, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const restTuplePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof [...string[]]>(props: { value: T }): T { return props.value }"
    ]
  ])
  const restTupleFixed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof [string]>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(restTuplePrevious, restTupleFixed, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const arrayKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof string[]>(props: { value: T }): T { return props.value }"
    ]
  ])
  const arrayKeyElementChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public<T extends keyof number[]>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(arrayKeyPrevious, arrayKeyElementChanged, ["packages/public/src/index.ts"]),
    []
  )
  const arrayLengthUnionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = string[] | { length: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const arrayLengthUnionRemoved = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = string[] | {}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(arrayLengthUnionPrevious, arrayLengthUnionRemoved, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const arrayLengthUnionElementChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = number[] | { length: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(arrayLengthUnionPrevious, arrayLengthUnionElementChanged, ["packages/public/src/index.ts"]),
    []
  )
  const arrayMethodUnionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = string[] | { length: number; push(value: string): number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const arrayMethodUnionRemoved = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = string[] | { length: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(arrayMethodUnionPrevious, arrayMethodUnionRemoved, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const tupleIndexUnionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = [string] | { "0": string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const tupleIndexUnionRemoved = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = [string] | {}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(tupleIndexUnionPrevious, tupleIndexUnionRemoved, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const variadicTupleSuffixPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = [...string[], number] | { "1": string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const variadicTupleSuffixEquivalent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = [...string[], number] | {}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(variadicTupleSuffixPrevious, variadicTupleSuffixEquivalent, ["packages/public/src/index.ts"]),
    []
  )
  const stringIndexPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { [key: string]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const stringIndexValueChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { [key: string]: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(stringIndexPrevious, stringIndexValueChanged, ["packages/public/src/index.ts"]),
    []
  )
  const numberIndexChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { [key: number]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(stringIndexPrevious, numberIndexChanged, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const mappedKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "source" as "public"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const mappedKeyBinderRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [P in "source" as "public"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedKeyPrevious, mappedKeyBinderRename, ["packages/public/src/index.ts"]),
    []
  )
  const mappedKeyRemap = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "source" as "private"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(mappedKeyPrevious, mappedKeyRemap, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const mappedDomainPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "a" | "b"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const mappedDomainReordered = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "b" | "a"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedDomainPrevious, mappedDomainReordered, ["packages/public/src/index.ts"]),
    []
  )
  const mappedDomainChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "c" | "d"]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(mappedDomainPrevious, mappedDomainChanged, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const mappedIntersectionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "a" & ("a" | "b")]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const mappedIntersectionChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "b" & ("a" | "b")]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedIntersectionPrevious, mappedIntersectionChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const mappedTemplatePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "source" as `get${Capitalize<K & string>}`]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const mappedTemplateBinderRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [P in "source" as `get${Capitalize<P & string>}`]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedTemplatePrevious, mappedTemplateBinderRename, ["packages/public/src/index.ts"]),
    []
  )
  const mappedTemplateRemap = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [K in "source" as `set${Capitalize<K & string>}`]: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedTemplatePrevious, mappedTemplateRemap, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const forwardedMappedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { source: string }\ntype Rename<T> = { [K in keyof T as `get${Capitalize<K & string>}`]: string }\ntype Wrapper<T> = Rename<T>\nexport function Public<T extends keyof Wrapper<Model>>(props: { value: T }): T { return props.value }"
    ]
  ])
  const forwardedMappedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { target: string }\ntype Rename<T> = { [K in keyof T as `get${Capitalize<K & string>}`]: string }\ntype Wrapper<T> = Rename<T>\nexport function Public<T extends keyof Wrapper<Model>>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(forwardedMappedPrevious, forwardedMappedChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const keyKindPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { 1: string; "a|b": string; id: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const keyKindNumericString = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { "1": string; "a|b": string; id: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(keyKindPrevious, keyKindNumericString, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const keyKindDelimiter = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { 1: string; a: string; "b": string; id: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(keyKindPrevious, keyKindDelimiter, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const keyKindQuoteRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { 1: string; "a|b": string; "id": string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(keyKindPrevious, keyKindQuoteRename, ["packages/public/src/index.ts"]), [])
  const unionKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { common: string; left: number } | { common: string; right: boolean }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const unionKeyEquivalent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { common: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(unionKeyPrevious, unionKeyEquivalent, ["packages/public/src/index.ts"]), [])
  const unionKeyCommonChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { changed: string; left: number } | { common: string; right: boolean }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(unionKeyPrevious, unionKeyCommonChanged, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const intersectionKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { a: string } & { b: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const intersectionKeyEquivalent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { a: string; b: number }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(intersectionKeyPrevious, intersectionKeyEquivalent, ["packages/public/src/index.ts"]),
    []
  )
  const intersectionKeyAdded = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { a: string } & { b: number; c: boolean }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(intersectionKeyPrevious, intersectionKeyAdded, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const contradictoryIntersectionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { kind: "a"; a: unknown } & { kind: "b"; b: unknown }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  const contradictoryIntersectionChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = { kind: string; a: unknown; b: unknown }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(contradictoryIntersectionPrevious, contradictoryIntersectionChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const explicitNeverModel = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Model = never\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(contradictoryIntersectionPrevious, explicitNeverModel, ["packages/public/src/index.ts"]),
    []
  )
  const aliasedContradictoryIntersectionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Left = { kind: "a"; a: unknown }\ntype Right = { kind: "b"; b: unknown }\ntype Model = Left & Right\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(aliasedContradictoryIntersectionPrevious, contradictoryIntersectionChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const conditionalKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Select<T> = T extends string ? { a: unknown } : { b: unknown }\nexport function Public<T extends keyof Select<string>>(props: { value: T }): T { return props.value }"
    ]
  ])
  const conditionalKeyChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Select<T> = T extends string ? { a: unknown } : { b: unknown }\nexport function Public<T extends keyof Select<number>>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(conditionalKeyPrevious, conditionalKeyChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const literalConditionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends "a" ? string : number\nexport const Public = (): Select<"a"> => "value"'
    ]
  ])
  const literalConditionalChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends "a" ? string : number\nexport const Public = (): Select<"b"> => 1'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(literalConditionalPrevious, literalConditionalChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const heritageKeyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Base { inherited: unknown }\ninterface Model extends Base {}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const heritageKeyChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Base { renamed: unknown }\ninterface Model extends Base {}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(heritageKeyPrevious, heritageKeyChanged, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const classHeritagePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Base { inherited: string = "" }\nclass Model extends Base {}\nexport function Public(): Model { return new Model() }'
    ]
  ])
  const classHeritageChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Base { renamed: string = "" }\nclass Model extends Base {}\nexport function Public(): Model { return new Model() }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(classHeritagePrevious, classHeritageChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const inferredClassPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'class Result { value = "" }\nexport const Public = () => new Result()']
  ])
  const inferredClassChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'class Result { renamed = "" }\nexport const Public = () => new Result()']
  ])
  assert.deepEqual(
    publicCallableChanges(inferredClassPrevious, inferredClassChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const inferredClassPropertyChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'class Result { value = "" }\nexport const Public = () => new Result()']
  ])
  const inferredClassPropertyNumber = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "class Result { value = 1 }\nexport const Public = () => new Result()"]
  ])
  assert.deepEqual(
    publicCallableChanges(inferredClassPropertyChanged, inferredClassPropertyNumber, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const localInferredClassPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = () => { class Result { value = "" }; return new Result() }']
  ])
  const localInferredClassChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'export const Public = () => { class Result { renamed = "" }; return new Result() }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(localInferredClassPrevious, localInferredClassChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const localInferredClassBinderRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'export const Public = () => { class Renamed { value = "" }; return new Renamed() }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(localInferredClassPrevious, localInferredClassBinderRename, ["packages/public/src/index.ts"]),
    []
  )
  const brandedClassReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class First { private brand = "first"; value = "" }\nexport function Public(): First { throw new Error("fixture") }'
    ]
  ])
  const brandedClassReturnChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Second { private brand = "second"; value = "" }\nexport function Public(): Second { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(brandedClassReturnPrevious, brandedClassReturnChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const structuralClassReturnChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Second { value = "" }\nexport function Public(): Second { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          'class First { value = "" }\nexport function Public(): First { throw new Error("fixture") }'
        ]
      ]),
      structuralClassReturnChanged,
      ["packages/public/src/index.ts"]
    ),
    []
  )
  const implementsPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Contract { value?: string }\nclass Result implements Contract {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const implementsChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Contract { renamed?: string }\nclass Result implements Contract {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(publicCallableChanges(implementsPrevious, implementsChanged, ["packages/public/src/index.ts"]), [])
  const refinedHeritagePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { value: string }\ninterface Result extends Base { value: "x" }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const refinedHeritageEquivalent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { value: "x" }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(refinedHeritagePrevious, refinedHeritageEquivalent, ["packages/public/src/index.ts"]),
    []
  )
  const refinedHeritageChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { value: string }\ninterface Result extends Base { value: "y" }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(refinedHeritagePrevious, refinedHeritageChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const localFirstMergedRefinement = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { value: string }\ninterface Result { value: "x" }\ninterface Result extends Base {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const localFirstMergedRefinementInline = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { value: "x" }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(localFirstMergedRefinement, localFirstMergedRefinementInline, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const localFirstMergedRefinementChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { value: string }\ninterface Result { value: "y" }\ninterface Result extends Base {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(localFirstMergedRefinement, localFirstMergedRefinementChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const namespaceQualifiedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { value: string }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Models from "./model.js"\nexport function Public(): Models.Result { throw new Error("fixture") }'
    ]
  ])
  const namespaceQualifiedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { renamed: string }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Models from "./model.js"\nexport function Public(): Models.Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namespaceQualifiedPrevious, namespaceQualifiedChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const namespaceQualifiedRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { value: string }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Renamed from "./model.js"\nexport function Public(): Renamed.Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namespaceQualifiedPrevious, namespaceQualifiedRename, ["packages/public/src/index.ts"]),
    []
  )
  const namespaceIndexedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { selected: string; other: number }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Models from "./model.js"\ntype Props = { value: Models.Result["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const namespaceIndexedOtherChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { selected: string; other: boolean }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Models from "./model.js"\ntype Props = { value: Models.Result["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namespaceIndexedPrevious, namespaceIndexedOtherChanged, ["packages/public/src/index.ts"]),
    []
  )
  const namespaceIndexedSelectedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/model.ts", "export interface Result { selected: number; other: number }"],
    [
      "packages/public/src/view.tsx",
      'import type * as Models from "./model.js"\ntype Props = { value: Models.Result["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namespaceIndexedPrevious, namespaceIndexedSelectedChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const structuralIndexPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Result = { [key: string]: string }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const structuralIndexChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Result = { [key: string]: number }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(structuralIndexPrevious, structuralIndexChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const enumNominalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'enum Result { A = "a" }\nexport function Public(): Result { return Result.A }']
  ])
  const enumNominalRenamed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'enum Renamed { A = "a" }\nexport function Public(): Renamed { return Renamed.A }']
  ])
  assert.deepEqual(publicCallableChanges(enumNominalPrevious, enumNominalRenamed, ["packages/public/src/index.ts"]), [
    { kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const sameNamedEnumPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/a.ts", 'export enum Result { A = "a" }'],
    ["packages/public/src/b.ts", 'export enum Result { A = "a" }'],
    [
      "packages/public/src/view.tsx",
      'import type { Result } from "./a.js"\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const sameNamedEnumChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/a.ts", 'export enum Result { A = "a" }'],
    ["packages/public/src/b.ts", 'export enum Result { A = "a" }'],
    [
      "packages/public/src/view.tsx",
      'import type { Result } from "./b.js"\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(sameNamedEnumPrevious, sameNamedEnumChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const indexSignaturePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string]: string }\nexport const Public = (props: Props) => props"
    ]
  ])
  const indexSignatureChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [name: string]: number }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexSignaturePrevious, indexSignatureChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["index:string"] }]
  )
  const equivalentIndexDomainPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string]: boolean }\nexport const Public = (props: Props) => props"
    ]
  ])
  const equivalentIndexUnionCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string | number]: boolean }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(equivalentIndexDomainPrevious, equivalentIndexUnionCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const equivalentIndexExplicitNumberCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string]: boolean; [index: number]: boolean }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(equivalentIndexDomainPrevious, equivalentIndexExplicitNumberCurrent, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const distinctNumberIndexPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string]: unknown; [index: number]: boolean }\nexport const Public = (props: Props) => props"
    ]
  ])
  const distinctNumberIndexChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [key: string]: unknown; [index: number]: string }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(distinctNumberIndexPrevious, distinctNumberIndexChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["index:number"] }]
  )
  const inheritedIndexPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface StringIndex { [key: string]: boolean }\ninterface NumberIndex { [key: number]: boolean }\ninterface Result extends StringIndex, NumberIndex {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const inheritedIndexInline = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { [key: string]: boolean }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(inheritedIndexPrevious, inheritedIndexInline, ["packages/public/src/index.ts"]),
    []
  )
  const inheritedIndexDistinctPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface StringIndex { [key: string]: unknown }\ninterface NumberIndex { [key: number]: "x" }\ninterface Result extends StringIndex, NumberIndex {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const inheritedIndexDistinctChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface StringIndex { [key: string]: unknown }\ninterface NumberIndex { [key: number]: "y" }\ninterface Result extends StringIndex, NumberIndex {}\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(inheritedIndexDistinctPrevious, inheritedIndexDistinctChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const indexSignatureRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { [name: string]: string }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexSignaturePrevious, indexSignatureRename, ["packages/public/src/index.ts"]),
    []
  )
  const lexicalDeclarationPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { value: string }\nfunction helper() { interface Result { value: number } return (value: Result) => value }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  const lexicalDeclarationChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { value: string }\nfunction helper() { interface Result { value: boolean } return (value: Result) => value }\nexport function Public(): Result { throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(lexicalDeclarationPrevious, lexicalDeclarationChanged, ["packages/public/src/index.ts"]),
    []
  )
  const keyofAliasChain = Array.from(
    { length: canonicalTypeMaxDepth + 2 },
    (_, index) => `type Alias${index} = ${index === 0 ? "{ value: string }" : `Alias${index - 1}`}`
  ).join("\n")
  const keyofDepthOverflow = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `${keyofAliasChain}\nexport function Public<T extends keyof Alias${
        canonicalTypeMaxDepth + 1
      }>(props: { value: T }): T { return props.value }`
    ]
  ])
  assert.throws(
    () => publicCallableChanges(keyofDepthOverflow, keyofDepthOverflow, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError && cause.reason.includes(`type depth exceeded ${canonicalTypeMaxDepth}`)
  )
  const crossFileSubstitutionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Box<T> = ReadonlyArray<T>"],
    [
      "packages/public/src/view.tsx",
      'import type { Box } from "./types.js"\ntype Local = string\ntype Props = { value: Box<Local> }\nexport const Public = (props: Props) => props'
    ]
  ])
  const crossFileSubstitutionChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Box<T> = ReadonlyArray<T>"],
    [
      "packages/public/src/view.tsx",
      'import type { Box } from "./types.js"\ntype Local = number\ntype Props = { value: Box<Local> }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(crossFileSubstitutionPrevious, crossFileSubstitutionChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const crossFileSubstitutionRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/types.ts", "export type Box<T> = ReadonlyArray<T>"],
    [
      "packages/public/src/view.tsx",
      'import type { Box } from "./types.js"\ntype Renamed = string\ntype Props = { value: Box<Renamed> }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(crossFileSubstitutionPrevious, crossFileSubstitutionRename, ["packages/public/src/index.ts"]),
    []
  )
  const mappedShadowedPhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = { [T in "fixed"]: T }\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(mappedShadowedPhantomSources, mappedShadowedPhantomSources, ["packages/public/src/index.ts"]),
    []
  )
  const inferShadowedPhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = unknown extends infer T ? { value: T } : never\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(inferShadowedPhantomSources, inferShadowedPhantomSources, ["packages/public/src/index.ts"]),
    []
  )
  const inferOuterReferenceSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = T extends infer U ? { value: T } : never\ntype Props = { value: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.throws(
    () =>
      publicCallableChanges(inferOuterReferenceSources, inferOuterReferenceSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop<T[]>"
  )
  const recursiveKeyofSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Node = { child: Node; keys: keyof Node }\ntype Props = { value: Node }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(recursiveKeyofSources, recursiveKeyofSources, ["packages/public/src/index.ts"], undefined, {
      recursiveDeclarations: unchangedDeclarationKeys(recursiveKeyofSources, recursiveKeyofSources)
    }),
    []
  )
  const mappedOuterPhantomSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop<T> = readonly Loop<T[]>[]\ntype Phantom<T> = { [K in keyof T]: string }\ntype Props = { left: Phantom<Loop<string>>; right: Phantom<Loop<string>> }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.throws(
    () => publicCallableChanges(mappedOuterPhantomSources, mappedOuterPhantomSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop<T[]>"
  )

  const methodPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb(value: string): void }\nexport const Public = (props: Props) => props"
    ]
  ])
  const methodCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb(value: number): void }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(publicCallableChanges(methodPrevious, methodCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["cb"] }
  ])
  const methodRenameCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { cb(nextValue: string): void }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(publicCallableChanges(methodPrevious, methodRenameCurrent, ["packages/public/src/index.ts"]), [])

  const returnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props): string => props.value"
    ]
  ])
  const returnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props): number => Number(props.value)"
    ]
  ])
  assert.deepEqual(publicCallableChanges(returnPrevious, returnCurrent, ["packages/public/src/index.ts"]), [
    { kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])

  const readonlyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const readonlyCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { readonly value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.deepEqual(publicCallableChanges(readonlyPrevious, readonlyCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])

  const removedEntryPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const removedEntryCurrent = new Map([
    ["packages/public/src/index.ts", "export {}"],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const conditionalSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  const conditionalManifest = {
    exports: { ".": { import: "./src/index.ts", require: "./src/index.ts" } }
  }
  const directManifest = { exports: { ".": "./src/index.ts" } }
  assert.deepEqual(
    manifestEntryPointDescriptors(conditionalManifest, "packages/public", [...conditionalSources.keys()]),
    [
      { conditionPath: ["import"], identity: "exports:.", sourcePath: "packages/public/src/index.ts" },
      { conditionPath: ["require"], identity: "exports:.", sourcePath: "packages/public/src/index.ts" }
    ]
  )
  const topLevelConditionalManifest = {
    exports: { import: "./src/index.ts", require: "./src/index.ts" }
  }
  assert.deepEqual(
    manifestEntryPointDescriptors(topLevelConditionalManifest, "packages/public", [...conditionalSources.keys()]),
    [
      { conditionPath: ["import"], identity: "exports:.", sourcePath: "packages/public/src/index.ts" },
      { conditionPath: ["require"], identity: "exports:.", sourcePath: "packages/public/src/index.ts" }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      conditionalSources,
      conditionalSources,
      manifestEntryPointDescriptors(conditionalManifest, "packages/public", [...conditionalSources.keys()]),
      manifestEntryPointDescriptors(directManifest, "packages/public", [...conditionalSources.keys()])
    ),
    []
  )
  const splitConditionalPrevious = new Map([
    ["packages/public/src/import-view.tsx", "export const Public = (props: { value: string }) => props.value"],
    ["packages/public/src/require-view.tsx", "export const Public = (props: { value: string }) => props.value"]
  ])
  const splitConditionalCurrent = new Map([
    ["packages/public/src/import-view.tsx", "export const Public = (props: { value: number }) => props.value"],
    ["packages/public/src/require-view.tsx", "export const Public = (props: { value: string }) => props.value"]
  ])
  const splitConditionalManifest = {
    exports: { ".": { import: "./src/import-view.tsx", require: "./src/require-view.tsx" } }
  }
  const splitConditionalDescriptors = (sources) =>
    manifestEntryPointDescriptors(splitConditionalManifest, "packages/public", [...sources.keys()])
  assert.deepEqual(
    publicCallableChanges(
      splitConditionalPrevious,
      splitConditionalCurrent,
      splitConditionalDescriptors(splitConditionalPrevious),
      splitConditionalDescriptors(splitConditionalCurrent)
    ),
    [
      {
        kind: "type-change",
        filePath: "packages/public/src/import-view.tsx",
        name: "Public",
        properties: ["value"]
      }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      splitConditionalPrevious,
      splitConditionalPrevious,
      splitConditionalDescriptors(splitConditionalPrevious),
      splitConditionalDescriptors(splitConditionalPrevious)
    ),
    []
  )
  const swappedConditionalPrevious = new Map([
    ["packages/public/src/import-view.tsx", "export const Public = (props: { value: string }) => props.value"],
    ["packages/public/src/require-view.tsx", "export const Public = (props: { value: number }) => props.value"]
  ])
  const swappedConditionalCurrent = swappedConditionalPrevious
  const swappedConditionalCurrentManifest = {
    exports: { ".": { import: "./src/require-view.tsx", require: "./src/import-view.tsx" } }
  }
  assert.deepEqual(
    publicCallableChanges(
      swappedConditionalPrevious,
      swappedConditionalCurrent,
      manifestEntryPointDescriptors(splitConditionalManifest, "packages/public", [
        ...swappedConditionalPrevious.keys()
      ]),
      manifestEntryPointDescriptors(swappedConditionalCurrentManifest, "packages/public", [
        ...swappedConditionalCurrent.keys()
      ])
    ),
    [
      {
        kind: "type-change",
        filePath: "packages/public/src/require-view.tsx",
        name: "Public",
        properties: ["value"]
      },
      {
        kind: "type-change",
        filePath: "packages/public/src/import-view.tsx",
        name: "Public",
        properties: ["value"]
      }
    ]
  )
  const sharedConditionalPrevious = new Map([
    ["packages/public/src/shared.tsx", 'export const Public = (): string => "value"']
  ])
  const sharedConditionalCurrent = new Map([
    ["packages/public/src/shared.tsx", 'export const Public = (): string => "value"'],
    ["packages/public/src/changed.tsx", "export const Public = (): number => 1"]
  ])
  const sharedConditionalPreviousManifest = {
    exports: { ".": { import: "./src/shared.tsx", require: "./src/shared.tsx" } }
  }
  const sharedConditionalCurrentManifest = {
    exports: { ".": { import: "./src/shared.tsx", require: "./src/changed.tsx" } }
  }
  assert.deepEqual(
    publicCallableChanges(
      sharedConditionalPrevious,
      sharedConditionalCurrent,
      manifestEntryPointDescriptors(sharedConditionalPreviousManifest, "packages/public", [
        ...sharedConditionalPrevious.keys()
      ]),
      manifestEntryPointDescriptors(sharedConditionalCurrentManifest, "packages/public", [
        ...sharedConditionalCurrent.keys()
      ])
    ),
    [
      {
        kind: "return-type-change",
        filePath: "packages/public/src/changed.tsx",
        name: "Public",
        properties: []
      }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      sharedConditionalPrevious,
      sharedConditionalPrevious,
      manifestEntryPointDescriptors(sharedConditionalPreviousManifest, "packages/public", [
        ...sharedConditionalPrevious.keys()
      ]),
      manifestEntryPointDescriptors(sharedConditionalPreviousManifest, "packages/public", [
        ...sharedConditionalPrevious.keys()
      ])
    ),
    []
  )
  const directBaselinePrevious = new Map([
    ["packages/public/src/shared.tsx", 'export const Public = (): string => "value"']
  ])
  const directBaselineManifest = { exports: { ".": "./src/shared.tsx" } }
  assert.deepEqual(
    publicCallableChanges(
      directBaselinePrevious,
      sharedConditionalCurrent,
      manifestEntryPointDescriptors(directBaselineManifest, "packages/public", [...directBaselinePrevious.keys()]),
      manifestEntryPointDescriptors(sharedConditionalCurrentManifest, "packages/public", [
        ...sharedConditionalCurrent.keys()
      ])
    ),
    [
      {
        kind: "return-type-change",
        filePath: "packages/public/src/changed.tsx",
        name: "Public",
        properties: []
      }
    ]
  )
  const directBaselineConditionalCurrent = new Map([
    ...directBaselinePrevious,
    ["packages/public/src/changed.tsx", 'export const Public = (): string => "other"']
  ])
  const directBaselineConditionalManifest = {
    exports: { ".": { import: "./src/shared.tsx", require: "./src/changed.tsx" } }
  }
  assert.deepEqual(
    publicCallableChanges(
      directBaselinePrevious,
      directBaselineConditionalCurrent,
      manifestEntryPointDescriptors(directBaselineManifest, "packages/public", [...directBaselinePrevious.keys()]),
      manifestEntryPointDescriptors(directBaselineConditionalManifest, "packages/public", [
        ...directBaselineConditionalCurrent.keys()
      ])
    ),
    []
  )
  const duplicateIdentityPrevious = new Map([
    ["packages/public/src/view.tsx", "export const Public = (props: { value: string }) => props.value"]
  ])
  const duplicateIdentityCurrent = new Map([
    ["packages/public/src/view.tsx", "export const Public = (props: { value: number }) => props.value"]
  ])
  const duplicateIdentityEntryPoints = [
    { identity: "main", sourcePath: "packages/public/src/view.tsx" },
    { identity: "exports:.", sourcePath: "packages/public/src/view.tsx" }
  ]
  assert.deepEqual(
    publicCallableChanges(
      duplicateIdentityPrevious,
      duplicateIdentityCurrent,
      duplicateIdentityEntryPoints,
      duplicateIdentityEntryPoints
    ),
    [
      {
        kind: "type-change",
        filePath: "packages/public/src/view.tsx",
        name: "Public",
        properties: ["value"]
      }
    ]
  )
  const wildcardDirectPrevious = new Map([
    ["packages/public/src/a.tsx", "export const Public = (props: { value: string }) => props.value"],
    ["packages/public/src/b.tsx", "export const Public = (props: { value: number }) => props.value"]
  ])
  const wildcardConditionalManifest = {
    exports: { "./*": { import: "./dist/*.js", require: "./dist/*.js" } }
  }
  const wildcardDirectManifest = { exports: { "./*": "./dist/*.js" } }
  assert.deepEqual(
    publicCallableChanges(
      wildcardDirectPrevious,
      wildcardDirectPrevious,
      manifestEntryPointDescriptors(wildcardDirectManifest, "packages/public", [...wildcardDirectPrevious.keys()]),
      manifestEntryPointDescriptors(wildcardConditionalManifest, "packages/public", [...wildcardDirectPrevious.keys()])
    ),
    []
  )
  const wildcardMovedPrevious = new Map([
    ["packages/public/src/a.tsx", "export const Public = (props: { value: string }) => props.value"],
    ["packages/public/src/b.tsx", "export const Public = (props: { value: number }) => props.value"]
  ])
  const wildcardMovedCurrent = new Map([
    ["packages/public/src/impl/a.tsx", "export const Public = (props: { value: number }) => props.value"],
    ["packages/public/src/impl/b.tsx", "export const Public = (props: { value: string }) => props.value"]
  ])
  const wildcardMovedPreviousManifest = { exports: { "./*": "./dist/*.js" } }
  const wildcardMovedCurrentManifest = {
    exports: { "./*": { import: "./dist/impl/*.js", require: "./dist/impl/*.js" } }
  }
  assert.deepEqual(
    publicCallableChanges(
      wildcardMovedPrevious,
      wildcardMovedCurrent,
      manifestEntryPointDescriptors(wildcardMovedPreviousManifest, "packages/public", [
        ...wildcardMovedPrevious.keys()
      ]),
      manifestEntryPointDescriptors(wildcardMovedCurrentManifest, "packages/public", [...wildcardMovedCurrent.keys()])
    ),
    [
      { kind: "type-change", filePath: "packages/public/src/impl/a.tsx", name: "Public", properties: ["value"] },
      { kind: "type-change", filePath: "packages/public/src/impl/b.tsx", name: "Public", properties: ["value"] }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      wildcardDirectPrevious,
      new Map([
        ["packages/public/src/impl/a.tsx", "export const Public = (props: { value: string }) => props.value"],
        ["packages/public/src/impl/b.tsx", "export const Public = (props: { value: number }) => props.value"]
      ]),
      manifestEntryPointDescriptors(wildcardDirectManifest, "packages/public", [...wildcardDirectPrevious.keys()]),
      manifestEntryPointDescriptors({ exports: { "./*": "./dist/impl/*.js" } }, "packages/public", [
        "packages/public/src/impl/a.tsx",
        "packages/public/src/impl/b.tsx"
      ])
    ),
    []
  )
  const repeatedWildcardManifest = { exports: { "./feature/*": "./dist/*/*.js" } }
  assert.deepEqual(
    manifestEntryPointDescriptors(repeatedWildcardManifest, "packages/public", [
      "packages/public/src/a/a.tsx",
      "packages/public/src/a/b.tsx"
    ]),
    [
      {
        identity: "exports:./feature/*",
        publicSubpath: "./feature/a",
        sourcePath: "packages/public/src/a/a.tsx"
      }
    ]
  )
  const adjacentWildcardManifest = { exports: { "./feature/*": "./dist/**.js" } }
  assert.deepEqual(
    manifestEntryPointDescriptors(adjacentWildcardManifest, "packages/public", ["packages/public/src/aa.tsx"]),
    [
      {
        identity: "exports:./feature/*",
        publicSubpath: "./feature/a",
        sourcePath: "packages/public/src/aa.tsx"
      }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      conditionalSources,
      conditionalSources,
      manifestEntryPointDescriptors(topLevelConditionalManifest, "packages/public", [...conditionalSources.keys()]),
      manifestEntryPointDescriptors(directManifest, "packages/public", [...conditionalSources.keys()])
    ),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      conditionalSources,
      conditionalSources,
      manifestEntryPointDescriptors(
        {
          exports: {
            ".": { import: "./src/index.ts", require: "./src/index.ts" },
            "./view.js": { import: "./src/view.js", require: "./src/view.js" }
          }
        },
        "packages/public",
        [...conditionalSources.keys()]
      ),
      manifestEntryPointDescriptors(directManifest, "packages/public", [...conditionalSources.keys()])
    ),
    [{ kind: "callable-removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      removedEntryPrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
        ]
      ]),
      [{ identity: "exports:./view.js", sourcePath: "packages/public/src/view.tsx" }],
      []
    ),
    [{ kind: "callable-removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  assert.deepEqual(
    manifestEntryPoints({ exports: { ".": "./src/index.ts", "./view.js": "./src/view.js" } }, "packages/public", [
      "packages/public/src/index.ts",
      "packages/public/src/view.tsx"
    ]),
    ["packages/public/src/index.ts", "packages/public/src/view.tsx"]
  )
  assert.deepEqual(
    manifestEntryPointDescriptors(
      { exports: { ".": "./src/index.ts", "./view.js": "./src/view.js" } },
      "packages/public",
      ["packages/public/src/index.ts", "packages/public/src/view.tsx"]
    ),
    [
      { identity: "exports:.", sourcePath: "packages/public/src/index.ts" },
      { identity: "exports:./view.js", sourcePath: "packages/public/src/view.tsx" }
    ]
  )
  assert.deepEqual(
    publicCallableChanges(
      removedEntryPrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "type Props = { value: string }\nexport const Public = (props: Props) => props.value"
        ]
      ]),
      manifestEntryPointDescriptors(
        { exports: { ".": "./src/index.ts", "./view.js": "./src/view.js" } },
        "packages/public",
        [...removedEntryPrevious.keys()]
      ),
      manifestEntryPointDescriptors({ exports: { ".": "./src/index.ts" } }, "packages/public", [
        ...removedEntryCurrent.keys()
      ])
    ),
    [{ kind: "callable-removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const constraintSources = (model) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `${model}\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }`
      ]
    ])
  const nestedConstraintSources = (model) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `${model}\nexport function Public<T extends keyof keyof Model>(props: { value: T }): T { return props.value }`
      ]
    ])
  const accessorPrevious = constraintSources("interface Model { get a(): string }")
  const accessorRenamed = constraintSources("interface Model { get b(): string }")
  assert.deepEqual(publicCallableChanges(accessorPrevious, accessorRenamed, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  assert.deepEqual(
    publicCallableChanges(accessorPrevious, constraintSources("interface Model { get a(): number }"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = object"), constraintSources("type Model = unknown"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = object"), constraintSources("type Model = string"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const keyofIntersectionAlias = (aliasValue) =>
    constraintSources(`type Tag = "${aliasValue}"\ntype Model = { tag: Tag } & { other: string }`)
  assert.deepEqual(
    publicCallableChanges(keyofIntersectionAlias("x"), keyofIntersectionAlias("x"), ["packages/public/src/index.ts"]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources('type Model = "x"'), constraintSources('type Model = "x" | "y"'), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = any"), constraintSources("type Model = never"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = any"), constraintSources("type Model = unknown"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources('type Model = "a"'), constraintSources("type Model = { a: string }"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const neverMappedPrevious = constraintSources('type Model = { [K in "a" as never]: string }')
  assert.deepEqual(
    publicCallableChanges(neverMappedPrevious, constraintSources('type Model = { [K in "b" as never]: string }'), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = string[]"), constraintSources("type Model = number[]"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      constraintSources("type Model = (value: string) => void"),
      constraintSources("type Model = (value: number) => number"),
      ["packages/public/src/index.ts"]
    ),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      constraintSources("type Model = ((value: string) => void) & { tag: string }"),
      constraintSources("type Model = ((value: string) => void) & { renamed: string }"),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(constraintSources("type Model = [...string[]]"), constraintSources("type Model = string[]"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      constraintSources("type Model = [...[string, number]]"),
      constraintSources("type Model = [...string[]]"),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      constraintSources('type Model = Record<"a", string>'),
      constraintSources('type Model = Record<"a", number>'),
      ["packages/public/src/index.ts"]
    ),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      constraintSources('type Model = Record<"a", string>'),
      constraintSources('type Model = Record<"b", string>'),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      nestedConstraintSources("type Model = { a: string }"),
      nestedConstraintSources("type Model = { b: string }"),
      ["packages/public/src/index.ts"]
    ),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "type Model = { a: string }\nexport function Public<T extends keyof keyof Model>(props: { value: T }): T { return props.value }"
        ]
      ]),
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "type Model = { a: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const concreteConditionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends string ? { a: string } : { b: number }\nexport const Public = (): Select<"a"> => ({ a: "" })'
    ]
  ])
  const concreteConditionalRename = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends string ? { a: string } : { b: number }\nexport const Public = (): Select<"b"> => ({ a: "" })'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(concreteConditionalPrevious, concreteConditionalRename, ["packages/public/src/index.ts"]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      concreteConditionalPrevious,
      new Map([
        ...concreteConditionalPrevious,
        [
          "packages/public/src/view.tsx",
          "type Select<T> = T extends string ? { a: string } : { b: number }\nexport const Public = (): Select<number> => ({ b: 1 })"
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const inferRenamePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Unwrap<X> = X extends Promise<infer T> ? T : never\nexport const Public = (): Unwrap<Promise<string>> => "value"'
    ]
  ])
  const inferRenameCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Unwrap<X> = X extends Promise<infer U> ? U : never\nexport const Public = (): Unwrap<Promise<string>> => "value"'
    ]
  ])
  assert.deepEqual(publicCallableChanges(inferRenamePrevious, inferRenameCurrent, ["packages/public/src/index.ts"]), [])
  const nestedInferShadowPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends [infer U, infer V] ? U extends [infer U] ? U : never : never\nexport const Public = (): Select<["value", unknown]> => "value"'
    ]
  ])
  const nestedInferShadowChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Select<T> = T extends [infer U, infer V] ? U extends [infer W] ? U : never : never\nexport const Public = (): Select<["value", unknown]> => "value"'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nestedInferShadowPrevious, nestedInferShadowChanged, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const mergedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Model { a: string }\ninterface Model { stable: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  const mergedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Model { b: string }\ninterface Model { stable: string }\nexport function Public<T extends keyof Model>(props: { value: T }): T { return props.value }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(mergedPrevious, mergedCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  assert.deepEqual(
    publicCallableChanges(constraintSources('class Model { a = "" }'), constraintSources('class Model { b = "" }'), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const opaqueHeritagePrevious = constraintSources("interface Model extends NS.Base { a: string }")
  assert.deepEqual(
    publicCallableChanges(opaqueHeritagePrevious, constraintSources("interface Model extends NS.Base { b: string }"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const callableOverloadPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Props { fn(value: string): string; fn(value: number): number }\nexport const Public = (props: Props) => props"
    ]
  ])
  const callableOverloadCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Props { fn(value: boolean): boolean; fn(value: number): number }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(callableOverloadPrevious, callableOverloadCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["fn"] }]
  )
  const exportedOverloadPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public(props: { value: string }): string\nexport function Public(props: { value: number }): number\nexport function Public(props: { value: string | number }): string | number { return String(props.value) }"
    ]
  ])
  const exportedOverloadCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "export function Public(props: { value: boolean }): boolean\nexport function Public(props: { value: number }): number\nexport function Public(props: { value: boolean | number }): boolean | number { return String(props.value) }"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(exportedOverloadPrevious, exportedOverloadCurrent, ["packages/public/src/index.ts"]),
    [
      { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] },
      { kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
    ]
  )
  const parenthesizedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export const Public = ((props: { a: string }) => props.a)"]
  ])
  const parenthesizedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export const Public = ((props: { b: string }) => props.b)"]
  ])
  assert.deepEqual(
    publicCallableChanges(parenthesizedPrevious, parenthesizedCurrent, ["packages/public/src/index.ts"]),
    [
      { kind: "addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["b"] },
      { kind: "removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["a"] }
    ]
  )
  const thisPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Context = { context: string }\nexport function Public(this: Context, props: { a: string }): string { return props.a }"
    ]
  ])
  const thisCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Context = { context: string }\nexport function Public(this: Context, props: { b: string }): string { return props.b }"
    ]
  ])
  assert.deepEqual(publicCallableChanges(thisPrevious, thisCurrent, ["packages/public/src/index.ts"]), [
    { kind: "addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["b"] },
    { kind: "removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["a"] }
  ])
  const unionPropsPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { kind: "a"; a: string } | { kind: "b"; b: string }\nexport const Public = (props: Props) => props'
    ]
  ])
  const unionPropsCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { kind: "a"; renamed: string } | { kind: "b"; b: string }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(publicCallableChanges(unionPropsPrevious, unionPropsCurrent, ["packages/public/src/index.ts"]), [
    { kind: "addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["renamed"] },
    { kind: "removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["a"] }
  ])
  const indexedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { value: string; other: string }\ntype Props = { value: Model["value"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { value: number; other: string }\ntype Props = { value: Model["value"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(publicCallableChanges(indexedPrevious, indexedCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])
  const indexedHeritagePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { selected: string; other: number }\ninterface Model extends Base {}\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedHeritageUnselectedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { selected: string; other: boolean }\ninterface Model extends Base {}\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedHeritagePrevious, indexedHeritageUnselectedChanged, ["packages/public/src/index.ts"]),
    []
  )
  const indexedHeritageSelectedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { selected: number; other: number }\ninterface Model extends Base {}\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedHeritagePrevious, indexedHeritageSelectedChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedRefinedHeritagePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { selected: string; other: number }\ninterface Model extends Base { selected: "x" }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedRefinedHeritageInline = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Model { selected: "x" }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedRefinedHeritagePrevious, indexedRefinedHeritageInline, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const indexedRefinedHeritageChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { selected: string; other: number }\ninterface Model extends Base { selected: "y" }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedRefinedHeritagePrevious, indexedRefinedHeritageChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedMethodPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Model { selected(value: string): string; other: number }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedMethodUnselectedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Model { selected(value: string): string; other: boolean }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedMethodPrevious, indexedMethodUnselectedChanged, ["packages/public/src/index.ts"]),
    []
  )
  const indexedMethodSelectedChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Model { selected(value: number): string; other: number }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedMethodPrevious, indexedMethodSelectedChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedStaticInstancePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Model { static selected: string = ""; selected(): string { return "" } }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedStaticInstanceChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Model { static selected: string = ""; selected(): number { return 0 } }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedStaticInstancePrevious, indexedStaticInstanceChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedArrayLengthPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: string[]["length"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedArrayLengthCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "type Props = { value: string }\nexport const Public = (props: Props) => props"]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedArrayLengthPrevious, indexedArrayLengthCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedArrayElementPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: string[][0] }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedArrayElementPrevious, indexedArrayLengthCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const indexedArrayStringElementCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: string[]["0"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedArrayElementPrevious, indexedArrayStringElementCurrent, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const indexedTupleElementPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [string][0] }\nexport const Public = (props: Props) => props"
    ]
  ])
  const indexedTupleStringElementCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: [string]["0"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedTupleElementPrevious, indexedTupleStringElementCurrent, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const indexedOptionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: { value?: string }["value"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedRequiredCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: { value: string }["value"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedOptionalPrevious, indexedRequiredCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  const indexedReadonlyPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: { readonly value: string }["value"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedReadonlyPrevious, indexedRequiredCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const interfaceReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'interface Result { a: string }\nexport const Public = (): Result => ({ a: "" })']
  ])
  const interfaceReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'interface Result { b: string }\nexport const Public = (): Result => ({ b: "" })']
  ])
  assert.deepEqual(
    publicCallableChanges(interfaceReturnPrevious, interfaceReturnCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const annotatedReturnShadowPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { publicValue: string }\nexport function Public(): Result { class Result { localValue = "" }; throw new Error("fixture") }'
    ]
  ])
  const annotatedReturnShadowModuleChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { renamed: string }\nexport function Public(): Result { class Result { localValue = "" }; throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(annotatedReturnShadowPrevious, annotatedReturnShadowModuleChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const annotatedReturnShadowLocalChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Result { publicValue: string }\nexport function Public(): Result { class Result { renamed = "" }; throw new Error("fixture") }'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(annotatedReturnShadowPrevious, annotatedReturnShadowLocalChanged, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const inheritedInterfaceReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { a: string }\ninterface Result extends Base {}\nexport const Public = (): Result => ({ a: "" })'
    ]
  ])
  const inheritedInterfaceReturnInline = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'interface Result { a: string }\nexport const Public = (): Result => ({ a: "" })']
  ])
  assert.deepEqual(
    publicCallableChanges(inheritedInterfaceReturnPrevious, inheritedInterfaceReturnInline, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const inheritedInterfaceReturnChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Base { a: number }\ninterface Result extends Base {}\nexport const Public = (): Result => ({ a: 1 })"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(inheritedInterfaceReturnPrevious, inheritedInterfaceReturnChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const redeclaredInheritedPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'interface Base { a: string }\ninterface Result extends Base { a: string }\nexport const Public = (): Result => ({ a: "" })'
    ]
  ])
  const redeclaredInheritedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'interface Result { a: string }\nexport const Public = (): Result => ({ a: "" })']
  ])
  assert.deepEqual(
    publicCallableChanges(redeclaredInheritedPrevious, redeclaredInheritedCurrent, ["packages/public/src/index.ts"]),
    []
  )
  const reorderedInlineReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = (): { a: string; b: number } => ({ a: "", b: 1 })']
  ])
  const reorderedInlineReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = (): { b: number; a: string } => ({ a: "", b: 1 })']
  ])
  assert.deepEqual(
    publicCallableChanges(reorderedInlineReturnPrevious, reorderedInlineReturnCurrent, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  const changedInlineReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = (): { b: boolean; a: string } => ({ a: "", b: true })']
  ])
  assert.deepEqual(
    publicCallableChanges(reorderedInlineReturnPrevious, changedInlineReturnCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const callSignaturePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Result { (value: string): string }\nexport const Public = (): Result => (value) => value"
    ]
  ])
  const callSignatureCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Result { (value: number): string }\nexport const Public = (): Result => (value) => String(value)"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(callSignaturePrevious, callSignatureCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const callSignatureRenamed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "interface Result { (renamed: string): string }\nexport const Public = (): Result => (renamed) => renamed"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(callSignaturePrevious, callSignatureRenamed, ["packages/public/src/index.ts"]),
    []
  )
  const enumReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'enum Result { A = "a", B = "b" }\nexport const Public = (): Result => Result.A']
  ])
  const enumReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'enum Result { A = "a", C = "c" }\nexport const Public = (): Result => Result.A']
  ])
  assert.deepEqual(publicCallableChanges(enumReturnPrevious, enumReturnCurrent, ["packages/public/src/index.ts"]), [
    { kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }
  ])
  const enumReturnReordered = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'enum Result { B = "b", A = "a" }\nexport const Public = (): Result => Result.A']
  ])
  assert.deepEqual(publicCallableChanges(enumReturnPrevious, enumReturnReordered, ["packages/public/src/index.ts"]), [])
  const staticClassReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Result { static a: string; value: string }\nexport const Public = (): Result => ({ value: "" })'
    ]
  ])
  const staticClassReturnRenamed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'class Result { static b: string; value: string }\nexport const Public = (): Result => ({ value: "" })'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(staticClassReturnPrevious, staticClassReturnRenamed, ["packages/public/src/index.ts"]),
    []
  )
  const staticClassReturnInstanceChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "class Result { static a: string; value: number }\nexport const Public = (): Result => ({ value: 1 })"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(staticClassReturnPrevious, staticClassReturnInstanceChanged, [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const inferredReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = () => ({ a: "" })']
  ])
  const inferredReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = () => ({ b: "" })']
  ])
  assert.deepEqual(
    publicCallableChanges(inferredReturnPrevious, inferredReturnCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const identifierReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'const value = { a: "" }\nexport const Public = () => value']
  ])
  const identifierReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'const value = { b: "" }\nexport const Public = () => value']
  ])
  assert.deepEqual(
    publicCallableChanges(identifierReturnPrevious, identifierReturnCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const identifierReturnRenamed = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'const renamed = { a: "" }\nexport const Public = () => renamed']
  ])
  assert.deepEqual(
    publicCallableChanges(identifierReturnPrevious, identifierReturnRenamed, ["packages/public/src/index.ts"]),
    []
  )
  let checkerProgramCount = 0
  const countingProgramFactory = (...arguments_) => {
    checkerProgramCount += 1
    return TypeScript.createProgram(...arguments_)
  }
  const explicitReturnPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = (): string => "value"']
  ])
  const explicitReturnCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export const Public = (): number => 1"]
  ])
  assert.deepEqual(
    publicCallableChanges(
      explicitReturnPrevious,
      explicitReturnCurrent,
      ["packages/public/src/index.ts"],
      ["packages/public/src/index.ts"],
      { programFactory: countingProgramFactory }
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.equal(checkerProgramCount, 0)
  assert.deepEqual(
    publicCallableChanges(
      inferredReturnPrevious,
      inferredReturnCurrent,
      ["packages/public/src/index.ts"],
      ["packages/public/src/index.ts"],
      { programFactory: countingProgramFactory }
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  assert.equal(checkerProgramCount, 2)
  assert.deepEqual(
    publicCallableChanges(
      inferredReturnPrevious,
      inferredReturnPrevious,
      ["packages/public/src/index.ts"],
      ["packages/public/src/index.ts"],
      { programFactory: countingProgramFactory }
    ),
    []
  )
  assert.equal(checkerProgramCount, 2)
  const observedCompilerOptions = []
  const observingProgramFactory = (rootNames, options, host) => {
    observedCompilerOptions.push(options)
    return TypeScript.createProgram(rootNames, options, host)
  }
  const inferredIndexedReturn = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export const Public = (values: string[]) => values[0]"]
  ])
  assert.deepEqual(
    publicCallableChanges(inferredIndexedReturn, inferredIndexedReturn, ["packages/public/src/index.ts"], undefined, {
      compilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: false },
      programFactory: observingProgramFactory
    }),
    []
  )
  assert.equal(observedCompilerOptions.length, 1)
  assert.equal(observedCompilerOptions[0].noUncheckedIndexedAccess, false)
  const parsedFixtureCompilerOptions = compilerOptionsFromConfig(
    "/fixture/packages/public/tsconfig.json",
    '{"extends":"../../tsconfig.base.jsonc","files":["src/index.ts"],"compilerOptions":{"noUncheckedIndexedAccess":false}}',
    new Map([
      ["/fixture/tsconfig.base.jsonc", '{"compilerOptions":{"noUncheckedIndexedAccess":true,"strict":true}}'],
      ["/fixture/packages/public/src/index.ts", ""]
    ])
  )
  assert.equal(parsedFixtureCompilerOptions.noUncheckedIndexedAccess, false)
  const referencedCompilerConfig = (noUncheckedIndexedAccess) =>
    packageCompilerOptions(inferredIndexedReturn, "/fixture", {
      configText: '{"files":[],"references":[{"path":"./tsconfig.build.json"}]}',
      configFiles: new Map([
        [
          "/fixture/packages/public/tsconfig.build.json",
          `{"files":["src/index.ts"],"compilerOptions":{"noUncheckedIndexedAccess":${noUncheckedIndexedAccess}}}`
        ],
        ["/fixture/packages/public/src/index.ts", ""],
        ["/fixture/packages/public/src/view.tsx", ""]
      ]),
      configurationPaths: ["/fixture/packages/public/tsconfig.json", "/fixture/packages/public/tsconfig.build.json"],
      entryPoints: [{ sourcePath: "packages/public/src/index.ts" }]
    })
  const referencedCompilerOptionsPrevious = referencedCompilerConfig(false)
  const referencedCompilerOptionsCurrent = referencedCompilerConfig(true)
  assert.equal(referencedCompilerOptionsPrevious.noUncheckedIndexedAccess, false)
  assert.equal(referencedCompilerOptionsCurrent.noUncheckedIndexedAccess, true)
  const referencedCompilerChanges = publicCallableChanges(
    inferredIndexedReturn,
    inferredIndexedReturn,
    ["packages/public/src/index.ts"],
    undefined,
    {
      previousCompilerOptions: referencedCompilerOptionsPrevious,
      currentCompilerOptions: referencedCompilerOptionsCurrent
    }
  ).map((change) => ({ ...change, packageName: "@fixture/public" }))
  assert.deepEqual(validatePublicCallableChangesets(referencedCompilerChanges, new Map()), ["@fixture/public"])
  assert.deepEqual(
    publicCallableChanges(inferredIndexedReturn, inferredIndexedReturn, ["packages/public/src/index.ts"], undefined, {
      previousCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: false },
      currentCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: false }
    }),
    []
  )
  const indexedCompilerOptionsCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export const Public = (values: string[]) => values[0]"]
  ])
  assert.deepEqual(
    publicCallableChanges(
      inferredIndexedReturn,
      indexedCompilerOptionsCurrent,
      ["packages/public/src/index.ts"],
      undefined,
      {
        previousCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: false },
        currentCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: true }
      }
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const compilerOnlyCallableChanges = publicCallableChanges(
    inferredIndexedReturn,
    indexedCompilerOptionsCurrent,
    ["packages/public/src/index.ts"],
    undefined,
    {
      previousCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: false },
      currentCompilerOptions: { ...defaultCompilerOptions, noUncheckedIndexedAccess: true }
    }
  ).map((change) => ({ ...change, packageName: "@fixture/public" }))
  assert.deepEqual(validatePublicCallableChangesets(compilerOnlyCallableChanges, new Map()), ["@fixture/public"])
  assert.deepEqual(
    validatePublicCallableChangesets(compilerOnlyCallableChanges, new Map([["@fixture/public", "patch"]])),
    []
  )
  const defaultPrevious = new Map([
    ["packages/public/src/index.ts", 'export { default as Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export default function Public(props: { a: string }): string { return props.a }"]
  ])
  const defaultCurrent = new Map([
    ["packages/public/src/index.ts", 'export { default as Public } from "./view.js"'],
    ["packages/public/src/view.tsx", "export default function Public(props: { b: string }): string { return props.b }"]
  ])
  assert.deepEqual(publicCallableChanges(defaultPrevious, defaultCurrent, ["packages/public/src/index.ts"]), [
    { kind: "addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["b"] },
    { kind: "removal", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["a"] }
  ])
  const namedDefaultSource = new Map([
    [
      "packages/public/src/view.tsx",
      "export default function Internal(props: { value: string }): string { return props.value }"
    ]
  ])
  assert.deepEqual(
    [
      ...new Set(
        reachableCallableEntries(namedDefaultSource, ["packages/public/src/view.tsx"]).map(
          ({ exportedName }) => exportedName
        )
      )
    ],
    ["default"]
  )
  const explicitlyNamedDefaultSource = new Map([
    [
      "packages/public/src/view.tsx",
      "export function Internal(props: { value: string }): string { return props.value }\nexport { Internal as default }"
    ]
  ])
  assert.deepEqual(
    [
      ...new Set(
        reachableCallableEntries(explicitlyNamedDefaultSource, ["packages/public/src/view.tsx"]).map(
          ({ exportedName }) => exportedName
        )
      )
    ],
    ["Internal", "default"]
  )
  const emptyCallablePrevious = new Map([["packages/public/src/index.ts", "export {}"]])
  const emptyCallableCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/view.tsx", 'export const Public = () => "value"']
  ])
  assert.deepEqual(
    publicCallableChanges(emptyCallablePrevious, emptyCallableCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "callable-addition", filePath: "packages/public/src/view.tsx", name: "Public", properties: [] }]
  )
  const conditionalIdentitySources = new Map([
    ["packages/public/src/shared.tsx", 'export const Public = (): string => "value"']
  ])
  const conditionalIdentityPrevious = { exports: { ".": { import: "./src/shared.tsx", require: "./src/shared.tsx" } } }
  const conditionalIdentityCurrent = { exports: { ".": { import: "./src/shared.tsx", browser: "./src/shared.tsx" } } }
  assert.deepEqual(
    publicCallableChanges(
      conditionalIdentitySources,
      conditionalIdentitySources,
      manifestEntryPointDescriptors(conditionalIdentityPrevious, "packages/public", [
        ...conditionalIdentitySources.keys()
      ]),
      manifestEntryPointDescriptors(conditionalIdentityCurrent, "packages/public", [
        ...conditionalIdentitySources.keys()
      ])
    ),
    [
      { kind: "callable-addition", filePath: "packages/public/src/shared.tsx", name: "Public", properties: [] },
      { kind: "callable-removal", filePath: "packages/public/src/shared.tsx", name: "Public", properties: [] }
    ]
  )

  assert.deepEqual(
    compilerConfigurationReferences(
      "/fixture/packages/public/tsconfig.json",
      '{"extends":["../../tsconfig.base.jsonc","./tsconfig.local.json"]}'
    ),
    ["/fixture/tsconfig.base.jsonc", "/fixture/packages/public/tsconfig.local.json"]
  )
  assert.throws(
    () =>
      compilerConfigurationReferences(
        "/fixture/packages/public/tsconfig.json",
        '{"extends":["../../tsconfig.base.jsonc",42]}'
      ),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason ===
        "/fixture/packages/public/tsconfig.json: compiler configuration extends must contain only strings"
  )
  const arrayExtendsCompilerOptions = compilerOptionsFromConfig(
    "/fixture/packages/public/tsconfig.json",
    '{"extends":["../../tsconfig.base.jsonc","./tsconfig.local.json"],"files":["src/index.ts"]}',
    new Map([
      ["/fixture/tsconfig.base.jsonc", '{"compilerOptions":{"noUncheckedIndexedAccess":true}}'],
      ["/fixture/packages/public/tsconfig.local.json", '{"compilerOptions":{"noUncheckedIndexedAccess":false}}'],
      ["/fixture/packages/public/src/index.ts", ""]
    ])
  )
  assert.equal(arrayExtendsCompilerOptions.noUncheckedIndexedAccess, false)

  const perProjectPrevious = new Map([
    ["packages/public/src/client.ts", "export const Public = (values: string[]) => values[0]"],
    ["packages/public/src/server.ts", "export const Public = (values: string[]) => values[0]"]
  ])
  const perProjectCompilerOptions = (noUncheckedIndexedAccess) => ({
    ...defaultCompilerOptions,
    noUncheckedIndexedAccess
  })
  assert.deepEqual(
    publicCallableChanges(
      perProjectPrevious,
      perProjectPrevious,
      ["packages/public/src/client.ts", "packages/public/src/server.ts"],
      undefined,
      {
        previousCompilerOptionsByEntryPoint: new Map([
          ["packages/public/src/client.ts", perProjectCompilerOptions(false)],
          ["packages/public/src/server.ts", perProjectCompilerOptions(false)]
        ]),
        currentCompilerOptionsByEntryPoint: new Map([
          ["packages/public/src/client.ts", perProjectCompilerOptions(false)],
          ["packages/public/src/server.ts", perProjectCompilerOptions(true)]
        ])
      }
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/server.ts", name: "Public", properties: [] }]
  )

  const typeOnlyAliasPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Added } from "./view.js"'],
    ["packages/public/src/view.tsx", "export function Added(): void {}"]
  ])
  const typeOnlyAliasCurrent = new Map([
    ["packages/public/src/index.ts", 'export type { Added } from "./view.js"'],
    ["packages/public/src/view.tsx", "export function Added(): void {}"]
  ])
  assert.deepEqual(
    publicCallableChanges(typeOnlyAliasPrevious, typeOnlyAliasCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "callable-removal", filePath: "packages/public/src/view.tsx", name: "Added", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      typeOnlyAliasPrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { type Added } from "./view.js"'],
        ["packages/public/src/view.tsx", "export function Added(): void {}"]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "callable-removal", filePath: "packages/public/src/view.tsx", name: "Added", properties: [] }]
  )

  const namedOptionalTuplePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [value?: string][0] }\nexport const Public = (props: Props) => props"
    ]
  ])
  const namedOptionalTupleRequired = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Props = { value: [value: string][0] }\nexport const Public = (props: Props) => props"
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(namedOptionalTuplePrevious, namedOptionalTupleRequired, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      namedOptionalTuplePrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "type Props = { value: [renamed?: string][0] }\nexport const Public = (props: Props) => props"
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    []
  )
  const namedRestTuple = (element) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `type Props = { value: ${element}[0] }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(namedRestTuple("[...values: string[]]"), namedRestTuple("[...string[]]"), [
      "packages/public/src/index.ts"
    ]),
    []
  )

  const parameterPropertySource = (valueType) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Result { constructor(public value: ${valueType}) {} }\ntype Props = { value: Result }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(parameterPropertySource("string"), parameterPropertySource("number"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      parameterPropertySource("string"),
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          "class Result { value: string; constructor(value: string) { this.value = value } }\ntype Props = { value: Result }\nexport const Public = (props: Props) => props"
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    []
  )

  const accessorSource = (getterType, setterType) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Model { get selected(): ${getterType} { throw new Error("unreachable") } set selected(value: ${setterType}) {} }\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(accessorSource("string", "string"), accessorSource("string", "string | number"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(accessorSource("string", "string"), accessorSource("number", "string"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const importTypeSource = (valueType, otherType = "boolean") =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/model.ts",
        `export interface Result { value: ${valueType} }\nexport interface Other { changed: ${otherType} }`
      ],
      [
        "packages/public/src/view.tsx",
        'type Props = { value: import("./model.js").Result }\nexport const Public = (props: Props) => props'
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(importTypeSource("string"), importTypeSource("number"), ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(importTypeSource("string"), importTypeSource("string", "number"), [
      "packages/public/src/index.ts"
    ]),
    []
  )

  const defaultExpressionSource = (returnType) =>
    new Map([
      ["packages/public/src/index.ts", 'export { default as Public } from "./view.js"'],
      ["packages/public/src/view.tsx", `export default (() : ${returnType} => "value")`]
    ])
  assert.deepEqual(
    publicCallableChanges(
      defaultExpressionSource("string"),
      new Map([
        ["packages/public/src/index.ts", 'export { default as Public } from "./view.js"'],
        ["packages/public/src/view.tsx", 'export default (() : number => "value")']
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "return-type-change", filePath: "packages/public/src/view.tsx", name: "default", properties: [] }]
  )
  assert.deepEqual(
    publicCallableChanges(new Map([["packages/public/src/index.ts", "export {}"]]), defaultExpressionSource("string"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "callable-addition", filePath: "packages/public/src/view.tsx", name: "default", properties: [] }]
  )

  const indexedAccessSignaturePrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [key: string]: string }\ntype Props = { value: Model["x"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexSignatureExplicitMember = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Model = { [key: string]: string; x: string }\ntype Props = { value: Model["x"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedAccessSignaturePrevious, indexSignatureExplicitMember, [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      indexedAccessSignaturePrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          'type Model = { [key: string]: number }\ntype Props = { value: Model["x"] }\nexport const Public = (props: Props) => props'
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const indexedIntersectionPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Left = { selected: string }\ntype Right = { other: number }\ntype Model = Left & Right\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  const indexedIntersectionUnselected = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Left = { selected: string }\ntype Right = { other: boolean }\ntype Model = Left & Right\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(indexedIntersectionPrevious, indexedIntersectionUnselected, ["packages/public/src/index.ts"]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      indexedIntersectionPrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          'type Left = { selected: number }\ntype Right = { other: number }\ntype Model = Left & Right\ntype Props = { value: Model["selected"] }\nexport const Public = (props: Props) => props'
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const reverseConditionalPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: string extends "a" ? string : number }\nexport const Public = (props: Props) => props'
    ]
  ])
  const reverseConditionalFalseChanged = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      'type Props = { value: string extends "a" ? string : boolean }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(reverseConditionalPrevious, reverseConditionalFalseChanged, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      reverseConditionalPrevious,
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          'type Props = { value: string extends "a" ? boolean : number }\nexport const Public = (props: Props) => props'
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    []
  )

  const defaultedMethod = (parameter) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Model { m(${parameter}): string { return "" } }\ntype Props = { value: Model }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(defaultedMethod('x: string = ""'), defaultedMethod("x: string"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(defaultedMethod('x: string = ""'), defaultedMethod('x: string = "changed"'), [
      "packages/public/src/index.ts"
    ]),
    []
  )

  const classOverloadImplementation = (implementationParameter) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Model { m(x: string): string\n m(${implementationParameter}): string { return "" } }\ntype Props = { value: Model }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(classOverloadImplementation("x: any"), classOverloadImplementation("x: unknown"), [
      "packages/public/src/index.ts"
    ]),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      classOverloadImplementation("x: any"),
      new Map([
        ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
        [
          "packages/public/src/view.tsx",
          'class Model { m(x: number): string\n m(x: any): string { return "" } }\ntype Props = { value: Model }\nexport const Public = (props: Props) => props'
        ]
      ]),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const typeQuerySource = (staticType, constructorType, body = "") =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Result { static selected: ${staticType}; constructor(value: ${constructorType}) { ${body} } }\ntype Props = { value: typeof Result }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(typeQuerySource("string", "string"), typeQuerySource("number", "string"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(typeQuerySource("string", "string"), typeQuerySource("string", "number"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(typeQuerySource("string", "string", "return value"), typeQuerySource("string", "string"), [
      "packages/public/src/index.ts"
    ]),
    []
  )

  const inheritedStaticSource = (selectedType) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Base { static selected: ${selectedType} }\nclass Derived extends Base {}\ntype Props = { value: typeof Derived }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(inheritedStaticSource("string"), inheritedStaticSource("number"), [
      "packages/public/src/index.ts"
    ]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const constructorVisibilitySource = (constructor) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `${constructor}\ntype Props = { value: typeof Result }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(
      constructorVisibilitySource("class Result { private constructor() {} }"),
      constructorVisibilitySource("class Result { public constructor() {} }"),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
  assert.deepEqual(
    publicCallableChanges(
      constructorVisibilitySource("class Result { private constructor() {} }"),
      constructorVisibilitySource('class Result { private constructor() { throw new Error("changed") } }'),
      ["packages/public/src/index.ts"]
    ),
    []
  )
  assert.deepEqual(
    publicCallableChanges(
      constructorVisibilitySource("abstract class Result {}"),
      constructorVisibilitySource("class Result {}"),
      ["packages/public/src/index.ts"]
    ),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )

  const structuralClassSource = (moduleName) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [`packages/public/src/${moduleName}.ts`, "export class Result {}"],
      [
        "packages/public/src/view.tsx",
        `import { Result } from "./${moduleName}.js"\ntype Props = { value: typeof Result }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(structuralClassSource("a"), structuralClassSource("b"), ["packages/public/src/index.ts"]),
    []
  )

  const staticOverloadSource = (implementationType) =>
    new Map([
      ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
      [
        "packages/public/src/view.tsx",
        `class Result { static m(value: string): string; static m(value: ${implementationType}): string { return "" } }\ntype Props = { value: typeof Result }\nexport const Public = (props: Props) => props`
      ]
    ])
  assert.deepEqual(
    publicCallableChanges(staticOverloadSource("any"), staticOverloadSource("unknown"), [
      "packages/public/src/index.ts"
    ]),
    []
  )

  const nominalOriginPrevious = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/a.ts", 'export class Result { private brand = "a"; value = "" }'],
    ["packages/public/src/b.ts", 'export class Result { private brand = "b"; value = "" }'],
    [
      "packages/public/src/view.tsx",
      'import type { Result } from "./a.js"\ntype Props = { value: Result }\nexport const Public = (props: Props) => props'
    ]
  ])
  const nominalOriginCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    ["packages/public/src/a.ts", 'export class Result { private brand = "a"; value = "" }'],
    ["packages/public/src/b.ts", 'export class Result { private brand = "b"; value = "" }'],
    [
      "packages/public/src/view.tsx",
      'import type { Result } from "./b.js"\ntype Props = { value: Result }\nexport const Public = (props: Props) => props'
    ]
  ])
  assert.deepEqual(
    publicCallableChanges(nominalOriginPrevious, nominalOriginCurrent, ["packages/public/src/index.ts"]),
    [{ kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }]
  )
}

const decodeJson = Effect.fn("ChangesetCoverage.decodeJson")(function* (content, location) {
  return yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) => new ChangesetCoverageError({ cause, reason: `${location}: invalid JSON` })
  })
})

const makeGit = Effect.fn("ChangesetCoverage.makeGit")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  return Effect.fn("ChangesetCoverage.git")(function* (args) {
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repositoryRoot }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* fail(
        `git ${args.join(" ")} failed with exit code ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`
      )
    }
    return stdout.trim()
  })
})

const gitOption = (git, args) => git(args).pipe(Effect.option, Effect.map(Option.getOrUndefined))

const resolveMergeBase = Effect.fn("ChangesetCoverage.resolveMergeBase")(function* (git, configuredBase, githubBase) {
  const candidates = [
    configuredBase,
    githubBase === undefined ? undefined : `origin/${githubBase}`,
    "origin/main",
    "main"
  ].filter((candidate) => candidate !== undefined)
  for (const candidate of candidates) {
    const mergeBase = yield* gitOption(git, ["merge-base", "HEAD", candidate])
    if (mergeBase !== undefined) return mergeBase
  }
  return yield* fail(
    `Could not resolve a changeset coverage merge base from: ${candidates.join(
      ", "
    )}. Fetch the base branch history or set CHANGESET_COVERAGE_BASE explicitly.`
  )
})

const runMergeBaseSelfTest = Effect.fn("ChangesetCoverage.runMergeBaseSelfTest")(function* () {
  const validAttempts = []
  const validGit = (args) => {
    validAttempts.push(args)
    return args.at(-1) === "origin/release"
      ? Effect.succeed("fixture-merge-base")
      : fail(`Fixture revision ${args.at(-1)} is unavailable`)
  }
  const mergeBase = yield* resolveMergeBase(validGit, "missing-base", "release")
  yield* Effect.try({
    try: () => {
      assert.equal(mergeBase, "fixture-merge-base")
      assert.deepEqual(validAttempts, [
        ["merge-base", "HEAD", "missing-base"],
        ["merge-base", "HEAD", "origin/release"]
      ])
    },
    catch: (cause) =>
      new ChangesetCoverageError({
        cause,
        reason: "Changeset coverage valid merge-base self-test failed"
      })
  })

  const invalidAttempts = []
  const invalidGit = (args) => {
    invalidAttempts.push(args)
    return fail(`Fixture revision ${args.at(-1)} is unavailable`)
  }
  const unresolved = yield* resolveMergeBase(invalidGit, undefined, undefined).pipe(Effect.flip)
  yield* Effect.try({
    try: () => {
      assert.match(unresolved.reason, /Could not resolve a changeset coverage merge base/u)
      assert.deepEqual(invalidAttempts, [
        ["merge-base", "HEAD", "origin/main"],
        ["merge-base", "HEAD", "main"]
      ])
      assert.equal(
        invalidAttempts.some(([command]) => command === "rev-parse"),
        false
      )
    },
    catch: (cause) =>
      new ChangesetCoverageError({
        cause,
        reason: "Changeset coverage fail-closed merge-base self-test failed"
      })
  })
})

const changedPaths = Effect.fn("ChangesetCoverage.changedPaths")(function* (git, mergeBase) {
  const [tracked, untracked] = yield* Effect.all([
    git(["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", mergeBase, "--"]),
    git(["ls-files", "--others", "--exclude-standard"])
  ])
  return new Set([...splitLines(tracked), ...splitLines(untracked)])
})

// Only frontmatter changed from this run's merge base may satisfy coverage.
// Existing changesets at the merge base describe older work and are deliberately absent.
const changedChangesetPackages = Effect.fn("ChangesetCoverage.changedChangesetPackages")(
  function* (fileSystem, path, repositoryRoot, paths) {
    const packages = new Set()
    const changesets = [...paths].filter(
      (changedPath) =>
        changedPath.startsWith(".changeset/") && changedPath.endsWith(".md") && changedPath !== ".changeset/README.md"
    )
    for (const changesetPath of changesets) {
      const absolute = path.join(repositoryRoot, changesetPath)
      if (!(yield* fileSystem.exists(absolute))) continue
      const content = yield* fileSystem.readFileString(absolute)
      const names = yield* Effect.try({
        try: () => parseChangesetFrontmatter(content, changesetPath),
        catch: (cause) => new ChangesetCoverageError({ cause, reason: `Could not parse ${changesetPath}` })
      })
      for (const name of names) packages.add(name)
    }
    return packages
  }
)

const changedChangesetReleaseTypes = Effect.fn("ChangesetCoverage.changedChangesetReleaseTypes")(
  function* (fileSystem, path, repositoryRoot, paths) {
    const releases = new Map()
    const changesets = [...paths].filter(
      (changedPath) =>
        changedPath.startsWith(".changeset/") && changedPath.endsWith(".md") && changedPath !== ".changeset/README.md"
    )
    for (const changesetPath of changesets) {
      const absolute = path.join(repositoryRoot, changesetPath)
      if (!(yield* fileSystem.exists(absolute))) continue
      const content = yield* fileSystem.readFileString(absolute)
      const parsed = yield* Effect.try({
        try: () => parseChangesetReleaseTypes(content, changesetPath),
        catch: (cause) => new ChangesetCoverageError({ cause, reason: `Could not parse ${changesetPath}` })
      })
      for (const [name, releaseType] of parsed) {
        releases.set(name, mergeReleaseType(releases.get(name), releaseType))
      }
    }
    return releases
  }
)

const sourcePaths = (paths) =>
  [...paths].filter(
    (changedPath) =>
      changedPath.startsWith("packages/") &&
      changedPath.includes("/src/") &&
      /\.(?:ts|tsx)$/u.test(changedPath) &&
      !isExcludedSourcePath(changedPath)
  )

const entryPathCaptures = (entryPath, candidate) => {
  const wildcardCount = entryPath.length - entryPath.replaceAll("*", "").length
  if (wildcardCount === 0) return entryPath === candidate ? [] : undefined
  const prefix = entryPath.split("*")[0]
  if (!candidate.startsWith(prefix)) return undefined
  const captureStart = prefix.length
  for (let captureEnd = captureStart; captureEnd <= candidate.length; captureEnd += 1) {
    const capture = candidate.slice(captureStart, captureEnd)
    if (entryPath.replaceAll("*", capture) === candidate) return [capture]
  }
  return undefined
}

const publicSubpathFor = (identity, captures) => {
  if (!identity.startsWith("exports:")) return undefined
  const subpath = identity.slice("exports:".length)
  if (!subpath.includes("*") || captures.length === 0) return undefined
  return subpath.replaceAll("*", captures[0])
}

const manifestEntries = (manifest) => {
  const entries = []
  const publishConfig =
    Predicate.isObjectOrArray(manifest.publishConfig) && !Array.isArray(manifest.publishConfig)
      ? manifest.publishConfig
      : undefined
  const effectiveManifest = publishConfig === undefined ? manifest : { ...manifest, ...publishConfig }
  for (const field of ["main", "module", "types"]) {
    const target = effectiveManifest[field]
    if (Predicate.isString(target)) entries.push({ identity: field, target })
  }
  const collectExports = (value, subpath, conditionPath = []) => {
    if (Predicate.isString(value)) {
      const entry = { identity: `exports:${subpath ?? "."}`, target: value }
      if (conditionPath.length > 0) entry.conditionPath = conditionPath
      entries.push(entry)
    } else if (Predicate.isObjectOrArray(value)) {
      for (const [key, nested] of Object.entries(value)) {
        const isSubpath = subpath === undefined && key.startsWith(".")
        const nextSubpath = subpath ?? (isSubpath ? key : ".")
        const nextConditionPath = isSubpath ? [] : [...conditionPath, key]
        collectExports(nested, nextSubpath, nextConditionPath)
      }
    }
  }
  if (effectiveManifest.exports !== undefined) collectExports(effectiveManifest.exports, undefined)
  return entries
}

const manifestEntryPointDescriptors = (manifest, directory, sourceFiles) => {
  if (!Predicate.isObjectOrArray(manifest) || Array.isArray(manifest)) return []
  const entries = manifestEntries(manifest)

  const candidates = sourceFiles === undefined ? [] : [...sourceFiles]
  const mapEntryPath = (entryPath) => {
    const normalized = entryPath.replace(/^\.\//u, "")
    const sourcePrefix = `${directory}/src/`
    if (normalized.startsWith("src/")) {
      const sourcePattern = normalized.slice("src/".length).replace(/\.(?:[cm]?js|jsx|tsx?)$/u, "")
      return candidates.flatMap((candidate) => {
        const candidateStem = candidate.slice(sourcePrefix.length).replace(/\.(?:tsx?|jsx)$/u, "")
        const captures = entryPathCaptures(sourcePattern, candidateStem)
        return captures === undefined ? [] : [{ sourcePath: candidate, captures }]
      })
    }
    if (!normalized.startsWith("dist/")) return []
    const outputPath = normalized.slice("dist/".length)
    return candidates.flatMap((candidate) => {
      const sourceRelative = candidate.slice(sourcePrefix.length)
      const sourceStem = sourceRelative.replace(/\.(?:tsx?|jsx)$/u, "")
      const outputCandidates = [
        `${sourceStem}.js`,
        `${sourceStem}.jsx`,
        `dts/${sourceStem}.d.ts`,
        `src/${sourceStem}.js`,
        `src/${sourceStem}.jsx`
      ]
      for (const outputCandidate of outputCandidates) {
        const captures = entryPathCaptures(outputPath, outputCandidate)
        if (captures !== undefined) return [{ sourcePath: candidate, captures }]
      }
      return []
    })
  }
  const descriptors = []
  for (const { conditionPath, identity, target } of entries) {
    for (const { captures, sourcePath } of mapEntryPath(target)) {
      if (!isExcludedSourcePath(sourcePath)) {
        const descriptor = { identity, sourcePath }
        if (conditionPath !== undefined) descriptor.conditionPath = conditionPath
        const publicSubpath = publicSubpathFor(identity, captures)
        if (publicSubpath !== undefined) descriptor.publicSubpath = publicSubpath
        descriptors.push(descriptor)
      }
    }
  }
  const uniqueDescriptors = new Map()
  for (const descriptor of descriptors) {
    const key = `${descriptor.identity}\u0000${descriptor.sourcePath}\u0000${conditionPathKey(
      descriptor.conditionPath
    )}\u0000${descriptor.publicSubpath ?? ""}`
    const existing = uniqueDescriptors.get(key)
    if (existing === undefined) uniqueDescriptors.set(key, descriptor)
  }
  return [...uniqueDescriptors.values()]
}

const manifestEntryPoints = (manifest, directory, sourceFiles) => [
  ...new Set(manifestEntryPointDescriptors(manifest, directory, sourceFiles).map(({ sourcePath }) => sourcePath))
]

const collectSourceFiles = Effect.fn("ChangesetCoverage.collectSourceFiles")(
  function* (fileSystem, path, directory, relativeDirectory) {
    const files = []
    for (const entry of (yield* fileSystem.readDirectory(directory)).toSorted()) {
      const absolute = path.join(directory, entry)
      const relative = `${relativeDirectory}/${entry}`
      const stats = yield* fileSystem.stat(absolute)
      if (stats.type === "Directory") {
        const nestedFiles = yield* collectSourceFiles(fileSystem, path, absolute, relative)
        for (const nestedFile of nestedFiles) files.push(nestedFile)
      } else if (/\.(?:ts|tsx)$/u.test(entry) && !isExcludedSourcePath(relative)) {
        files.push(relative)
      }
    }
    return files
  }
)

const shouldAnalyzePublicCallableChanges = (record, changedSourceFiles, changedCompilerConfiguration = false) =>
  record.publishable && (changedSourceFiles.length > 0 || record.changedReleaseManifest || changedCompilerConfiguration)

const changedPublicCallableChanges = Effect.fn("ChangesetCoverage.changedPublicCallableChanges")(
  function* (git, fileSystem, path, repositoryRoot, mergeBase, paths, records) {
    const changes = []
    for (const record of records) {
      if (!record.publishable) continue
      const changedSourceFiles = sourcePaths(paths).filter((changedPath) =>
        changedPath.startsWith(`${record.directory}/`)
      )
      const packageConfigPath = `${record.directory}/tsconfig.json`
      const packageConfigAbsolutePath = path.join(repositoryRoot, packageConfigPath)
      const currentConfig = yield* fileSystem.readFileString(packageConfigAbsolutePath)
      const currentConfigFiles = yield* collectCompilerConfigurationFiles(
        packageConfigAbsolutePath,
        currentConfig,
        (configPath) => fileSystem.readFileString(configPath)
      )
      let previousConfigFiles = new Map()
      const previousConfig = yield* gitOption(git, ["show", `${mergeBase}:${packageConfigPath}`])
      if (previousConfig !== undefined) {
        previousConfigFiles = yield* collectCompilerConfigurationFiles(
          packageConfigAbsolutePath,
          previousConfig,
          (configPath) =>
            git(["show", `${mergeBase}:${configPath.slice(repositoryRoot.length + 1)}`]).pipe(
              Effect.mapError(
                (cause) =>
                  new ChangesetCoverageError({
                    cause,
                    reason: `${mergeBase}:${configPath.slice(repositoryRoot.length + 1)}: compiler configuration is unavailable`
                  })
              )
            )
        )
      }
      const relativeConfigurationPath = (configPath) =>
        configPath.startsWith(`${repositoryRoot}/`) ? configPath.slice(repositoryRoot.length + 1) : configPath
      const changedCompilerConfiguration =
        paths.has("tsconfig.base.jsonc") ||
        [...currentConfigFiles.keys(), ...previousConfigFiles.keys()]
          .map(relativeConfigurationPath)
          .some((configPath) => paths.has(configPath))
      if (!shouldAnalyzePublicCallableChanges(record, changedSourceFiles, changedCompilerConfiguration)) continue
      const sourceRoot = path.join(repositoryRoot, record.directory, "src")
      const relativeSourceFiles = yield* collectSourceFiles(fileSystem, path, sourceRoot, `${record.directory}/src`)
      const currentSources = new Map()
      for (const relativePath of relativeSourceFiles) {
        currentSources.set(relativePath, yield* fileSystem.readFileString(path.join(repositoryRoot, relativePath)))
      }
      const previousOutput = yield* git(["ls-tree", "-r", "--name-only", mergeBase, "--", `${record.directory}/src`])
      const previousRelativeSourceFiles = splitLines(previousOutput).filter(
        (filePath) => /\.(?:ts|tsx)$/u.test(filePath) && !isExcludedSourcePath(filePath)
      )
      const previousSources = new Map()
      for (const relativePath of previousRelativeSourceFiles) {
        const source = yield* gitOption(git, ["show", `${mergeBase}:${relativePath}`])
        if (source !== undefined) previousSources.set(relativePath, source)
      }
      const currentEntryPoints = manifestEntryPointDescriptors(record.manifest, record.directory, relativeSourceFiles)
      const previousEntryPoints = manifestEntryPointDescriptors(
        record.previousManifest,
        record.directory,
        previousRelativeSourceFiles
      )
      const readConfig = (configText, configFiles, sources, entryPoints, configurationPaths) => {
        const normalizedEntryPoints = normalizeEntryPoints(entryPoints)
        const sourceFiles = new Map([
          ...configFiles,
          ...[...sources.keys()].map((sourcePath) => [path.join(repositoryRoot, sourcePath), ""])
        ])
        return new Map(
          [...new Set(normalizedEntryPoints.map(({ sourcePath }) => sourcePath))].map((entryPointSourcePath) => [
            entryPointSourcePath,
            packageCompilerOptions(sources, repositoryRoot, {
              configText,
              configFiles: sourceFiles,
              configurationPaths,
              entryPointSourcePath
            })
          ])
        )
      }
      let currentCompilerOptionsByEntryPoint = new Map()
      if (currentSources.size > 0) {
        currentCompilerOptionsByEntryPoint = readConfig(
          currentConfig,
          currentConfigFiles,
          currentSources,
          currentEntryPoints,
          [...currentConfigFiles.keys()]
        )
      }
      let previousCompilerOptionsByEntryPoint = new Map()
      if (previousSources.size > 0) {
        if (previousConfig === undefined) {
          return yield* fail(`${mergeBase}: compiler configuration for ${record.directory} is unavailable`)
        }
        previousCompilerOptionsByEntryPoint = readConfig(
          previousConfig,
          previousConfigFiles,
          previousSources,
          previousEntryPoints,
          [...previousConfigFiles.keys()]
        )
      }
      const callableChanges = yield* Effect.try({
        try: () =>
          publicCallableChanges(previousSources, currentSources, previousEntryPoints, currentEntryPoints, {
            currentCompilerOptionsByEntryPoint,
            previousCompilerOptionsByEntryPoint,
            recursiveDeclarations: unchangedDeclarationKeys(previousSources, currentSources)
          }),
        catch: toPublicCallableChangesError
      })
      for (const change of callableChanges) {
        changes.push({ ...change, packageName: record.name })
      }
    }
    return changes
  }
)

const valueAtRevision = Effect.fn("ChangesetCoverage.valueAtRevision")(function* (git, revision, filePath) {
  const content = yield* gitOption(git, ["show", `${revision}:${filePath}`])
  return content === undefined ? undefined : yield* decodeJson(content, `${revision}:${filePath}`)
})

const loadPackageRecords = Effect.fn("ChangesetCoverage.loadPackageRecords")(
  function* (git, fileSystem, path, repositoryRoot, packagesRoot, mergeBase, paths) {
    const records = []
    // Whole-package deletion has no surviving release target and is intentionally
    // outside this check. Deletions within a surviving package remain release-bearing.
    const entries = (yield* fileSystem.readDirectory(packagesRoot)).toSorted()
    for (const entry of entries) {
      const packageDirectory = path.join(packagesRoot, entry)
      if ((yield* fileSystem.stat(packageDirectory)).type !== "Directory") continue
      const manifestRelativePath = `packages/${entry}/package.json`
      const manifestPath = path.join(repositoryRoot, manifestRelativePath)
      if (!(yield* fileSystem.exists(manifestPath))) continue
      const current = yield* decodeJson(yield* fileSystem.readFileString(manifestPath), manifestRelativePath)
      const previous = paths.has(manifestRelativePath)
        ? yield* valueAtRevision(git, mergeBase, manifestRelativePath)
        : current
      records.push({
        changedReleaseManifest: paths.has(manifestRelativePath) && manifestsDifferForRelease(current, previous),
        directory: `packages/${entry}`,
        manifest: current,
        previousManifest: previous,
        name: current.name ?? `packages/${entry}`,
        publishable: current.private !== true
      })
    }
    return records
  }
)

const program = Effect.gen(function* () {
  yield* Effect.try({
    try: runSelfTest,
    catch: (cause) => new ChangesetCoverageError({ cause, reason: "Changeset coverage self-test failed" })
  })
  yield* runMergeBaseSelfTest()

  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.includes("--self-test")) return

  const path = yield* Path.Path
  const fileSystem = yield* FileSystem.FileSystem
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const packagesRoot = path.join(repositoryRoot, "packages")
  const git = yield* makeGit(repositoryRoot)
  const configuredBase = Option.getOrUndefined(yield* Config.option(Config.string("CHANGESET_COVERAGE_BASE")))
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.string("GITHUB_BASE_REF")))
  const mergeBase = yield* resolveMergeBase(git, configuredBase, githubBase)
  const paths = yield* changedPaths(git, mergeBase)
  const records = yield* loadPackageRecords(git, fileSystem, path, repositoryRoot, packagesRoot, mergeBase, paths)
  const changedChangesetNames = yield* changedChangesetPackages(fileSystem, path, repositoryRoot, paths)
  const changedReleaseTypes = yield* changedChangesetReleaseTypes(fileSystem, path, repositoryRoot, paths)
  const missing = validateCoverage({ changedChangesetNames, paths, records })
  if (missing.length > 0) {
    return yield* fail(
      `Changeset coverage failed for publishable package changes since ${mergeBase}:\n- ${missing.join("\n- ")}`
    )
  }
  const callableChanges = yield* changedPublicCallableChanges(
    git,
    fileSystem,
    path,
    repositoryRoot,
    mergeBase,
    paths,
    records
  )
  const missingCallableChangesets = validatePublicCallableChangesets(callableChanges, changedReleaseTypes)
  if (missingCallableChangesets.length > 0) {
    return yield* fail(
      `Changeset coverage failed for public callable changes:\n- ${missingCallableChangesets.join("\n- ")}`
    )
  }
  const releaseDiagnostics = validatePublicCallableReleaseTypes({
    changes: callableChanges,
    releaseTypes: changedReleaseTypes
  })
  if (releaseDiagnostics.length > 0) {
    return yield* fail(`Changeset release type coverage failed:\n- ${releaseDiagnostics.join("\n- ")}`)
  }
  yield* Console.log(
    `Changeset coverage checked ${
      releaseBearingPackages(paths, records).length
    } publishable packages against changed changesets`
  )
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
