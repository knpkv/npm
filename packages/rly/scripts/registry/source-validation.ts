import * as TypeScript from "typescript"
import type { ComponentManifest, ComponentRecord, RegistryMetadata } from "../../component-manifest.js"

const FORBIDDEN_APPLICATION_IMPORT =
  /^(?:@knpkv\/(?!rly(?:\/|$))|@aws-sdk\/|distilled-aws(?:\/|$)|react-router(?:-dom)?(?:\/|$))/
const FORBIDDEN_BROWSER_IMPORT = /^(?:node:|@effect\/platform-node(?:\/|$)|effect\/process(?:\/|$))/
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

const isValueReference = (node: TypeScript.Identifier): boolean => {
  const parent = node.parent
  if (parent === undefined) return false
  if (
    (TypeScript.isVariableDeclaration(parent)
      || TypeScript.isParameter(parent)
      || TypeScript.isBindingElement(parent)
      || TypeScript.isFunctionDeclaration(parent)
      || TypeScript.isClassDeclaration(parent)
      || TypeScript.isInterfaceDeclaration(parent)
      || TypeScript.isTypeAliasDeclaration(parent))
    && parent.name === node
  ) {
    return false
  }
  if (
    (TypeScript.isPropertyAssignment(parent)
      || TypeScript.isPropertyDeclaration(parent)
      || TypeScript.isMethodDeclaration(parent)
      || TypeScript.isPropertyAccessExpression(parent)
      || TypeScript.isJsxAttribute(parent))
    && parent.name === node
  ) {
    return false
  }
  if (
    TypeScript.isImportClause(parent)
    || TypeScript.isImportSpecifier(parent)
    || TypeScript.isNamespaceImport(parent)
    || TypeScript.isExportSpecifier(parent)
  ) {
    return false
  }
  return true
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
  const visit = (file: string, node: TypeScript.Node): void => {
    const key = `${file}:${node.kind}:${node.pos}:${node.end}`
    if (visited.has(key)) return
    visited.add(key)
    if (TypeScript.isIdentifier(node) || TypeScript.isStringLiteralLike(node) || TypeScript.isJsxText(node)) {
      add(node.text)
    }
    if (TypeScript.isIdentifier(node) && isValueReference(node)) {
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

const propertyName = (property: TypeScript.ObjectLiteralElementLike): string | undefined =>
  TypeScript.isPropertyAssignment(property)
    && (TypeScript.isIdentifier(property.name)
      || TypeScript.isStringLiteral(property.name)
      || TypeScript.isNumericLiteral(property.name))
    ? property.name.text
    : undefined

interface SourceVariants {
  /** Axis name to its value names, from each `RLY_*_VARIANTS = defineVariants({...})`. */
  readonly axes: ReadonlyMap<string, ReadonlyArray<ReadonlySet<string>>>
  /** Axis name to its default, from each `RLY_*_DEFAULT_VARIANTS = defineVariants({...})`. */
  readonly defaults: ReadonlyMap<string, ReadonlyArray<string>>
  /** Names of the `*_DEFAULT_VARIANTS` constants the file declares. */
  readonly defaultConstants: ReadonlySet<string>
  /** Axes whose default is written as something other than a string literal. */
  readonly unreadableDefaults: ReadonlySet<string>
  /**
   * `defineVariants` catalogs, axes or values the registry cannot read: a non-literal argument, a
   * spread, a computed or shorthand member, or an axis whose values are not an inline object.
   */
  readonly unreadableCatalogs: ReadonlySet<string>
}

/** Literal variant axes and defaults a component source declares through `defineVariants`. */
/** Looks through parentheses, `as`, `satisfies` and non-null wrappers to the expression they hold. */
const unwrap = (expression: TypeScript.Expression): TypeScript.Expression =>
  TypeScript.isParenthesizedExpression(expression)
    || TypeScript.isAsExpression(expression)
    || TypeScript.isSatisfiesExpression(expression)
    || TypeScript.isNonNullExpression(expression)
    ? unwrap(expression.expression)
    : expression

const sourceVariants = (source: string, fileName: string): SourceVariants => {
  const axes = new Map<string, Array<ReadonlySet<string>>>()
  const defaults = new Map<string, Array<string>>()
  const defaultConstants = new Set<string>()
  const unreadableDefaults = new Set<string>()
  const unreadableCatalogs = new Set<string>()
  const sourceFile = TypeScript.createSourceFile(fileName, source, TypeScript.ScriptTarget.Latest, true)
  for (const statement of sourceFile.statements) {
    if (!TypeScript.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!TypeScript.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const initializer = unwrap(declaration.initializer)
      if (!TypeScript.isCallExpression(initializer) || !TypeScript.isIdentifier(initializer.expression)) continue
      if (initializer.expression.text !== "defineVariants") continue
      // Catalogs follow the `RLY_*_VARIANTS` / `RLY_*_DEFAULT_VARIANTS` naming; other `defineVariants`
      // tables (ReleaseRelay's symbol list) describe no prop.
      if (!declaration.name.text.endsWith("_VARIANTS")) continue
      const [rawArgument] = initializer.arguments
      const argument = rawArgument === undefined ? undefined : unwrap(rawArgument)
      if (argument === undefined || !TypeScript.isObjectLiteralExpression(argument)) {
        unreadableCatalogs.add(declaration.name.text)
        continue
      }
      const isDefaults = declaration.name.text.endsWith("_DEFAULT_VARIANTS")
      if (isDefaults) defaultConstants.add(declaration.name.text)
      for (const property of argument.properties) {
        const axis = propertyName(property)
        // A spread, shorthand or computed axis hides what it declares, so it fails rather than vanishing.
        if (axis === undefined || !TypeScript.isPropertyAssignment(property)) {
          unreadableCatalogs.add(`${declaration.name.text} (${property.getText(sourceFile)})`)
          continue
        }
        if (isDefaults && TypeScript.isStringLiteral(property.initializer)) {
          defaults.set(axis, [...(defaults.get(axis) ?? []), property.initializer.text])
          continue
        }
        if (isDefaults) {
          unreadableDefaults.add(axis)
          continue
        }
        const catalog = unwrap(property.initializer)
        if (!TypeScript.isObjectLiteralExpression(catalog)) {
          unreadableCatalogs.add(`${declaration.name.text}.${axis}`)
          continue
        }
        const values = new Set<string>()
        for (const value of catalog.properties) {
          const name = propertyName(value)
          if (name === undefined) {
            unreadableCatalogs.add(`${declaration.name.text}.${axis} (${value.getText(sourceFile)})`)
          } else values.add(name)
        }
        axes.set(axis, [...(axes.get(axis) ?? []), values])
      }
    }
  }
  return { axes, defaultConstants, defaults, unreadableCatalogs, unreadableDefaults }
}

/**
 * A component's destructured fallbacks for one prop: a string literal (`size = "dense"`), a read of
 * a defaults constant in the same file (`size = RLY_BUTTON_DEFAULT_VARIANTS.size`), or anything
 * else, reported as unsupported so the check never passes by not understanding the source.
 */
type Fallback =
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Defaults"; readonly constant: string; readonly axis: string }
  | { readonly _tag: "Unsupported"; readonly text: string }

type FunctionNode = TypeScript.ArrowFunction | TypeScript.FunctionExpression | TypeScript.FunctionDeclaration

/**
 * The functions that implement an exported component: its own arrow or function, the function a
 * top-level wrapper call receives (`registerFieldControl(SelectImplementation)`), or every part of a
 * compound object (`Object.freeze({ Root: DialogRoot, Content: DialogContent })`), followed through
 * top-level names. Empty when the source builds it some other way.
 */
const componentImplementation = (sourceFile: TypeScript.SourceFile, name: string): ReadonlyArray<FunctionNode> => {
  const declared = (identifier: string, seen: ReadonlySet<string>): ReadonlyArray<FunctionNode> => {
    if (seen.has(identifier)) return []
    for (const statement of sourceFile.statements) {
      if (TypeScript.isFunctionDeclaration(statement) && statement.name?.text === identifier) return [statement]
      if (!TypeScript.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!TypeScript.isIdentifier(declaration.name) || declaration.name.text !== identifier) continue
        if (declaration.initializer === undefined) return []
        return resolve(unwrap(declaration.initializer), new Set([...seen, identifier]))
      }
    }
    return []
  }
  const resolve = (expression: TypeScript.Expression, seen: ReadonlySet<string>): ReadonlyArray<FunctionNode> => {
    if (TypeScript.isArrowFunction(expression) || TypeScript.isFunctionExpression(expression)) return [expression]
    if (TypeScript.isIdentifier(expression)) return declared(expression.text, seen)
    if (TypeScript.isCallExpression(expression)) {
      const [first] = expression.arguments
      return first === undefined ? [] : resolve(unwrap(first), seen)
    }
    if (TypeScript.isObjectLiteralExpression(expression)) {
      return expression.properties.flatMap((property) =>
        TypeScript.isPropertyAssignment(property)
          ? resolve(unwrap(property.initializer), seen)
          : TypeScript.isShorthandPropertyAssignment(property)
          ? declared(property.name.text, seen)
          : []
      )
    }
    return []
  }
  return declared(name, new Set())
}

/**
 * The fallbacks for `prop` that the component's implementation gives its own props: in the props
 * parameter's destructuring, or in a body destructure of that parameter, aliases included. Nested
 * helpers and other objects never count. Undefined when no implementation is found.
 */
const destructuredFallbacks = (
  source: string,
  fileName: string,
  component: string,
  prop: string
): ReadonlyArray<Fallback> | undefined => {
  const fallbacks: Array<Fallback> = []
  const sourceFile = TypeScript.createSourceFile(fileName, source, TypeScript.ScriptTarget.Latest, true)
  const implementation = componentImplementation(sourceFile, component)
  if (implementation.length === 0) return undefined
  const fallbackOf = (raw: TypeScript.Expression): Fallback => {
    // Read through parentheses, `as`, `satisfies` and non-null wrappers to the literal or constant inside.
    const initializer = unwrap(raw)
    return TypeScript.isStringLiteral(initializer)
      ? { _tag: "Literal", value: initializer.text }
      : TypeScript.isPropertyAccessExpression(initializer) && TypeScript.isIdentifier(initializer.expression)
      ? { _tag: "Defaults", constant: initializer.expression.text, axis: initializer.name.text }
      : { _tag: "Unsupported", text: initializer.getText(sourceFile) }
  }
  /** The binding for `prop` in a props pattern, aliased (`size: chosen = …`) or not. */
  const collect = (pattern: TypeScript.BindingName): void => {
    if (!TypeScript.isObjectBindingPattern(pattern)) return
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name
      if (!TypeScript.isIdentifier(key) || key.text !== prop) continue
      if (element.initializer !== undefined) fallbacks.push(fallbackOf(element.initializer))
    }
  }
  const isFunctionScope = (node: TypeScript.Node): boolean =>
    TypeScript.isFunctionLike(node) || TypeScript.isClassLike(node)
  for (const implementationNode of implementation) {
    const [propsParameter] = implementationNode.parameters
    if (propsParameter === undefined) continue
    // The props parameter destructured in place...
    collect(propsParameter.name)
    // ...or destructured from the props parameter in the body, never inside nested functions.
    const propsName = TypeScript.isIdentifier(propsParameter.name) ? propsParameter.name.text : undefined
    const visit = (node: TypeScript.Node): void => {
      if (isFunctionScope(node)) return
      if (
        propsName !== undefined
        && TypeScript.isVariableDeclaration(node)
        && node.initializer !== undefined
        && TypeScript.isIdentifier(unwrap(node.initializer))
        && unwrap(node.initializer).getText(sourceFile) === propsName
      ) {
        collect(node.name)
      }
      TypeScript.forEachChild(node, visit)
    }
    if (implementationNode.body !== undefined) TypeScript.forEachChild(implementationNode.body, visit)
  }
  return fallbacks
}

/**
 * The manifest's variants must match the source's `defineVariants` declarations exactly. Every
 * axis the source declares there is listed in the manifest, declared once (not duplicated across
 * catalogs), with the same values; a default it declares matches the manifest's; and every
 * destructured fallback for it points at that default. Duplicated or unreadable declarations fail
 * rather than being skipped. Manifest axes the source types as plain props, outside
 * `defineVariants` (for example `DiffCodeView.mode`), have no catalog to compare and stay a review
 * judgment.
 */
const validateVariants = (component: ComponentRecord, source: string): ReadonlyArray<string> => {
  const failures: Array<string> = []
  const { axes, defaultConstants, defaults, unreadableCatalogs, unreadableDefaults } = sourceVariants(
    source,
    component.source
  )
  for (const catalog of unreadableCatalogs) {
    failures.push(`component ${component.name} declares ${catalog} in a form the registry cannot read`)
  }
  const where = (axis: string) => `variant ${component.name}.${axis}`
  for (const variant of component.variants) {
    const declared = axes.get(variant.name) ?? []
    if (declared.length === 0) continue
    if (declared.length > 1 || declared[0] === undefined) {
      failures.push(`${where(variant.name)} is declared ${declared.length} times in ${component.source}, expected once`)
      continue
    }
    const values = declared[0]
    const listed = new Set(variant.values)
    if (values.size !== listed.size || [...values].some((value) => !listed.has(value))) {
      failures.push(
        `${where(variant.name)} lists ${variant.values.join("|")} but source declares ${[...values].join("|")}`
      )
    }
    if (unreadableDefaults.has(variant.name)) {
      failures.push(`${where(variant.name)} has a source default the registry cannot read; write it as a string`)
      continue
    }
    const fallback = defaults.get(variant.name) ?? []
    // A required variant (no manifest default) has no source default to compare.
    if (fallback.length === 0 && variant.defaultValue === undefined) continue
    if (fallback.length !== 1 || fallback[0] === undefined) {
      failures.push(`${where(variant.name)} has ${fallback.length} source defaults, expected one`)
      continue
    }
    const sourceDefault = fallback[0]
    if (sourceDefault !== variant.defaultValue) {
      failures.push(
        `${where(variant.name)} defaults to ${variant.defaultValue} but source defaults to ${sourceDefault}`
      )
    }
    const destructuredAll = destructuredFallbacks(source, component.source, component.name, variant.name)
    if (destructuredAll === undefined) {
      failures.push(`component ${component.name} has no implementation the registry can find in ${component.source}`)
      continue
    }
    if (destructuredAll.length === 0) {
      failures.push(
        `component ${component.name} never falls back to its ${variant.name} default when the prop is omitted`
      )
    }
    for (const destructured of destructuredAll) {
      if (destructured._tag === "Literal" && destructured.value !== sourceDefault) {
        failures.push(
          `component ${component.name} destructures ${variant.name} = "${destructured.value}" but its declared default is ${sourceDefault}`
        )
      }
      if (
        destructured._tag === "Defaults"
        && (!defaultConstants.has(destructured.constant) || destructured.axis !== variant.name)
      ) {
        failures.push(
          `component ${component.name} destructures ${variant.name} from ${destructured.constant}.${destructured.axis}, not its own default`
        )
      }
      if (destructured._tag === "Unsupported") {
        failures.push(
          `component ${component.name} destructures ${variant.name} = ${destructured.text}, which the registry cannot check`
        )
      }
    }
  }
  const listedAxes = new Set(component.variants.map((variant) => variant.name))
  for (const axis of axes.keys()) {
    if (!listedAxes.has(axis)) failures.push(`${where(axis)} is declared in source but missing from the manifest`)
  }
  return failures
}

/**
 * A component can forward another's axis without a catalog of its own (ThemeSelect passes Select's
 * `size`). Any prop it defaults whose name is a registry axis elsewhere (`size`, `tone`, …) must
 * then be listed among its manifest variants, or consumers never learn its values or default. A
 * listed forwarded axis is checked against its owner: a fallback read from another component's
 * defaults constant must agree with that owner's catalog values and default.
 */
const validateForwardedAxes = (
  component: ComponentRecord,
  source: string,
  axisNames: ReadonlySet<string>,
  owners: ReadonlyMap<string, SourceVariants>
): ReadonlyArray<string> => {
  const failures: Array<string> = []
  const listed = new Map(component.variants.map((variant) => [variant.name, variant]))
  const local = sourceVariants(source, component.source)
  for (const axis of axisNames) {
    const fallbacks = destructuredFallbacks(source, component.source, component.name, axis) ?? []
    const variant = listed.get(axis)
    if (variant === undefined) {
      if (fallbacks.length > 0) {
        failures.push(`component ${component.name} defaults its ${axis} prop but the manifest lists no ${axis} variant`)
      }
      continue
    }
    // An axis with a local catalog is validateVariants' job.
    if ((local.axes.get(axis) ?? []).length > 0) continue
    for (const fallback of fallbacks) {
      // A forwarded default the registry cannot read fails, as it does for a local catalog.
      if (fallback._tag === "Unsupported") {
        failures.push(
          `component ${component.name} forwards ${axis} = ${fallback.text}, which the registry cannot check`
        )
        continue
      }
      if (fallback._tag === "Literal" && fallback.value !== variant.defaultValue) {
        failures.push(
          `variant ${component.name}.${axis} defaults to ${variant.defaultValue} but source forwards ${fallback.value}`
        )
      }
      if (fallback._tag !== "Defaults" || local.defaultConstants.has(fallback.constant)) continue
      const owner = owners.get(fallback.constant)
      const ownerDefault = owner?.defaults.get(fallback.axis)?.[0]
      const ownerValues = owner?.axes.get(fallback.axis)?.[0]
      if (owner === undefined || ownerDefault === undefined || ownerValues === undefined) {
        failures.push(
          `component ${component.name} forwards ${axis} from ${fallback.constant}.${fallback.axis}, which no registry catalog declares`
        )
        continue
      }
      if (ownerDefault !== variant.defaultValue) {
        failures.push(
          `variant ${component.name}.${axis} defaults to ${variant.defaultValue} but its owner ${fallback.constant} defaults to ${ownerDefault}`
        )
      }
      const values = new Set(variant.values)
      if (values.size !== ownerValues.size || [...ownerValues].some((value) => !values.has(value))) {
        failures.push(
          `variant ${component.name}.${axis} lists ${variant.values.join("|")} but its owner declares ${
            [...ownerValues].join("|")
          }`
        )
      }
    }
  }
  return failures
}

const validateComponent = (
  component: ComponentRecord,
  metadata: RegistryMetadata | undefined,
  files: ReadonlyMap<string, string>,
  axisNames: ReadonlySet<string>,
  owners: ReadonlyMap<string, SourceVariants>
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
    for (const failure of validateVariants(component, source)) failures.push(failure)
    for (const failure of validateForwardedAxes(component, source, axisNames, owners)) failures.push(failure)
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
): ReadonlyArray<string> => {
  const registryComponents = manifest.components.filter(({ registry }) => registry)
  const axisNames = new Set(registryComponents.flatMap((component) => component.variants.map(({ name }) => name)))
  // Each defaults constant mapped to the catalog of the source that declares it, for forwarded axes.
  const owners = new Map<string, SourceVariants>()
  for (const component of registryComponents) {
    const source = files.get(component.source)
    if (source === undefined) continue
    const variants = sourceVariants(source, component.source)
    for (const constant of variants.defaultConstants) owners.set(constant, variants)
  }
  return [
    ...registryComponents.flatMap((component) =>
      validateComponent(component, manifest.registryMetadata[component.name], files, axisNames, owners)
    ),
    ...validateImports(files)
  ].sort((left, right) => left.localeCompare(right))
}
