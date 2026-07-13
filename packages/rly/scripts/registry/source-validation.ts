import * as TypeScript from "typescript"
import type { ComponentManifest, ComponentRecord, RegistryMetadata } from "../../component-manifest.js"

const FORBIDDEN_APPLICATION_IMPORT =
  /^(?:@knpkv\/(?!rly(?:\/|$))|@aws-sdk\/|distilled-aws(?:\/|$)|react-router(?:-dom)?(?:\/|$))/
const FORBIDDEN_BROWSER_IMPORT = /^(?:node:|@effect\/platform-node(?:\/|$)|effect\/unstable\/process(?:\/|$))/
const ALLOWED_BROWSER_PACKAGE_IMPORT = /^(?:@pierre\/diffs|lucide-react|radix-ui|react|react-dom)(?:\/|$)/
const FORBIDDEN_BROWSER_HOST_API = /\b(?:EventSource|WebSocket|fetch|localStorage|sessionStorage)\s*(?:\(|\.)/

const exportedNames = (source: string, fileName: string): ReadonlySet<string> => {
  const sourceFile = TypeScript.createSourceFile(fileName, source, TypeScript.ScriptTarget.Latest, true)
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (TypeScript.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (TypeScript.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      }
      continue
    }
    const modifiers = TypeScript.canHaveModifiers(statement) ? TypeScript.getModifiers(statement) : undefined
    if (!modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ExportKeyword)) continue
    if (
      TypeScript.isFunctionDeclaration(statement) ||
      TypeScript.isClassDeclaration(statement) ||
      TypeScript.isInterfaceDeclaration(statement) ||
      TypeScript.isTypeAliasDeclaration(statement)
    ) {
      if (statement.name !== undefined) names.add(statement.name.text)
    } else if (TypeScript.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (TypeScript.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
  }
  return names
}

const kebabCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLocaleLowerCase("en-US")

const normalizeRelativePath = (from: string, specifier: string): string => {
  const segments = [...from.split("/").slice(0, -1), ...specifier.split("/")]
  const resolved: Array<string> = []
  for (const segment of segments) {
    if (segment === "." || segment.length === 0) continue
    if (segment === "..") resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join("/")
}

const resolveStoryImport = (
  files: ReadonlyMap<string, string>,
  from: string,
  specifier: string
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const stem = normalizeRelativePath(from, specifier).replace(/\.js$/, "")
  return [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]
    .find((candidate) => candidate.startsWith("stories/") && files.has(candidate))
}

interface StoryImportBinding {
  readonly file: string
  readonly name: string
}

interface StorySource {
  readonly bindings: ReadonlyMap<string, TypeScript.Node>
  readonly imports: ReadonlyMap<string, StoryImportBinding>
  readonly sourceFile: TypeScript.SourceFile
}

const sourceBindings = (sourceFile: TypeScript.SourceFile): ReadonlyMap<string, TypeScript.Node> => {
  const bindings = new Map<string, TypeScript.Node>()
  for (const statement of sourceFile.statements) {
    if (
      (TypeScript.isFunctionDeclaration(statement)
        || TypeScript.isClassDeclaration(statement)
        || TypeScript.isInterfaceDeclaration(statement)
        || TypeScript.isTypeAliasDeclaration(statement))
      && statement.name !== undefined
    ) {
      bindings.set(statement.name.text, statement)
    } else if (TypeScript.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (TypeScript.isIdentifier(declaration.name)) bindings.set(declaration.name.text, declaration)
      }
    }
  }
  return bindings
}

const storyImports = (
  sourceFile: TypeScript.SourceFile,
  file: string,
  files: ReadonlyMap<string, string>
): ReadonlyMap<string, StoryImportBinding> => {
  const imports = new Map<string, StoryImportBinding>()
  for (const statement of sourceFile.statements) {
    if (!TypeScript.isImportDeclaration(statement) || !TypeScript.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const resolved = resolveStoryImport(files, file, statement.moduleSpecifier.text)
    const clause = statement.importClause
    if (resolved === undefined || clause === undefined || clause.isTypeOnly) continue
    if (clause.name !== undefined) imports.set(clause.name.text, { file: resolved, name: "default" })
    const namedBindings = clause.namedBindings
    if (namedBindings === undefined || TypeScript.isNamespaceImport(namedBindings)) continue
    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        imports.set(element.name.text, { file: resolved, name: element.propertyName?.text ?? element.name.text })
      }
    }
  }
  return imports
}

