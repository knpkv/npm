import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

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

const normalizeTypeText = (typeNode) => typeNode.getText().replace(/\s+/gu, " ").trim()

class ChangesetCoverageError extends Data.TaggedError("ChangesetCoverageError") {
  get message() {
    return this.reason
  }
}

const hasReadonlyModifier = (node) =>
  node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ReadonlyKeyword) === true

const analyzeSources = (sources) => {
  const modules = new Map()
  for (const [filePath, source] of sources) {
    const sourceFile = sourceFileFor(source, filePath)
    const local = new Set()
    const aliases = new Map()
    const stars = []
    const imports = new Map()
    const declarations = new Map()
    const exportedTypes = new Set()
    const visit = (node) => {
      if (TypeScript.isTypeAliasDeclaration(node) || TypeScript.isInterfaceDeclaration(node)) {
        declarations.set(node.name.text, node)
        if (hasExportModifier(node)) exportedTypes.add(node.name.text)
      }
      if ((TypeScript.isVariableStatement(node) || TypeScript.isFunctionDeclaration(node)) && hasExportModifier(node)) {
        if (TypeScript.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            if (TypeScript.isIdentifier(declaration.name)) local.add(declaration.name.text)
          }
        } else if (node.name !== undefined) {
          local.add(node.name.text)
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
            aliases.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              sourceSpecifier
            })
          }
        }
      }
      TypeScript.forEachChild(node, visit)
    }
    visit(sourceFile)
    modules.set(filePath, { aliases, declarations, exportedTypes, imports, local, sourceFile, stars })
  }
  return { modules, sources }
}

const resolveTypeDeclaration = (analysis, filePath, name, seen = new Set()) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return undefined
  const local = module.declarations.get(name)
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

const canonicalTypeMaxDepth = 128

const nextCanonicalTypeContext = (context, substitutionPath = context.substitutionPath) => ({
  depth: context.depth + 1,
  substitutionPath
})

const failCanonicalType = (filePath, typeNode, reason) => {
  throw new ChangesetCoverageError({
    reason: `${filePath}: ${reason} while canonicalizing ${normalizeTypeText(typeNode)}`
  })
}

