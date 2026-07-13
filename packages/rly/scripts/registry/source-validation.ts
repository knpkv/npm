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

const storyTerms = (source: string, fileName: string): ReadonlySet<string> => {
  const sourceFile = TypeScript.createSourceFile(fileName, source, TypeScript.ScriptTarget.Latest, true)
  const terms = new Set<string>()
  const add = (value: string): void => {
    const normalized = kebabCase(value)
    terms.add(normalized)
    for (const segment of normalized.split(/[^a-z0-9]+/)) {
      if (segment.length > 0) terms.add(segment)
    }
  }
  const visit = (node: TypeScript.Node): void => {
    if (TypeScript.isIdentifier(node) || TypeScript.isStringLiteralLike(node)) add(node.text)
    TypeScript.forEachChild(node, visit)
  }
  visit(sourceFile)
  return terms
}

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

const completeStoryTerms = (entry: string, files: ReadonlyMap<string, string>): ReadonlySet<string> => {
  const terms = new Set<string>()
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    const source = files.get(file)
    if (source === undefined) return
    for (const term of storyTerms(source, file)) terms.add(term)
    for (const imported of TypeScript.preProcessFile(source).importedFiles) {
      const resolved = resolveStoryImport(files, file, imported.fileName)
      if (resolved !== undefined) visit(resolved)
    }
  }
  visit(entry)
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
  const terms = completeStoryTerms(component.visual.story, files)
  if (!/tags:\s*\[\s*["']autodocs["']\s*\]/.test(source)) {
    failures.push(`missing docs metadata ${component.visual.story}`)
  }
  const storyName = component.visual.storyId.split("--")[1]
  const exports = exportedNames(source, component.visual.story)
  if (storyName === undefined || ![...exports].some((name) => kebabCase(name) === storyName)) {
    failures.push(`missing navigable story ${component.visual.storyId}`)
  } else if (!exportedStoryHasPlay(source, component.visual.story, storyName)) {
    failures.push(`missing a11y interaction ${component.visual.storyId}`)
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