const storyInitializer = (
  sourceFile: TypeScript.SourceFile,
  storyName: string
): TypeScript.Expression | undefined => {
  for (const statement of sourceFile.statements) {
    if (!TypeScript.isVariableStatement(statement)) continue
    const modifiers = TypeScript.getModifiers(statement)
    if (!modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (TypeScript.isIdentifier(declaration.name) && kebabCase(declaration.name.text) === storyName) {
        return declaration.initializer
      }
    }
  }
  return undefined
}

const completeStoryTerms = (
  entry: string,
  storyName: string,
  files: ReadonlyMap<string, string>
): ReadonlySet<string> => {
  const terms = new Set<string>()
  const sources = new Map<string, StorySource>()
  const visited = new Set<string>()
  const sourceFor = (file: string): StorySource | undefined => {
    const cached = sources.get(file)
    if (cached !== undefined) return cached
    const source = files.get(file)
    if (source === undefined) return undefined
    const sourceFile = TypeScript.createSourceFile(file, source, TypeScript.ScriptTarget.Latest, true)
    const storySource = {
      bindings: sourceBindings(sourceFile),
      imports: storyImports(sourceFile, file, files),
      sourceFile
    }
    sources.set(file, storySource)
    return storySource
  }
  const add = (value: string): void => {
    const normalized = kebabCase(value)
    terms.add(normalized)
    for (const segment of normalized.split(/[^a-z0-9]+/)) {
      if (segment.length > 0) terms.add(segment)
    }
  }
  add(storyName)
  const visit = (file: string, node: TypeScript.Node): void => {
    const key = `${file}:${node.kind}:${node.pos}:${node.end}`
    if (visited.has(key)) return
    visited.add(key)
    if (TypeScript.isIdentifier(node) || TypeScript.isStringLiteralLike(node) || TypeScript.isJsxText(node)) {
      add(node.text)
    }
    if (TypeScript.isIdentifier(node)) {
      const storySource = sourceFor(file)
      const local = storySource?.bindings.get(node.text)
      if (local !== undefined) visit(file, local)
      const imported = storySource?.imports.get(node.text)
      if (imported !== undefined) {
        const importedSource = sourceFor(imported.file)
        const importedNode = importedSource?.bindings.get(imported.name)
        if (importedNode !== undefined) visit(imported.file, importedNode)
      }
    }
    TypeScript.forEachChild(node, (child) => visit(file, child))
  }
  const entrySource = sourceFor(entry)
  if (entrySource === undefined) return terms
  const initializer = storyInitializer(entrySource.sourceFile, storyName)
  if (initializer !== undefined) visit(entry, initializer)
  return terms
}

const exportedStoryHasPlay = (source: string, fileName: string, storyName: string): boolean => {
  const sourceFile = TypeScript.createSourceFile(fileName, source, TypeScript.ScriptTarget.Latest, true)
  for (const statement of sourceFile.statements) {
    if (!TypeScript.isVariableStatement(statement)) continue
    const modifiers = TypeScript.getModifiers(statement)
    if (!modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!TypeScript.isIdentifier(declaration.name) || kebabCase(declaration.name.text) !== storyName) continue
      const initializer = declaration.initializer
      if (initializer === undefined || !TypeScript.isObjectLiteralExpression(initializer)) return false
      return initializer.properties.some((property) =>
        TypeScript.isPropertyAssignment(property)
        && ((TypeScript.isIdentifier(property.name) && property.name.text === "play")
          || (TypeScript.isStringLiteral(property.name) && property.name.text === "play"))
      )
    }
  }
  return false
}

