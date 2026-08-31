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
  const key = `${filePath}\u0000${name}`
  if (seen.has(key)) return undefined
  const nextSeen = new Set(seen).add(key)
  const module = analysis.modules.get(filePath)
  if (module === undefined) return undefined
  const local = module.declarations.get(name)
  if (local !== undefined) return { filePath, node: local }
  const imported = module.imports.get(name)
  if (imported === undefined || imported.importedName === "*") return undefined
  const target = resolveLocalModule(filePath, imported.sourceSpecifier, analysis.sources)
  return target === undefined ? undefined : resolveExportedType(analysis, target, imported.importedName, nextSeen)
}

const resolveExportedType = (analysis, filePath, name, seen = new Set()) => {
  const key = `${filePath}\u0000${name}`
  if (seen.has(key)) return undefined
  const nextSeen = new Set(seen).add(key)
  const module = analysis.modules.get(filePath)
  if (module === undefined) return undefined
  const local = module.declarations.get(name)
  if (local !== undefined && module.exportedTypes.has(name)) return { filePath, node: local }
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

const typeMembers = (typeNode, analysis, filePath, seen = new Set()) => {
  if (TypeScript.isParenthesizedTypeNode(typeNode)) return typeMembers(typeNode.type, analysis, filePath, seen)
  if (TypeScript.isIntersectionTypeNode(typeNode)) {
    const members = new Map()
    for (const member of typeNode.types) {
      for (const [name, type] of typeMembers(member, analysis, filePath, seen)) members.set(name, type)
    }
    return members
  }
  if (TypeScript.isTypeLiteralNode(typeNode) || TypeScript.isInterfaceDeclaration(typeNode)) {
    const members = new Map()
    for (const member of typeNode.members) {
      if (!TypeScript.isPropertySignature(member) && !TypeScript.isMethodSignature(member)) continue
      const name = member.name
      if (!TypeScript.isIdentifier(name) && !TypeScript.isStringLiteral(name) && !TypeScript.isNumericLiteral(name)) {
        continue
      }
      members.set(name.text, member.type === undefined ? "unknown" : normalizeTypeText(member.type))
    }
    if (TypeScript.isInterfaceDeclaration(typeNode)) {
      for (const clause of typeNode.heritageClauses ?? []) {
        for (const heritageType of clause.types) {
          for (const [name, type] of typeMembers(heritageType, analysis, filePath, seen)) members.set(name, type)
        }
      }
    }
    return members
  }
  if (TypeScript.isTypeReferenceNode(typeNode) && TypeScript.isIdentifier(typeNode.typeName)) {
    const declaration = resolveTypeDeclaration(analysis, filePath, typeNode.typeName.text, seen)
    if (declaration === undefined) return new Map()
    const nextSeen = new Set(seen).add(`${declaration.filePath}\u0000${typeNode.typeName.text}`)
    if (TypeScript.isTypeAliasDeclaration(declaration.node)) {
      return typeMembers(declaration.node.type, analysis, declaration.filePath, nextSeen)
    }
    if (TypeScript.isInterfaceDeclaration(declaration.node)) {
      return typeMembers(declaration.node, analysis, declaration.filePath, nextSeen)
    }
  }
  return new Map()
}

const callableParameterTypesInSources = (sources, filePath, analysis = analyzeSources(sources)) => {
  const module = analysis.modules.get(filePath)
  if (module === undefined) return new Map()
  const exports = new Map()
  const addCallable = (name, parameters) => {
    const firstParameter = parameters[0]
    if (firstParameter === undefined || firstParameter.type === undefined) return
    exports.set(name, typeMembers(firstParameter.type, analysis, filePath))
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
        addCallable(declaration.name.text, initializer.parameters)
      }
    }
    if (TypeScript.isFunctionDeclaration(node) && node.name !== undefined && hasExportModifier(node)) {
      addCallable(node.name.text, node.parameters)
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
      .filter(([, properties]) => properties.size > 0)
      .map(([name, properties]) => [name, new Set(properties.keys())])
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
  return entryPoints.flatMap((entryPoint) =>
    [...exportsFor(entryPoint)].map(([exportedName, target]) => ({ entryPoint, exportedName, target }))
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

const publicCallableChanges = (previousSources, currentSources, entryPoints) => {
  const signatures = (sources) => {
    const analysis = analyzeSources(sources)
    const result = new Map()
    for (const { entryPoint, exportedName, target } of reachableCallableEntries(sources, entryPoints)) {
      const properties = callableParameterTypesInSources(sources, target.filePath, analysis).get(target.name)
      if (properties === undefined) continue
      result.set(`${entryPoint}\u0000${exportedName}`, { filePath: target.filePath, name: target.name, properties })
    }
    return result
  }
  const previous = signatures(previousSources)
  const current = signatures(currentSources)
  const changes = []
  for (const [identity, currentSignature] of current) {
    const previousSignature = previous.get(identity)
    const previousProperties = previousSignature?.properties ?? new Map()
    for (const property of [...currentSignature.properties.keys()].toSorted()) {
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
      if (!currentSignature.properties.has(property)) {
        changes.push({
          kind: "removal",
          filePath: currentSignature.filePath,
          name: currentSignature.name,
          properties: [property]
        })
      }
    }
    for (const property of [...currentSignature.properties.keys()].toSorted()) {
      const previousType = previousProperties.get(property)
      const currentType = currentSignature.properties.get(property)
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
  return changes
}

const validatePublicCallableReleaseTypes = ({ changes, releaseTypes }) =>
  changes.flatMap(({ filePath, kind = "addition", name, packageName, properties }) => {
    if (releaseTypes.get(packageName) !== "patch") return []
    const diagnostic = [
      `${packageName}: patch changeset cannot ${kind === "addition" ? "add" : kind === "removal" ? "remove" : "change"} public callable props`,
      properties.join(", "),
      `(${name} in ${filePath})`
    ].join(" ")
    return [diagnostic]
  })

class ChangesetCoverageError extends Data.TaggedError("ChangesetCoverageError") {
  get message() {
    return this.reason
  }
}

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

const entryPathPattern = (entryPath) => {
  const escaped = entryPath.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u")
}

const manifestEntryPoints = (manifest, directory, sourceFiles) => {
  const paths = []
  const collect = (value) => {
    if (Predicate.isString(value)) paths.push(value)
    else if (Predicate.isObjectOrArray(value)) {
      for (const nested of Object.values(value)) collect(nested)
    }
  }
  const publishConfig =
    Predicate.isObjectOrArray(manifest.publishConfig) && !Array.isArray(manifest.publishConfig)
      ? manifest.publishConfig
      : undefined
  const effectiveManifest = publishConfig === undefined ? manifest : { ...manifest, ...publishConfig }
  for (const field of ["main", "module", "types", "exports"]) collect(effectiveManifest[field])

  const candidates = sourceFiles === undefined ? [] : [...sourceFiles]
  const mapEntryPath = (entryPath) => {
    const normalized = entryPath.replace(/^\.\//u, "")
    const sourcePrefix = `${directory}/src/`
    if (normalized.startsWith("src/")) {
      const sourcePattern = entryPathPattern(normalized.slice("src/".length).replace(/\.(?:[cm]?js|jsx)$/u, ".ts"))
      return candidates.filter((candidate) => sourcePattern.test(candidate.slice(sourcePrefix.length)))
    }
    if (!normalized.startsWith("dist/")) return []
    const outputPath = normalized.slice("dist/".length)
    const outputPattern = entryPathPattern(outputPath)
    return candidates.filter((candidate) => {
      const sourceRelative = candidate.slice(sourcePrefix.length)
      const sourceStem = sourceRelative.replace(/\.(?:tsx?|jsx)$/u, "")
      const outputCandidates = [
        `${sourceStem}.js`,
        `${sourceStem}.jsx`,
        `dts/${sourceStem}.d.ts`,
        `src/${sourceStem}.js`,
        `src/${sourceStem}.jsx`
      ]
      return outputCandidates.some((outputCandidate) => outputPattern.test(outputCandidate))
    })
  }
  return [...new Set(paths.flatMap(mapEntryPath))].filter((entryPath) => !isExcludedSourcePath(entryPath))
}

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

const changedPublicCallableChanges = Effect.fn("ChangesetCoverage.changedPublicCallableChanges")(
  function* (git, fileSystem, path, repositoryRoot, mergeBase, paths, records) {
    const changes = []
    for (const record of records) {
      if (!record.publishable) continue
      const changedSourceFiles = sourcePaths(paths).filter((changedPath) =>
        changedPath.startsWith(`${record.directory}/`)
      )
      if (changedSourceFiles.length === 0) continue
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
      const entryPoints = manifestEntryPoints(record.manifest, record.directory, relativeSourceFiles)
      for (const change of publicCallableChanges(previousSources, currentSources, entryPoints)) {
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