const canonicalTypeText = (
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
  if (TypeScript.isParenthesizedTypeNode(typeNode))
    return canonicalTypeText(typeNode.type, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text
    const substituted = substitutions.get(typeName)
    if (substituted !== undefined) {
      if (Predicate.isString(substituted)) return substituted
      if (context.substitutionPath.has(typeNode)) {
        failCanonicalType(filePath, typeNode, "recursive type substitution")
      }
      const substitutionPath = new Set(context.substitutionPath).add(typeNode)
      return canonicalTypeText(
        substituted,
        analysis,
        filePath,
        substitutions,
        seen,
        nextCanonicalTypeContext(context, substitutionPath)
      )
    }
    const declaration = resolveTypeDeclaration(analysis, filePath, typeName, seen)
    if (declaration !== undefined) {
      const declarationName = declaration.node.name.text
      const key = `${declaration.filePath}\u0000${declarationName}`
      if (seen.has(key)) failCanonicalType(filePath, typeNode, "recursive type declaration")
      const nextSeen = new Set(seen).add(key)
      const nextSubstitutions = new Map(substitutions)
      for (const [index, parameter] of (declaration.node.typeParameters ?? []).entries()) {
        const argument = typeNode.typeArguments?.[index]
        if (argument !== undefined) {
          nextSubstitutions.set(
            parameter.name.text,
            canonicalTypeText(argument, analysis, filePath, substitutions, seen, nextCanonicalTypeContext(context))
          )
        }
      }
      if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
        return canonicalTypeText(
          declaration.node.type,
          analysis,
          declaration.filePath,
          nextSubstitutions,
          nextSeen,
          nextCanonicalTypeContext(context)
        )
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
  if (TypeScript.isFunctionTypeNode(typeNode)) {
    const generic = genericDescriptor(typeNode.typeParameters, analysis, filePath, substitutions, context)
    return `function<${generic.descriptor}>(${typeNode.parameters
      .map((parameter) =>
        parameterDescriptor(parameter, analysis, filePath, generic.substitutions, nextCanonicalTypeContext(context))
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
            nextCanonicalTypeContext(context)
          )
    }`
  }
  return normalizeTypeText(typeNode)
}

const genericDescriptor = (
  typeParameters,
  analysis,
  filePath,
  substitutions,
  context = { depth: 0, substitutionPath: new Set() }
) => {
  const nextSubstitutions = new Map(substitutions)
  for (const [index, parameter] of (typeParameters ?? []).entries()) {
    nextSubstitutions.set(parameter.name.text, `generic#${index}`)
  }
  const descriptor = (typeParameters ?? [])
    .map((parameter, index) => {
      const constraint =
        parameter.constraint === undefined
          ? ""
          : `extends:${canonicalTypeText(
              parameter.constraint,
              analysis,
              filePath,
              nextSubstitutions,
              new Set(),
              nextCanonicalTypeContext(context)
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
              nextCanonicalTypeContext(context)
            )}`
      return `${index}:${constraint}:${defaultType}`
    })
    .join(",")
  return { descriptor, substitutions: nextSubstitutions }
}

const parameterDescriptor = (
  parameter,
  analysis,
  filePath,
  substitutions,
  context = { depth: 0, substitutionPath: new Set() }
) => {
  const marker = parameter.dotDotDotToken === undefined ? "" : "..."
  const optional = parameter.questionToken === undefined ? "" : "?"
  const type =
    parameter.type === undefined
      ? "unknown"
      : canonicalTypeText(parameter.type, analysis, filePath, substitutions, new Set(), context)
  return `${marker}${optional}:${type}`
}

const memberDescriptor = (
  member,
  analysis,
  filePath,
  substitutions,
  context = { depth: 0, substitutionPath: new Set() }
) => {
  const optional = member.questionToken === undefined ? "required" : "optional"
  const readonly = hasReadonlyModifier(member) ? "readonly:" : ""
  if (TypeScript.isMethodSignature(member)) {
    const generic = genericDescriptor(member.typeParameters, analysis, filePath, substitutions, context)
    const parameters = member.parameters
      .map((parameter) => parameterDescriptor(parameter, analysis, filePath, generic.substitutions, context))
      .join(",")
    const returnType =
      member.type === undefined
        ? "unknown"
        : canonicalTypeText(member.type, analysis, filePath, generic.substitutions, new Set(), context)
    return `${readonly}${optional}:method<${generic.descriptor}>(${parameters}):${returnType}`
  }
  const type =
    member.type === undefined
      ? "unknown"
      : canonicalTypeText(member.type, analysis, filePath, substitutions, new Set(), context)
  return `${readonly}${optional}:${type}`
}

const typeMembers = (typeNode, analysis, filePath, seen = new Set(), substitutions = new Map()) => {
  if (TypeScript.isParenthesizedTypeNode(typeNode))
    return typeMembers(typeNode.type, analysis, filePath, seen, substitutions)
  if (TypeScript.isIntersectionTypeNode(typeNode)) {
    const members = new Map()
    let resolved = true
    for (const member of typeNode.types) {
      const result = typeMembers(member, analysis, filePath, seen, substitutions)
      if (!result.resolved) resolved = false
      for (const [name, type] of result.members) members.set(name, type)
    }
    return { members, resolved }
  }
  if (TypeScript.isTypeLiteralNode(typeNode) || TypeScript.isInterfaceDeclaration(typeNode)) {
    const members = new Map()
    let resolved = true
    if (TypeScript.isInterfaceDeclaration(typeNode)) {
      for (const clause of typeNode.heritageClauses ?? []) {
        for (const heritageType of clause.types) {
          const result = typeMembers(heritageType, analysis, filePath, seen, substitutions)
          if (!result.resolved) resolved = false
          for (const [name, type] of result.members) members.set(name, type)
        }
      }
    }
    for (const member of typeNode.members) {
      if (!TypeScript.isPropertySignature(member) && !TypeScript.isMethodSignature(member)) continue
      const name = member.name
      if (!TypeScript.isIdentifier(name) && !TypeScript.isStringLiteral(name) && !TypeScript.isNumericLiteral(name)) {
        continue
      }
      members.set(name.text, memberDescriptor(member, analysis, filePath, substitutions))
    }
    return { members, resolved }
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen)
    if (declaration === undefined) return { members: new Map(), resolved: false }
    const declarationName = declaration.node.name.text
    const declarationKey = `${declaration.filePath}\u0000${declarationName}`
    if (seen.has(declarationKey)) failCanonicalType(filePath, typeNode, "recursive type declaration")
    const nextSeen = new Set(seen).add(declarationKey)
    const nextSubstitutions = new Map(substitutions)
    for (const [index, parameter] of (declaration.node.typeParameters ?? []).entries()) {
      const argument = typeNode.typeArguments?.[index]
      if (argument !== undefined) {
        nextSubstitutions.set(parameter.name.text, canonicalTypeText(argument, analysis, filePath, substitutions, seen))
      }
    }
    if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
      return typeMembers(declaration.node.type, analysis, declaration.filePath, nextSeen, nextSubstitutions)
    }
    if (TypeScript.isInterfaceDeclaration(declaration.node)) {
      return typeMembers(declaration.node, analysis, declaration.filePath, nextSeen, nextSubstitutions)
    }
  }
  if (TypeScript.isExpressionWithTypeArguments(typeNode) && TypeScript.isIdentifier(typeNode.expression)) {
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.expression.text, seen)
    if (declaration === undefined) return { members: new Map(), resolved: false }
    const declarationName = declaration.node.name.text
    const declarationKey = `${declaration.filePath}\u0000${declarationName}`
    if (seen.has(declarationKey)) failCanonicalType(filePath, typeNode, "recursive type declaration")
    const nextSeen = new Set(seen).add(declarationKey)
    const nextSubstitutions = new Map(substitutions)
    for (const [index, parameter] of (declaration.node.typeParameters ?? []).entries()) {
      const argument = typeNode.typeArguments?.[index]
      if (argument !== undefined) {
        nextSubstitutions.set(parameter.name.text, canonicalTypeText(argument, analysis, filePath, substitutions, seen))
      }
    }
    if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
      return typeMembers(declaration.node.type, analysis, declaration.filePath, nextSeen, nextSubstitutions)
    }
    if (TypeScript.isInterfaceDeclaration(declaration.node)) {
      return typeMembers(declaration.node, analysis, declaration.filePath, nextSeen, nextSubstitutions)
    }
  }
  return { members: new Map(), resolved: false }
}