const validateStory = (
  component: ComponentRecord,
  metadata: RegistryMetadata,
  source: string,
  files: ReadonlyMap<string, string>
): ReadonlyArray<string> => {
  const failures: Array<string> = []
  const terms = new Set<string>()
  const storyIds = [component.visual.storyId, ...(component.visual.coverageStoryIds ?? [])]
  if (!/tags:\s*\[\s*["']autodocs["']\s*\]/.test(source)) {
    failures.push(`missing docs metadata ${component.visual.story}`)
  }
  const exports = exportedNames(source, component.visual.story)
  for (const storyId of storyIds) {
    const storyName = storyId.split("--")[1]
    if (storyName === undefined || ![...exports].some((name) => kebabCase(name) === storyName)) {
      failures.push(`missing navigable story ${storyId}`)
      continue
    }
    if (!exportedStoryHasPlay(source, component.visual.story, storyName)) {
      failures.push(`missing a11y interaction ${storyId}`)
    }
    for (const term of completeStoryTerms(component.visual.story, storyName, files)) terms.add(term)
  }
  for (const variant of component.variants) {
    for (const value of variant.values) {
      if (value === variant.defaultValue) continue
      if (!terms.has(value)) {
        failures.push(`story ${component.visual.storyId} does not cover ${variant.name}=${value}`)
      }
    }
  }
  for (const state of metadata.states) {
    if (!terms.has(state)) failures.push(`story ${component.visual.storyId} does not cover state=${state}`)
  }
  return failures
}

const validateComponent = (
  component: ComponentRecord,
  metadata: RegistryMetadata | undefined,
  files: ReadonlyMap<string, string>
): ReadonlyArray<string> => {
  const failures: Array<string> = []
  if (metadata === undefined) failures.push(`missing registry metadata ${component.name}`)
  const source = files.get(component.source)
  if (source === undefined) failures.push(`missing source ${component.source}`)
  else {
    const exports = exportedNames(source, component.source)
    for (const declaration of component.exports) {
      if (!exports.has(declaration.name)) failures.push(`missing export ${declaration.name} in ${component.source}`)
    }
  }
  for (const style of component.styles) {
    const contents = files.get(style)
    if (contents === undefined) failures.push(`missing style ${style}`)
    else if (contents.trim().length === 0) failures.push(`empty style ${style}`)
  }
  const story = files.get(component.visual.story)
  if (story === undefined) failures.push(`missing story ${component.visual.story}`)
  else if (metadata !== undefined) {
    for (const failure of validateStory(component, metadata, story, files)) failures.push(failure)
  }
  for (const test of component.visual.tests) {
    const contents = files.get(test)
    if (contents === undefined) failures.push(`missing test ${test}`)
    else if (contents.trim().length === 0) failures.push(`empty test ${test}`)
  }
  return failures
}

const validateImports = (files: ReadonlyMap<string, string>): ReadonlyArray<string> => {
  const failures: Array<string> = []
  for (const [file, source] of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue
    if (file.startsWith("src/") && FORBIDDEN_BROWSER_HOST_API.test(source)) {
      failures.push(`forbidden browser host API in ${file}`)
    }
    for (const { fileName } of TypeScript.preProcessFile(source).importedFiles) {
      if (FORBIDDEN_APPLICATION_IMPORT.test(fileName)) {
        failures.push(`forbidden application import ${fileName} in ${file}`)
      }
      if (fileName.startsWith(".")) {
        const segments = [...file.split("/").slice(0, -1), ...fileName.split("/")]
        const resolved: Array<string> = []
        for (const segment of segments) {
          if (segment === "." || segment.length === 0) continue
          if (segment === "..") resolved.pop()
          else resolved.push(segment)
        }
        const escapesPackage = segments.filter((segment) => segment === "..").length >
          file
            .split("/")
            .slice(0, -1)
            .filter((segment) => segment.length > 0).length
        if (escapesPackage || resolved[0] === undefined) {
          failures.push(`relative import escapes rly package ${fileName} in ${file}`)
        }
      }
      if (file.startsWith("src/") && FORBIDDEN_BROWSER_IMPORT.test(fileName)) {
        failures.push(`forbidden browser import ${fileName} in ${file}`)
      }
      if (file.startsWith("src/") && !fileName.startsWith(".") && !ALLOWED_BROWSER_PACKAGE_IMPORT.test(fileName)) {
        failures.push(`undeclared browser dependency ${fileName} in ${file}`)
      }
    }
  }
  return failures
}

/** Validate complete component files, navigable stories, accessibility hooks, variants, and package boundaries. */
export const findRegistrySourceFailures = (
  manifest: ComponentManifest,
  files: ReadonlyMap<string, string>
): ReadonlyArray<string> =>
  [
    ...manifest.components
      .filter(({ registry }) => registry)
      .flatMap((component) => validateComponent(component, manifest.registryMetadata[component.name], files)),
    ...validateImports(files)
  ].sort((left, right) => left.localeCompare(right))