const callableParameterTypesInSources = (sources, filePath, analysis = analyzeSources(sources)) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return new Map()
  const exports = new Map()
  const addCallable = (name, parameters, returnType, contextualType) => {
    const contextualParameters = contextualType === undefined ? [] : contextualType.parameters
    const firstParameter = parameters[0]
    const contextualParameter = contextualParameters[0]
    const parameterType = firstParameter?.type ?? contextualParameter?.type
    const properties =
      parameterType === undefined
        ? { members: new Map(), resolved: false }
        : typeMembers(parameterType, analysis, filePath)
    const contextualReturnType = contextualType?.type
    const effectiveReturnType = returnType ?? contextualReturnType
    exports.set(name, {
      properties,
      returnType:
        effectiveReturnType === undefined ? undefined : canonicalTypeText(effectiveReturnType, analysis, filePath),
      returnResolved: effectiveReturnType !== undefined
    })
  }
  const visit = (node) => {
    if (TypeScript.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer
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
        addCallable(declaration.name.text, initializer.parameters, initializer.type, contextualType)
      }
    }
    if (TypeScript.isFunctionDeclaration(node) && node.name !== undefined && hasExportModifier(node)) {
      addCallable(node.name.text, node.parameters, node.type, undefined)
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

const reachableCallableEntries = (sources, entryPoints) => {
  const info = analyzeSources(sources).modules
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
  currentEntryPoints = previousEntryPoints
) => {
  const signatures = (sources, entryPoints) => {
    const analysis = analyzeSources(sources)
    const result = new Map()
    for (const { conditionPath, entryPoint, exportedName, publicSubpath, target } of reachableCallableEntries(
      sources,
      entryPoints
    )) {
      const signature = callableParameterTypesInSources(sources, target.filePath, analysis).get(target.name)
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
    return result
  }
  const previous = signatures(previousSources, previousEntryPoints)
  const current = signatures(currentSources, currentEntryPoints)
  const changes = []
  const signatureContract = (signature) =>
    [
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
    `${signatureTargetKey(signature)}\u0000${signaturePublicSubpathKey(signature)}`
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
          previousSignature.filePath === currentSignature.filePath && previousSignature.name === currentSignature.name
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
        (previousSignature) => signatureContract(previousSignature) === signatureContract(currentSignature)
      )
      if (index === -1) {
        unmatchedAfterContract.push(currentSignature)
      } else {
        pairs.push([remainingPrevious[index], currentSignature])
        remainingPrevious.splice(index, 1)
      }
    }
    const fallbackCount = Math.min(remainingPrevious.length, unmatchedAfterContract.length)
    for (let index = 0; index < fallbackCount; index += 1) {
      pairs.push([remainingPrevious[index], unmatchedAfterContract[index]])
    }
    const pairedTargetKeys = new Set(
      pairs.flatMap(([previousSignature, currentSignature]) => [
        signatureOccurrenceKey(previousSignature),
        signatureOccurrenceKey(currentSignature)
      ])
    )
    const currentOnly = unmatchedAfterContract
      .slice(fallbackCount)
      .filter(
        (signature) =>
          !previousSignatures.some(
            (previousSignature) =>
              conditionPathKey(previousSignature.conditionPath) === "" &&
              pairedTargetKeys.has(signatureOccurrenceKey(signature))
          )
      )
    const previousOnly = remainingPrevious
      .slice(fallbackCount)
      .filter(
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
    if (
      currentSignature !== undefined &&
      currentSignature.properties.resolved &&
      (previousSignature === undefined || previousSignature.properties.resolved)
    ) {
      for (const property of [...currentProperties.keys()].toSorted()) {
        if (!previousProperties.has(property)) {
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
      currentSignature.returnType !== previousSignature.returnType
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
    const { pairs, currentOnly, previousOnly } = pairSignatures(previousSignatures, currentSignatures)
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

const publicCallableChangesEffect = (
  previousSources,
  currentSources,
  previousEntryPoints,
  currentEntryPoints = previousEntryPoints
) =>
  Effect.try({
    try: () => publicCallableChanges(previousSources, currentSources, previousEntryPoints, currentEntryPoints),
    catch: (cause) =>
      cause instanceof ChangesetCoverageError
        ? cause
        : new ChangesetCoverageError({ cause, reason: "Public callable changes analysis failed" })
  })

const validatePublicCallableReleaseTypes = ({ changes, releaseTypes }) =>
  changes.flatMap(({ filePath, kind = "addition", name, packageName, properties }) => {
    if (releaseTypes.get(packageName) !== "patch") return []
    const action =
      kind === "addition" ? "add" : kind === "removal" ? "remove" : kind === "callable-removal" ? "remove" : "change"
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
  assert.deepEqual(publicCallableChanges(unionPrevious, unionCurrent, ["packages/public/src/index.ts"]), [])

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
      properties: []
    }
  ])
  assert.deepEqual(
    validatePublicCallableReleaseTypes({
      changes: unresolvedCallableRemoval,
      releaseTypes: new Map([["@fixture/public", "patch"]])
    }),
    ["@fixture/public: patch changeset cannot remove public callable (Public in packages/public/src/view.tsx)"]
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
  const directCyclicSources = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      "type Loop = ReadonlyArray<Loop>\ntype Props = { value: Loop }\nexport const Public = (props: Props) => props.value"
    ]
  ])
  assert.throws(
    () => publicCallableChanges(directCyclicSources, directCyclicSources, ["packages/public/src/index.ts"]),
    (cause) =>
      cause instanceof ChangesetCoverageError &&
      cause.reason === "packages/public/src/view.tsx: recursive type declaration while canonicalizing Loop"
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
      `type Props = { value: ${deeplyNestedType("string", canonicalTypeMaxDepth)} }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  const deeplyNestedCurrent = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `type Props = { value: ${deeplyNestedType("number", canonicalTypeMaxDepth)} }\nexport const Public = (props: Props) => props.value`
    ]
  ])
  assert.deepEqual(publicCallableChanges(deeplyNestedPrevious, deeplyNestedCurrent, ["packages/public/src/index.ts"]), [
    { kind: "type-change", filePath: "packages/public/src/view.tsx", name: "Public", properties: ["value"] }
  ])
  const deeplyNestedOverflow = new Map([
    ["packages/public/src/index.ts", 'export { Public } from "./view.js"'],
    [
      "packages/public/src/view.tsx",
      `type Props = { value: ${deeplyNestedType("number", canonicalTypeMaxDepth + 1)} }\nexport const Public = (props: Props) => props.value`
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
    const key = `${descriptor.identity}\u0000${descriptor.sourcePath}\u0000${conditionPathKey(descriptor.conditionPath)}\u0000${descriptor.publicSubpath ?? ""}`
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
        files.push(...(yield* collectSourceFiles(fileSystem, path, absolute, relative)))
      } else if (/\.(?:ts|tsx)$/u.test(entry) && !isExcludedSourcePath(relative)) {
        files.push(relative)
      }
    }
    return files
  }
)

const shouldAnalyzePublicCallableChanges = (record, changedSourceFiles) =>
  record.publishable && (changedSourceFiles.length > 0 || record.changedReleaseManifest)

const changedPublicCallableChanges = Effect.fn("ChangesetCoverage.changedPublicCallableChanges")(
  function* (git, fileSystem, path, repositoryRoot, mergeBase, paths, records) {
    const changes = []
    for (const record of records) {
      if (!record.publishable) continue
      const changedSourceFiles = sourcePaths(paths).filter((changedPath) =>
        changedPath.startsWith(`${record.directory}/`)
      )
      if (!shouldAnalyzePublicCallableChanges(record, changedSourceFiles)) continue
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
      const callableChanges = yield* publicCallableChangesEffect(
        previousSources,
        currentSources,
        previousEntryPoints,
        currentEntryPoints
      )
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
  const releaseDiagnostics = validatePublicCallableReleaseTypes({
    changes: callableChanges,
    releaseTypes: changedReleaseTypes
  })
  if (releaseDiagnostics.length > 0) {
    return yield* fail(`Changeset release type coverage failed:\n- ${releaseDiagnostics.join("\n- ")}`)
  }
  yield* Console.log(
    `Changeset coverage checked ${releaseBearingPackages(paths, records).length} publishable packages against changed changesets`
  )
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
