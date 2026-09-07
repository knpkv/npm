const Predicate = require("effect/Predicate")
const path = require("node:path")

const staticPropertyName = (node) => {
  if (node.type === "Identifier") return node.name
  if (node.type === "Literal" && Predicate.isString(node.value)) return node.value
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    const cooked = node.quasis[0].value.cooked
    return Predicate.isString(cooked) ? cooked : undefined
  }
  return undefined
}

const importedBinding = (context, identifier) => {
  let scope = context.sourceCode.getScope(identifier)
  while (scope !== null) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) {
      return variable.defs.find((definition) => definition.type === "ImportBinding")
    }
    scope = scope.upper
  }
  return undefined
}

const importSource = (definition) => definition?.parent?.source?.value

const isValueImport = (definition) =>
  definition !== undefined && definition.node.importKind !== "type" && definition.parent.importKind !== "type"

const isNamespaceImportFrom = (context, identifier, sources) => {
  const definition = importedBinding(context, identifier)
  return (
    isValueImport(definition) &&
    definition.node.type === "ImportNamespaceSpecifier" &&
    sources.includes(importSource(definition))
  )
}

const isDefaultImportFrom = (context, identifier, sources) => {
  const definition = importedBinding(context, identifier)
  return (
    isValueImport(definition) &&
    definition.node.type === "ImportDefaultSpecifier" &&
    sources.includes(importSource(definition))
  )
}

const isNamedImportBindingFrom = (context, identifier, sources, importedNames) => {
  const definition = importedBinding(context, identifier)
  return (
    definition !== undefined &&
    definition.node.type === "ImportSpecifier" &&
    sources.includes(importSource(definition)) &&
    importedNames.includes(staticPropertyName(definition.node.imported))
  )
}

const isNamedImportFrom = (context, identifier, sources, importedNames) => {
  const definition = importedBinding(context, identifier)
  return isValueImport(definition) && isNamedImportBindingFrom(context, identifier, sources, importedNames)
}

const resolvedVariable = (context, identifier) => {
  let scope = context.sourceCode.getScope(identifier)
  while (scope !== null) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) return variable
    scope = scope.upper
  }
  return undefined
}

const enclosingFunction = (node) => {
  let current = node.parent
  while (current !== undefined && current !== null) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      return current
    }
    current = current.parent
  }
  return undefined
}

const isPureTypeReference = (reference) => {
  if (reference.isTypeReference && !reference.isValueReference) return true
  let current = reference.identifier.parent
  while (current !== undefined && current.type !== "Program") {
    if (current.type === "TSTypeQuery") return true
    current = current.parent
  }
  return false
}

const isReadOnlyMemberReference = (reference) => {
  if (isPureTypeReference(reference)) return true
  if (reference.isWrite()) return false
  const member = reference.identifier.parent
  if (member?.type !== "MemberExpression" || member.object !== reference.identifier) return false
  if (member.computed) return false
  const usage = member.parent
  if (usage?.type === "AssignmentExpression" && usage.left === member) return false
  if (usage?.type === "UpdateExpression" && usage.argument === member) return false
  return !(usage?.type === "UnaryExpression" && usage.operator === "delete" && usage.argument === member)
}

const frozenArgument = (context, expression) => {
  if (
    expression?.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    expression.arguments[0].type === "SpreadElement" ||
    expression.callee.type !== "MemberExpression" ||
    expression.callee.computed ||
    expression.callee.object.type !== "Identifier" ||
    expression.callee.object.name !== "Object" ||
    staticPropertyName(expression.callee.property) !== "freeze" ||
    (resolvedVariable(context, expression.callee.object)?.defs.length ?? 0) > 0
  ) {
    return undefined
  }
  return expression.arguments[0]
}

const unwrapTypeExpression = (expression) => {
  let current = expression
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression
  }
  return current
}

const isReviewedEnvironmentProjection = (context, expression, call) => {
  if (
    expression.type !== "MemberExpression" ||
    expression.computed ||
    expression.object.type !== "Identifier" ||
    expression.object.name !== "options" ||
    staticPropertyName(expression.property) !== "environment"
  ) {
    return false
  }
  const factory = enclosingFunction(call)
  if (
    factory === undefined ||
    factory.parent?.type !== "VariableDeclarator" ||
    factory.parent.id.type !== "Identifier" ||
    factory.parent.id.name !== "makeCommand" ||
    factory.parent.parent?.type !== "VariableDeclaration" ||
    factory.parent.parent.kind !== "const" ||
    factory.parent.parent.parent?.type !== "Program"
  ) {
    return false
  }
  const parameter = factory.params.find((candidate) => candidate.type === "Identifier" && candidate.name === "options")
  const binding = resolvedVariable(context, expression.object)
  const environmentReferences = binding?.references.filter((reference) => {
    if (isPureTypeReference(reference)) return false
    const member = reference.identifier.parent
    return (
      member?.type === "MemberExpression" &&
      member.object === reference.identifier &&
      staticPropertyName(member.property) === "environment"
    )
  })
  return (
    parameter !== undefined &&
    binding?.identifiers.includes(parameter) === true &&
    binding.references.every(isReadOnlyMemberReference) &&
    environmentReferences?.length === 1 &&
    environmentReferences[0]?.identifier.parent === expression
  )
}

const isFrozenEnvironmentSnapshot = (context, expression, call) => {
  const snapshot = frozenArgument(context, expression)
  if (snapshot === undefined) return false
  const object = unwrapTypeExpression(snapshot)
  return (
    object.type === "ObjectExpression" &&
    object.properties.length === 1 &&
    object.properties[0].type === "SpreadElement" &&
    isReviewedEnvironmentProjection(context, object.properties[0].argument, call)
  )
}

const isFrozenArgumentsSnapshot = (context, expression, call) => {
  const snapshot = frozenArgument(context, expression)
  if (
    snapshot?.type !== "ArrayExpression" ||
    snapshot.elements.length !== 1 ||
    snapshot.elements[0]?.type !== "SpreadElement"
  ) {
    return false
  }
  const source = snapshot.elements[0].argument
  const factory = enclosingFunction(call)
  if (factory === undefined) return false
  if (
    source.type === "MemberExpression" &&
    !source.computed &&
    source.object.type === "Identifier" &&
    source.object.name === "options" &&
    staticPropertyName(source.property) === "args"
  ) {
    const parameter = factory.params.find(
      (candidate) => candidate.type === "Identifier" && candidate.name === "options"
    )
    const binding = resolvedVariable(context, source.object)
    const argumentReferences = binding?.references.filter((reference) => {
      if (isPureTypeReference(reference)) return false
      const member = reference.identifier.parent
      return (
        member?.type === "MemberExpression" &&
        member.object === reference.identifier &&
        !member.computed &&
        staticPropertyName(member.property) === "args"
      )
    })
    return (
      binding?.identifiers.includes(parameter) === true &&
      argumentReferences?.length === 1 &&
      argumentReferences[0]?.identifier.parent === source
    )
  }
  if (source.type !== "Identifier") return false
  const parameter = factory.params.find(
    (candidate) => candidate.type === "Identifier" && candidate.name === source.name
  )
  const binding = resolvedVariable(context, source)
  const runtimeReferences = binding?.references.filter((reference) => !isPureTypeReference(reference))
  return (
    parameter !== undefined &&
    binding?.identifiers.includes(parameter) === true &&
    runtimeReferences?.length === 1 &&
    runtimeReferences[0]?.identifier === source
  )
}

const isStreamMember = (context, expression, name) =>
  expression.type === "MemberExpression" &&
  !expression.computed &&
  expression.object.type === "Identifier" &&
  staticPropertyName(expression.property) === name &&
  (isNamedImportFrom(context, expression.object, ["effect"], ["Stream"]) ||
    isNamespaceImportFrom(context, expression.object, ["effect/Stream"]))

const isReviewedStdinStream = (context, expression) => {
  if (
    expression.type !== "CallExpression" ||
    expression.arguments.length !== 1 ||
    !isStreamMember(context, expression.arguments[0], "encodeText") ||
    expression.callee.type !== "MemberExpression" ||
    expression.callee.computed ||
    staticPropertyName(expression.callee.property) !== "pipe" ||
    expression.callee.object.type !== "CallExpression" ||
    expression.callee.object.arguments.length !== 1 ||
    !isStreamMember(context, expression.callee.object.callee, "make")
  ) {
    return false
  }
  const prompt = expression.callee.object.arguments[0]
  return (
    prompt.type === "MemberExpression" &&
    !prompt.computed &&
    prompt.object.type === "Identifier" &&
    prompt.object.name === "options" &&
    staticPropertyName(prompt.property) === "prompt"
  )
}

const isFrozenStdinSnapshot = (context, expression) => {
  const snapshot = frozenArgument(context, expression)
  if (
    snapshot?.type !== "ObjectExpression" ||
    snapshot.properties.some((property) => property.type === "SpreadElement") ||
    snapshot.properties.some((property) => property.type === "Property" && property.computed)
  ) {
    return false
  }
  const streams = snapshot.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "stream"
  )
  const completions = snapshot.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "endOnDone"
  )
  return (
    snapshot.properties.length === 2 &&
    streams.length === 1 &&
    completions.length === 1 &&
    isReviewedStdinStream(context, streams[0].value) &&
    completions[0].value.type === "Literal" &&
    completions[0].value.value === true
  )
}

const hasIsolatedChildEnvironment = (context, options, call) => {
  const frozenOptions = frozenArgument(context, options)
  if (frozenOptions?.type !== "ObjectExpression") return false
  if (frozenOptions.properties.some((property) => property.type === "SpreadElement")) return false
  if (frozenOptions.properties.some((property) => property.type === "Property" && property.computed)) {
    return false
  }
  const environment = frozenOptions.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "env"
  )
  const inheritance = frozenOptions.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "extendEnv"
  )
  const stdin = frozenOptions.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "stdin"
  )
  const factory = enclosingFunction(call)
  return (
    call.arguments.length === 3 &&
    factory?.type === "ArrowFunctionExpression" &&
    factory.expression &&
    frozenArgument(context, factory.body) === call &&
    isFrozenArgumentsSnapshot(context, call.arguments[1], call) &&
    environment.length === 1 &&
    inheritance.length === 1 &&
    stdin.length <= 1 &&
    (stdin.length === 0 || isFrozenStdinSnapshot(context, stdin[0].value)) &&
    isFrozenEnvironmentSnapshot(context, environment[0].value, call) &&
    inheritance[0].value.type === "Literal" &&
    inheritance[0].value.value === false
  )
}

const CHILD_PROCESS_MODULE = "effect/unstable/process/ChildProcess"
const CHILD_PROCESS_BARREL = "effect/unstable/process"
const COMMONJS_LOADER_MODULES = new Set(["module", "node:module"])
const COMMONJS_LOADER_EXPORTS = new Set(["Module", "createRequire", "default"])
const PROCESS_MODULES = new Set(["node:process", "process"])
const AGENT_COMMAND_SEAMS = new Map([
  [path.resolve(__dirname, "packages/ai-claude/src/runner.ts"), { importKind: "named", localName: "ChildProcess" }],
  [
    path.resolve(__dirname, "packages/ai-codex/src/internal/process.ts"),
    { importKind: "namespace", localName: "ChildProcess" }
  ]
])

const commandSeamFor = (context) => AGENT_COMMAND_SEAMS.get(path.normalize(context.physicalFilename))

const staticImportExpressionSource = (source) => {
  if (source.type === "Literal" && Predicate.isString(source.value)) return source.value
  if (source.type === "TemplateLiteral" && source.expressions.length === 0) {
    return source.quasis[0]?.value.cooked
  }
  return undefined
}

const isTypeOnlyExport = (declaration, specifier) =>
  declaration.exportKind === "type" || specifier?.exportKind === "type"

const isSensitiveChildProcessExport = (declaration) => {
  if (isTypeOnlyExport(declaration)) return false
  if (declaration.source?.value === CHILD_PROCESS_MODULE) {
    return declaration.specifiers.some((specifier) => !isTypeOnlyExport(declaration, specifier))
  }
  if (declaration.source?.value !== CHILD_PROCESS_BARREL) return false
  return declaration.specifiers.some(
    (specifier) =>
      !isTypeOnlyExport(declaration, specifier) &&
      (specifier.type === "ExportNamespaceSpecifier" || staticPropertyName(specifier.local) === "ChildProcess")
  )
}

const isSensitiveCommonJsExport = (declaration) => {
  if (!COMMONJS_LOADER_MODULES.has(declaration.source?.value) || isTypeOnlyExport(declaration)) return false
  return declaration.specifiers.some(
    (specifier) =>
      !isTypeOnlyExport(declaration, specifier) &&
      (specifier.type === "ExportNamespaceSpecifier" ||
        COMMONJS_LOADER_EXPORTS.has(staticPropertyName(specifier.local)))
  )
}

const isSensitiveChildProcessSpecifier = (declaration, specifier) => {
  if (declaration.importKind === "type" || specifier.importKind === "type") return false
  if (declaration.source.value === CHILD_PROCESS_MODULE) return true
  if (declaration.source.value !== CHILD_PROCESS_BARREL) return false
  return (
    specifier.type === "ImportNamespaceSpecifier" ||
    (specifier.type === "ImportSpecifier" && staticPropertyName(specifier.imported) === "ChildProcess")
  )
}

const isSensitiveCommonJsSpecifier = (declaration, specifier) => {
  if (declaration.importKind === "type" || specifier.importKind === "type") return false
  if (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") return true
  return specifier.type === "ImportSpecifier" && COMMONJS_LOADER_EXPORTS.has(staticPropertyName(specifier.imported))
}

const isApprovedChildProcessSpecifier = (declaration, specifier, seam) => {
  if (seam === undefined || specifier.local.name !== seam.localName) return false
  if (seam.importKind === "namespace") {
    return declaration.source.value === CHILD_PROCESS_MODULE && specifier.type === "ImportNamespaceSpecifier"
  }
  return (
    declaration.source.value === CHILD_PROCESS_BARREL &&
    specifier.type === "ImportSpecifier" &&
    staticPropertyName(specifier.imported) === "ChildProcess"
  )
}

const directChildProcessMakeCall = (identifier) => {
  const member = identifier.parent
  if (
    member?.type !== "MemberExpression" ||
    member.object !== identifier ||
    staticPropertyName(member.property) !== "make"
  ) {
    return undefined
  }
  const call = member.parent
  return call?.type === "CallExpression" && call.callee === member ? call : undefined
}

const CHILD_PROCESS_OPTION_DEPTH_LIMIT = 8

/**
 * True when the binding is reassigned or has a property written to it.
 *
 * ESLint counts `options.extendEnv = true` as a *read* of `options`, so a
 * write-reference check alone concludes the initializer is the whole story and
 * reports a missing `extendEnv` that the next statement supplies. Reporting
 * valid configuration is worse than missing an invalid one, so any mutation makes
 * the shape unresolvable rather than assumed-complete.
 */
const isMutatedChildProcessOptionsBinding = (variable, definition, resolvedReference, knownOptionArguments) =>
  variable.references.some((reference) => {
    const identifier = reference.identifier
    // The reference being resolved is the options argument itself, not a mutation.
    if (identifier === resolvedReference || identifier === definition.name) return false
    // Nor is a sibling `ChildProcess.make` that consumes the same object: a
    // recognised consumer cannot mutate it, so sharing one options binding across
    // calls must keep reporting rather than silence every call.
    if (knownOptionArguments?.has(identifier) === true) return false
    // A mutation after the command was created cannot retroactively change it, so
    // later references do not matter — but only when both sit in the same
    // immediately-executing scope. Across a function boundary textual order is not
    // execution order: `const run = () => make(..., options); configure(options);
    // run()` configures before the command is ever built, so the cutoff is skipped
    // and the mutation counts, leaving the call unresolved rather than reported.
    if (
      enclosingFunction(identifier) === enclosingFunction(resolvedReference) &&
      identifier.range[0] > resolvedReference.range[0]
    ) {
      return false
    }
    if (reference.isWrite()) return true
    const parent = identifier.parent
    if (parent === undefined || parent === null) return false
    // A property write, increment, or delete through the binding.
    if (parent.type === "MemberExpression" && parent.object === identifier) {
      const target = parent.parent
      return (
        (target?.type === "AssignmentExpression" && target.left === parent) ||
        (target?.type === "UpdateExpression" && target.argument === parent) ||
        (target?.type === "UnaryExpression" && target.operator === "delete" && target.argument === parent)
      )
    }
    // Anywhere the binding escapes, something out of view may complete it —
    // `configure(options)` adding `extendEnv` is indistinguishable from a pure
    // read without interprocedural analysis, so treat escape as unresolvable.
    if (
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      parent.arguments.includes(identifier)
    ) {
      return true
    }
    if (parent.type === "ReturnStatement" && parent.argument === identifier) return true
    if (parent.type === "AssignmentExpression" && parent.right === identifier) return true
    if (parent.type === "VariableDeclarator" && parent.init === identifier) return true
    if (parent.type === "Property" && parent.value === identifier) return true
    if (parent.type === "ArrayExpression") return true
    return false
  })

/** Whether an expression is unambiguously `undefined`. */
const isDefinitelyUndefined = (expression) => {
  const value = unwrapTypeExpression(expression)
  if (value.type === "Identifier") return value.name === "undefined"
  return value.type === "UnaryExpression" && value.operator === "void"
}

/** Bound on alias-chain following; chains this long do not occur in practice. */
const CHILD_PROCESS_ALIAS_ROUNDS = 4

/**
 * The static name of a computed property key, when it has one.
 *
 * `{ ["env"]: v }` and `` { [`env`]: v } `` name `env` as definitely as `{ env: v }`
 * does. An identifier or interpolated key returns undefined — deliberately not
 * treating a variable *named* `env` as the key `"env"`, since its runtime value
 * is what decides.
 */
const staticComputedKeyName = (key) => {
  if (key.type === "Literal" && Predicate.isString(key.value)) return key.value
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked
  }
  return undefined
}

/**
 * Given a reference to a known ChildProcess binding, returns any `const` aliases
 * declared from it.
 *
 * Handles `const Local = ChildProcess`, `const Local = Process.ChildProcess`, and
 * `const { make } = ChildProcess` including a renamed key. Anything else — `let`,
 * a call result, a computed key, a nested pattern — yields nothing, leaving the
 * call unchecked rather than guessed at.
 */
const aliasedChildProcessBindings = (context, identifier, isBarrel) => {
  const empty = { moduleBindings: [], makeBindings: [] }
  // For a barrel binding the module object is `Process.ChildProcess`, one hop out.
  let initializer = identifier
  if (isBarrel) {
    const member = identifier.parent
    if (
      member?.type !== "MemberExpression" ||
      member.object !== identifier ||
      staticPropertyName(member.property) !== "ChildProcess"
    ) {
      return empty
    }
    initializer = member
  }
  // `const spawn = ChildProcess.make` extracts the method rather than the module.
  const asMember = initializer.parent
  if (
    asMember?.type === "MemberExpression" &&
    asMember.object === initializer &&
    staticPropertyName(asMember.property) === "make" &&
    asMember.parent?.type === "VariableDeclarator" &&
    asMember.parent.init === asMember &&
    asMember.parent.parent?.kind === "const" &&
    asMember.parent.id.type === "Identifier"
  ) {
    const extracted = context.sourceCode
      .getDeclaredVariables(asMember.parent)
      .find((variable) => variable.name === asMember.parent.id.name)
    return extracted === undefined ? empty : { moduleBindings: [], makeBindings: [extracted] }
  }
  const declarator = initializer.parent
  if (
    declarator?.type !== "VariableDeclarator" ||
    declarator.init !== initializer ||
    declarator.parent?.kind !== "const"
  ) {
    return empty
  }
  const declared = context.sourceCode.getDeclaredVariables(declarator)
  if (declarator.id.type === "Identifier") {
    const binding = declared.find((variable) => variable.name === declarator.id.name)
    return binding === undefined ? empty : { moduleBindings: [binding], makeBindings: [] }
  }
  if (declarator.id.type !== "ObjectPattern") return empty
  const makeBindings = []
  for (const property of declarator.id.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      staticPropertyName(property.key) !== "make" ||
      property.value.type !== "Identifier"
    ) {
      continue
    }
    const binding = declared.find((variable) => variable.name === property.value.name)
    if (binding !== undefined) makeBindings.push(binding)
  }
  return { moduleBindings: [], makeBindings }
}

/**
 * Given a reference to a known `make` binding, returns the `const` alias declared
 * from it, so `const spawn = make` is tracked as another `make` binding.
 *
 * Only the plain immutable form is followed; `let`, destructuring, `.bind`, and
 * call results stay unresolved.
 */
const aliasedMakeBinding = (context, identifier) => {
  const declarator = identifier.parent
  if (
    declarator?.type !== "VariableDeclarator" ||
    declarator.init !== identifier ||
    declarator.parent?.kind !== "const" ||
    declarator.id.type !== "Identifier"
  ) {
    return undefined
  }
  return context.sourceCode.getDeclaredVariables(declarator).find((variable) => variable.name === declarator.id.name)
}

/**
 * Resolves `Process.ChildProcess.make(...)`, the barrel namespace form, to its
 * call expression. The plain `ChildProcess.make(...)` shape is handled by
 * `directChildProcessMakeCall`; here the binding is one member hop further out.
 */
const barrelChildProcessMakeCall = (identifier) => {
  const namespaced = identifier.parent
  if (
    namespaced?.type !== "MemberExpression" ||
    namespaced.object !== identifier ||
    staticPropertyName(namespaced.property) !== "ChildProcess"
  ) {
    return undefined
  }
  const member = namespaced.parent
  if (
    member?.type !== "MemberExpression" ||
    member.object !== namespaced ||
    staticPropertyName(member.property) !== "make"
  ) {
    return undefined
  }
  const call = member.parent
  return call?.type === "CallExpression" && call.callee === member ? call : undefined
}

/**
 * Resolves the options argument of a `ChildProcess.make` call to the object
 * literal that produced it, following `const` bindings and any `Object.freeze`
 * wrapper.
 *
 * Returns undefined when the shape cannot be established statically — a
 * reassignable binding, a call result, or the args array of a two-argument call.
 * Those are left to review rather than guessed at, since interprocedural
 * inference would trade real false positives for coverage.
 */
const resolvedChildProcessOptions = (context, argument, depth = 0, knownOptionArguments = undefined) => {
  if (argument === undefined || argument.type === "SpreadElement") return undefined
  if (depth > CHILD_PROCESS_OPTION_DEPTH_LIMIT) return undefined
  const expression = unwrapTypeExpression(argument)
  const unfrozen = frozenArgument(context, expression) ?? expression
  if (unfrozen.type === "ObjectExpression") return unfrozen
  if (unfrozen.type !== "Identifier") return undefined
  const variable = resolvedVariable(context, unfrozen)
  if (variable === undefined || variable.defs.length !== 1) return undefined
  const [definition] = variable.defs
  if (
    definition.type !== "Variable" ||
    definition.parent.kind !== "const" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.node.init === null
  ) {
    return undefined
  }
  if (isMutatedChildProcessOptionsBinding(variable, definition, unfrozen, knownOptionArguments)) return undefined
  return resolvedChildProcessOptions(context, definition.node.init, depth + 1, knownOptionArguments)
}

/**
 * Resolves the option properties a `ChildProcess.make` options object effectively
 * carries, following statically resolvable spreads in source order.
 *
 * Returns a map of name to "is definitely undefined", or undefined when any
 * spread operand cannot be resolved — silently ignoring an opaque spread would
 * report "no env" on an object that may well set one.
 *
 * Source order matters. An earlier comment here claimed it did not, which held
 * only while the rule tracked bare presence; once `extendEnv: undefined` began to
 * count as unstated, a later property overriding a spread-supplied value changed
 * the outcome, and `{ ...safeBase, extendEnv: undefined }` slipped through. Last
 * write wins, exactly as it does at runtime.
 */
const effectiveChildProcessOptions = (context, argument, depth = 0, knownOptionArguments = undefined) => {
  if (depth > CHILD_PROCESS_OPTION_DEPTH_LIMIT) return undefined
  const options = resolvedChildProcessOptions(context, argument, depth, knownOptionArguments)
  if (options === undefined) return undefined
  const resolved = new Map()
  for (const property of options.properties) {
    if (property.type === "SpreadElement") {
      const nested = effectiveChildProcessOptions(context, property.argument, depth + 1, knownOptionArguments)
      if (nested === undefined) return undefined
      for (const [name, isUndefined] of nested) resolved.set(name, isUndefined)
      continue
    }
    if (property.type !== "Property") continue
    let name
    if (property.computed) {
      // A key whose value is only known at runtime could be `extendEnv`, so the
      // object's shape is unknowable and reporting would risk a false positive.
      name = staticComputedKeyName(property.key)
      if (name === undefined) return undefined
    } else {
      name = staticPropertyName(property.key)
      if (name === undefined) continue
    }
    resolved.set(name, isDefinitelyUndefined(property.value))
  }
  return resolved
}

const objectPatternBindsPath = (context, pattern, path, variable) => {
  const [head, ...tail] = path
  return pattern.properties.some((property) => {
    if (property.type !== "Property" || staticPropertyName(property.key) !== head) return false
    const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value
    if (tail.length === 0) {
      return value.type === "Identifier" && resolvedVariable(context, value) === variable
    }
    return value.type === "ObjectPattern" && objectPatternBindsPath(context, value, tail, variable)
  })
}

const isObjectPatternBindingIdentifier = (identifier) => {
  const value =
    identifier.parent?.type === "AssignmentPattern" && identifier.parent.left === identifier
      ? identifier.parent
      : identifier
  return (
    value.parent?.type === "Property" && value.parent.value === value && value.parent.parent?.type === "ObjectPattern"
  )
}

const isRootEffectNamespace = (context, expression) =>
  expression.type === "Identifier" && isNamespaceImportFrom(context, expression, ["effect"])

const isVariableDestructuredFrom = (context, identifier, sourcePredicate, path) => {
  const variable = resolvedVariable(context, identifier)
  return (variable?.defs ?? []).some(
    (definition) =>
      definition.type === "Variable" &&
      definition.node.id.type === "ObjectPattern" &&
      definition.node.init !== null &&
      sourcePredicate(unwrapTypeExpression(definition.node.init)) &&
      objectPatternBindsPath(context, definition.node.id, path, variable)
  )
}

const isEffectModule = (context, expression) => {
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, ["effect/Effect"]) ||
      isNamedImportFrom(context, expression, ["effect"], ["Effect"]) ||
      isVariableDestructuredFrom(context, expression, (source) => isRootEffectNamespace(context, source), ["Effect"])
    )
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "Effect" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ["effect"])
  )
}

const isSchemaModule = (context, expression) => {
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, ["effect/Schema"]) ||
      isNamedImportFrom(context, expression, ["effect"], ["Schema"])
    )
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "Schema" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ["effect"])
  )
}

const isDestructuredEffectFunction = (context, identifier, name) => {
  return (
    isVariableDestructuredFrom(context, identifier, (source) => isEffectModule(context, source), [name]) ||
    isVariableDestructuredFrom(context, identifier, (source) => isRootEffectNamespace(context, source), [
      "Effect",
      name
    ])
  )
}

const isEffectFunction = (context, expression, name) =>
  (expression.type === "Identifier" &&
    (isNamedImportFrom(context, expression, ["effect/Effect"], [name]) ||
      isDestructuredEffectFunction(context, expression, name))) ||
  (expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === name &&
    isEffectModule(context, expression.object))

const isNodeRuntimeModule = (context, expression) => {
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, ["@effect/platform-node/NodeRuntime"]) ||
      isNamedImportFrom(context, expression, ["@effect/platform-node"], ["NodeRuntime"])
    )
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "NodeRuntime" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ["@effect/platform-node"])
  )
}

const isNodeRunMainCall = (context, call) => {
  const callee = call.callee
  if (callee.type === "Identifier") {
    return isNamedImportFrom(context, callee, ["@effect/platform-node/NodeRuntime"], ["runMain"])
  }
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property) === "runMain" &&
    isNodeRuntimeModule(context, callee.object)
  )
}

const keepsRuntimeErrorReporting = (options) => {
  if (options === undefined) return true
  if (options.type !== "ObjectExpression") return false
  for (const property of options.properties) {
    if (property.type === "SpreadElement") return false
    const name = property.computed ? staticComputedKeyName(property.key) : staticPropertyName(property.key)
    if (name === undefined) return false
    if (name !== "disableErrorReporting") continue
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.value.type !== "Literal" ||
      property.value.value !== false
    ) {
      return false
    }
  }
  return true
}

const isResultModule = (context, expression) => {
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, ["effect/Result"]) ||
      isNamedImportFrom(context, expression, ["effect"], ["Result"])
    )
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "Result" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ["effect"])
  )
}

const isResultFailureCall = (context, expression) => {
  if (expression.type !== "CallExpression" || expression.arguments.length !== 1) return false
  const callee = expression.callee
  if (callee.type === "Identifier") {
    return isNamedImportFrom(context, callee, ["effect", "effect/Result"], ["isFailure"])
  }
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property) === "isFailure" &&
    isResultModule(context, callee.object)
  )
}

const failureTagTarget = (expression) => {
  if (
    expression.type !== "MemberExpression" ||
    staticPropertyName(expression.property) !== "_tag" ||
    expression.object.type !== "MemberExpression" ||
    staticPropertyName(expression.object.property) !== "failure"
  ) {
    return undefined
  }
  return expression.object.object
}

const stringLiteralValue = (expression) =>
  expression.type === "Literal" && Predicate.isString(expression.value) ? expression.value : undefined

const failureTagComparison = (context, expression) => {
  if (expression.type !== "BinaryExpression" || expression.operator !== "===") return undefined
  const leftTarget = failureTagTarget(expression.left)
  const rightTarget = failureTagTarget(expression.right)
  const leftTag = stringLiteralValue(expression.left)
  const rightTag = stringLiteralValue(expression.right)
  if (leftTarget !== undefined && rightTag !== undefined) {
    return { result: context.sourceCode.getText(leftTarget), tag: rightTag }
  }
  if (rightTarget !== undefined && leftTag !== undefined) {
    return { result: context.sourceCode.getText(rightTarget), tag: leftTag }
  }
  return undefined
}

const flattenLogicalAnd = (expression) =>
  expression.type === "LogicalExpression" && expression.operator === "&&"
    ? [...flattenLogicalAnd(expression.left), ...flattenLogicalAnd(expression.right)]
    : [expression]

const conditionalFailureTag = (context, expression) => {
  const operands = flattenLogicalAnd(expression)
  const failureResults = operands
    .filter((operand) => isResultFailureCall(context, operand))
    .map((operand) => context.sourceCode.getText(operand.arguments[0]))
  const comparisons = operands.map((operand) => failureTagComparison(context, operand)).filter(Boolean)
  if (failureResults.length !== 1 || comparisons.length !== 1) return undefined
  return comparisons[0].result === failureResults[0] ? comparisons[0] : undefined
}

const EXPECT_IMPORT_SOURCES = ["@effect/vitest", "@jest/globals", "vitest"]
const ASSERT_IMPORT_SOURCES = ["@effect/vitest", "vitest"]
const ASSERT_EQUALITY_METHODS = ["deepEqual", "deepStrictEqual", "equal", "strictEqual"]

const isAssertFunction = (context, expression) => {
  if (expression.type === "Identifier") {
    return isNamedImportFrom(context, expression, ASSERT_IMPORT_SOURCES, ["assert"])
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "assert" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ASSERT_IMPORT_SOURCES)
  )
}

const isExpectFunction = (context, expression) => {
  if (expression.type === "Identifier") {
    return isNamedImportFrom(context, expression, EXPECT_IMPORT_SOURCES, ["expect"])
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === "expect" &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, EXPECT_IMPORT_SOURCES)
  )
}

const expectInvocation = (context, expression) => {
  let candidate = expression
  while (candidate.type === "MemberExpression") candidate = candidate.object
  return candidate.type === "CallExpression" && isExpectFunction(context, candidate.callee) ? candidate : undefined
}

const isExpectAssertionCall = (context, expression) =>
  expression.type === "CallExpression" &&
  expression.callee.type === "MemberExpression" &&
  expectInvocation(context, expression.callee.object) !== undefined

const exactExpectTagAssertion = (context, expression, expected) => {
  if (
    expression.type !== "CallExpression" ||
    expression.callee.type !== "MemberExpression" ||
    !["toBe", "toEqual", "toStrictEqual"].includes(staticPropertyName(expression.callee.property)) ||
    expression.callee.object.type !== "CallExpression" ||
    !isExpectFunction(context, expression.callee.object.callee) ||
    expression.callee.object.arguments.length !== 1 ||
    expression.arguments.length !== 1
  ) {
    return false
  }
  const target = failureTagTarget(expression.callee.object.arguments[0])
  const tag = stringLiteralValue(expression.arguments[0])
  return target !== undefined && context.sourceCode.getText(target) === expected.result && tag === expected.tag
}

const isAssertionCall = (context, expression) => {
  if (expression.type !== "CallExpression") return false
  if (isAssertFunction(context, expression.callee)) return true
  return (
    isExpectAssertionCall(context, expression) ||
    (expression.callee.type === "MemberExpression" && isAssertFunction(context, expression.callee.object))
  )
}

const isAssertEqualityCall = (context, expression) =>
  expression.type === "CallExpression" &&
  expression.callee.type === "MemberExpression" &&
  ASSERT_EQUALITY_METHODS.includes(staticPropertyName(expression.callee.property)) &&
  isAssertFunction(context, expression.callee.object)

const containsAssertion = (context, node) => {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false
  }
  if (node.type === "CallExpression" && isAssertionCall(context, node)) return true
  const keys = context.sourceCode.visitorKeys[node.type] ?? []
  return keys.some((key) => {
    const child = node[key]
    return Array.isArray(child)
      ? child.some((entry) => entry !== null && Predicate.isObjectOrArray(entry) && containsAssertion(context, entry))
      : child !== null && Predicate.isObjectOrArray(child) && containsAssertion(context, child)
  })
}

const tagAssertion = (context, statement, expected) => {
  if (statement.type !== "ExpressionStatement") return false
  if (exactExpectTagAssertion(context, statement.expression, expected)) return true
  if (!isAssertEqualityCall(context, statement.expression)) return false
  const args = statement.expression.arguments
  if (args.length < 2) return false
  const leftTarget = failureTagTarget(args[0])
  const rightTarget = failureTagTarget(args[1])
  const leftTag = stringLiteralValue(args[0])
  const rightTag = stringLiteralValue(args[1])
  return (
    (leftTarget !== undefined &&
      context.sourceCode.getText(leftTarget) === expected.result &&
      rightTag === expected.tag) ||
    (rightTarget !== undefined &&
      context.sourceCode.getText(rightTarget) === expected.result &&
      leftTag === expected.tag)
  )
}

const directTagAssertion = (context, statement, expected) => {
  if (tagAssertion(context, statement, expected)) return true
  if (statement.type !== "IfStatement" || !isResultFailureCall(context, statement.test)) return false
  const argument = statement.test.arguments[0]
  if (argument === undefined || context.sourceCode.getText(argument) !== expected.result) return false
  const body = statement.consequent.type === "BlockStatement" ? statement.consequent.body : [statement.consequent]
  return body.some((entry) => tagAssertion(context, entry, expected))
}

const hasDominatingTagAssertion = (context, node, expected) => {
  const parent = node.parent
  if (parent?.type !== "BlockStatement" && parent?.type !== "Program") return false
  const index = parent.body.indexOf(node)
  return index > 0 && parent.body.slice(0, index).some((statement) => directTagAssertion(context, statement, expected))
}

const isRunPromiseCall = (context, expression) => {
  if (expression.type !== "CallExpression") return false
  const callee = expression.callee
  if (callee.type === "Identifier") {
    return isNamedImportFrom(context, callee, ["effect", "effect/Effect"], ["runPromise"])
  }
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property) === "runPromise" &&
    isEffectModule(context, callee.object)
  )
}

const isReactUseEffectCall = (context, expression) => {
  if (expression.type !== "CallExpression") return false
  const callee = expression.callee
  if (callee.type === "Identifier") {
    return isNamedImportFrom(context, callee, ["react"], ["useEffect"])
  }
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property) === "useEffect" &&
    callee.object.type === "Identifier" &&
    (isNamespaceImportFrom(context, callee.object, ["react"]) || isDefaultImportFrom(context, callee.object, ["react"]))
  )
}

const reactUseEffectCallback = (context, node) => {
  let current = node.parent
  while (current !== undefined && current !== null) {
    if (
      (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") &&
      current.parent?.type === "CallExpression" &&
      current.parent.arguments[0] === current &&
      isReactUseEffectCall(context, current.parent)
    ) {
      return current
    }
    current = current.parent
  }
  return undefined
}

const runPromiseAbortController = (context, call) => {
  const options = call.arguments[1]
  if (options?.type !== "ObjectExpression") return undefined
  const signalProperty = options.properties.find(
    (property) =>
      property.type === "Property" && property.kind === "init" && staticPropertyName(property.key) === "signal"
  )
  if (
    signalProperty?.type !== "Property" ||
    isDefinitelyUndefined(signalProperty.value) ||
    signalProperty.value.type !== "MemberExpression" ||
    staticPropertyName(signalProperty.value.property) !== "signal" ||
    signalProperty.value.object.type !== "Identifier"
  ) {
    return undefined
  }
  return resolvedVariable(context, signalProperty.value.object)
}

const isFunctionNode = (node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration"

const isDescendantOf = (node, ancestor) => {
  let current = node.parent
  while (current !== undefined && current !== null) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

const isLocalAbortController = (context, variable, effectCallback) =>
  variable.defs.some(
    (definition) =>
      definition.type === "Variable" &&
      isDescendantOf(definition.node, effectCallback) &&
      definition.node.init?.type === "NewExpression" &&
      definition.node.init.callee.type === "Identifier" &&
      definition.node.init.callee.name === "AbortController" &&
      (resolvedVariable(context, definition.node.init.callee)?.defs.length ?? 0) === 0
  )

const cleanupFunctionsFromExpression = (context, expression) => {
  const cleanups = []
  const returned = unwrapTypeExpression(expression)
  if (returned.type === "ArrowFunctionExpression" || returned.type === "FunctionExpression") {
    cleanups.push(returned)
    return cleanups
  }
  if (returned.type === "Identifier") {
    const variable = resolvedVariable(context, returned)
    for (const definition of variable?.defs ?? []) {
      if (
        definition.type === "Variable" &&
        (definition.node.init?.type === "ArrowFunctionExpression" ||
          definition.node.init?.type === "FunctionExpression")
      ) {
        cleanups.push(definition.node.init)
      } else if (definition.type === "FunctionName" && definition.node.type === "FunctionDeclaration") {
        cleanups.push(definition.node)
      }
    }
  }
  return cleanups
}

const cleanupFunctionsAfterCall = (context, effectCallback, call) => {
  const cleanups = []
  let descendant = call
  let current = call.parent
  while (current !== undefined && current !== null && current !== effectCallback) {
    if (current.type === "BlockStatement" && enclosingFunction(current) === effectCallback) {
      let directChild = descendant
      while (directChild.parent !== current && directChild.parent !== undefined && directChild.parent !== null) {
        directChild = directChild.parent
      }
      const index = current.body.indexOf(directChild)
      if (index >= 0) {
        for (const statement of current.body.slice(index + 1)) {
          if (statement.type === "ReturnStatement" && statement.argument !== null) {
            cleanups.push(...cleanupFunctionsFromExpression(context, statement.argument))
          }
        }
      }
    }
    descendant = current
    current = current.parent
  }
  return cleanups
}

const isControllerAbortCall = (context, expression, controller) =>
  expression.type === "CallExpression" &&
  expression.callee.type === "MemberExpression" &&
  staticPropertyName(expression.callee.property) === "abort" &&
  expression.callee.object.type === "Identifier" &&
  resolvedVariable(context, expression.callee.object) === controller

const containsAbruptCleanupExit = (context, root) => {
  const visit = (node) => {
    if (node !== root && isFunctionNode(node)) return false
    if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true
    const keys = context.sourceCode.visitorKeys[node.type] ?? []
    return keys.some((key) => {
      const child = node[key]
      return Array.isArray(child)
        ? child.some((entry) => entry !== null && Predicate.isObjectOrArray(entry) && visit(entry))
        : child !== null && Predicate.isObjectOrArray(child) && visit(child)
    })
  }
  return visit(root)
}

const cleanupAbortsController = (context, cleanup, controller) => {
  if (cleanup.body.type !== "BlockStatement") {
    return isControllerAbortCall(context, unwrapTypeExpression(cleanup.body), controller)
  }
  const abortIndex = cleanup.body.body.findIndex(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      isControllerAbortCall(context, unwrapTypeExpression(statement.expression), controller)
  )
  return (
    abortIndex >= 0 &&
    !cleanup.body.body.slice(0, abortIndex).some((statement) => containsAbruptCleanupExit(context, statement))
  )
}

const containsEffectSleep = (context, root) => {
  const visit = (node) => {
    if (node !== root && isFunctionNode(node)) return false
    if (node.type === "CallExpression" && isEffectFunction(context, node.callee, "sleep")) return true
    const keys = context.sourceCode.visitorKeys[node.type] ?? []
    return keys.some((key) => {
      const child = node[key]
      return Array.isArray(child)
        ? child.some((entry) => entry !== null && Predicate.isObjectOrArray(entry) && visit(entry))
        : child !== null && Predicate.isObjectOrArray(child) && visit(child)
    })
  }
  return visit(root)
}

const isInsideEffectGen = (context, node) => {
  const callback = enclosingFunction(node)
  return (
    callback !== undefined &&
    callback.parent?.type === "CallExpression" &&
    callback.parent.arguments.includes(callback) &&
    isEffectFunction(context, callback.parent.callee, "gen")
  )
}

const isNamedEffectLibraryModule = (context, expression, name) => {
  if (name === "Effect") return isEffectModule(context, expression)
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, [`effect/${name}`]) ||
      isNamedImportFrom(context, expression, ["effect"], [name])
    )
  }
  return (
    expression.type === "MemberExpression" &&
    staticPropertyName(expression.property) === name &&
    expression.object.type === "Identifier" &&
    isNamespaceImportFrom(context, expression.object, ["effect"])
  )
}

const catchCauseKind = (context, call) => {
  const callee = call.callee
  if (callee.type === "MemberExpression" && staticPropertyName(callee.property) === "catchCause") {
    for (const name of ["Effect", "Layer", "Stream"]) {
      if (isNamedEffectLibraryModule(context, callee.object, name)) return name
    }
    return undefined
  }
  if (callee.type !== "Identifier") return undefined
  for (const name of ["Effect", "Layer", "Stream"]) {
    if (isNamedImportFrom(context, callee, [`effect/${name}`], ["catchCause"])) return name
  }
  return undefined
}

const resolveFunction = (context, expression) => {
  if (expression?.type === "ArrowFunctionExpression" || expression?.type === "FunctionExpression") return expression
  if (expression?.type !== "Identifier") return undefined
  const variable = resolvedVariable(context, expression)
  for (const definition of variable?.defs ?? []) {
    if (
      definition.type === "Variable" &&
      (definition.node.init?.type === "ArrowFunctionExpression" || definition.node.init?.type === "FunctionExpression")
    ) {
      return definition.node.init
    }
    if (definition.type === "FunctionName" && definition.node.type === "FunctionDeclaration") {
      return definition.node
    }
  }
  return undefined
}

const isCauseReasonPredicate = (context, expression, reasonBinding, name) => {
  const candidate = unwrapTypeExpression(expression)
  if (
    candidate.type !== "CallExpression" ||
    candidate.arguments.length !== 1 ||
    candidate.arguments[0].type !== "Identifier" ||
    resolvedVariable(context, candidate.arguments[0]) !== reasonBinding
  ) {
    return false
  }
  const callee = candidate.callee
  return (
    (callee.type === "Identifier" && isNamedImportFrom(context, callee, ["effect/Cause"], [name])) ||
    (callee.type === "MemberExpression" &&
      staticPropertyName(callee.property) === name &&
      isNamedEffectLibraryModule(context, callee.object, "Cause"))
  )
}

const isNonFailReasonPredicate = (context, expression) => {
  const predicate = resolveFunction(context, expression)
  const reasonParameter = predicate?.params[0]
  if (predicate === undefined || reasonParameter?.type !== "Identifier" || predicate.body.type === "BlockStatement") {
    return false
  }
  const reasonBinding = resolvedVariable(context, reasonParameter)
  if (reasonBinding === undefined) return false
  const body = unwrapTypeExpression(predicate.body)
  if (body.type !== "LogicalExpression" || body.operator !== "||") return false
  const names = ["isDieReason", "isInterruptReason"]
  return names.every(
    (name) =>
      isCauseReasonPredicate(context, body.left, reasonBinding, name) ||
      isCauseReasonPredicate(context, body.right, reasonBinding, name)
  )
}

const isExactNonFailProjection = (context, expression, causeBinding) => {
  const candidate = unwrapTypeExpression(expression)
  if (
    candidate.type !== "CallExpression" ||
    candidate.arguments.length !== 1 ||
    candidate.callee.type !== "MemberExpression" ||
    staticPropertyName(candidate.callee.property) !== "fromReasons" ||
    !isNamedEffectLibraryModule(context, candidate.callee.object, "Cause")
  ) {
    return false
  }
  const filteredReasons = candidate.arguments[0]
  if (
    filteredReasons.type !== "CallExpression" ||
    filteredReasons.arguments.length !== 1 ||
    filteredReasons.callee.type !== "MemberExpression" ||
    staticPropertyName(filteredReasons.callee.property) !== "filter"
  ) {
    return false
  }
  const reasons = filteredReasons.callee.object
  if (
    reasons.type !== "MemberExpression" ||
    staticPropertyName(reasons.property) !== "reasons" ||
    reasons.object.type !== "Identifier" ||
    resolvedVariable(context, reasons.object) !== causeBinding
  ) {
    return false
  }
  const predicate = filteredReasons.arguments[0]
  return isNonFailReasonPredicate(context, predicate)
}

const isPreservedCauseArgument = (context, argument, causeBinding) =>
  (argument.type === "Identifier" && resolvedVariable(context, argument) === causeBinding) ||
  isExactNonFailProjection(context, argument, causeBinding)

const isExactFailCauseCall = (context, call, kind, causeBinding) => {
  if (
    call.arguments.length !== 1 ||
    call.arguments[0].type === "SpreadElement" ||
    !isPreservedCauseArgument(context, call.arguments[0], causeBinding)
  ) {
    return false
  }
  const callee = call.callee
  const requiredModule = kind === "Stream" ? "Stream" : "Effect"
  if (callee.type === "Identifier") {
    return isNamedImportFrom(context, callee, [`effect/${requiredModule}`], ["failCause"])
  }
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property) === "failCause" &&
    isNamedEffectLibraryModule(context, callee.object, requiredModule)
  )
}

const isCauseTest = (context, expression, causeBinding, name) => {
  const candidate = unwrapTypeExpression(expression)
  if (
    candidate.type !== "CallExpression" ||
    candidate.arguments.length !== 1 ||
    candidate.arguments[0].type !== "Identifier" ||
    resolvedVariable(context, candidate.arguments[0]) !== causeBinding
  ) {
    return false
  }
  const callee = candidate.callee
  return (
    (callee.type === "Identifier" && isNamedImportFrom(context, callee, ["effect/Cause"], [name])) ||
    (callee.type === "MemberExpression" &&
      staticPropertyName(callee.property) === name &&
      isNamedEffectLibraryModule(context, callee.object, "Cause"))
  )
}

const provesNonFailCause = (context, expression, causeBinding) => {
  const candidate = unwrapTypeExpression(expression)
  if (candidate.type !== "LogicalExpression" || candidate.operator !== "||") return false
  const names = ["hasDies", "hasInterrupts"]
  return names.every(
    (name) =>
      isCauseTest(context, candidate.left, causeBinding, name) ||
      isCauseTest(context, candidate.right, causeBinding, name)
  )
}

const expressionRethrowsPreservedCause = (context, expression, kind, causeBinding) => {
  const candidate = unwrapTypeExpression(expression)
  if (candidate.type === "CallExpression") {
    if (isExactFailCauseCall(context, candidate, kind, causeBinding)) return true
    if (
      candidate.callee.type === "MemberExpression" &&
      staticPropertyName(candidate.callee.property) === "effectContext" &&
      isNamedEffectLibraryModule(context, candidate.callee.object, "Layer") &&
      candidate.arguments.length === 1 &&
      candidate.arguments[0].type !== "SpreadElement"
    ) {
      return expressionRethrowsPreservedCause(context, candidate.arguments[0], "Effect", causeBinding)
    }
    if (
      candidate.callee.type === "MemberExpression" &&
      staticPropertyName(candidate.callee.property) === "pipe" &&
      candidate.arguments.length > 0
    ) {
      const finalOperator = candidate.arguments.at(-1)
      return (
        finalOperator?.type !== "SpreadElement" &&
        finalOperator?.type === "CallExpression" &&
        isEffectFunction(context, finalOperator.callee, "andThen") &&
        finalOperator.arguments.length === 1 &&
        finalOperator.arguments[0].type !== "SpreadElement" &&
        expressionRethrowsPreservedCause(context, finalOperator.arguments[0], kind, causeBinding)
      )
    }
    if (
      isEffectFunction(context, candidate.callee, "andThen") &&
      candidate.arguments.length === 2 &&
      candidate.arguments[1].type !== "SpreadElement"
    ) {
      return expressionRethrowsPreservedCause(context, candidate.arguments[1], kind, causeBinding)
    }
  }
  if (candidate.type !== "ConditionalExpression") return false
  if (
    provesNonFailCause(context, candidate.test, causeBinding) &&
    expressionRethrowsPreservedCause(context, candidate.consequent, kind, causeBinding)
  ) {
    return true
  }
  return (
    expressionRethrowsPreservedCause(context, candidate.consequent, kind, causeBinding) &&
    expressionRethrowsPreservedCause(context, candidate.alternate, kind, causeBinding)
  )
}

const statementRethrowsPreservedCause = (context, statement, kind, causeBinding) => {
  if (statement.type === "ReturnStatement" && statement.argument !== null) {
    return expressionRethrowsPreservedCause(context, statement.argument, kind, causeBinding)
  }
  if (statement.type !== "BlockStatement") return false
  return statement.body.length === 1 && statementRethrowsPreservedCause(context, statement.body[0], kind, causeBinding)
}

const handlerPreservesNonFailCause = (context, handler, kind) => {
  const causeParameter = handler.params[0]
  if (causeParameter?.type !== "Identifier") return false
  const causeBinding = resolvedVariable(context, causeParameter)
  if (causeBinding === undefined) return false
  if (handler.body.type !== "BlockStatement") {
    return expressionRethrowsPreservedCause(context, handler.body, kind, causeBinding)
  }
  for (const statement of handler.body.body) {
    if (
      statement.type === "IfStatement" &&
      statement.alternate === null &&
      provesNonFailCause(context, statement.test, causeBinding) &&
      statementRethrowsPreservedCause(context, statement.consequent, kind, causeBinding)
    ) {
      return true
    }
    if (statement.type === "ReturnStatement") {
      return (
        statement.argument !== null && expressionRethrowsPreservedCause(context, statement.argument, kind, causeBinding)
      )
    }
  }
  return false
}

const isGlobalJsonIdentifier = (context, identifier) => {
  if (identifier.name !== "JSON") return false
  const variable = resolvedVariable(context, identifier)
  return variable === undefined || variable.defs.length === 0
}

const isGlobalJsonParseMember = (context, expression) =>
  expression.type === "MemberExpression" &&
  staticPropertyName(expression.property) === "parse" &&
  expression.object.type === "Identifier" &&
  isGlobalJsonIdentifier(context, expression.object)

const isGlobalJsonParseCall = (context, call) => {
  if (isGlobalJsonParseMember(context, call.callee)) return true
  if (call.callee.type !== "Identifier") return false
  const variable = resolvedVariable(context, call.callee)
  return (variable?.defs ?? []).some(
    (definition) =>
      definition.type === "Variable" &&
      definition.node.init !== null &&
      isGlobalJsonParseMember(context, unwrapTypeExpression(definition.node.init))
  )
}

const isUndefinedExpression = (expression) =>
  (expression.type === "Identifier" && expression.name === "undefined") ||
  (expression.type === "UnaryExpression" &&
    expression.operator === "void" &&
    (expression.argument.type === "Identifier" || expression.argument.type === "Literal"))

const isSilentRejectionHandler = (handler) => {
  if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") return false
  if (handler.body.type !== "BlockStatement") return isUndefinedExpression(handler.body)
  if (handler.body.body.length === 0) return true
  if (handler.body.body.length !== 1 || handler.body.body[0].type !== "ReturnStatement") return false
  const returned = handler.body.body[0].argument
  return returned === null || isUndefinedExpression(returned)
}

const HTTP_HANDLER_REQUEST_SERVICE_IMPORTS = [
  { importedName: "CurrentSession", source: "../../api/session.js" },
  { importedName: "CurrentSession", source: "../../api/index.js" }
]

const importReference = (context, expression, seen = new Set()) => {
  if (seen.has(expression)) return undefined
  seen.add(expression)
  if (expression.type === "MemberExpression" && expression.object.type === "Identifier") {
    const definition = importedBinding(context, expression.object)
    if (isValueImport(definition) && definition.node.type === "ImportNamespaceSpecifier") {
      return { definition, importedName: staticPropertyName(expression.property) }
    }
    return undefined
  }
  if (expression.type !== "Identifier") return undefined

  let scope = context.sourceCode.getScope(expression)
  while (scope !== null) {
    const variable = scope.set.get(expression.name)
    if (variable !== undefined) {
      const importDefinition = variable.defs.find((definition) => definition.type === "ImportBinding")
      if (isValueImport(importDefinition)) {
        return {
          definition: importDefinition,
          importedName:
            importDefinition.node.type === "ImportSpecifier"
              ? staticPropertyName(importDefinition.node.imported)
              : undefined
        }
      }
      const variableDefinition = variable.defs.find(
        (definition) => definition.type === "Variable" && definition.node.init !== null
      )
      return variableDefinition === undefined ? undefined : importReference(context, variableDefinition.node.init, seen)
    }
    scope = scope.upper
  }
  return undefined
}

const isAllowedHttpHandlerRequestService = ({ definition, importedName }) =>
  HTTP_HANDLER_REQUEST_SERVICE_IMPORTS.some(
    (allowed) => importSource(definition) === allowed.source && importedName === allowed.importedName
  )

const optionalServiceReference = (context, expression) => {
  if (expression.type !== "CallExpression" || expression.arguments.length === 0) return undefined
  const callee = importReference(context, expression.callee)
  if (
    callee === undefined ||
    callee.importedName !== "serviceOption" ||
    !["effect", "effect/Effect"].includes(importSource(callee.definition))
  ) {
    return undefined
  }
  const service = expression.arguments[0]
  return service.type === "SpreadElement" ? undefined : importReference(context, service)
}

const isHttpHandleCallback = (node) => {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return false
  const parent = node.parent
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return false
  return parent.callee.type === "MemberExpression" && staticPropertyName(parent.callee.property) === "handle"
}

const containsEntityIdLikeIdentifier = (sourceCode, node) => {
  if (node.type === "Identifier") return /entityId$/iu.test(node.name)
  const visitorKeys = sourceCode.visitorKeys[node.type] ?? []
  return visitorKeys.some((key) => {
    const child = node[key]
    return Array.isArray(child)
      ? child.some((entry) => entry !== null && containsEntityIdLikeIdentifier(sourceCode, entry))
      : child !== null && child !== undefined && containsEntityIdLikeIdentifier(sourceCode, child)
  })
}

module.exports = {
  "require-immediate-work-store-cleanup": {
    meta: {
      type: "problem",
      docs: {
        description: "register WorkStore cleanup immediately after a successful test acquisition",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        missingCleanup: "Register an Effect finalizer for this WorkStore before inspecting or transforming it."
      }
    },
    create(context) {
      const isWorkStoreOpenCall = (expression) => {
        if (
          expression.type !== "CallExpression" ||
          expression.callee.type !== "MemberExpression" ||
          staticPropertyName(expression.callee.property) !== "open" ||
          expression.callee.object.type !== "Identifier"
        ) {
          return false
        }
        return isNamedImportFrom(
          context,
          expression.callee.object,
          ["@knpkv/herdr-work", "@knpkv/herdr-work/store", "../src/index.js", "../src/store.js"],
          ["WorkStore"]
        )
      }
      const isWorkStoreOpen = (expression) =>
        expression.type === "YieldExpression" &&
        expression.delegate &&
        expression.argument !== null &&
        isWorkStoreOpenCall(expression.argument)
      const isProtectedAcquisition = (node) => {
        let child = node
        let parent = node.parent
        while (parent !== undefined && parent.type !== "YieldExpression") {
          if (
            parent.type === "CallExpression" &&
            (isEffectFunction(context, parent.callee, "acquireRelease") ||
              isEffectFunction(context, parent.callee, "acquireUseRelease")) &&
            parent.arguments[0] === child
          ) {
            const releaseIndex = isEffectFunction(context, parent.callee, "acquireRelease") ? 1 : 2
            const release = parent.arguments[releaseIndex]
            if (release?.type === "ArrowFunctionExpression" || release?.type === "FunctionExpression") {
              const resource = release.params[0]
              if (resource?.type === "Identifier") {
                const variable = resolvedVariable(context, resource)
                if (variable !== undefined && releaseClosesVariable(release, variable)) return true
              }
            }
            return false
          }
          child = parent
          parent = parent.parent
        }
        return false
      }
      const isCloseCall = (root, variable) =>
        root.type === "CallExpression" &&
        root.arguments.length === 0 &&
        root.callee.type === "MemberExpression" &&
        staticPropertyName(root.callee.property) === "close" &&
        root.callee.object.type === "Identifier" &&
        resolvedVariable(context, root.callee.object) === variable
      const returnedExpression = (callback) => {
        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return undefined
        if (callback.body.type !== "BlockStatement") return callback.body
        return callback.body.body.length === 1 && callback.body.body[0].type === "ReturnStatement"
          ? (callback.body.body[0].argument ?? undefined)
          : undefined
      }
      const closesVariable = (finalizer, variable) => {
        const cleanupEffect = returnedExpression(finalizer)
        if (
          cleanupEffect?.type !== "CallExpression" ||
          !isEffectFunction(context, cleanupEffect.callee, "sync") ||
          cleanupEffect.arguments.length !== 1
        ) {
          return false
        }
        const cleanup = cleanupEffect.arguments[0]
        if (cleanup.type === "SpreadElement") return false
        const close = returnedExpression(cleanup)
        return close !== undefined && isCloseCall(close, variable)
      }
      const releaseClosesVariable = (release, variable) => {
        if (closesVariable(release, variable)) return true
        const cleanupEffect = returnedExpression(release)
        if (
          cleanupEffect?.type !== "CallExpression" ||
          !isEffectFunction(context, cleanupEffect.callee, "sync") ||
          cleanupEffect.arguments.length !== 1
        )
          return false
        const cleanup = cleanupEffect.arguments[0]
        if (
          cleanup.type === "SpreadElement" ||
          (cleanup.type !== "ArrowFunctionExpression" && cleanup.type !== "FunctionExpression") ||
          cleanup.body.type !== "BlockStatement"
        )
          return false
        const statementsClose = (statements) =>
          statements.some((statement) => {
            return statement.type === "ExpressionStatement" && isCloseCall(statement.expression, variable)
          })
        return statementsClose(cleanup.body.body)
      }
      const isImmediateFinalizer = (statement, variable) =>
        statement?.type === "ExpressionStatement" &&
        statement.expression.type === "YieldExpression" &&
        statement.expression.delegate &&
        statement.expression.argument?.type === "CallExpression" &&
        isEffectFunction(context, statement.expression.argument.callee, "addFinalizer") &&
        statement.expression.argument.arguments.length === 1 &&
        statement.expression.argument.arguments[0].type !== "SpreadElement" &&
        releaseClosesVariable(statement.expression.argument.arguments[0], variable)

      return {
        CallExpression(node) {
          if (!isWorkStoreOpenCall(node)) return
          if (isProtectedAcquisition(node)) return
          const yieldExpression = node.parent
          const declarator = yieldExpression?.parent
          const declaration = declarator?.parent
          const block = declaration?.parent
          if (
            yieldExpression?.type === "YieldExpression" &&
            yieldExpression.delegate &&
            declarator?.type === "VariableDeclarator" &&
            declarator.id.type === "Identifier" &&
            declarator.init === yieldExpression &&
            declaration?.type === "VariableDeclaration" &&
            block?.type === "BlockStatement"
          ) {
            return
          }
          context.report({ messageId: "missingCleanup", node })
        },
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier" || node.init === null || !isWorkStoreOpen(node.init)) return
          const declaration = node.parent
          const block = declaration?.parent
          if (declaration?.type !== "VariableDeclaration" || block?.type !== "BlockStatement") return
          if (declaration.declarations.at(-1) !== node) {
            context.report({ messageId: "missingCleanup", node })
            return
          }
          const index = block.body.indexOf(declaration)
          const variable = resolvedVariable(context, node.id)
          if (variable !== undefined && isImmediateFinalizer(block.body[index + 1], variable)) return
          context.report({ messageId: "missingCleanup", node })
        }
      }
    }
  },
  "require-named-orchestrator-service-effects": {
    meta: {
      type: "problem",
      docs: {
        description: "require operation-specific Effect.fn names on public coordinator effects",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        unnamed: "Wrap public OrchestratorService Effect operation '{{name}}' with Effect.fn('Orchestrator.{{name}}')."
      }
    },
    create(context) {
      const filename = context.filename.replaceAll("\\", "/")
      if (!filename.endsWith("packages/herdr-coordinator/src/orchestrator.ts")) return {}
      const effectOperations = new Set([
        "failDelivery",
        "failTask",
        "pending",
        "queue",
        "request",
        "run",
        "settle",
        "submit",
        "submitRouted",
        "workerStarted"
      ])
      const hasExpectedEffectName = (expression, name) =>
        expression?.type === "CallExpression" &&
        expression.callee.type === "CallExpression" &&
        isEffectFunction(context, expression.callee.callee, "fn") &&
        staticPropertyName(expression.callee.arguments[0]) === `Orchestrator.${name}`
      const resolvesToExpectedEffect = (expression, name) => {
        if (hasExpectedEffectName(expression, name)) return true
        if (expression.type !== "Identifier") return false
        const variable = resolvedVariable(context, expression)
        const definition = variable?.defs.find((candidate) => candidate.type === "Variable")
        return (
          definition?.node.type === "VariableDeclarator" &&
          definition.node.parent.type === "VariableDeclaration" &&
          definition.node.parent.kind === "const" &&
          hasExpectedEffectName(definition.node.init, name)
        )
      }
      return {
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier" || node.id.name !== "service" || node.init?.type !== "ObjectExpression") {
            return
          }
          for (const property of node.init.properties) {
            if (property.type !== "Property") continue
            const name = staticPropertyName(property.key)
            if (name !== undefined && effectOperations.has(name) && !resolvesToExpectedEffect(property.value, name)) {
              context.report({ data: { name }, messageId: "unnamed", node: property })
            }
          }
        }
      }
    }
  },
  "require-structured-reconciliation-key-schema": {
    meta: {
      type: "problem",
      docs: {
        description: "require Schema parsing before comparing structured plugin reconciliation keys",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        rawStructuredLocator:
          "Parse colon-delimited reconciliation locators with Schema.TemplateLiteralParser before comparing request fields."
      }
    },
    create(context) {
      const filename = context.filename.replaceAll("\\", "/")
      if (!filename.includes("/server/plugins/") || /\/(?:fake|generated|vendor)\//u.test(filename)) {
        return {}
      }

      const structuredKeyConstructors = []
      const localDefinitions = new Map()
      let comparesRequestKey = false
      const isReconciliationKeyImport = (identifier) => {
        const definition = importedBinding(context, identifier)
        return (
          definition?.node.type === "ImportSpecifier" &&
          staticPropertyName(definition.node.imported) === "PluginActionReconciliationKey"
        )
      }
      const isRequestReconciliationKey = (expression) =>
        expression.type === "MemberExpression" && staticPropertyName(expression.property) === "reconciliationKey"
      const isNullLiteral = (expression) => expression.type === "Literal" && expression.value === null
      const returnedExpressions = (expression) => {
        if (expression.type === "ArrowFunctionExpression" && expression.body.type !== "BlockStatement") {
          return [expression.body]
        }
        if (
          (expression.type === "ArrowFunctionExpression" ||
            expression.type === "FunctionExpression" ||
            expression.type === "FunctionDeclaration") &&
          expression.body.type === "BlockStatement"
        ) {
          const returns = []
          const collectReturns = (node) => {
            if (node.type === "ReturnStatement") {
              if (node.argument !== null) returns.push(node.argument)
              return
            }
            if (
              node !== expression.body &&
              (node.type === "ArrowFunctionExpression" ||
                node.type === "FunctionExpression" ||
                node.type === "FunctionDeclaration")
            ) {
              return
            }
            for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
              const child = node[key]
              if (Array.isArray(child)) {
                for (const entry of child) {
                  if (entry !== null) collectReturns(entry)
                }
              } else if (child !== null && child !== undefined) {
                collectReturns(child)
              }
            }
          }
          collectReturns(expression.body)
          return returns
        }
        return null
      }
      const isTemplateLiteralParserSchema = (expression, visited = new Set()) => {
        const unwrapped = unwrapTypeExpression(expression)
        if (visited.has(unwrapped)) return false
        visited.add(unwrapped)
        if (unwrapped.type === "Identifier") {
          const definition = localDefinitions.get(unwrapped.name)
          return definition !== undefined && isTemplateLiteralParserSchema(definition, visited)
        }
        return (
          unwrapped.type === "CallExpression" &&
          unwrapped.callee.type === "MemberExpression" &&
          staticPropertyName(unwrapped.callee.property) === "TemplateLiteralParser" &&
          isSchemaModule(context, unwrapped.callee.object)
        )
      }
      const containsStructuredLocator = (expression, visited = new Set()) => {
        if (expression === null || expression === undefined || visited.has(expression)) return false
        visited.add(expression)
        const returned = returnedExpressions(expression)
        if (returned !== null) {
          return returned.some((candidate) => containsStructuredLocator(candidate, new Set(visited)))
        }
        if (expression.type === "TemplateLiteral") {
          return expression.quasis.some((quasi) => quasi.value.raw.includes(":"))
        }
        if (expression.type === "Literal") {
          return Predicate.isString(expression.value) && expression.value.includes(":")
        }
        if (expression.type === "BinaryExpression" && expression.operator === "+") {
          return (
            containsStructuredLocator(expression.left, visited) || containsStructuredLocator(expression.right, visited)
          )
        }
        if (expression.type === "Identifier") {
          return containsStructuredLocator(localDefinitions.get(expression.name), visited)
        }
        if (expression.type === "CallExpression") {
          if (
            expression.callee.type === "CallExpression" &&
            expression.callee.callee.type === "MemberExpression" &&
            isSchemaModule(context, expression.callee.callee.object) &&
            ["encode", "encodeSync"].includes(staticPropertyName(expression.callee.callee.property))
          ) {
            const schema = expression.callee.arguments[0]
            if (schema !== undefined && schema.type !== "SpreadElement" && isTemplateLiteralParserSchema(schema)) {
              return false
            }
          }
          if (
            expression.callee.type === "Identifier" &&
            containsStructuredLocator(localDefinitions.get(expression.callee.name), visited)
          ) {
            return true
          }
          return expression.arguments.some(
            (argument) => argument.type !== "SpreadElement" && containsStructuredLocator(argument, visited)
          )
        }
        return false
      }

      return {
        FunctionDeclaration(node) {
          if (node.id !== null) localDefinitions.set(node.id.name, node)
        },
        VariableDeclarator(node) {
          if (node.id.type === "Identifier" && node.init !== null) {
            localDefinitions.set(node.id.name, node.init)
          }
        },
        CallExpression(node) {
          if (
            node.callee.type !== "MemberExpression" ||
            staticPropertyName(node.callee.property) !== "make" ||
            node.callee.object.type !== "Identifier" ||
            !isReconciliationKeyImport(node.callee.object) ||
            node.arguments.length !== 1
          ) {
            return
          }
          const argument = node.arguments[0]
          if (argument.type !== "SpreadElement") {
            structuredKeyConstructors.push({ argument, node })
          }
        },
        BinaryExpression(node) {
          if (
            ["==", "===", "!=", "!=="].includes(node.operator) &&
            ((isRequestReconciliationKey(node.left) && !isNullLiteral(node.right)) ||
              (isRequestReconciliationKey(node.right) && !isNullLiteral(node.left)))
          ) {
            comparesRequestKey = true
          }
        },
        "Program:exit"() {
          if (!comparesRequestKey) return
          for (const { argument, node } of structuredKeyConstructors) {
            if (containsStructuredLocator(argument)) {
              context.report({ node, messageId: "rawStructuredLocator" })
            }
          }
        }
      }
    }
  },
  "require-bounded-base64-schema": {
    meta: {
      type: "problem",
      docs: {
        description: "require a text-length bound before base64 schema filters decode input",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        unboundedDecode: "Apply Schema.isMaxLength before decoding base64 text inside a Schema.String filter."
      }
    },
    create(context) {
      const isSchemaCall = (call, method) =>
        call?.type === "CallExpression" &&
        call.callee.type === "MemberExpression" &&
        staticPropertyName(call.callee.property) === method &&
        isSchemaModule(context, call.callee.object)
      const isDecodeBase64Call = (call) => {
        if (call.callee.type === "Identifier") {
          return isNamedImportFrom(context, call.callee, ["effect/Encoding"], ["decodeBase64"])
        }
        return (
          call.callee.type === "MemberExpression" &&
          staticPropertyName(call.callee.property) === "decodeBase64" &&
          call.callee.object.type === "Identifier" &&
          isNamespaceImportFrom(context, call.callee.object, ["effect/Encoding"])
        )
      }
      const enclosingInlineFilter = (node) => {
        const callback = enclosingFunction(node)
        const makeFilter = callback?.parent
        if (
          callback === undefined ||
          makeFilter?.type !== "CallExpression" ||
          !makeFilter.arguments.includes(callback) ||
          !isSchemaCall(makeFilter, "makeFilter")
        ) {
          return undefined
        }
        return makeFilter
      }
      const attachedStringCheck = (filter) => {
        const check = filter.parent
        if (
          check?.type !== "CallExpression" ||
          !check.arguments.includes(filter) ||
          check.callee.type !== "MemberExpression" ||
          staticPropertyName(check.callee.property) !== "check" ||
          check.callee.object.type !== "MemberExpression" ||
          staticPropertyName(check.callee.object.property) !== "String" ||
          !isSchemaModule(context, check.callee.object.object)
        ) {
          return undefined
        }
        return check
      }

      return {
        CallExpression(node) {
          if (!isDecodeBase64Call(node)) return
          const filter = enclosingInlineFilter(node)
          if (filter === undefined) return
          const check = attachedStringCheck(filter)
          if (check === undefined) return
          const filterIndex = check.arguments.indexOf(filter)
          const hasPriorTextBound = check.arguments
            .slice(0, filterIndex)
            .some((argument) => argument.type !== "SpreadElement" && isSchemaCall(argument, "isMaxLength"))
          if (!hasPriorTextBound) context.report({ node, messageId: "unboundedDecode" })
        }
      }
    }
  },
  "require-jira-path-identifier-schema": {
    meta: {
      type: "problem",
      docs: {
        description: "require path-safe schemas for Jira identifiers used in provider URL paths",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        unsafePathIdentifier: "Use JiraProviderPathIdentifier for values passed to Jira provider path parameters."
      }
    },
    create(context) {
      const filename = context.filename.replaceAll("\\", "/")
      if (!filename.includes("/server/plugins/jira/")) return {}

      const requestPathFields = new Set(["linkedIssueId", "parentCommentId", "versionIds"])
      const providerPathMethods = new Set([
        "addIssueComment",
        "getChangelogs",
        "getComment",
        "getComments",
        "getIssue",
        "getIssueTransitions",
        "getProject",
        "getProjectVersion",
        "transitionIssue",
        "updateIssueDescription"
      ])
      const containsVendorImmutableId = (node) => {
        if (node.type === "MemberExpression" && staticPropertyName(node.property) === "vendorImmutableId") {
          return true
        }
        const visitorKeys = context.sourceCode.visitorKeys[node.type] ?? []
        return visitorKeys.some((key) => {
          const child = node[key]
          return Array.isArray(child)
            ? child.some((entry) => entry !== null && containsVendorImmutableId(entry))
            : child !== null && child !== undefined && containsVendorImmutableId(child)
        })
      }
      const nearestProperty = (node) => {
        let current = node.parent
        while (current !== undefined && current.type !== "Property" && current.type !== "VariableDeclarator") {
          current = current.parent
        }
        return current?.type === "Property" ? current : undefined
      }
      const enclosingVariableName = (node) => {
        let current = node.parent
        while (current !== undefined && current.type !== "VariableDeclarator") current = current.parent
        return current?.type === "VariableDeclarator" && current.id.type === "Identifier" ? current.id.name : undefined
      }

      return {
        CallExpression(node) {
          if (
            node.callee.type !== "MemberExpression" ||
            node.callee.object.type !== "Identifier" ||
            node.callee.object.name !== "provider" ||
            !providerPathMethods.has(staticPropertyName(node.callee.property)) ||
            !node.arguments.some((argument) => argument.type !== "SpreadElement" && containsVendorImmutableId(argument))
          ) {
            return
          }
          context.report({ messageId: "unsafePathIdentifier", node })
        },
        Identifier(node) {
          if (node.name !== "JiraProviderIdentity") return
          if (!filename.endsWith("/JiraGovernedActions.ts")) return
          const property = nearestProperty(node)
          if (property === undefined) return
          const propertyName = staticPropertyName(property.key)
          const isActionIssueId = propertyName === "id" && enclosingVariableName(node) === "JiraActionIssue"
          if (!isActionIssueId && !requestPathFields.has(propertyName)) return
          context.report({ messageId: "unsafePathIdentifier", node })
        }
      }
    }
  },
  "no-ad-hoc-workspace-entity-path": {
    meta: {
      type: "problem",
      docs: {
        description: "require the canonical workspace entity path helper in Control Center client source",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        adHocPath: "Build canonical workspace entity hrefs with workspaceEntityPath."
      }
    },
    create(context) {
      if (context.filename.replaceAll("\\", "/").endsWith("/client/workspaceEntityPaths.ts")) return {}
      return {
        TemplateLiteral(node) {
          if (!node.quasis.some((quasi) => quasi.value.raw.includes("/items/"))) return
          if (!node.expressions.some((expression) => containsEntityIdLikeIdentifier(context.sourceCode, expression))) {
            return
          }
          context.report({ messageId: "adHocPath", node })
        }
      }
    }
  },
  "require-isolated-agent-child-environment": {
    meta: {
      type: "problem",
      docs: {
        description: "require local agent child processes to use the reviewed environment projection",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        commonJsLoaderForbidden:
          "Do not load CommonJS module constructors in agent source; use static audited imports instead.",
        rawProcessForbidden:
          "Do not access the raw Node process in agent source; use Effect runtime services and reviewed configuration.",
        unsafeEnvironment:
          "Pass a direct options object with env: options.environment and extendEnv: false; do not spread or inherit child environment options."
      }
    },
    create(context) {
      const approvedBindings = []
      const seam = commandSeamFor(context)
      const report = (node, messageId = "unsafeEnvironment") => context.report({ node, messageId })

      return {
        ImportDeclaration(node) {
          if (PROCESS_MODULES.has(node.source.value)) {
            for (const specifier of node.specifiers) {
              if (node.importKind !== "type" && specifier.importKind !== "type") {
                report(specifier, "rawProcessForbidden")
              }
            }
            return
          }
          if (COMMONJS_LOADER_MODULES.has(node.source.value)) {
            for (const specifier of node.specifiers) {
              if (isSensitiveCommonJsSpecifier(node, specifier)) report(specifier, "commonJsLoaderForbidden")
            }
            return
          }
          if (node.source.value !== CHILD_PROCESS_MODULE && node.source.value !== CHILD_PROCESS_BARREL) return
          const variables = context.sourceCode.getDeclaredVariables(node)
          for (const specifier of node.specifiers) {
            if (!isSensitiveChildProcessSpecifier(node, specifier)) continue
            if (!isApprovedChildProcessSpecifier(node, specifier, seam)) {
              report(specifier)
              continue
            }
            const binding = variables.find((variable) => variable.name === specifier.local.name)
            if (binding !== undefined) approvedBindings.push(binding)
          }
        },
        ExportAllDeclaration(node) {
          if (node.exportKind === "type") return
          if (PROCESS_MODULES.has(node.source.value)) return report(node, "rawProcessForbidden")
          if (COMMONJS_LOADER_MODULES.has(node.source.value)) return report(node, "commonJsLoaderForbidden")
          if (node.source.value === CHILD_PROCESS_MODULE || node.source.value === CHILD_PROCESS_BARREL) report(node)
        },
        ExportNamedDeclaration(node) {
          if (PROCESS_MODULES.has(node.source?.value)) {
            if (node.specifiers.some((specifier) => !isTypeOnlyExport(node, specifier))) {
              return report(node, "rawProcessForbidden")
            }
          }
          if (isSensitiveCommonJsExport(node)) return report(node, "commonJsLoaderForbidden")
          if (isSensitiveChildProcessExport(node)) report(node)
        },
        ImportExpression(node) {
          const source = staticImportExpressionSource(node.source)
          if (source === undefined) return report(node)
          if (PROCESS_MODULES.has(source)) return report(node, "rawProcessForbidden")
          if (COMMONJS_LOADER_MODULES.has(source)) return report(node, "commonJsLoaderForbidden")
          if (source === CHILD_PROCESS_MODULE || source === CHILD_PROCESS_BARREL) report(node)
        },
        "Program:exit"(node) {
          for (const binding of approvedBindings) {
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const call = directChildProcessMakeCall(reference.identifier)
              if (call === undefined) {
                report(reference.identifier)
                continue
              }
              if (!hasIsolatedChildEnvironment(context, call.arguments.at(-1), call)) report(call)
            }
          }
          for (const reference of context.sourceCode.getScope(node).through) {
            if (reference.identifier.name === "process" && (!reference.isTypeReference || reference.isValueReference)) {
              report(reference.identifier, "rawProcessForbidden")
            }
          }
        }
      }
    }
  },
  "require-explicit-child-process-env-inheritance": {
    meta: {
      type: "problem",
      docs: {
        description: "require ChildProcess.make options that set env to also declare extendEnv explicitly",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        implicitInheritance:
          "Declare extendEnv explicitly next to env. It defaults to falsy, so env alone replaces the child environment and drops PATH; use extendEnv: true to augment, or extendEnv: false with an env that carries PATH itself."
      }
    },
    create(context) {
      // Namespace or `ChildProcess`-object bindings, used as `ChildProcess.make(...)`.
      const moduleBindings = []
      // Barrel namespace bindings, used as `Process.ChildProcess.make(...)`.
      const barrelBindings = []
      // `make` imported directly from the module, possibly aliased, and called
      // bare. Resolving the binding is what separates this from every unrelated
      // function named `make`, which is why ast-grep cannot own this case.
      const makeBindings = []

      const checkCall = (call, knownOptionArguments) => {
        const argument = call.arguments.at(-1)
        const options = resolvedChildProcessOptions(context, argument, 0, knownOptionArguments)
        if (options === undefined) return
        const resolved = effectiveChildProcessOptions(context, argument, 0, knownOptionArguments)
        if (resolved === undefined) return
        // `env: undefined` leaves `options.env` unset, so Effect inherits normally
        // and nothing is dropped; only a really-set `env` needs `extendEnv` stated.
        const setsEnv = resolved.get("env") === false
        const statesExtendEnv = resolved.get("extendEnv") === false
        if (setsEnv && !statesExtendEnv) {
          context.report({ node: options, messageId: "implicitInheritance" })
        }
      }

      /**
       * Follows `const` aliases of an already-known binding, so
       * `const Local = ChildProcess` and `const { make } = ChildProcess` are
       * tracked as the module object and as `make` respectively.
       *
       * Only immutable `const` declarations are followed, and only in this
       * declarative form. A reassignable alias, a call result, or a computed
       * destructuring key stays unresolved — the same conservative direction as
       * the options resolver, since a false report is worse than a missed one.
       */
      const followAliases = () => {
        for (let round = 0; round < CHILD_PROCESS_ALIAS_ROUNDS; round += 1) {
          let discovered = false
          for (const binding of [...moduleBindings, ...barrelBindings]) {
            const isBarrel = barrelBindings.includes(binding)
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const aliased = aliasedChildProcessBindings(context, reference.identifier, isBarrel)
              for (const found of aliased.moduleBindings) {
                if (!moduleBindings.includes(found)) {
                  moduleBindings.push(found)
                  discovered = true
                }
              }
              for (const found of aliased.makeBindings) {
                if (!makeBindings.includes(found)) {
                  makeBindings.push(found)
                  discovered = true
                }
              }
            }
          }
          for (const binding of [...makeBindings]) {
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const alias = aliasedMakeBinding(context, reference.identifier)
              if (alias !== undefined && !makeBindings.includes(alias)) {
                makeBindings.push(alias)
                discovered = true
              }
            }
          }
          if (!discovered) return
        }
      }

      return {
        ImportDeclaration(node) {
          if (node.source.value !== CHILD_PROCESS_MODULE && node.source.value !== CHILD_PROCESS_BARREL) return
          const variables = context.sourceCode.getDeclaredVariables(node)
          for (const specifier of node.specifiers) {
            if (!isSensitiveChildProcessSpecifier(node, specifier)) continue
            const binding = variables.find((variable) => variable.name === specifier.local.name)
            if (binding === undefined) continue
            const importsMakeDirectly =
              node.source.value === CHILD_PROCESS_MODULE &&
              specifier.type === "ImportSpecifier" &&
              staticPropertyName(specifier.imported) === "make"
            const importsBarrelNamespace =
              node.source.value === CHILD_PROCESS_BARREL && specifier.type === "ImportNamespaceSpecifier"
            if (importsMakeDirectly) {
              makeBindings.push(binding)
            } else if (importsBarrelNamespace) {
              barrelBindings.push(binding)
            } else {
              moduleBindings.push(binding)
            }
          }
        },
        "Program:exit"() {
          followAliases()
          const calls = []
          for (const binding of moduleBindings) {
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const call = directChildProcessMakeCall(reference.identifier)
              if (call !== undefined) calls.push(call)
            }
          }
          for (const binding of barrelBindings) {
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const call = barrelChildProcessMakeCall(reference.identifier)
              if (call !== undefined) calls.push(call)
            }
          }
          for (const binding of makeBindings) {
            for (const reference of binding.references) {
              if (reference.isTypeReference && !reference.isValueReference) continue
              const call = reference.identifier.parent
              if (call?.type === "CallExpression" && call.callee === reference.identifier) calls.push(call)
            }
          }
          // Collected before checking so that one options binding shared by several
          // recognised calls stays resolvable: each call would otherwise read the
          // others' arguments as unknown escapes and all of them would fall silent.
          const knownOptionArguments = new Set(calls.map((call) => call.arguments.at(-1)))
          for (const call of calls) checkCall(call, knownOptionArguments)
        }
      }
    }
  },
  "no-conditional-only-result-tag-assertion": {
    meta: {
      type: "problem",
      docs: {
        description: "require tests to assert the expected tagged Result failure before narrowing its fields",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        conditionalOnly:
          "Assert that {{result}}.failure._tag is {{tag}} before conditionally checking tag-specific fields."
      }
    },
    create(context) {
      return {
        IfStatement(node) {
          const expected = conditionalFailureTag(context, node.test)
          if (
            expected === undefined ||
            !containsAssertion(context, node.consequent) ||
            hasDominatingTagAssertion(context, node, expected)
          ) {
            return
          }
          context.report({
            data: { result: expected.result, tag: JSON.stringify(expected.tag) },
            messageId: "conditionalOnly",
            node: node.test
          })
        }
      }
    }
  },
  "no-stable-service-yield-in-http-handler": {
    meta: {
      type: "problem",
      docs: {
        description: "bind stable Effect services once at the HttpApiBuilder group boundary",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        nestedStableService:
          "Bind {{service}} at the HttpApiBuilder group boundary; request handlers should yield only request-scoped services."
      }
    },
    create(context) {
      return {
        YieldExpression(node) {
          if (node.argument === null) return
          const reference = importReference(context, node.argument) ?? optionalServiceReference(context, node.argument)
          if (reference === undefined || isAllowedHttpHandlerRequestService(reference)) return
          if (!context.sourceCode.getAncestors(node).some(isHttpHandleCallback)) return
          context.report({
            data: { service: reference.importedName ?? context.sourceCode.getText(node.argument) },
            messageId: "nestedStableService",
            node
          })
        }
      }
    }
  },
  "no-silent-run-promise-rejection": {
    meta: {
      type: "problem",
      docs: {
        description: "require Effect.runPromise rejection handlers to surface unexpected failures",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        silentRejection: "Inspect Effect.runPromise failures instead of silently discarding the rejection."
      }
    },
    create(context) {
      return {
        CallExpression(node) {
          if (node.callee.type !== "MemberExpression" || !isRunPromiseCall(context, node.callee.object)) return
          const method = staticPropertyName(node.callee.property)
          const rejectionHandler =
            method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined
          if (!isSilentRejectionHandler(rejectionHandler)) return
          context.report({ node: rejectionHandler, messageId: "silentRejection" })
        }
      }
    }
  },
  "require-exact-cause-rethrow": {
    meta: {
      type: "problem",
      docs: {
        description: "preserve every defect and interruption reason when catchCause owns only typed failures",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        missingExactRethrow:
          "{{module}}.catchCause must rethrow every defect and interruption reason on every recovery path."
      }
    },
    create(context) {
      return {
        CallExpression(node) {
          const kind = catchCauseKind(context, node)
          if (kind === undefined) return
          const handlerArgument = node.arguments.length === 1 ? node.arguments[0] : node.arguments[1]
          if (handlerArgument?.type === "SpreadElement") return
          const handler = resolveFunction(context, handlerArgument)
          if (handler !== undefined && handlerPreservesNonFailCause(context, handler, kind)) return
          context.report({
            data: { module: kind },
            messageId: "missingExactRethrow",
            node
          })
        }
      }
    }
  },
  "no-unowned-detached-fiber": {
    meta: {
      type: "problem",
      docs: {
        description: "require Effect fibers to remain attached to an application, layer, or service scope",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        detachedFiber:
          "Effect.forkDetach attaches to the global scope; use Effect.forkScoped or Effect.forkIn with the owning scope."
      }
    },
    create(context) {
      const report = (node) => context.report({ node, messageId: "detachedFiber" })
      return {
        CallExpression(node) {
          if (isEffectFunction(context, node.callee, "forkDetach")) report(node)
        },
        MemberExpression(node) {
          if (node.parent?.type === "CallExpression" && node.parent.callee === node) return
          if (isEffectFunction(context, node, "forkDetach")) report(node)
        },
        Identifier(node) {
          if (
            node.parent?.type === "ImportSpecifier" ||
            isObjectPatternBindingIdentifier(node) ||
            (node.parent?.type === "CallExpression" && node.parent.callee === node)
          ) {
            return
          }
          if (isEffectFunction(context, node, "forkDetach")) report(node)
        }
      }
    }
  },
  "no-ignore-cause-in-codecommit-refresh": {
    meta: {
      type: "problem",
      docs: {
        description: "keep CodeCommit refresh defects and interruption observable",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        ignoredCause:
          "Do not use Effect.ignoreCause in refresh lifecycle code; recover typed failures or explicitly supervise non-interrupt causes."
      }
    },
    create(context) {
      const report = (node) => context.report({ node, messageId: "ignoredCause" })
      return {
        CallExpression(node) {
          if (!isEffectFunction(context, node.callee, "ignoreCause")) return
          report(node)
        },
        MemberExpression(node) {
          if (node.parent?.type === "CallExpression" && node.parent.callee === node) {
            return
          }
          if (isEffectFunction(context, node, "ignoreCause")) report(node)
        },
        Identifier(node) {
          if (
            node.parent?.type === "ImportSpecifier" ||
            (node.parent?.type === "CallExpression" && node.parent.callee === node)
          ) {
            return
          }
          if (isEffectFunction(context, node, "ignoreCause")) report(node)
        }
      }
    }
  },
  "no-throwing-json-parse-in-effect-map": {
    meta: {
      type: "problem",
      docs: {
        description: "keep raw JSON parsing out of Effect.map callbacks",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        throwingParse:
          "JSON.parse can throw inside Effect.map; decode through Schema.fromJsonString or Effect.try instead."
      }
    },
    create(context) {
      const inspectCallback = (callback) => {
        const visit = (node) => {
          if (node !== callback && isFunctionNode(node)) return
          if (node.type === "CallExpression" && isGlobalJsonParseCall(context, node)) {
            context.report({ node, messageId: "throwingParse" })
            return
          }
          const visitorKeys = context.sourceCode.visitorKeys[node.type] ?? []
          for (const key of visitorKeys) {
            const child = node[key]
            if (Array.isArray(child)) {
              for (const entry of child) {
                if (entry !== null) visit(entry)
              }
            } else if (child !== null && child !== undefined) {
              visit(child)
            }
          }
        }
        visit(callback)
      }
      return {
        CallExpression(node) {
          if (!isEffectFunction(context, node.callee, "map")) return
          const callbackArgument = node.arguments.length === 1 ? node.arguments[0] : node.arguments[1]
          if (callbackArgument?.type === "SpreadElement") return
          const callback = resolveFunction(context, callbackArgument)
          if (callback !== undefined) inspectCallback(callback)
        }
      }
    }
  },
  "require-rly-visual-classifier-runtime-error-reporting": {
    meta: {
      type: "problem",
      docs: {
        description: "keep NodeRuntime defect reporting enabled for the Rly visual classifier",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        disabledReporting:
          "Leave NodeRuntime error reporting enabled; expected classifier failures are already recovered to fail-closed JSON."
      }
    },
    create(context) {
      return {
        CallExpression(node) {
          if (!isNodeRunMainCall(context, node)) return
          const isCurriedOptions = node.parent?.type === "CallExpression" && node.parent.callee === node
          const options = isCurriedOptions ? node.arguments[0] : node.arguments[1]
          if (
            node.arguments.some((argument) => argument.type === "SpreadElement") ||
            !keepsRuntimeErrorReporting(options)
          ) {
            context.report({ node, messageId: "disabledReporting" })
          }
        }
      }
    }
  },
  "no-manual-control-center-client-poll-loop": {
    meta: {
      type: "problem",
      docs: {
        description: "require Schedule-based repetition for periodic Control Center client work",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        manualPoll: "Use Effect.repeat with a Schedule for periodic client polling."
      }
    },
    create(context) {
      return {
        WhileStatement(node) {
          if (!isInsideEffectGen(context, node) || !containsEffectSleep(context, node.body)) return
          context.report({ node, messageId: "manualPoll" })
        }
      }
    }
  },
  "no-throwing-schema-decode-in-control-center-client": {
    meta: {
      type: "problem",
      docs: {
        description: "keep client-controlled Schema decode failures out of the defect channel",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        throwingDecode: "Decode client-controlled values with Schema Effect, Result, or Option APIs."
      }
    },
    create(context) {
      const forbidden = ["decodeSync", "decodeUnknownSync"]
      const report = (node) => context.report({ node, messageId: "throwingDecode" })
      return {
        ImportDeclaration(node) {
          if (node.source.value !== "effect/Schema" || node.importKind === "type") return
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type" &&
              forbidden.includes(staticPropertyName(specifier.imported))
            ) {
              report(specifier)
            }
          }
        },
        ExportNamedDeclaration(node) {
          if (node.source?.value !== "effect/Schema" || node.exportKind === "type") return
          for (const specifier of node.specifiers) {
            if (specifier.exportKind !== "type" && forbidden.includes(staticPropertyName(specifier.local))) {
              report(specifier)
            }
          }
        },
        MemberExpression(node) {
          if (forbidden.includes(staticPropertyName(node.property)) && isSchemaModule(context, node.object)) {
            report(node)
          }
        },
        VariableDeclarator(node) {
          if (node.id.type !== "ObjectPattern" || node.init === null || !isSchemaModule(context, node.init)) return
          for (const property of node.id.properties) {
            if (property.type === "Property" && forbidden.includes(staticPropertyName(property.key))) {
              report(property)
            }
          }
        }
      }
    }
  },
  "require-run-promise-signal-in-react-effect": {
    meta: {
      type: "problem",
      docs: {
        description: "require React effects to interrupt Effect.runPromise work during cleanup",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        missingSignal:
          "Pass a local AbortController signal to Effect.runPromise and abort that same controller from cleanup."
      }
    },
    create(context) {
      return {
        CallExpression(node) {
          if (!isRunPromiseCall(context, node)) return
          const effectCallback = reactUseEffectCallback(context, node)
          if (effectCallback === undefined) return
          const controller = runPromiseAbortController(context, node)
          if (
            controller !== undefined &&
            isLocalAbortController(context, controller, effectCallback) &&
            cleanupFunctionsAfterCall(context, effectCallback, node).some((cleanup) =>
              cleanupAbortsController(context, cleanup, controller)
            )
          ) {
            return
          }
          context.report({ node, messageId: "missingSignal" })
        }
      }
    }
  },
  "no-number-from-string-in-control-center-api": {
    meta: {
      type: "problem",
      docs: {
        description: "require canonical number wire schemas in Control Center public API contracts",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        unsafeWireNumber: "Use a canonical wire-number schema instead of Schema.NumberFromString."
      }
    },
    create(context) {
      const report = (node) => context.report({ node, messageId: "unsafeWireNumber" })
      return {
        ImportDeclaration(node) {
          if (node.source.value !== "effect/Schema" || node.importKind === "type") return
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type" &&
              staticPropertyName(specifier.imported) === "NumberFromString"
            ) {
              report(specifier)
            }
          }
        },
        ExportNamedDeclaration(node) {
          if (node.source?.value !== "effect/Schema" || node.exportKind === "type") return
          for (const specifier of node.specifiers) {
            if (specifier.exportKind !== "type" && staticPropertyName(specifier.local) === "NumberFromString") {
              report(specifier)
            }
          }
        },
        MemberExpression(node) {
          if (staticPropertyName(node.property) !== "NumberFromString") return
          if (isSchemaModule(context, node.object)) report(node)
        },
        VariableDeclarator(node) {
          if (node.id.type !== "ObjectPattern" || node.init === null || !isSchemaModule(context, node.init)) return
          for (const property of node.id.properties) {
            if (property.type === "Property" && staticPropertyName(property.key) === "NumberFromString") {
              report(property)
            }
          }
        }
      }
    }
  },
  "no-direct-mutation-proof-read": {
    meta: {
      type: "problem",
      docs: {
        description: "centralize Control Center mutation-proof reads in the authenticated client helper",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        directRead: "Read cc_csrf through makeAuthenticatedMutationClient instead of accessing sessionStorage."
      }
    },
    create(context) {
      if (context.filename.replaceAll("\\", "/").endsWith("/client/authenticatedMutationClient.ts")) return {}

      const isUnshadowedGlobal = (identifier) =>
        identifier.type === "Identifier" && (resolvedVariable(context, identifier)?.defs.length ?? 0) === 0

      const isSessionStorage = (expression, visited = new Set()) => {
        const candidate = unwrapTypeExpression(expression)
        if (candidate.type === "Identifier") {
          if (candidate.name === "sessionStorage" && isUnshadowedGlobal(candidate)) return true
          const variable = resolvedVariable(context, candidate)
          if (variable === undefined || visited.has(variable)) return false
          visited.add(variable)
          const definition = variable.defs.find(
            (entry) => entry.type === "Variable" && entry.node.type === "VariableDeclarator" && entry.node.init !== null
          )
          return definition === undefined ? false : isSessionStorage(definition.node.init, visited)
        }
        return (
          candidate.type === "MemberExpression" &&
          !candidate.computed &&
          candidate.object.type === "Identifier" &&
          candidate.object.name === "window" &&
          isUnshadowedGlobal(candidate.object) &&
          staticPropertyName(candidate.property) === "sessionStorage"
        )
      }

      return {
        CallExpression(node) {
          if (
            node.callee.type !== "MemberExpression" ||
            staticPropertyName(node.callee.property) !== "getItem" ||
            node.arguments.length === 0 ||
            node.arguments[0].type === "SpreadElement" ||
            node.arguments[0].type !== "Literal" ||
            node.arguments[0].value !== "cc_csrf" ||
            !isSessionStorage(node.callee.object)
          ) {
            return
          }
          context.report({ node, messageId: "directRead" })
        }
      }
    }
  },
  "require-playwright-clock-before-navigation": {
    meta: {
      type: "problem",
      docs: {
        description: "install Playwright's controllable clock before navigating the page under test",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        awaitClockInstall: "Await {{page}}.clock.install() directly before navigating {{page}}.",
        lateClock: "Call {{page}}.clock.install() before this test's first {{page}}.goto()."
      }
    },
    create(context) {
      const calls = []
      const clockPage = (node, methods) => {
        if (
          node.callee.type !== "MemberExpression" ||
          !methods.includes(staticPropertyName(node.callee.property)) ||
          node.callee.object.type !== "MemberExpression" ||
          staticPropertyName(node.callee.object.property) !== "clock" ||
          node.callee.object.object.type !== "Identifier"
        ) {
          return undefined
        }
        return node.callee.object.object
      }
      const navigationPage = (node) =>
        node.callee.type === "MemberExpression" &&
        staticPropertyName(node.callee.property) === "goto" &&
        node.callee.object.type === "Identifier"
          ? node.callee.object
          : undefined
      const samePage = (left, right) =>
        left.name === right.name && resolvedVariable(context, left) === resolvedVariable(context, right)

      return {
        CallExpression(node) {
          calls.push(node)
        },
        "Program:exit"() {
          const checked = new Map()
          for (const clockCall of calls) {
            const page = clockPage(clockCall, ["fastForward", "install", "pauseAt", "runFor"])
            if (page === undefined) continue
            const owner = enclosingFunction(clockCall)
            const binding = resolvedVariable(context, page)
            const ownerChecks = checked.get(owner) ?? new Set()
            if (ownerChecks.has(binding)) continue
            ownerChecks.add(binding)
            checked.set(owner, ownerChecks)
            const navigations = calls.filter((candidate) => {
              const candidatePage = navigationPage(candidate)
              return (
                candidatePage !== undefined && enclosingFunction(candidate) === owner && samePage(page, candidatePage)
              )
            })
            if (navigations.length === 0) continue
            const firstNavigation = Math.min(...navigations.map((candidate) => candidate.range?.[0] ?? 0))
            const installs = calls.filter((candidate) => {
              const candidatePage = clockPage(candidate, ["install"])
              return (
                candidatePage !== undefined && enclosingFunction(candidate) === owner && samePage(page, candidatePage)
              )
            })
            const installsBeforeNavigation = installs.filter(
              (candidate) => (candidate.range?.[0] ?? 0) < firstNavigation
            )
            const awaitedInstallsBeforeNavigation = installsBeforeNavigation.filter(
              (candidate) => candidate.parent?.type === "AwaitExpression" && candidate.parent.argument === candidate
            )
            const unawaitedInstallsBeforeNavigation = installsBeforeNavigation.filter(
              (candidate) => !awaitedInstallsBeforeNavigation.includes(candidate)
            )
            for (const unawaitedInstall of unawaitedInstallsBeforeNavigation) {
              context.report({
                data: { page: page.name },
                messageId: "awaitClockInstall",
                node: unawaitedInstall
              })
            }
            if (awaitedInstallsBeforeNavigation.length === 0 && unawaitedInstallsBeforeNavigation.length === 0) {
              context.report({
                data: { page: page.name },
                messageId: "lateClock",
                node: installs[0] ?? clockCall
              })
            }
          }
        }
      }
    }
  },
  "no-unsafe-optional-host-global-read": {
    meta: {
      type: "problem",
      docs: {
        description: "require optional browser globals to be read inside an exception guard",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        unsafeRead:
          "{{name}} is an optional host global; evaluating it as a predicate argument can throw before the predicate runs. Read it inside a try block and branch on the returned local value."
      }
    },
    create(context) {
      const optionalHostGlobals = new Set(["Notification", "window"])
      const optionalityPredicates = new Set(["isNotUndefined", "isNullOrUndefined", "isUndefined"])
      const isUnshadowedHostGlobal = (identifier) => {
        const variable = resolvedVariable(context, identifier)
        return optionalHostGlobals.has(identifier.name) && (variable === undefined || variable.defs.length === 0)
      }
      const isInsideTryBlock = (node) => {
        let current = node
        while (current.parent !== undefined && current.parent !== null) {
          if (current.parent.type === "TryStatement" && current.parent.block === current) return true
          current = current.parent
        }
        return false
      }
      const predicateMethod = (callee) => {
        if (callee.type === "Identifier") {
          const definition = importedBinding(context, callee)
          return definition?.node.type === "ImportSpecifier" &&
            importSource(definition) === "effect/Predicate" &&
            optionalityPredicates.has(staticPropertyName(definition.node.imported))
            ? staticPropertyName(definition.node.imported)
            : undefined
        }
        if (
          callee.type !== "MemberExpression" ||
          callee.object.type !== "Identifier" ||
          !optionalityPredicates.has(staticPropertyName(callee.property))
        ) {
          return undefined
        }
        return isNamespaceImportFrom(context, callee.object, ["effect/Predicate"]) ||
          isNamedImportFrom(context, callee.object, ["effect"], ["Predicate"])
          ? staticPropertyName(callee.property)
          : undefined
      }

      return {
        CallExpression(node) {
          if (predicateMethod(node.callee) === undefined || isInsideTryBlock(node)) return
          for (const argument of node.arguments) {
            if (argument.type !== "Identifier" || !isUnshadowedHostGlobal(argument)) continue
            context.report({ data: { name: argument.name }, messageId: "unsafeRead", node: argument })
          }
        }
      }
    }
  },
  "no-playwright-evaluate-closure-captures": {
    meta: {
      type: "problem",
      docs: {
        description: "disallow Node-realm lexical captures in Playwright browser callbacks",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        capturedBinding:
          "Playwright serializes this callback into the browser realm, where captured binding {{name}} is unavailable. Use browser globals, callback locals, or an explicitly serialized argument."
      }
    },
    create(context) {
      const evaluateMethods = new Set(["$eval", "$$eval", "evaluate", "evaluateAll", "evaluateHandle"])
      const callbackArgument = (node) => {
        if (
          node.callee.type !== "MemberExpression" ||
          !evaluateMethods.has(staticPropertyName(node.callee.property)) ||
          node.arguments.length === 0 ||
          node.arguments[0].type === "SpreadElement"
        ) {
          return undefined
        }
        return node.arguments[0]
      }
      const isInlineFunction = (node) => node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression"
      const bindingIsDeclaredInside = (variable, callback) =>
        variable.identifiers.some(
          (identifier) =>
            (identifier.range?.[0] ?? -1) >= (callback.range?.[0] ?? 0) &&
            (identifier.range?.[1] ?? Number.POSITIVE_INFINITY) <= (callback.range?.[1] ?? 0)
        )
      const isAmbientBrowserBinding = (variable) =>
        variable.defs.length > 0 && variable.defs.every((definition) => definition.parent?.declare === true)

      return {
        CallExpression(node) {
          const callback = callbackArgument(node)
          if (callback === undefined || callback.type === "Literal" || callback.type === "TemplateLiteral") return
          if (!isInlineFunction(callback)) return
          const callbackScope =
            context.sourceCode.scopeManager.acquire(callback, true) ?? context.sourceCode.scopeManager.acquire(callback)
          if (callbackScope === null) return
          const reported = new Set()
          for (const reference of callbackScope.through) {
            if (isPureTypeReference(reference)) continue
            const variable = resolvedVariable(context, reference.identifier)
            if (
              variable === undefined ||
              variable.defs.length === 0 ||
              variable.scope.type === "global" ||
              context.sourceCode.scopeManager.globalScope?.set.get(reference.identifier.name) === variable ||
              isAmbientBrowserBinding(variable) ||
              bindingIsDeclaredInside(variable, callback) ||
              reported.has(variable)
            ) {
              continue
            }
            reported.add(variable)
            context.report({
              data: { name: reference.identifier.name },
              messageId: "capturedBinding",
              node: reference.identifier
            })
          }
        }
      }
    }
  },
  "no-echoing-secret-assertions": {
    meta: {
      type: "problem",
      docs: {
        description: "prevent live-integration assertions from echoing sensitive operands",
        category: "Security",
        recommended: false
      },
      schema: [],
      messages: {
        echoingAssertion:
          "Do not pass sensitive operands to an echoing assertion; compare booleans with a constant message or use the redaction helper."
      }
    },
    create(context) {
      const immutableConstInitializer = (identifier) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined || variable.defs.length !== 1) return undefined
        const definition = variable.defs[0]
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.id.type !== "Identifier" ||
          definition.node.init === null ||
          definition.parent?.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const"
        ) {
          return undefined
        }
        return {
          definition,
          initializer: unwrapTypeExpression(definition.node.init),
          variable
        }
      }
      const immutableConstString = (identifier, visitedVariables = new Set()) => {
        const binding = immutableConstInitializer(identifier)
        if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
        visitedVariables.add(binding.variable)
        const initializer = binding.initializer
        const value =
          initializer.type === "Identifier"
            ? immutableConstString(initializer, visitedVariables)
            : initializer.type === "Literal" || initializer.type === "TemplateLiteral"
              ? staticPropertyName(initializer)
              : undefined
        visitedVariables.delete(binding.variable)
        return value
      }
      const immutableConstNumber = (expression, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (node.type === "Literal" && Predicate.isNumber(node.value)) return node.value
        if (node.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
          const argument = immutableConstNumber(node.argument, visitedVariables)
          return argument === undefined ? undefined : node.operator === "-" ? -argument : argument
        }
        if (node.type === "BinaryExpression" && ["%", "*", "**", "+", "-", "/"].includes(node.operator)) {
          const left = immutableConstNumber(node.left, visitedVariables)
          const right = immutableConstNumber(node.right, visitedVariables)
          if (left === undefined || right === undefined) return undefined
          switch (node.operator) {
            case "%":
              return left % right
            case "*":
              return left * right
            case "**":
              return left ** right
            case "+":
              return left + right
            case "-":
              return left - right
            case "/":
              return left / right
          }
        }
        if (node.type === "Identifier" && node.name === "Infinity" && isUnshadowedGlobal(node, "Infinity")) {
          return Number.POSITIVE_INFINITY
        }
        if (node.type === "Identifier" && node.name === "NaN" && isUnshadowedGlobal(node, "NaN")) {
          return Number.NaN
        }
        if (node.type !== "Identifier") return undefined
        const binding = immutableConstInitializer(node)
        if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
        visitedVariables.add(binding.variable)
        const value = immutableConstNumber(binding.initializer, visitedVariables)
        visitedVariables.delete(binding.variable)
        return value
      }
      const memberPropertyName = (node) => {
        const property = unwrapTypeExpression(node.property)
        if (!node.computed) return staticPropertyName(property)
        if (property.type === "Identifier") return immutableConstString(property)
        if (
          property.type === "Literal" &&
          Predicate.isNumber(property.value) &&
          Number.isSafeInteger(property.value) &&
          property.value >= 0
        ) {
          return String(property.value)
        }
        return staticPropertyName(property)
      }
      const isDirectProviderImmutableId = (node) =>
        node?.type === "MemberExpression" && memberPropertyName(node) === "providerImmutableId"
      const credentialEmailFields = new Set(["confluenceEmail", "jiraEmail"])
      const credentialApiKeyFields = new Set(["confluenceApiKey", "jiraApiKey"])
      const fixtureLocatorFields = new Set([
        "atlassianSiteId",
        "atlassianSiteUrl",
        "awsRegion",
        "codeCommitRepository",
        "codePipelinePipeline",
        "confluenceProbePageId",
        "confluenceSpaceId",
        "jiraProjectId"
      ])
      const hasLiveConfigurationType = (identifier) => {
        const annotation = identifier.typeAnnotation?.typeAnnotation
        return (
          annotation?.type === "TSTypeReference" &&
          annotation.typeName.type === "Identifier" &&
          isNamedImportBindingFrom(
            context,
            annotation.typeName,
            ["./liveConnectionConfiguration.js"],
            ["LiveConnectionConfiguration"]
          )
        )
      }
      const isLiveConfigurationBinding = (identifier) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined) return identifier.name === "configuration"
        if (variable.defs.length !== 1) return false
        const definition = variable.defs[0]
        if (definition.name?.type === "Identifier" && hasLiveConfigurationType(definition.name)) return true
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.init === null
        ) {
          return false
        }
        const initializer = unwrapTypeExpression(definition.node.init)
        return (
          initializer.type === "YieldExpression" &&
          initializer.delegate &&
          initializer.argument?.type === "Identifier" &&
          isNamedImportFrom(
            context,
            initializer.argument,
            ["./liveConnectionConfiguration.js"],
            ["loadLiveConnectionConfiguration"]
          )
        )
      }
      const isConfigurationObject = (node, visitedVariables = new Set()) => {
        node = unwrapTypeExpression(node)
        if (node.type === "MemberExpression") {
          const projection = memberProjection(node)
          return (
            projection.state === "found" &&
            projection.values.some((value) => isConfigurationObject(value, visitedVariables))
          )
        }
        if (node.type !== "Identifier") return false
        if (isLiveConfigurationBinding(node)) return true
        const binding = immutableConstInitializer(node)
        if (
          binding === undefined ||
          binding.initializer.type !== "Identifier" ||
          visitedVariables.has(binding.variable)
        ) {
          return false
        }
        visitedVariables.add(binding.variable)
        const isConfiguration = isConfigurationObject(binding.initializer, visitedVariables)
        visitedVariables.delete(binding.variable)
        return isConfiguration
      }
      const isConfigurationField = (node, fields) =>
        node?.type === "MemberExpression" && isConfigurationObject(node.object) && fields.has(memberPropertyName(node))
      const destructuredConfigurationField = (identifier) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined || variable.defs.length !== 1) return undefined
        const definition = variable.defs[0]
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.id.type !== "ObjectPattern" ||
          definition.node.init === null ||
          definition.parent?.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const" ||
          !isConfigurationObject(unwrapTypeExpression(definition.node.init))
        ) {
          return undefined
        }
        const property = definition.node.id.properties.find(
          (candidate) =>
            candidate.type === "Property" &&
            !candidate.computed &&
            candidate.value.type === "Identifier" &&
            candidate.value === definition.name
        )
        return property === undefined ? undefined : staticPropertyName(property.key)
      }
      const isConfigurationValue = (node, fields, visitedVariables = new Set()) => {
        if (isConfigurationField(node, fields)) return true
        if (node?.type !== "Identifier") return false
        const destructuredField = destructuredConfigurationField(node)
        if (destructuredField !== undefined) return fields.has(destructuredField)
        const binding = immutableConstInitializer(node)
        if (binding === undefined || visitedVariables.has(binding.variable)) return false
        visitedVariables.add(binding.variable)
        const isValue = isConfigurationValue(binding.initializer, fields, visitedVariables)
        visitedVariables.delete(binding.variable)
        return isValue
      }
      const isCredentialEmail = (node) => isConfigurationValue(node, credentialEmailFields)
      const isFixtureLocator = (node) => isConfigurationValue(node, fixtureLocatorFields)
      const isRedactedNamespace = (identifier, visitedVariables = new Set()) => {
        if (isNamespaceImportFrom(context, identifier, ["effect/Redacted"])) return true
        const variable = resolvedVariable(context, identifier)
        const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined
        if (
          definition?.type === "Variable" &&
          definition.node.type === "VariableDeclarator" &&
          definition.node.id.type === "ObjectPattern" &&
          definition.node.init !== null &&
          definition.parent?.type === "VariableDeclaration" &&
          definition.parent.kind === "const" &&
          definition.name?.type === "Identifier"
        ) {
          const route = destructuringRoute(definition.node.id, definition.name)
          const source = identityExpressionIdentifier(definition.node.init)
          if (
            route?.excludedProperties !== undefined &&
            !route.excludedProperties.has("value") &&
            source !== undefined &&
            isRedactedNamespace(source, visitedVariables)
          ) {
            return true
          }
        }
        const binding = immutableConstInitializer(identifier)
        if (binding === undefined || visitedVariables.has(binding.variable)) return false
        visitedVariables.add(binding.variable)
        const initializer = unwrapTypeExpression(binding.initializer)
        const expressionRetainsValue = (expression) => {
          const node = unwrapTypeExpression(frozenArgument(context, unwrapTypeExpression(expression)) ?? expression)
          if (node.type === "Identifier") return isRedactedNamespace(node, visitedVariables)
          if (node.type === "ObjectExpression") {
            for (let index = node.properties.length - 1; index >= 0; index -= 1) {
              const property = node.properties[index]
              if (property.type === "SpreadElement") {
                if (expressionRetainsValue(property.argument)) return true
                continue
              }
              const key = unwrapTypeExpression(property.key)
              const propertyName = property.computed
                ? key.type === "Identifier"
                  ? immutableConstString(key)
                  : staticPropertyName(key)
                : staticPropertyName(key)
              if (propertyName === undefined) return false
              if (propertyName === "value") {
                const value = unwrapTypeExpression(property.value)
                return (
                  (value.type === "Identifier" && isRedactedValueFunction(value, visitedVariables)) ||
                  (value.type === "MemberExpression" &&
                    memberPropertyName(value) === "value" &&
                    unwrapTypeExpression(value.object).type === "Identifier" &&
                    isRedactedNamespace(unwrapTypeExpression(value.object), visitedVariables))
                )
              }
            }
            return false
          }
          if (
            node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            memberPropertyName(node.callee) === "assign" &&
            unwrapTypeExpression(node.callee.object).type === "Identifier" &&
            isUnshadowedGlobal(unwrapTypeExpression(node.callee.object), "Object")
          ) {
            const arguments_ = expandedAssignSources(node.arguments, node)
            for (let index = arguments_.length - 1; index >= 0; index -= 1) {
              const argument = arguments_[index]
              if (!argument.certain || argument.alternatives.length !== 1) return false
              const candidate = argument.alternatives[0]
              if (expressionRetainsValue(candidate)) return true
              const candidateNode = unwrapTypeExpression(candidate)
              if (candidateNode.type === "ObjectExpression") {
                const hasValueOverride = candidateNode.properties.some((property) => {
                  if (property.type === "SpreadElement") return false
                  const key = unwrapTypeExpression(property.key)
                  return (
                    (property.computed && key.type === "Identifier"
                      ? immutableConstString(key)
                      : staticPropertyName(key)) === "value"
                  )
                })
                if (hasValueOverride) return false
              }
            }
          }
          return false
        }
        const isNamespace = expressionRetainsValue(initializer)
        visitedVariables.delete(binding.variable)
        return isNamespace
      }
      const isUnshadowedGlobal = (identifier, name) => {
        if (identifier.type !== "Identifier" || identifier.name !== name) return false
        const variable = resolvedVariable(context, identifier)
        return variable === undefined || variable.defs.length === 0
      }
      const isRedactedValueFunction = (identifier, visitedVariables = new Set()) => {
        if (isNamedImportFrom(context, identifier, ["effect/Redacted"], ["value"])) return true
        const variable = resolvedVariable(context, identifier)
        const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined
        if (
          definition?.type === "Variable" &&
          definition.node.type === "VariableDeclarator" &&
          definition.node.id.type === "ObjectPattern" &&
          definition.node.init !== null &&
          definition.parent?.type === "VariableDeclaration" &&
          definition.parent.kind === "const" &&
          definition.name?.type === "Identifier"
        ) {
          const route = destructuringRoute(definition.node.id, definition.name)
          const source = identityExpressionIdentifier(definition.node.init)
          if (
            route?.path.length === 1 &&
            route.path[0] === "value" &&
            source !== undefined &&
            isRedactedNamespace(source, visitedVariables)
          ) {
            return true
          }
        }
        const binding = immutableConstInitializer(identifier)
        if (binding === undefined || visitedVariables.has(binding.variable)) {
          return false
        }
        visitedVariables.add(binding.variable)
        const initializer = unwrapTypeExpression(binding.initializer)
        const isValueFunction =
          (initializer.type === "Identifier" && isRedactedValueFunction(initializer, visitedVariables)) ||
          (initializer.type === "MemberExpression" &&
            memberPropertyName(initializer) === "value" &&
            unwrapTypeExpression(initializer.object).type === "Identifier" &&
            isRedactedNamespace(unwrapTypeExpression(initializer.object)))
        visitedVariables.delete(binding.variable)
        return isValueFunction
      }
      const isRawCredentialApiKey = (node) => {
        if (node?.type !== "CallExpression") return false
        const argumentCandidates = expandedCallArgumentCandidates(node.arguments, node)
        if (
          argumentCandidates?.length !== 1 ||
          !argumentCandidates[0].some((argument) => isConfigurationValue(argument, credentialApiKeyFields))
        ) {
          return false
        }
        return (
          (node.callee.type === "MemberExpression" &&
            memberPropertyName(node.callee) === "value" &&
            node.callee.object.type === "Identifier" &&
            isRedactedNamespace(node.callee.object)) ||
          (identityExpressionIdentifier(node.callee) !== undefined &&
            isRedactedValueFunction(identityExpressionIdentifier(node.callee)))
        )
      }
      const immutableArrayRoot = (identifier, visitedVariables = new Set()) => {
        const binding = immutableConstInitializer(identifier)
        if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
        if (binding.initializer.type === "ArrayExpression") return binding
        if (binding.initializer.type !== "Identifier") return undefined
        visitedVariables.add(binding.variable)
        const arrayBinding = immutableArrayRoot(binding.initializer, visitedVariables)
        visitedVariables.delete(binding.variable)
        return arrayBinding
      }
      const outerIdentityExpression = (identifier) => {
        let expression = identifier
        let parent = expression.parent
        while (
          (parent?.type === "TSAsExpression" ||
            parent?.type === "TSTypeAssertion" ||
            parent?.type === "TSSatisfiesExpression" ||
            parent?.type === "TSNonNullExpression") &&
          parent.expression === expression
        ) {
          expression = parent
          parent = expression.parent
        }
        return expression
      }
      const identityExpressionIdentifier = (expression) => {
        let current = expression
        while (
          current.type === "TSAsExpression" ||
          current.type === "TSTypeAssertion" ||
          current.type === "TSSatisfiesExpression" ||
          current.type === "TSNonNullExpression"
        ) {
          current = current.expression
        }
        return current.type === "Identifier" ? current : undefined
      }
      const assertionMemberCallee = (callee) => {
        const unwrappedCallee = unwrapTypeExpression(callee)
        if (unwrappedCallee.type !== "MemberExpression") return undefined
        const object = unwrapTypeExpression(unwrappedCallee.object)
        return object.type === "Identifier" && isNamedImportFrom(context, object, ["@effect/vitest"], ["assert"])
          ? unwrappedCallee
          : undefined
      }
      const immutableIdentityAliasIdentifier = (referenceIdentifier) => {
        const expression = outerIdentityExpression(referenceIdentifier)
        const parent = expression.parent
        return parent?.type === "VariableDeclarator" &&
          parent.init === expression &&
          parent.id.type === "Identifier" &&
          parent.parent?.type === "VariableDeclaration" &&
          parent.parent.kind === "const"
          ? parent.id
          : undefined
      }
      const isAssertionSpreadReference = (identifier) => {
        const expression = outerIdentityExpression(identifier)
        const spread = expression.parent
        const call = spread?.parent
        return (
          spread?.type === "SpreadElement" &&
          spread.argument === expression &&
          call?.type === "CallExpression" &&
          call.arguments.includes(spread) &&
          assertionMemberCallee(call.callee) !== undefined
        )
      }
      const isProvablyAfter = (candidate, boundary, owner = undefined) => {
        if (boundary === undefined) return false
        let current = boundary
        while (current !== undefined && current !== null) {
          if (
            current.type === "ForStatement" ||
            current.type === "ForInStatement" ||
            current.type === "ForOfStatement" ||
            current.type === "WhileStatement" ||
            current.type === "DoWhileStatement"
          ) {
            return false
          }
          if (
            current.type === "ArrowFunctionExpression" ||
            current.type === "FunctionExpression" ||
            current.type === "FunctionDeclaration"
          ) {
            const expression = outerIdentityExpression(current)
            if (
              enclosingFunction(owner) !== current &&
              (current.type === "FunctionDeclaration" ||
                current.id !== null ||
                expression.parent?.type !== "CallExpression" ||
                expression.parent.callee !== expression)
            ) {
              return false
            }
          }
          current = current.parent
        }
        const candidateAncestors = []
        current = candidate
        while (current.parent !== undefined && current.parent !== null) {
          const parent = current.parent
          if ((parent.type === "Program" || parent.type === "BlockStatement") && parent.body.includes(current)) {
            candidateAncestors.push({ container: parent, statement: current })
          }
          current = parent
        }
        current = boundary
        while (current.parent !== undefined && current.parent !== null) {
          const parent = current.parent
          if ((parent.type === "Program" || parent.type === "BlockStatement") && parent.body.includes(current)) {
            const candidateAncestor = candidateAncestors.find((entry) => entry.container === parent)
            if (candidateAncestor !== undefined) {
              return candidateAncestor.statement.range[0] > current.range[0]
            }
          }
          current = parent
        }
        return false
      }
      const isMutuallyExclusiveWith = (candidate, boundary, owner) => {
        if (enclosingFunction(owner) !== enclosingFunction(boundary)) return false
        let candidateAncestor = candidate
        while (candidateAncestor.parent !== undefined && candidateAncestor.parent !== null) {
          const parent = candidateAncestor.parent
          if (parent.type === "IfStatement") {
            let boundaryAncestor = boundary
            while (
              boundaryAncestor.parent !== undefined &&
              boundaryAncestor.parent !== null &&
              boundaryAncestor.parent !== parent
            ) {
              boundaryAncestor = boundaryAncestor.parent
            }
            if (
              boundaryAncestor.parent === parent &&
              ((candidateAncestor === parent.consequent && boundaryAncestor === parent.alternate) ||
                (candidateAncestor === parent.alternate && boundaryAncestor === parent.consequent))
            ) {
              return true
            }
          }
          if (parent.type === "ConditionalExpression") {
            let boundaryAncestor = boundary
            while (
              boundaryAncestor.parent !== undefined &&
              boundaryAncestor.parent !== null &&
              boundaryAncestor.parent !== parent
            ) {
              boundaryAncestor = boundaryAncestor.parent
            }
            if (
              boundaryAncestor.parent === parent &&
              ((candidateAncestor === parent.consequent && boundaryAncestor === parent.alternate) ||
                (candidateAncestor === parent.alternate && boundaryAncestor === parent.consequent))
            ) {
              return true
            }
          }
          if (parent.type === "SwitchCase") {
            let boundaryAncestor = boundary
            while (
              boundaryAncestor.parent !== undefined &&
              boundaryAncestor.parent !== null &&
              boundaryAncestor.parent.type !== "SwitchCase"
            ) {
              boundaryAncestor = boundaryAncestor.parent
            }
            const boundaryCase = boundaryAncestor.parent?.type === "SwitchCase" ? boundaryAncestor.parent : undefined
            if (boundaryCase !== undefined && boundaryCase !== parent) {
              const cases = parent.parent.cases
              const candidateIndex = cases.indexOf(parent)
              const boundaryIndex = cases.indexOf(boundaryCase)
              if (candidateIndex > boundaryIndex) return true
              if (candidateIndex >= 0 && boundaryIndex >= 0) {
                const cannotFallThrough = cases.slice(candidateIndex, boundaryIndex).some((switchCase) => {
                  const lastStatement = switchCase.consequent.at(-1)
                  return (
                    lastStatement?.type === "BreakStatement" ||
                    lastStatement?.type === "ReturnStatement" ||
                    lastStatement?.type === "ThrowStatement"
                  )
                })
                if (cannotFallThrough) return true
              }
            }
          }
          candidateAncestor = parent
        }
        return false
      }
      const isUnconditionalMutation = (candidate, boundary) => {
        let controlAncestor = candidate
        while (controlAncestor.parent !== undefined && controlAncestor.parent !== null) {
          const parent = controlAncestor.parent
          if (
            parent.type === "IfStatement" ||
            parent.type === "ConditionalExpression" ||
            parent.type === "LogicalExpression" ||
            parent.type === "SwitchCase" ||
            parent.type === "TryStatement" ||
            parent.type === "ForStatement" ||
            parent.type === "ForInStatement" ||
            parent.type === "ForOfStatement" ||
            parent.type === "WhileStatement" ||
            parent.type === "DoWhileStatement"
          ) {
            return false
          }
          if (
            (parent.type === "Program" || parent.type === "BlockStatement") &&
            parent.body.includes(controlAncestor)
          ) {
            break
          }
          controlAncestor = parent
        }
        const candidateStatement = (() => {
          let current = candidate
          while (current.parent !== undefined && current.parent !== null) {
            const parent = current.parent
            if ((parent.type === "Program" || parent.type === "BlockStatement") && parent.body.includes(current)) {
              return { container: parent, statement: current }
            }
            current = parent
          }
          return undefined
        })()
        const boundaryStatement = (() => {
          let current = boundary
          while (current.parent !== undefined && current.parent !== null) {
            const parent = current.parent
            if ((parent.type === "Program" || parent.type === "BlockStatement") && parent.body.includes(current)) {
              return { container: parent, statement: current }
            }
            current = parent
          }
          return undefined
        })()
        return (
          candidateStatement !== undefined &&
          boundaryStatement !== undefined &&
          candidateStatement.container === boundaryStatement.container &&
          candidateStatement.statement.range[0] < boundaryStatement.statement.range[0]
        )
      }
      const arrayMutationValues = (referenceIdentifier, boundary, owner) => {
        const expression = outerIdentityExpression(referenceIdentifier)
        const member = expression.parent
        if (member?.type !== "MemberExpression" || member.object !== expression) return []
        const memberExpression = outerIdentityExpression(member)
        const usage = memberExpression.parent
        if (
          usage !== undefined &&
          (isProvablyAfter(usage, boundary, owner) || isMutuallyExclusiveWith(usage, boundary, owner))
        ) {
          return []
        }
        if (usage?.type === "AssignmentExpression" && usage.left === member) {
          return [usage.right]
        }
        if (usage?.type !== "CallExpression" || usage.callee !== memberExpression) return []
        switch (memberPropertyName(member)) {
          case "fill":
            return usage.arguments.slice(0, 1)
          case "push":
          case "unshift":
            return usage.arguments
          case "splice":
            return usage.arguments.filter((argument, index) => argument.type === "SpreadElement" || index >= 2)
          default:
            return []
        }
      }
      const immutableConstArray = (identifier, boundary) => {
        const root = immutableArrayRoot(identifier)
        if (root === undefined) return undefined
        const pending = [root]
        const graphVariables = new Set()
        const mutationValues = []
        while (pending.length > 0) {
          const binding = pending.pop()
          if (binding === undefined || graphVariables.has(binding.variable)) continue
          graphVariables.add(binding.variable)
          for (const reference of binding.variable.references) {
            if (isPureTypeReference(reference)) continue
            const referenceIdentifier = reference.identifier
            if (
              referenceIdentifier.parent === binding.definition.node &&
              binding.definition.node.id === referenceIdentifier
            ) {
              continue
            }
            if (!reference.isWrite() && isAssertionSpreadReference(referenceIdentifier)) continue
            mutationValues.push(...arrayMutationValues(referenceIdentifier, boundary, root.definition.node))
            if (reference.isWrite()) continue
            const aliasIdentifier = immutableIdentityAliasIdentifier(referenceIdentifier)
            if (aliasIdentifier === undefined) continue
            const alias = immutableConstInitializer(aliasIdentifier)
            if (
              alias === undefined ||
              alias.initializer.type !== "Identifier" ||
              resolvedVariable(context, alias.initializer) !== binding.variable
            ) {
              continue
            }
            pending.push(alias)
          }
        }
        return { graphVariables, mutationValues, root }
      }
      const immutableIdentityRoot = (identifier, visitedVariables = new Set()) => {
        const binding = immutableConstInitializer(identifier)
        if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
        if (binding.initializer.type !== "Identifier") return binding
        visitedVariables.add(binding.variable)
        const root = immutableIdentityRoot(binding.initializer, visitedVariables)
        visitedVariables.delete(binding.variable)
        return root
      }
      const objectMemberMutation = (referenceIdentifier, boundary, owner) => {
        let expression = outerIdentityExpression(referenceIdentifier)
        const path = []
        while (true) {
          const member = expression.parent
          if (member?.type !== "MemberExpression" || member.object !== expression) break
          path.push(memberPropertyName(member))
          expression = outerIdentityExpression(member)
        }
        const usage = expression.parent
        return usage?.type === "AssignmentExpression" &&
          usage.left === expression &&
          !isProvablyAfter(usage, boundary, owner) &&
          !isMutuallyExclusiveWith(usage, boundary, owner)
          ? {
              definitive: usage.operator === "=" && isUnconditionalMutation(usage, boundary),
              node: usage,
              operator: usage.operator,
              path,
              value: usage.right
            }
          : undefined
      }
      const expandedAssignSources = (arguments_, boundary) => {
        const sources = []
        for (const argument of arguments_) {
          if (argument.type !== "SpreadElement") {
            sources.push({ alternatives: [argument], certain: true })
            continue
          }
          const spreadCandidates = staticArrayCandidates(argument.argument, boundary)
          if (spreadCandidates === undefined) {
            sources.push({ alternatives: [], certain: false })
            continue
          }
          for (const alternatives of spreadCandidates) {
            sources.push({ alternatives, certain: alternatives.length === 1 })
          }
        }
        return sources
      }
      const objectMutationEvents = (root, boundary) => {
        const pending = [{ binding: root, prefix: [] }]
        const graphVariables = new Set()
        const events = []
        while (pending.length > 0) {
          const pendingEntry = pending.pop()
          if (pendingEntry === undefined) continue
          const { binding, prefix } = pendingEntry
          if (graphVariables.has(binding.variable)) continue
          graphVariables.add(binding.variable)
          for (const reference of binding.variable.references) {
            if (isPureTypeReference(reference) || reference.isWrite()) continue
            const referenceIdentifier = reference.identifier
            const aliasIdentifier = immutableIdentityAliasIdentifier(referenceIdentifier)
            if (aliasIdentifier !== undefined) {
              const alias = immutableConstInitializer(aliasIdentifier)
              if (
                alias !== undefined &&
                alias.initializer.type === "Identifier" &&
                resolvedVariable(context, alias.initializer) === binding.variable
              ) {
                pending.push({ binding: alias, prefix })
                continue
              }
            }
            const spreadAssignCalls = (() => {
              let current = outerIdentityExpression(referenceIdentifier)
              while (
                current.parent !== undefined &&
                current.parent !== null &&
                current.parent.type !== "ArrayExpression" &&
                current.parent.type !== "VariableDeclarator"
              ) {
                current = current.parent
              }
              const array =
                current.parent?.type === "ArrayExpression"
                  ? current.parent
                  : current.type === "ArrayExpression"
                    ? current
                    : undefined
              if (array === undefined) return []
              const calls = []
              const collectSpreadCall = (arrayExpression) => {
                const wrappedArray = outerIdentityExpression(arrayExpression)
                const spread = wrappedArray.parent
                const call = spread?.parent
                if (
                  spread?.type === "SpreadElement" &&
                  spread.argument === wrappedArray &&
                  call?.type === "CallExpression" &&
                  call.callee.type === "MemberExpression" &&
                  memberPropertyName(call.callee) === "assign" &&
                  unwrapTypeExpression(call.callee.object).type === "Identifier" &&
                  isUnshadowedGlobal(unwrapTypeExpression(call.callee.object), "Object")
                ) {
                  calls.push(call)
                }
              }
              collectSpreadCall(array)
              const arrayExpression = outerIdentityExpression(array)
              const declarator = arrayExpression.parent
              if (
                declarator?.type === "VariableDeclarator" &&
                declarator.init === arrayExpression &&
                declarator.id.type === "Identifier" &&
                declarator.parent?.type === "VariableDeclaration" &&
                declarator.parent.kind === "const"
              ) {
                const arrayVariable = resolvedVariable(context, declarator.id)
                for (const reference of arrayVariable?.references ?? []) {
                  collectSpreadCall(outerIdentityExpression(reference.identifier))
                }
              }
              return calls
            })()
            let handledSpreadAssign = false
            for (const assignCall of spreadAssignCalls) {
              if (
                isProvablyAfter(assignCall, boundary, root.definition.node) ||
                isMutuallyExclusiveWith(assignCall, boundary, root.definition.node)
              ) {
                continue
              }
              const assignArguments = expandedAssignSources(assignCall.arguments, assignCall)
              const target = assignArguments[0]
              const trackedTargetPath = target?.certain
                ? target.alternatives.flatMap((alternative) => {
                    let node = unwrapTypeExpression(alternative)
                    const path = []
                    while (node.type === "MemberExpression") {
                      path.unshift(memberPropertyName(node))
                      node = unwrapTypeExpression(node.object)
                    }
                    return node.type === "Identifier" && resolvedVariable(context, node) === binding.variable
                      ? [path]
                      : []
                  })[0]
                : undefined
              if (trackedTargetPath === undefined) continue
              handledSpreadAssign = true
              for (const source of assignArguments.slice(1)) {
                for (const alternative of source.alternatives) {
                  events.push({
                    definitive: source.certain && isUnconditionalMutation(assignCall, boundary),
                    kind: "assignSource",
                    node: assignCall,
                    operator: "=",
                    path: [...prefix, ...trackedTargetPath],
                    value: alternative
                  })
                }
              }
            }
            if (handledSpreadAssign) continue
            let assignedTarget = outerIdentityExpression(referenceIdentifier)
            const assignedPath = []
            while (
              assignedTarget.parent?.type === "MemberExpression" &&
              assignedTarget.parent.object === assignedTarget
            ) {
              assignedPath.push(memberPropertyName(assignedTarget.parent))
              assignedTarget = outerIdentityExpression(assignedTarget.parent)
            }
            const assignCall = assignedTarget.parent
            if (
              assignCall?.type === "CallExpression" &&
              assignCall.arguments[0] === assignedTarget &&
              assignCall.callee.type === "MemberExpression" &&
              memberPropertyName(assignCall.callee) === "assign" &&
              unwrapTypeExpression(assignCall.callee.object).type === "Identifier" &&
              isUnshadowedGlobal(unwrapTypeExpression(assignCall.callee.object), "Object") &&
              !isProvablyAfter(assignCall, boundary, root.definition.node) &&
              !isMutuallyExclusiveWith(assignCall, boundary, root.definition.node)
            ) {
              for (const source of expandedAssignSources(assignCall.arguments.slice(1), assignCall)) {
                for (const alternative of source.alternatives) {
                  events.push({
                    definitive: source.certain && isUnconditionalMutation(assignCall, boundary),
                    kind: "assignSource",
                    node: assignCall,
                    operator: "=",
                    path: [...prefix, ...assignedPath],
                    value: alternative
                  })
                }
              }
              continue
            }
            let projectedAliasExpression = outerIdentityExpression(referenceIdentifier)
            const projectedAliasPath = []
            while (
              projectedAliasExpression.parent?.type === "MemberExpression" &&
              projectedAliasExpression.parent.object === projectedAliasExpression
            ) {
              projectedAliasPath.push(memberPropertyName(projectedAliasExpression.parent))
              projectedAliasExpression = outerIdentityExpression(projectedAliasExpression.parent)
            }
            const projectedAliasDeclarator = projectedAliasExpression.parent
            if (
              projectedAliasPath.length > 0 &&
              projectedAliasDeclarator?.type === "VariableDeclarator" &&
              projectedAliasDeclarator.init === projectedAliasExpression &&
              projectedAliasDeclarator.id.type === "Identifier" &&
              projectedAliasDeclarator.parent?.type === "VariableDeclaration" &&
              projectedAliasDeclarator.parent.kind === "const"
            ) {
              const variable = resolvedVariable(context, projectedAliasDeclarator.id)
              const definition = variable?.defs[0]
              if (variable !== undefined && variable.defs.length === 1 && definition !== undefined) {
                pending.push({
                  binding: { definition, variable },
                  prefix: [...prefix, ...projectedAliasPath]
                })
                continue
              }
            }
            const expression = outerIdentityExpression(referenceIdentifier)
            const declarator = expression.parent
            if (
              declarator?.type === "VariableDeclarator" &&
              declarator.init === expression &&
              declarator.id.type !== "Identifier" &&
              declarator.parent?.type === "VariableDeclaration" &&
              declarator.parent.kind === "const"
            ) {
              const identifiers = []
              const collectIdentifiers = (node) => {
                if (node.type === "Identifier") {
                  identifiers.push(node)
                  return
                }
                for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
                  const child = node[key]
                  if (Array.isArray(child)) {
                    for (const entry of child) if (entry !== null) collectIdentifiers(entry)
                  } else if (child !== null && child !== undefined) {
                    collectIdentifiers(child)
                  }
                }
              }
              collectIdentifiers(declarator.id)
              for (const identifier of identifiers) {
                const route = destructuringRoute(declarator.id, identifier)
                const variable = resolvedVariable(context, identifier)
                const definition = variable?.defs[0]
                if (
                  route !== undefined &&
                  route.excludedProperties === undefined &&
                  variable !== undefined &&
                  variable.defs.length === 1 &&
                  definition !== undefined
                ) {
                  pending.push({
                    binding: { definition, variable },
                    prefix: [...prefix, ...route.path]
                  })
                }
              }
              continue
            }
            const event = objectMemberMutation(referenceIdentifier, boundary, root.definition.node)
            if (event !== undefined) events.push({ ...event, path: [...prefix, ...event.path] })
          }
        }
        return events.sort((left, right) => left.node.range[0] - right.node.range[0])
      }
      const arrayMutationEvent = (referenceIdentifier, boundary, owner) => {
        const expression = outerIdentityExpression(referenceIdentifier)
        const member = expression.parent
        if (member?.type !== "MemberExpression" || member.object !== expression) return undefined
        const memberExpression = outerIdentityExpression(member)
        const usage = memberExpression.parent
        if (
          usage === undefined ||
          isProvablyAfter(usage, boundary, owner) ||
          isMutuallyExclusiveWith(usage, boundary, owner)
        ) {
          return undefined
        }
        const propertyName = memberPropertyName(member)
        if (usage.type === "AssignmentExpression" && usage.left === memberExpression) {
          return {
            args: [usage.right],
            kind: "assign",
            node: usage,
            operator: usage.operator,
            definitive: usage.operator === "=" && isUnconditionalMutation(usage, boundary),
            propertyName
          }
        }
        return usage.type === "CallExpression" &&
          usage.callee === memberExpression &&
          ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"].includes(propertyName)
          ? {
              args: usage.arguments,
              definitive: isUnconditionalMutation(usage, boundary),
              kind: propertyName,
              node: usage
            }
          : undefined
      }
      const arrayMutationEvents = (root, boundary) => {
        const pending = [root]
        const graphVariables = new Set()
        const events = []
        while (pending.length > 0) {
          const binding = pending.pop()
          if (binding === undefined || graphVariables.has(binding.variable)) continue
          graphVariables.add(binding.variable)
          for (const reference of binding.variable.references) {
            if (isPureTypeReference(reference) || reference.isWrite()) continue
            const referenceIdentifier = reference.identifier
            const aliasIdentifier = immutableIdentityAliasIdentifier(referenceIdentifier)
            if (aliasIdentifier !== undefined) {
              const alias = immutableConstInitializer(aliasIdentifier)
              if (
                alias !== undefined &&
                alias.initializer.type === "Identifier" &&
                resolvedVariable(context, alias.initializer) === binding.variable
              ) {
                pending.push(alias)
                continue
              }
            }
            const event = arrayMutationEvent(referenceIdentifier, boundary, root.definition.node)
            if (event !== undefined) events.push(event)
          }
        }
        return events.sort((left, right) => left.node.range[0] - right.node.range[0])
      }
      const staticObjectEntries = (expression, boundary, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (node.type === "Identifier") {
          const root = immutableIdentityRoot(node)
          if (root === undefined || visitedVariables.has(root.variable)) return undefined
          visitedVariables.add(root.variable)
          const entries = staticObjectEntries(root.initializer, boundary, visitedVariables)
          if (entries !== undefined) {
            for (const event of objectMutationEvents(root, boundary)) {
              if (event.kind === "assignSource" && event.path.length === 0) {
                const sourceEntries = staticObjectEntries(event.value, event.node, visitedVariables)
                if (sourceEntries === undefined) {
                  entries.unknown.push(event.value)
                  continue
                }
                for (const [key, values] of sourceEntries.known) {
                  entries.known.set(key, event.definitive ? values : [...(entries.known.get(key) ?? []), ...values])
                }
                entries.unknown.push(...sourceEntries.unknown)
                continue
              }
              if (event.path.length !== 1 || event.path[0] === undefined) {
                entries.unknown.push(event.value)
                continue
              }
              const key = event.path[0]
              entries.known.set(
                key,
                event.definitive ? [event.value] : [...(entries.known.get(key) ?? []), event.value]
              )
            }
          }
          visitedVariables.delete(root.variable)
          return entries
        }
        if (node.type !== "ObjectExpression") return undefined
        const entries = { known: new Map(), unknown: [] }
        for (const property of node.properties) {
          if (property.type === "SpreadElement") {
            const spreadEntries = staticObjectEntries(property.argument, node, visitedVariables)
            if (spreadEntries === undefined) continue
            for (const [key, values] of spreadEntries.known) entries.known.set(key, values)
            entries.unknown.push(...spreadEntries.unknown)
            continue
          }
          const key = unwrapTypeExpression(property.key)
          const propertyName = property.computed
            ? key.type === "Identifier"
              ? immutableConstString(key)
              : key.type === "Literal" && Predicate.isNumber(key.value) && Number.isFinite(key.value)
                ? String(key.value)
                : staticPropertyName(key)
            : key.type === "Literal" && Predicate.isNumber(key.value) && Number.isFinite(key.value)
              ? String(key.value)
              : staticPropertyName(key)
          if (propertyName === undefined) entries.unknown.push(property.value)
          else entries.known.set(propertyName, [property.value])
        }
        return entries
      }
      const projectionAbsent = { state: "absent" }
      const projectionOpaque = { state: "opaque" }
      const projectionShadowed = { state: "shadowed" }
      const projectionFound = (...values) => ({ state: "found", values })
      const staticArrayCandidates = (expression, boundary, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (node.type === "Identifier") {
          const root = immutableArrayRoot(node)
          if (root === undefined || visitedVariables.has(root.variable)) return undefined
          visitedVariables.add(root.variable)
          const candidates = staticArrayCandidates(root.initializer, boundary, visitedVariables)
          if (candidates === undefined) {
            visitedVariables.delete(root.variable)
            return undefined
          }
          const expandedArguments = (args) => {
            const values = []
            for (const argument of args) {
              if (argument.type !== "SpreadElement") {
                values.push([argument])
                continue
              }
              const spreadValues = staticArrayCandidates(argument.argument, boundary, visitedVariables)
              if (spreadValues === undefined) return undefined
              values.push(...spreadValues)
            }
            return values
          }
          const normalizedIndex = (value, length, fallback) => {
            if (value === undefined) return fallback
            if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0
            if (value === Number.POSITIVE_INFINITY) return length
            const integer = Math.trunc(value)
            return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length)
          }
          for (const event of arrayMutationEvents(root, boundary)) {
            const priorCandidates = event.definitive ? undefined : candidates.map((values) => [...values])
            try {
              if (event.kind === "assign") {
                if (event.propertyName === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(event.propertyName)) {
                  continue
                }
                const index = Number(event.propertyName)
                const nextValues = event.args[0] === undefined ? [] : [event.args[0]]
                candidates[index] = event.definitive ? nextValues : [...(candidates[index] ?? []), ...nextValues]
                continue
              }
              if (event.kind === "fill") {
                const value = event.args[0]
                if (value === undefined || value.type === "SpreadElement") continue
                const startArgument = event.args[1]
                const endArgument = event.args[2]
                const resolvedStart = startArgument === undefined ? 0 : immutableConstNumber(startArgument)
                const resolvedEnd = endArgument === undefined ? candidates.length : immutableConstNumber(endArgument)
                if (resolvedStart === undefined || resolvedEnd === undefined) {
                  for (let index = 0; index < candidates.length; index += 1) {
                    candidates[index] = [...candidates[index], value]
                  }
                  continue
                }
                const start = normalizedIndex(resolvedStart, candidates.length, 0)
                const end = normalizedIndex(resolvedEnd, candidates.length, candidates.length)
                for (let index = start; index < end; index += 1) {
                  candidates[index] = event.definitive ? [value] : [...candidates[index], value]
                }
                continue
              }
              if (event.kind === "reverse") {
                candidates.reverse()
                continue
              }
              if (event.kind === "shift") {
                candidates.shift()
                continue
              }
              if (event.kind === "pop") {
                candidates.pop()
                continue
              }
              if (event.kind === "copyWithin") {
                const indexes = event.args
                  .slice(0, 3)
                  .map((argument) => (argument === undefined ? undefined : immutableConstNumber(argument)))
                if (indexes[0] === undefined || indexes[1] === undefined) {
                  const allCandidates = candidates.flat()
                  for (let index = 0; index < candidates.length; index += 1) {
                    candidates[index] = [...allCandidates]
                  }
                } else {
                  candidates.copyWithin(indexes[0], indexes[1], indexes[2])
                }
                continue
              }
              if (event.kind === "sort") {
                const allCandidates = candidates.flat()
                for (let index = 0; index < candidates.length; index += 1) {
                  candidates[index] = [...allCandidates]
                }
                continue
              }
              const inserted = expandedArguments(event.kind === "splice" ? event.args.slice(2) : event.args)
              if (inserted === undefined) continue
              if (event.kind === "push") candidates.push(...inserted)
              if (event.kind === "unshift") candidates.unshift(...inserted)
              if (event.kind === "splice") {
                const startArgument = event.args[0]
                const deleteArgument = event.args[1]
                const resolvedStart = startArgument === undefined ? 0 : immutableConstNumber(startArgument)
                const resolvedDelete =
                  deleteArgument === undefined ? candidates.length : immutableConstNumber(deleteArgument)
                if (resolvedStart === undefined || resolvedDelete === undefined) {
                  const insertedCandidates = inserted.flat()
                  const allReachable = [...candidates.flat(), ...insertedCandidates]
                  const possibleLength = Math.max(candidates.length + inserted.length, candidates.length, 1)
                  for (let index = 0; index < possibleLength; index += 1) {
                    candidates[index] = [...allReachable]
                  }
                  continue
                }
                const start = normalizedIndex(resolvedStart, candidates.length, 0)
                const deleteCount = Math.max(0, Math.min(Math.trunc(resolvedDelete), candidates.length - start))
                if (event.args.length === 0) continue
                candidates.splice(start, deleteCount, ...inserted)
              }
            } finally {
              if (priorCandidates !== undefined) {
                const length = Math.max(candidates.length, priorCandidates.length)
                for (let index = 0; index < length; index += 1) {
                  candidates[index] = [...(candidates[index] ?? []), ...(priorCandidates[index] ?? [])]
                }
              }
            }
          }
          visitedVariables.delete(root.variable)
          return candidates
        }
        if (node.type !== "ArrayExpression") return undefined
        const candidates = []
        for (const element of node.elements) {
          if (element === null) {
            candidates.push([])
          } else if (element.type === "SpreadElement") {
            const spreadValues = staticArrayCandidates(element.argument, node, visitedVariables)
            if (spreadValues === undefined) return undefined
            candidates.push(...spreadValues)
          } else {
            candidates.push([element])
          }
        }
        return candidates
      }
      const projectedPropertyValue = (value, remainingPath, visitedVariables, boundary) => {
        if (remainingPath.length === 0) return projectionFound(value)
        const projection = immutableObjectProjection(value, remainingPath, visitedVariables, boundary)
        return projection.state === "absent" ? projectionShadowed : projection
      }
      const immutableObjectProjection = (expression, path, visitedVariables = new Set(), boundary = undefined) => {
        const node = unwrapTypeExpression(frozenArgument(context, unwrapTypeExpression(expression)) ?? expression)
        if (path.length === 0) return projectionFound(node)
        const [selectedProperty, ...remainingPath] = path
        if (
          (selectedProperty === undefined || /^(?:0|[1-9][0-9]*)$/u.test(selectedProperty)) &&
          (node.type === "Identifier" || node.type === "ArrayExpression")
        ) {
          const arrayCandidates = staticArrayCandidates(node, boundary)
          if (arrayCandidates !== undefined) {
            const selectedCandidates =
              selectedProperty === undefined
                ? arrayCandidates.flat()
                : (arrayCandidates[Number(selectedProperty)] ?? [])
            const projectedCandidates = selectedCandidates.flatMap(
              (candidate) => projectedPropertyValue(candidate, remainingPath, visitedVariables, boundary).values ?? []
            )
            const sourceArray =
              node.type === "ArrayExpression"
                ? node
                : immutableArrayRoot(node)?.initializer.type === "ArrayExpression"
                  ? immutableArrayRoot(node).initializer
                  : undefined
            if (
              sourceArray !== undefined &&
              selectedProperty !== undefined &&
              /^(?:0|[1-9][0-9]*)$/u.test(selectedProperty) &&
              remainingPath.length > 0
            ) {
              const selectedIndex = Number(selectedProperty)
              let offset = 0
              for (const element of sourceArray.elements) {
                if (element?.type === "SpreadElement") {
                  const spreadCandidates = staticArrayCandidates(element.argument, sourceArray)
                  const spreadLength = spreadCandidates?.length
                  if (spreadLength !== undefined && selectedIndex >= offset && selectedIndex < offset + spreadLength) {
                    const sourceIdentifier = identityExpressionIdentifier(element.argument)
                    const sourceRoot =
                      sourceIdentifier === undefined ? undefined : immutableIdentityRoot(sourceIdentifier)
                    const sourcePath = [String(selectedIndex - offset), ...remainingPath]
                    if (sourceRoot !== undefined) {
                      for (const event of objectMutationEvents(sourceRoot, boundary)) {
                        if (
                          event.path.length <= 1 ||
                          event.path.some(
                            (propertyName, index) =>
                              propertyName !== undefined &&
                              index < sourcePath.length &&
                              propertyName !== sourcePath[index]
                          )
                        ) {
                          continue
                        }
                        const projection = projectedPropertyValue(
                          event.value,
                          sourcePath.slice(event.path.length),
                          visitedVariables,
                          boundary
                        )
                        projectedCandidates.push(...(projection.values ?? []))
                      }
                    }
                  }
                  offset += spreadLength ?? 0
                } else {
                  offset += 1
                }
              }
            }
            if (projectedCandidates.length > 0) return projectionFound(...projectedCandidates)
            return selectedProperty === undefined ? projectionOpaque : projectionShadowed
          }
        }
        if (selectedProperty === undefined && (node.type === "Identifier" || node.type === "ObjectExpression")) {
          const entries = staticObjectEntries(node, boundary)
          if (entries !== undefined) {
            const values = [...entries.known.values(), entries.unknown]
              .flat()
              .flatMap(
                (candidate) => projectedPropertyValue(candidate, remainingPath, visitedVariables, boundary).values ?? []
              )
            return values.length > 0 ? projectionFound(...values) : projectionOpaque
          }
        }
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          memberPropertyName(node.callee) === "assign" &&
          unwrapTypeExpression(node.callee.object).type === "Identifier" &&
          isUnshadowedGlobal(unwrapTypeExpression(node.callee.object), "Object")
        ) {
          const expandedArguments = expandedAssignSources(node.arguments, node)
          const targetEntry = expandedArguments[0]
          const target =
            targetEntry?.certain && targetEntry.alternatives.length === 1 ? targetEntry.alternatives[0] : undefined
          if (target !== undefined) {
            const targetNode = unwrapTypeExpression(target)
            if (targetNode.type === "Identifier") {
              const targetProjection = immutableObjectProjection(targetNode, path, visitedVariables, boundary)
              if (targetProjection.state !== "opaque") return targetProjection
            }
            if (targetNode.type === "MemberExpression") {
              const targetPath = []
              let targetMember = targetNode
              while (true) {
                targetPath.unshift(memberPropertyName(targetMember))
                const targetObject = unwrapTypeExpression(targetMember.object)
                if (targetObject.type !== "MemberExpression") {
                  const targetProjection = immutableObjectProjection(
                    targetObject,
                    [...targetPath, ...path],
                    visitedVariables,
                    boundary
                  )
                  if (targetProjection.state !== "opaque") return targetProjection
                  break
                }
                targetMember = targetObject
              }
            }
          }
          const projectCopiedSource = (argument) => {
            let projection = immutableObjectProjection(argument, path, visitedVariables, node)
            if (path.length > 1) {
              const sourceIdentifier = identityExpressionIdentifier(argument)
              const sourceRoot = sourceIdentifier === undefined ? undefined : immutableIdentityRoot(sourceIdentifier)
              if (sourceRoot !== undefined) {
                for (const event of objectMutationEvents(sourceRoot, boundary)) {
                  if (
                    event.path.length <= 1 ||
                    event.path.some(
                      (propertyName, pathIndex) =>
                        propertyName !== undefined && pathIndex < path.length && propertyName !== path[pathIndex]
                    )
                  ) {
                    continue
                  }
                  const assigned = projectedPropertyValue(
                    event.value,
                    path.slice(event.path.length),
                    visitedVariables,
                    boundary
                  )
                  projection = event.definitive
                    ? assigned
                    : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
                }
              }
              const copiedSlot = immutableObjectProjection(argument, [path[0]], visitedVariables, node)
              for (const copiedValue of copiedSlot.values ?? []) {
                const copiedIdentifier = identityExpressionIdentifier(copiedValue)
                const copiedRoot = copiedIdentifier === undefined ? undefined : immutableIdentityRoot(copiedIdentifier)
                if (copiedRoot === undefined) continue
                const descendantPath = path.slice(1)
                for (const event of objectMutationEvents(copiedRoot, boundary)) {
                  if (
                    event.path.some(
                      (propertyName, pathIndex) =>
                        propertyName !== undefined &&
                        pathIndex < descendantPath.length &&
                        propertyName !== descendantPath[pathIndex]
                    )
                  ) {
                    continue
                  }
                  const assigned = projectedPropertyValue(
                    event.value,
                    descendantPath.slice(event.path.length),
                    visitedVariables,
                    boundary
                  )
                  projection = event.definitive
                    ? assigned
                    : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
                }
              }
            }
            return projection
          }
          const possibleValues = []
          const sources = expandedArguments.slice(1)
          for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
            const source = sources[sourceIndex]
            const sourceValues = []
            let definitelyDefinesProperty = false
            for (const argument of source.alternatives) {
              const projection = projectCopiedSource(argument)
              if (projection.state === "found") sourceValues.push(...projection.values)
              const entries = selectedProperty === undefined ? undefined : staticObjectEntries(argument, node)
              if (source.certain && entries?.known.has(selectedProperty)) {
                definitelyDefinesProperty = true
              }
            }
            if (definitelyDefinesProperty) {
              return sourceValues.length === 0
                ? possibleValues.length === 0
                  ? projectionShadowed
                  : projectionFound(...possibleValues)
                : projectionFound(...possibleValues, ...sourceValues)
            }
            possibleValues.push(...sourceValues)
          }
          if (target !== undefined) {
            const targetProjection = immutableObjectProjection(target, path, visitedVariables, node)
            if (targetProjection.state === "found") {
              return projectionFound(...possibleValues, ...targetProjection.values)
            }
            if (targetProjection.state === "shadowed" && possibleValues.length === 0) return targetProjection
          }
          return possibleValues.length > 0 ? projectionFound(...possibleValues) : projectionOpaque
        }
        if (node.type === "Identifier") {
          const root = immutableIdentityRoot(node)
          if (root === undefined || visitedVariables.has(root.variable)) return projectionOpaque
          visitedVariables.add(root.variable)
          let projection = immutableObjectProjection(root.initializer, path, visitedVariables, boundary)
          for (const event of objectMutationEvents(root, boundary)) {
            const mismatchIndex = event.path.findIndex(
              (propertyName, index) => propertyName !== undefined && index < path.length && propertyName !== path[index]
            )
            if (mismatchIndex >= 0) continue
            const unknownIndex = event.path.findIndex((propertyName) => propertyName === undefined)
            const knownAncestor = unknownIndex < 0 && event.path.length <= path.length
            if (knownAncestor) {
              const remainingEventPath = path.slice(event.path.length)
              const assignedProjection =
                event.kind === "assignSource"
                  ? immutableObjectProjection(event.value, remainingEventPath, visitedVariables, event.node)
                  : projectedPropertyValue(event.value, remainingEventPath, visitedVariables, boundary)
              if (event.kind === "assignSource" && assignedProjection.state === "absent") continue
              const sourceEntries =
                event.kind === "assignSource" && remainingEventPath[0] !== undefined
                  ? staticObjectEntries(event.value, event.node)
                  : undefined
              const definitelyAssigned =
                event.kind !== "assignSource" ||
                (remainingEventPath[0] !== undefined && sourceEntries?.known.has(remainingEventPath[0]))
              projection =
                event.definitive && definitelyAssigned
                  ? assignedProjection
                  : projectionFound(...(projection.values ?? []), ...(assignedProjection.values ?? []))
              continue
            }
            const possibleProjection =
              event.path.length >= path.length
                ? projectionFound(event.value)
                : projectedPropertyValue(event.value, path.slice(event.path.length), visitedVariables, boundary)
            if (possibleProjection.state === "found") {
              projection = projectionFound(...(projection.values ?? []), ...possibleProjection.values)
            }
          }
          visitedVariables.delete(root.variable)
          return projection
        }
        if (node.type === "ArrayExpression") {
          if (selectedProperty === undefined) {
            const values = []
            for (const element of node.elements) {
              if (element === null || element.type === "SpreadElement") continue
              const projection = projectedPropertyValue(element, remainingPath, visitedVariables, boundary)
              if (projection.state === "found") values.push(...projection.values)
            }
            return values.length > 0 ? projectionFound(...values) : projectionOpaque
          }
          if (!/^(?:0|[1-9][0-9]*)$/u.test(selectedProperty)) return projectionOpaque
          const selectedIndex = Number(selectedProperty)
          const spreadIndex = node.elements.findIndex((element) => element?.type === "SpreadElement")
          if (spreadIndex >= 0 && spreadIndex <= selectedIndex) return projectionOpaque
          const selectedElement = node.elements[selectedIndex]
          if (selectedElement === undefined || selectedElement === null) return projectionShadowed
          return projectedPropertyValue(selectedElement, remainingPath, visitedVariables, boundary)
        }
        if (node.type !== "ObjectExpression") return projectionOpaque
        if (selectedProperty === undefined) return projectionOpaque
        let encounteredOpaqueProjection = false
        const possibleValues = []
        for (let index = node.properties.length - 1; index >= 0; index -= 1) {
          const property = node.properties[index]
          if (property.type === "SpreadElement") {
            let projection = immutableObjectProjection(property.argument, path, visitedVariables, node)
            const sourceIdentifier = identityExpressionIdentifier(property.argument)
            const sourceRoot = sourceIdentifier === undefined ? undefined : immutableIdentityRoot(sourceIdentifier)
            if (sourceRoot !== undefined && path.length > 1) {
              for (const event of objectMutationEvents(sourceRoot, boundary)) {
                if (
                  event.path.length <= 1 ||
                  event.path.some(
                    (propertyName, pathIndex) =>
                      propertyName !== undefined && pathIndex < path.length && propertyName !== path[pathIndex]
                  )
                ) {
                  continue
                }
                const assigned = projectedPropertyValue(
                  event.value,
                  path.slice(event.path.length),
                  visitedVariables,
                  boundary
                )
                projection = event.definitive
                  ? assigned
                  : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
              }
            }
            if (path.length > 1) {
              const copiedSlot = immutableObjectProjection(property.argument, [path[0]], visitedVariables, node)
              for (const copiedValue of copiedSlot.values ?? []) {
                const copiedIdentifier = identityExpressionIdentifier(copiedValue)
                const copiedRoot = copiedIdentifier === undefined ? undefined : immutableIdentityRoot(copiedIdentifier)
                if (copiedRoot === undefined) continue
                const descendantPath = path.slice(1)
                for (const event of objectMutationEvents(copiedRoot, boundary)) {
                  if (
                    event.path.some(
                      (propertyName, index) =>
                        propertyName !== undefined &&
                        index < descendantPath.length &&
                        propertyName !== descendantPath[index]
                    )
                  ) {
                    continue
                  }
                  const assigned = projectedPropertyValue(
                    event.value,
                    descendantPath.slice(event.path.length),
                    visitedVariables,
                    boundary
                  )
                  projection = event.definitive
                    ? assigned
                    : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
                }
              }
            }
            if (projection.state === "found" || projection.state === "shadowed") {
              return possibleValues.length === 0
                ? projection
                : projectionFound(...possibleValues, ...(projection.values ?? []))
            }
            if (projection.state === "opaque") encounteredOpaqueProjection = true
            continue
          }
          const propertyKey = unwrapTypeExpression(property.key)
          const propertyName = property.computed
            ? propertyKey.type === "Identifier"
              ? immutableConstString(propertyKey)
              : staticPropertyName(propertyKey)
            : staticPropertyName(propertyKey)
          if (propertyName === undefined) {
            encounteredOpaqueProjection = true
            const possibleProjection = projectedPropertyValue(property.value, remainingPath, visitedVariables, boundary)
            if (possibleProjection.state === "found") possibleValues.push(...possibleProjection.values)
            continue
          }
          if (propertyName !== selectedProperty) continue
          if (property.kind === "get" && property.value.body.type === "BlockStatement") {
            const returns = []
            const collectReturns = (statement) => {
              if (statement.type === "ReturnStatement") {
                if (statement.argument !== null) returns.push(statement.argument)
                return
              }
              if (
                statement.type === "FunctionDeclaration" ||
                statement.type === "FunctionExpression" ||
                statement.type === "ArrowFunctionExpression"
              ) {
                return
              }
              for (const key of context.sourceCode.visitorKeys[statement.type] ?? []) {
                const child = statement[key]
                if (Array.isArray(child)) {
                  for (const entry of child) if (entry !== null) collectReturns(entry)
                } else if (child !== null && child !== undefined) {
                  collectReturns(child)
                }
              }
            }
            for (const statement of property.value.body.body) collectReturns(statement)
            const values = returns.flatMap(
              (value) => projectedPropertyValue(value, remainingPath, visitedVariables, boundary).values ?? []
            )
            return values.length > 0 ? projectionFound(...possibleValues, ...values) : projectionOpaque
          }
          if (property.kind !== "init" || property.method) return projectionOpaque
          const projection = projectedPropertyValue(property.value, remainingPath, visitedVariables, boundary)
          return possibleValues.length === 0
            ? projection
            : projectionFound(...possibleValues, ...(projection.values ?? []))
        }
        if (possibleValues.length > 0) return projectionFound(...possibleValues)
        return encounteredOpaqueProjection ? projectionOpaque : projectionAbsent
      }
      const memberProjection = (member) => {
        const path = []
        let current = member
        while (true) {
          const propertyName = memberPropertyName(current)
          path.unshift(propertyName)
          const object = unwrapTypeExpression(current.object)
          if (object.type !== "MemberExpression") {
            if (object.type === "Identifier") {
              const destructuredProjection = destructuredConstProjection(object, path, member)
              if (destructuredProjection !== undefined) return destructuredProjection
            }
            return immutableObjectProjection(object, path, new Set(), member)
          }
          current = object
        }
      }
      const destructuringRoute = (pattern, target, path = [], defaults = []) => {
        if (pattern.type === "Identifier") {
          return pattern === target ? { defaults, path } : undefined
        }
        if (pattern.type === "AssignmentPattern") {
          return destructuringRoute(pattern.left, target, path, [...defaults, pattern.right])
        }
        if (pattern.type === "ObjectPattern") {
          for (const property of pattern.properties) {
            if (property.type === "RestElement") {
              const route = destructuringRoute(property.argument, target, path, defaults)
              if (route !== undefined) {
                const excludedProperties = pattern.properties
                  .filter((candidate) => candidate.type === "Property")
                  .map((candidate) => {
                    const key = unwrapTypeExpression(candidate.key)
                    return candidate.computed
                      ? key.type === "Identifier"
                        ? immutableConstString(key)
                        : staticPropertyName(key)
                      : staticPropertyName(key)
                  })
                  .filter((propertyName) => propertyName !== undefined)
                return { ...route, excludedProperties: new Set(excludedProperties) }
              }
              continue
            }
            const key = unwrapTypeExpression(property.key)
            const propertyName = property.computed
              ? key.type === "Identifier"
                ? immutableConstString(key)
                : staticPropertyName(key)
              : staticPropertyName(key)
            const route = destructuringRoute(property.value, target, [...path, propertyName], defaults)
            if (route !== undefined) return route
          }
          return undefined
        }
        if (pattern.type === "ArrayPattern") {
          for (let index = 0; index < pattern.elements.length; index += 1) {
            const element = pattern.elements[index]
            if (element === null) continue
            if (element.type === "RestElement") {
              const route = destructuringRoute(element.argument, target, path, defaults)
              if (route !== undefined) return { ...route, arrayRestStart: index }
              continue
            }
            const route = destructuringRoute(element, target, [...path, String(index)], defaults)
            if (route !== undefined) return route
          }
        }
        return undefined
      }
      const destructuredConstProjection = (identifier, suffixPath = [], boundary = undefined) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined || variable.defs.length !== 1) return undefined
        const definition = variable.defs[0]
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.id.type === "Identifier" ||
          definition.node.init === null ||
          definition.parent?.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const" ||
          definition.name?.type !== "Identifier"
        ) {
          return undefined
        }
        const route = destructuringRoute(definition.node.id, definition.name)
        if (route === undefined) return undefined
        if (route.arrayRestStart !== undefined) {
          const candidates = staticArrayCandidates(definition.node.init, definition.node)
          if (candidates === undefined) return projectionOpaque
          const restCandidates = candidates.slice(route.arrayRestStart)
          for (const event of arrayMutationEvents({ definition, variable }, boundary ?? definition.node)) {
            const priorCandidates = event.definitive ? undefined : restCandidates.map((values) => [...values])
            try {
              const argumentsAsCandidates = event.args.flatMap((argument) => {
                if (argument.type !== "SpreadElement") return [[argument]]
                return staticArrayCandidates(argument.argument, boundary ?? definition.node) ?? []
              })
              if (event.kind === "push") restCandidates.push(...argumentsAsCandidates)
              if (event.kind === "unshift") restCandidates.unshift(...argumentsAsCandidates)
              if (
                event.kind === "assign" &&
                event.propertyName !== undefined &&
                /^(?:0|[1-9][0-9]*)$/u.test(event.propertyName)
              ) {
                const index = Number(event.propertyName)
                restCandidates[index] = event.definitive
                  ? argumentsAsCandidates.flat()
                  : [...(restCandidates[index] ?? []), ...argumentsAsCandidates.flat()]
              }
              if (event.kind === "reverse") restCandidates.reverse()
              if (event.kind === "shift") restCandidates.shift()
              if (event.kind === "pop") restCandidates.pop()
              if (event.kind === "fill" && event.args[0]?.type !== "SpreadElement") {
                const value = event.args[0]
                if (value !== undefined) {
                  const rawStart = event.args[1] === undefined ? 0 : immutableConstNumber(event.args[1])
                  const rawEnd =
                    event.args[2] === undefined ? restCandidates.length : immutableConstNumber(event.args[2])
                  if (
                    (event.args[1] !== undefined && rawStart === undefined) ||
                    (event.args[2] !== undefined && rawEnd === undefined)
                  ) {
                    for (let index = 0; index < restCandidates.length; index += 1) {
                      restCandidates[index] = [...restCandidates[index], value]
                    }
                    continue
                  }
                  const normalize = (raw, fallback) => {
                    if (raw === undefined) return fallback
                    if (Number.isNaN(raw) || raw === Number.NEGATIVE_INFINITY) return 0
                    if (raw === Number.POSITIVE_INFINITY) return restCandidates.length
                    const integer = Math.trunc(raw)
                    return integer < 0
                      ? Math.max(restCandidates.length + integer, 0)
                      : Math.min(integer, restCandidates.length)
                  }
                  const start = normalize(rawStart, 0)
                  const end = normalize(rawEnd, restCandidates.length)
                  for (let index = start; index < end; index += 1) {
                    restCandidates[index] = [value]
                  }
                }
              }
              if (event.kind === "sort") {
                const allValues = restCandidates.flat()
                for (let index = 0; index < restCandidates.length; index += 1) {
                  restCandidates[index] = [...allValues]
                }
              }
              if (event.kind === "copyWithin") {
                const target = event.args[0] && immutableConstNumber(event.args[0])
                const start = event.args[1] && immutableConstNumber(event.args[1])
                const end = event.args[2] && immutableConstNumber(event.args[2])
                if (target === undefined || start === undefined) {
                  const allValues = restCandidates.flat()
                  for (let index = 0; index < restCandidates.length; index += 1) {
                    restCandidates[index] = [...allValues]
                  }
                } else {
                  restCandidates.copyWithin(target, start, end)
                }
              }
              if (event.kind === "splice" && event.args.length > 0) {
                const start = immutableConstNumber(event.args[0])
                const remove = event.args[1] === undefined ? restCandidates.length : immutableConstNumber(event.args[1])
                if (start === undefined || remove === undefined) {
                  const inserted = argumentsAsCandidates.slice(2).flat()
                  for (let index = 0; index < restCandidates.length; index += 1) {
                    restCandidates[index] = [...restCandidates[index], ...inserted]
                  }
                } else {
                  restCandidates.splice(start, remove, ...argumentsAsCandidates.slice(2))
                }
              }
            } finally {
              if (priorCandidates !== undefined) {
                const length = Math.max(restCandidates.length, priorCandidates.length)
                for (let index = 0; index < length; index += 1) {
                  restCandidates[index] = [...(restCandidates[index] ?? []), ...(priorCandidates[index] ?? [])]
                }
              }
            }
          }
          if (suffixPath.length === 0) return projectionFound(...restCandidates.flat())
          const [selectedProperty, ...remainingPath] = suffixPath
          const selectedCandidates =
            selectedProperty === undefined
              ? restCandidates.flat()
              : /^(?:0|[1-9][0-9]*)$/u.test(selectedProperty)
                ? (restCandidates[Number(selectedProperty)] ?? [])
                : []
          const values = selectedCandidates.flatMap(
            (candidate) =>
              projectedPropertyValue(candidate, remainingPath, new Set(), boundary ?? definition.node).values ?? []
          )
          const sourceIdentifier = identityExpressionIdentifier(definition.node.init)
          const sourceRoot = sourceIdentifier === undefined ? undefined : immutableIdentityRoot(sourceIdentifier)
          if (
            sourceRoot !== undefined &&
            selectedProperty !== undefined &&
            /^(?:0|[1-9][0-9]*)$/u.test(selectedProperty) &&
            remainingPath.length > 0
          ) {
            const sourcePath = [String(route.arrayRestStart + Number(selectedProperty)), ...remainingPath]
            for (const event of objectMutationEvents(sourceRoot, boundary ?? definition.node)) {
              if (
                event.path.length <= 1 ||
                event.path.some(
                  (propertyName, index) =>
                    propertyName !== undefined && index < sourcePath.length && propertyName !== sourcePath[index]
                )
              ) {
                continue
              }
              const projection = projectedPropertyValue(
                event.value,
                sourcePath.slice(event.path.length),
                new Set(),
                boundary ?? definition.node
              )
              values.push(...(projection.values ?? []))
            }
          }
          return values.length > 0 ? projectionFound(...values) : projectionShadowed
        }
        let projection =
          route.excludedProperties !== undefined &&
          suffixPath[0] !== undefined &&
          route.excludedProperties.has(suffixPath[0])
            ? projectionShadowed
            : immutableObjectProjection(
                definition.node.init,
                [...route.path, ...suffixPath],
                new Set(),
                route.excludedProperties === undefined ? (boundary ?? definition.node) : definition.node
              )
        if (route.excludedProperties !== undefined && suffixPath.length > 0) {
          const sourceIdentifier = identityExpressionIdentifier(definition.node.init)
          const sourceRoot = sourceIdentifier === undefined ? undefined : immutableIdentityRoot(sourceIdentifier)
          if (sourceRoot !== undefined && suffixPath.length > 1) {
            for (const event of objectMutationEvents(sourceRoot, boundary ?? definition.node)) {
              if (
                event.path.length <= 1 ||
                event.path.some(
                  (propertyName, index) =>
                    propertyName !== undefined && index < suffixPath.length && propertyName !== suffixPath[index]
                )
              ) {
                continue
              }
              const assigned = projectedPropertyValue(
                event.value,
                suffixPath.slice(event.path.length),
                new Set(),
                boundary ?? definition.node
              )
              projection = event.definitive
                ? assigned
                : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
            }
          }
          for (const event of objectMutationEvents({ definition, variable }, boundary ?? definition.node)) {
            const mismatch = event.path.some(
              (propertyName, index) =>
                propertyName !== undefined && index < suffixPath.length && propertyName !== suffixPath[index]
            )
            if (mismatch) continue
            const assigned = projectedPropertyValue(
              event.value,
              suffixPath.slice(event.path.length),
              new Set(),
              boundary ?? definition.node
            )
            projection = event.definitive
              ? assigned
              : projectionFound(...(projection.values ?? []), ...(assigned.values ?? []))
          }
        }
        const values = projection.values ?? []
        const isDefinitelyDefined = (value, visitedVariables = new Set()) => {
          const node = unwrapTypeExpression(value)
          if (
            (node.type === "Literal" && node.value !== undefined) ||
            node.type === "ArrayExpression" ||
            node.type === "ObjectExpression" ||
            (node.type === "TemplateLiteral" && node.expressions.length === 0)
          ) {
            return true
          }
          if (node.type !== "Identifier") return false
          const binding = immutableConstInitializer(node)
          if (binding === undefined || visitedVariables.has(binding.variable)) return false
          visitedVariables.add(binding.variable)
          const defined = isDefinitelyDefined(binding.initializer, visitedVariables)
          visitedVariables.delete(binding.variable)
          return defined
        }
        const defaults =
          projection.state === "found" && values.length > 0 && values.every((value) => isDefinitelyDefined(value))
            ? []
            : route.defaults
        const defaultValues = defaults.flatMap((value) => {
          if (suffixPath.length === 0) return [value]
          const defaultProjection = immutableObjectProjection(value, suffixPath, new Set(), boundary ?? definition.node)
          return defaultProjection.values ?? []
        })
        return values.length === 0 && defaultValues.length === 0
          ? projection
          : projectionFound(...values, ...defaultValues)
      }
      const destructuredConstValues = (identifier) => destructuredConstProjection(identifier)?.values
      const isCalledMemberReceiver = (member) => {
        const expression = outerIdentityExpression(member)
        return expression.parent?.type === "CallExpression" && expression.parent.callee === expression
      }
      const mutableScalarValues = (identifier, boundary) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined || variable.defs.length !== 1) return undefined
        const definition = variable.defs[0]
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.id.type !== "Identifier" ||
          definition.parent?.type !== "VariableDeclaration" ||
          (definition.parent.kind !== "let" && definition.parent.kind !== "var")
        ) {
          return undefined
        }
        let values = definition.node.init === null ? [] : [definition.node.init]
        const boundaryOwner = enclosingFunction(boundary)
        const definitionOwner = enclosingFunction(definition.node)
        const isOneShotIife =
          boundaryOwner !== undefined &&
          boundaryOwner !== null &&
          boundaryOwner.type !== "FunctionDeclaration" &&
          (boundaryOwner.type === "ArrowFunctionExpression" || boundaryOwner.id === null) &&
          outerIdentityExpression(boundaryOwner).parent?.type === "CallExpression" &&
          outerIdentityExpression(boundaryOwner).parent.callee === outerIdentityExpression(boundaryOwner)
        const functionInvocations = (functionNode) => {
          if (functionNode === undefined || functionNode === null) return []
          const expression = outerIdentityExpression(functionNode)
          if (expression.parent?.type === "CallExpression" && expression.parent.callee === expression) {
            return [expression.parent]
          }
          if (
            expression.parent?.type === "CallExpression" &&
            expression.parent.arguments[0] === expression &&
            expression.parent.callee.type === "MemberExpression" &&
            memberPropertyName(expression.parent.callee) === "forEach" &&
            (staticArrayCandidates(expression.parent.callee.object, expression.parent)?.some(
              (slot) => slot.length > 0
            ) ??
              false)
          ) {
            return [expression.parent]
          }
          const identifier =
            functionNode.type === "FunctionDeclaration"
              ? functionNode.id
              : expression.parent?.type === "VariableDeclarator" &&
                  expression.parent.init === expression &&
                  expression.parent.id.type === "Identifier"
                ? expression.parent.id
                : undefined
          const functionVariable =
            identifier === undefined || identifier === null ? undefined : resolvedVariable(context, identifier)
          if (functionVariable === undefined) return []
          const pendingVariables = [functionVariable]
          const visitedFunctionVariables = new Set()
          const invocations = []
          while (pendingVariables.length > 0) {
            const currentVariable = pendingVariables.pop()
            if (currentVariable === undefined || visitedFunctionVariables.has(currentVariable)) continue
            visitedFunctionVariables.add(currentVariable)
            for (const reference of currentVariable.references) {
              const referenceExpression = outerIdentityExpression(reference.identifier)
              const call = referenceExpression.parent
              if (call?.type === "CallExpression" && call.callee === referenceExpression) {
                invocations.push(call)
                continue
              }
              if (
                call?.type === "CallExpression" &&
                call.arguments[0] === referenceExpression &&
                call.callee.type === "MemberExpression" &&
                memberPropertyName(call.callee) === "forEach" &&
                (staticArrayCandidates(call.callee.object, call)?.some((slot) => slot.length > 0) ?? false)
              ) {
                invocations.push(call)
                continue
              }
              const invocationMember = referenceExpression.parent
              const reflectedCall = outerIdentityExpression(invocationMember).parent
              if (
                invocationMember?.type === "MemberExpression" &&
                invocationMember.object === referenceExpression &&
                ["apply", "call"].includes(memberPropertyName(invocationMember)) &&
                reflectedCall?.type === "CallExpression" &&
                reflectedCall.callee === outerIdentityExpression(invocationMember)
              ) {
                invocations.push(reflectedCall)
                continue
              }
              const aliasIdentifier = immutableIdentityAliasIdentifier(reference.identifier)
              if (aliasIdentifier === undefined) continue
              const aliasVariable = resolvedVariable(context, aliasIdentifier)
              if (aliasVariable !== undefined && aliasVariable.defs.length === 1) {
                pendingVariables.push(aliasVariable)
              }
            }
          }
          return invocations
        }
        const boundaryInvocations = functionInvocations(boundaryOwner)
        const isBoundaryInsideForOf = (usage) => {
          if (usage.type !== "ForOfStatement") return false
          let current = boundary
          while (current !== undefined && current !== null) {
            if (current === usage.body) return true
            current = current.parent
          }
          return false
        }
        const enclosingForOf = (candidate) => {
          let current = candidate.parent
          while (current !== undefined && current !== null && current !== boundary) {
            if (current.type === "ForOfStatement") return current
            current = current.parent
          }
          return undefined
        }
        const loopExitMode = (loop) => {
          if (loop.type !== "ForOfStatement") return "none"
          if (
            loop.body.type === "BlockStatement" &&
            loop.body.body.some((statement) => statement.type === "BreakStatement")
          ) {
            return "first"
          }
          let hasAbruptExit = false
          const breakTargetsLoop = (statement) => {
            if (statement.label !== null) {
              let labeled = loop.parent
              while (labeled?.type === "LabeledStatement") {
                if (labeled.label.name === statement.label.name) return true
                labeled = labeled.parent
              }
              return false
            }
            let current = statement.parent
            while (current !== undefined && current !== null) {
              if (current === loop) return true
              if (
                current.type === "SwitchStatement" ||
                current.type === "ForStatement" ||
                current.type === "ForInStatement" ||
                current.type === "ForOfStatement" ||
                current.type === "WhileStatement" ||
                current.type === "DoWhileStatement"
              ) {
                return false
              }
              current = current.parent
            }
            return false
          }
          const visit = (candidate) => {
            if (
              candidate !== loop.body &&
              (candidate.type === "ArrowFunctionExpression" ||
                candidate.type === "FunctionExpression" ||
                candidate.type === "FunctionDeclaration")
            ) {
              return
            }
            if (candidate.type === "BreakStatement") {
              if (breakTargetsLoop(candidate)) hasAbruptExit = true
              return
            }
            if (candidate.type === "ReturnStatement" || candidate.type === "ThrowStatement") {
              hasAbruptExit = true
              return
            }
            for (const key of context.sourceCode.visitorKeys[candidate.type] ?? []) {
              const child = candidate[key]
              if (Array.isArray(child)) {
                for (const entry of child) if (entry !== null) visit(entry)
              } else if (child !== null && child !== undefined) {
                visit(child)
              }
            }
          }
          visit(loop.body)
          return hasAbruptExit ? "possible" : "none"
        }
        const writeCanReachBoundary = (usage) => {
          const usageOwner = enclosingFunction(usage)
          if (usageOwner === boundaryOwner) {
            if (isBoundaryInsideForOf(usage)) return true
            const containingLoop = enclosingForOf(usage)
            if (
              containingLoop !== undefined &&
              staticArrayCandidates(containingLoop.right, containingLoop)?.length === 0
            ) {
              return false
            }
            return usage.range[1] <= boundary.range[0] || (boundaryOwner !== definitionOwner && !isOneShotIife)
          }
          if (usageOwner === definitionOwner && boundaryOwner !== definitionOwner) {
            return boundaryInvocations.some((invocation) => usage.range[1] <= invocation.range[0])
          }
          const usageOwnerInvocations = functionInvocations(usageOwner)
          if (usageOwnerInvocations.length !== 1) return false
          const oneShotCall = usageOwnerInvocations[0]
          return boundaryOwner === definitionOwner
            ? oneShotCall.range[1] <= boundary.range[0]
            : boundaryInvocations.some((invocation) => oneShotCall.range[1] <= invocation.range[0])
        }
        const writes = variable.references
          .flatMap((reference) => {
            const expression = outerIdentityExpression(reference.identifier)
            const usage = expression.parent
            if (
              usage?.type === "AssignmentExpression" &&
              usage.left === expression &&
              writeCanReachBoundary(usage) &&
              !isMutuallyExclusiveWith(usage, boundary, definition.node)
            ) {
              return [{ usage, values: usage.operator === "=" ? [usage.right] : undefined }]
            }
            if (usage?.type === "ForOfStatement" && usage.left === expression && writeCanReachBoundary(usage)) {
              const iterationSlots = staticArrayCandidates(usage.right, usage)
              if (iterationSlots?.length === 0 && !isBoundaryInsideForOf(usage)) return []
              const candidates =
                iterationSlots === undefined
                  ? [usage.right]
                  : isBoundaryInsideForOf(usage)
                    ? iterationSlots.flat()
                    : loopExitMode(usage) === "first"
                      ? (iterationSlots[0] ?? [])
                      : loopExitMode(usage) === "possible"
                        ? iterationSlots.flat()
                        : (iterationSlots.at(-1) ?? [])
              return [{ definitive: iterationSlots !== undefined, usage, values: candidates }]
            }
            let pattern = expression.parent
            while (
              pattern !== undefined &&
              pattern !== null &&
              pattern.type !== "AssignmentExpression" &&
              pattern.type !== "ForOfStatement" &&
              pattern.type !== "VariableDeclarator"
            ) {
              pattern = pattern.parent
            }
            if (pattern?.type === "ForOfStatement" && writeCanReachBoundary(pattern)) {
              const route = destructuringRoute(pattern.left, reference.identifier)
              if (route === undefined || route.excludedProperties !== undefined || route.arrayRestStart !== undefined) {
                return []
              }
              const iterationSlots = staticArrayCandidates(pattern.right, pattern)
              if (iterationSlots?.length === 0 && !isBoundaryInsideForOf(pattern)) return []
              const iterableCandidates =
                iterationSlots === undefined
                  ? [pattern.right]
                  : isBoundaryInsideForOf(pattern)
                    ? iterationSlots.flat()
                    : loopExitMode(pattern) === "first"
                      ? (iterationSlots[0] ?? [])
                      : loopExitMode(pattern) === "possible"
                        ? iterationSlots.flat()
                        : (iterationSlots.at(-1) ?? [])
              const values = iterableCandidates.flatMap(
                (candidate) => projectedPropertyValue(candidate, route.path, new Set(), pattern).values ?? []
              )
              return values.length > 0 ? [{ definitive: iterationSlots !== undefined, usage: pattern, values }] : []
            }
            if (
              pattern?.type !== "AssignmentExpression" ||
              pattern.operator !== "=" ||
              !writeCanReachBoundary(pattern) ||
              isMutuallyExclusiveWith(pattern, boundary, definition.node)
            ) {
              return []
            }
            const route = destructuringRoute(pattern.left, reference.identifier)
            if (route === undefined || route.excludedProperties !== undefined || route.arrayRestStart !== undefined) {
              return []
            }
            const projection = immutableObjectProjection(pattern.right, route.path, new Set(), pattern)
            return projection.state === "found" ? [{ usage: pattern, values: projection.values }] : []
          })
          .sort((left, right) => left.usage.range[0] - right.usage.range[0])
        for (const write of writes) {
          const nextValues = write.values ?? [...values, write.usage.right]
          values =
            write.definitive ||
            (write.usage.type !== "ForOfStatement" && isUnconditionalMutation(write.usage, boundary))
              ? nextValues
              : [...values, ...nextValues]
        }
        return values
      }
      const forOfDeclarationValues = (identifier) => {
        const variable = resolvedVariable(context, identifier)
        if (variable === undefined || variable.defs.length !== 1) return undefined
        const definition = variable.defs[0]
        if (
          definition.type !== "Variable" ||
          definition.node.type !== "VariableDeclarator" ||
          definition.node.init !== null ||
          definition.parent?.type !== "VariableDeclaration" ||
          definition.parent.parent?.type !== "ForOfStatement"
        ) {
          return undefined
        }
        const loop = definition.parent.parent
        const candidates = staticArrayCandidates(loop.right, loop)?.flat() ?? [loop.right]
        if (definition.node.id.type === "Identifier") return candidates
        if (definition.name?.type !== "Identifier") return undefined
        const route = destructuringRoute(definition.node.id, definition.name)
        if (route === undefined || route.excludedProperties !== undefined || route.arrayRestStart !== undefined) {
          return undefined
        }
        return candidates.flatMap(
          (candidate) => projectedPropertyValue(candidate, route.path, new Set(), loop).values ?? []
        )
      }
      const expandedCallArgumentCandidates = (arguments_, boundary) => {
        const candidates = []
        for (const argument of arguments_) {
          if (argument.type !== "SpreadElement") {
            candidates.push([argument])
            continue
          }
          const spreadCandidates = staticArrayCandidates(argument.argument, boundary)
          if (spreadCandidates === undefined) return undefined
          candidates.push(...spreadCandidates)
        }
        return candidates
      }
      const isStaticallyNullish = (expression) => {
        if (expression === undefined) return true
        const node = unwrapTypeExpression(expression)
        if (node.type === "Literal" && node.value === null) return true
        if (node.type === "Identifier" && isUnshadowedGlobal(node, "undefined")) return true
        if (node.type !== "Identifier") return false
        const binding = immutableConstInitializer(node)
        return binding !== undefined && isStaticallyNullish(binding.initializer)
      }
      const functionReturnExpressions = (expression, visitedVariables = new Set()) => {
        let node = unwrapTypeExpression(expression)
        if (node.type === "Identifier") {
          const binding = immutableConstInitializer(node)
          if (binding === undefined || visitedVariables.has(binding.variable)) return []
          visitedVariables.add(binding.variable)
          const returns = functionReturnExpressions(binding.initializer, visitedVariables)
          visitedVariables.delete(binding.variable)
          return returns
        }
        if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return []
        if (node.body.type !== "BlockStatement") return [node.body]
        const returns = []
        const collectReturns = (candidate) => {
          if (candidate.type === "ReturnStatement") {
            if (candidate.argument !== null) returns.push(candidate.argument)
            return
          }
          if (
            candidate !== node.body &&
            (candidate.type === "ArrowFunctionExpression" ||
              candidate.type === "FunctionExpression" ||
              candidate.type === "FunctionDeclaration")
          ) {
            return
          }
          for (const key of context.sourceCode.visitorKeys[candidate.type] ?? []) {
            const child = candidate[key]
            if (Array.isArray(child)) {
              for (const entry of child) if (entry !== null) collectReturns(entry)
            } else if (child !== null && child !== undefined) {
              collectReturns(child)
            }
          }
        }
        collectReturns(node.body)
        return returns
      }
      const staticFunctionExpression = (expression, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return node
        if (node.type !== "Identifier") return undefined
        const binding = immutableConstInitializer(node)
        if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
        visitedVariables.add(binding.variable)
        const functionExpression = staticFunctionExpression(binding.initializer, visitedVariables)
        visitedVariables.delete(binding.variable)
        return functionExpression
      }
      const isProvablyStringExpression = (expression, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (
          (node.type === "Literal" && Predicate.isString(node.value)) ||
          node.type === "TemplateLiteral" ||
          isRawCredentialApiKey(node) ||
          isCredentialEmail(node) ||
          isFixtureLocator(node)
        ) {
          return true
        }
        if (node.type === "Identifier") {
          const binding = immutableConstInitializer(node)
          if (binding !== undefined && !visitedVariables.has(binding.variable)) {
            visitedVariables.add(binding.variable)
            const isString = isProvablyStringExpression(binding.initializer, visitedVariables)
            visitedVariables.delete(binding.variable)
            return isString
          }
          const scalarValues = mutableScalarValues(node, node)
          const iterationValues = forOfDeclarationValues(node)
          return (
            ((scalarValues !== undefined && scalarValues.length > 0) ||
              (iterationValues !== undefined && iterationValues.length > 0)) &&
            [...(scalarValues ?? []), ...(iterationValues ?? [])].every((value) =>
              isProvablyStringExpression(value, visitedVariables)
            )
          )
        }
        if (node.type === "MemberExpression") {
          if (visitedVariables.has(node)) return false
          visitedVariables.add(node)
          const projection = memberProjection(node)
          const isString =
            projection.state === "found" &&
            projection.values.some((value) => isProvablyStringExpression(value, visitedVariables))
          visitedVariables.delete(node)
          return isString
        }
        if (node.type !== "CallExpression") return false
        const callee = unwrapTypeExpression(node.callee)
        if (
          callee.type === "Identifier" &&
          (isUnshadowedGlobal(callee, "String") || isUnshadowedGlobal(callee, "encodeURIComponent"))
        ) {
          return true
        }
        if (callee.type !== "MemberExpression") return false
        return (
          [
            "concat",
            "normalize",
            "padEnd",
            "padStart",
            "repeat",
            "replace",
            "replaceAll",
            "slice",
            "substring",
            "toLocaleLowerCase",
            "toLocaleUpperCase",
            "toLowerCase",
            "toUpperCase",
            "trim",
            "trimEnd",
            "trimStart"
          ].includes(memberPropertyName(callee)) && isProvablyStringExpression(callee.object, visitedVariables)
        )
      }
      const transparentDerivedExpressionTypes = new Set([
        "ArrayExpression",
        "BinaryExpression",
        "ChainExpression",
        "ConditionalExpression",
        "Identifier",
        "LogicalExpression",
        "MemberExpression",
        "ObjectExpression",
        "Property",
        "SpreadElement",
        "TemplateLiteral",
        "UnaryExpression"
      ])
      const parameterIdentifier = (parameter) => {
        let node = parameter
        while (
          node?.type === "AssignmentPattern" ||
          node?.type === "TSAsExpression" ||
          node?.type === "TSTypeAssertion" ||
          node?.type === "TSSatisfiesExpression" ||
          node?.type === "TSNonNullExpression"
        ) {
          node = node.type === "AssignmentPattern" ? node.left : node.expression
        }
        return node?.type === "Identifier" ? node : undefined
      }
      const containsTransparentVariableFlow = (expression, variable, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (node.type === "Identifier") {
          if (resolvedVariable(context, node) === variable) return true
          const binding = immutableConstInitializer(node)
          if (binding === undefined || visitedVariables.has(binding.variable)) return false
          visitedVariables.add(binding.variable)
          const containsFlow = containsTransparentVariableFlow(binding.initializer, variable, visitedVariables)
          visitedVariables.delete(binding.variable)
          return containsFlow
        }
        if (node.type.startsWith("TS")) return false
        if (node.type === "CallExpression") {
          const callee = unwrapTypeExpression(node.callee)
          if (callee.type === "Identifier") {
            if (!isUnshadowedGlobal(callee, "String") && !isUnshadowedGlobal(callee, "encodeURIComponent")) {
              return false
            }
            return (
              expandedCallArgumentCandidates(node.arguments, node)?.[0]?.some((argument) =>
                containsTransparentVariableFlow(argument, variable, visitedVariables)
              ) ?? false
            )
          }
          return (
            callee.type === "MemberExpression" &&
            [
              "normalize",
              "repeat",
              "slice",
              "substring",
              "toLocaleLowerCase",
              "toLocaleUpperCase",
              "toLowerCase",
              "toUpperCase",
              "trim",
              "trimEnd",
              "trimStart"
            ].includes(memberPropertyName(callee)) &&
            containsTransparentVariableFlow(callee.object, variable, visitedVariables)
          )
        }
        if (node.type === "BinaryExpression" && booleanComparisonOperators.has(node.operator)) return false
        if (
          ![
            "ArrayExpression",
            "BinaryExpression",
            "ChainExpression",
            "ConditionalExpression",
            "LogicalExpression",
            "MemberExpression",
            "ObjectExpression",
            "Property",
            "SpreadElement",
            "TemplateLiteral"
          ].includes(node.type)
        ) {
          return false
        }
        return (context.sourceCode.visitorKeys[node.type] ?? []).some((key) => {
          const child = node[key]
          return Array.isArray(child)
            ? child.some(
                (entry) => entry !== null && containsTransparentVariableFlow(entry, variable, visitedVariables)
              )
            : child !== null &&
                child !== undefined &&
                containsTransparentVariableFlow(child, variable, visitedVariables)
        })
      }
      const staticToJsonReturns = (expression, visitedVariables = new Set(), receiver = expression) => {
        const unwrappedExpression = unwrapTypeExpression(expression)
        const node = unwrapTypeExpression(frozenArgument(context, unwrappedExpression) ?? unwrappedExpression)
        if (node.type === "Identifier") {
          const binding = immutableConstInitializer(node)
          if (binding === undefined || visitedVariables.has(binding.variable)) return undefined
          visitedVariables.add(binding.variable)
          const hook = staticToJsonReturns(binding.initializer, visitedVariables, receiver)
          visitedVariables.delete(binding.variable)
          return hook
        }
        if (node.type !== "ObjectExpression") return undefined
        for (let index = node.properties.length - 1; index >= 0; index -= 1) {
          const property = node.properties[index]
          if (property.type === "SpreadElement") {
            const hook = staticToJsonReturns(property.argument, visitedVariables, receiver)
            if (hook !== undefined) return hook
            continue
          }
          const key = unwrapTypeExpression(property.key)
          const propertyName = property.computed
            ? key.type === "Identifier"
              ? immutableConstString(key)
              : key.type === "Literal" && Predicate.isNumber(key.value) && Number.isFinite(key.value)
                ? String(key.value)
                : staticPropertyName(key)
            : key.type === "Literal" && Predicate.isNumber(key.value) && Number.isFinite(key.value)
              ? String(key.value)
              : staticPropertyName(key)
          if (propertyName === undefined) return { returns: [] }
          if (propertyName !== "toJSON") continue
          const functionExpression = staticFunctionExpression(property.value)
          return {
            owner: receiver,
            returns: functionExpression === undefined ? [] : functionReturnExpressions(functionExpression)
          }
        }
        return undefined
      }
      const containsToJsonSensitiveReturn = (expression, owner, directMatch, visitedNodes = new Set()) => {
        const node = unwrapTypeExpression(expression)
        if (directMatch(node)) return true
        if (node.type === "ThisExpression") {
          return containsTransparentDerivedOperand(unwrapTypeExpression(owner), directMatch, visitedNodes)
        }
        if (visitedNodes.has(node)) return false
        visitedNodes.add(node)
        try {
          if (node.type === "Identifier") {
            const variable = resolvedVariable(context, node)
            const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined
            if (
              definition?.type === "Variable" &&
              definition.node.type === "VariableDeclarator" &&
              definition.node.id.type !== "Identifier" &&
              definition.node.init !== null &&
              unwrapTypeExpression(definition.node.init).type === "ThisExpression" &&
              definition.name?.type === "Identifier" &&
              definition.parent?.type === "VariableDeclaration" &&
              definition.parent.kind === "const"
            ) {
              const route = destructuringRoute(definition.node.id, definition.name)
              if (route !== undefined && route.excludedProperties === undefined && route.arrayRestStart === undefined) {
                const projection = immutableObjectProjection(owner, route.path, new Set(), node)
                if (
                  projection.state === "found" &&
                  projection.values.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedNodes))
                ) {
                  return true
                }
                if (
                  route.defaults.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedNodes))
                ) {
                  return true
                }
              }
            }
            const binding = immutableConstInitializer(node)
            return (
              binding !== undefined &&
              containsToJsonSensitiveReturn(binding.initializer, owner, directMatch, visitedNodes)
            )
          }
          if (node.type === "MemberExpression") {
            const isThisAlias = (identifier, visitedVariables = new Set()) => {
              const binding = immutableConstInitializer(identifier)
              if (binding === undefined || visitedVariables.has(binding.variable)) return false
              visitedVariables.add(binding.variable)
              const initializer = unwrapTypeExpression(binding.initializer)
              const aliasesThis =
                initializer.type === "ThisExpression" ||
                (initializer.type === "Identifier" && isThisAlias(initializer, visitedVariables))
              visitedVariables.delete(binding.variable)
              return aliasesThis
            }
            const path = []
            let current = node
            while (true) {
              path.unshift(memberPropertyName(current))
              const object = unwrapTypeExpression(current.object)
              if (object.type === "ThisExpression") {
                const projection = immutableObjectProjection(owner, path, new Set(), node)
                return (
                  projection.state === "found" &&
                  projection.values.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedNodes))
                )
              }
              if (object.type === "Identifier" && isThisAlias(object)) {
                const projection = immutableObjectProjection(owner, path, new Set(), node)
                return (
                  projection.state === "found" &&
                  projection.values.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedNodes))
                )
              }
              if (object.type !== "MemberExpression") break
              current = object
            }
          }
          if (node.type === "BinaryExpression" && booleanComparisonOperators.has(node.operator)) return false
          if (node.type === "CallExpression") {
            const frozenValue = frozenArgument(context, node)
            if (frozenValue !== undefined) {
              return containsTransparentDerivedOperand(frozenValue, directMatch, visitedNodes)
            }
            const callee = unwrapTypeExpression(node.callee)
            if (
              callee.type !== "Identifier" ||
              (!isUnshadowedGlobal(callee, "String") && !isUnshadowedGlobal(callee, "encodeURIComponent"))
            ) {
              return false
            }
          }
          if (
            node.type.startsWith("TS") ||
            ![
              "ArrayExpression",
              "BinaryExpression",
              "CallExpression",
              "ChainExpression",
              "ConditionalExpression",
              "LogicalExpression",
              "MemberExpression",
              "ObjectExpression",
              "Property",
              "SpreadElement",
              "TemplateLiteral"
            ].includes(node.type)
          ) {
            return false
          }
          return (context.sourceCode.visitorKeys[node.type] ?? []).some((key) => {
            const child = node[key]
            return Array.isArray(child)
              ? child.some(
                  (entry) => entry !== null && containsToJsonSensitiveReturn(entry, owner, directMatch, visitedNodes)
                )
              : child !== null &&
                  child !== undefined &&
                  containsToJsonSensitiveReturn(child, owner, directMatch, visitedNodes)
          })
        } finally {
          visitedNodes.delete(node)
        }
      }
      const containsTransparentDerivedOperand = (node, directMatch, visitedVariables) => {
        if (directMatch(node)) return true
        if (visitedVariables.has(node)) return false
        visitedVariables.add(node)
        try {
          if (
            node.type === "TSAsExpression" ||
            node.type === "TSTypeAssertion" ||
            node.type === "TSSatisfiesExpression" ||
            node.type === "TSNonNullExpression"
          ) {
            return containsTransparentDerivedOperand(node.expression, directMatch, visitedVariables)
          }
          if (node.type.startsWith("TS")) return false
          if (node.type === "Identifier") {
            const destructuredValues = destructuredConstValues(node)
            if (
              destructuredValues !== undefined &&
              destructuredValues.some((value) =>
                containsTransparentDerivedOperand(value, directMatch, visitedVariables)
              )
            ) {
              return true
            }
            const binding = immutableConstInitializer(node)
            if (binding !== undefined && !visitedVariables.has(binding.variable)) {
              visitedVariables.add(binding.variable)
              const containsMatch = containsTransparentDerivedOperand(
                binding.initializer,
                directMatch,
                visitedVariables
              )
              visitedVariables.delete(binding.variable)
              return containsMatch
            }
            const scalarValues = mutableScalarValues(node, node)
            const iterationValues = forOfDeclarationValues(node)
            return [...(scalarValues ?? []), ...(iterationValues ?? [])].some((value) =>
              containsTransparentDerivedOperand(value, directMatch, visitedVariables)
            )
          }
          if (node.type === "CallExpression") {
            const callee = unwrapTypeExpression(node.callee)
            if (
              callee.type === "Identifier" &&
              (isUnshadowedGlobal(callee, "String") || isUnshadowedGlobal(callee, "encodeURIComponent"))
            ) {
              const valueCandidates = expandedCallArgumentCandidates(node.arguments, node)?.[0] ?? []
              return valueCandidates.some((value) =>
                containsTransparentDerivedOperand(value, directMatch, visitedVariables)
              )
            }
            if (callee.type !== "MemberExpression") return false
            const object = unwrapTypeExpression(callee.object)
            const method = memberPropertyName(callee)
            if (method === "stringify" && object.type === "Identifier" && isUnshadowedGlobal(object, "JSON")) {
              const callArguments = expandedCallArgumentCandidates(node.arguments, node)
              if (callArguments === undefined) return false
              const rawValueCandidates = callArguments[0] ?? []
              const valueCandidates = rawValueCandidates.flatMap((value) => {
                const hook = staticToJsonReturns(value)
                return hook === undefined
                  ? [{ value }]
                  : hook.returns.map((returned) => ({ hookOwner: hook.owner, value: returned }))
              })
              const containsSerializedSensitive = (candidate) =>
                candidate.hookOwner === undefined
                  ? containsTransparentDerivedOperand(candidate.value, directMatch, visitedVariables)
                  : containsToJsonSensitiveReturn(candidate.value, candidate.hookOwner, directMatch, visitedVariables)
              const containsWhitelistedValue = (value, whitelist, includeAllKnownKeys, visitedValues = new Set()) => {
                const candidate = unwrapTypeExpression(value)
                if (directMatch(candidate)) return true
                if (visitedValues.has(candidate)) return false
                visitedValues.add(candidate)
                try {
                  const arrayCandidates = staticArrayCandidates(candidate, node)
                  if (arrayCandidates !== undefined) {
                    return arrayCandidates
                      .flat()
                      .some((entry) => containsWhitelistedValue(entry, whitelist, includeAllKnownKeys, visitedValues))
                  }
                  const entries = staticObjectEntries(candidate, node)
                  if (entries === undefined) {
                    return containsTransparentDerivedOperand(candidate, directMatch, visitedVariables)
                  }
                  const selectedKeys = includeAllKnownKeys
                    ? new Set([...whitelist, ...entries.known.keys()])
                    : whitelist
                  return [...selectedKeys].some((propertyName) =>
                    (entries.known.get(propertyName) ?? []).some((entry) =>
                      containsWhitelistedValue(entry, whitelist, includeAllKnownKeys, visitedValues)
                    )
                  )
                } finally {
                  visitedValues.delete(candidate)
                }
              }
              const replacerCandidates = callArguments[1]
              if (
                replacerCandidates === undefined ||
                replacerCandidates.some((replacer) => isStaticallyNullish(replacer))
              ) {
                return valueCandidates.some(containsSerializedSensitive)
              }
              return replacerCandidates.some((replacer) => {
                const replacerFunction = staticFunctionExpression(replacer)
                if (replacerFunction !== undefined) {
                  const returns = functionReturnExpressions(replacerFunction)
                  if (
                    returns.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedVariables))
                  ) {
                    return true
                  }
                  const valueIdentifier = parameterIdentifier(replacerFunction.params[1])
                  const valueVariable =
                    valueIdentifier === undefined ? undefined : resolvedVariable(context, valueIdentifier)
                  if (
                    valueVariable !== undefined &&
                    returns.some((value) => containsTransparentVariableFlow(value, valueVariable)) &&
                    valueCandidates.some(containsSerializedSensitive)
                  ) {
                    return true
                  }
                  for (let parameterIndex = 0; parameterIndex < replacerFunction.params.length; parameterIndex += 1) {
                    const parameter = replacerFunction.params[parameterIndex]
                    if (parameter.type !== "RestElement" || parameter.argument.type !== "Identifier") continue
                    const valueRestIndex = 1 - parameterIndex
                    if (valueRestIndex < 0) continue
                    const restVariable = resolvedVariable(context, parameter.argument)
                    if (restVariable === undefined) continue
                    const containsRestValue = (expression, visitedVariables = new Set()) => {
                      const candidate = unwrapTypeExpression(expression)
                      if (candidate.type === "Identifier") {
                        const binding = immutableConstInitializer(candidate)
                        if (binding === undefined || visitedVariables.has(binding.variable)) return false
                        visitedVariables.add(binding.variable)
                        const containsValue = containsRestValue(binding.initializer, visitedVariables)
                        visitedVariables.delete(binding.variable)
                        return containsValue
                      }
                      if (candidate.type === "MemberExpression") {
                        const receiver = unwrapTypeExpression(candidate.object)
                        return (
                          receiver.type === "Identifier" &&
                          resolvedVariable(context, receiver) === restVariable &&
                          memberPropertyName(candidate) === String(valueRestIndex)
                        )
                      }
                      return false
                    }
                    if (
                      returns.some((value) => containsRestValue(value)) &&
                      valueCandidates.some(containsSerializedSensitive)
                    ) {
                      return true
                    }
                  }
                  const valuePattern =
                    replacerFunction.params[1]?.type === "AssignmentPattern"
                      ? replacerFunction.params[1].left
                      : replacerFunction.params[1]
                  if (valuePattern !== undefined && valuePattern.type !== "Identifier") {
                    const identifiers = []
                    const collectPatternIdentifiers = (pattern) => {
                      if (pattern.type === "Identifier") {
                        identifiers.push(pattern)
                        return
                      }
                      for (const key of context.sourceCode.visitorKeys[pattern.type] ?? []) {
                        const child = pattern[key]
                        if (Array.isArray(child)) {
                          for (const entry of child) if (entry !== null) collectPatternIdentifiers(entry)
                        } else if (child !== null && child !== undefined) {
                          collectPatternIdentifiers(child)
                        }
                      }
                    }
                    collectPatternIdentifiers(valuePattern)
                    for (const identifier of identifiers) {
                      const route = destructuringRoute(valuePattern, identifier)
                      const variable = resolvedVariable(context, identifier)
                      if (
                        route === undefined ||
                        route.excludedProperties !== undefined ||
                        route.arrayRestStart !== undefined ||
                        variable === undefined ||
                        !returns.some((value) => containsTransparentVariableFlow(value, variable))
                      ) {
                        continue
                      }
                      const projectedSensitive = valueCandidates.some((candidate) => {
                        if (candidate.hookOwner !== undefined) return false
                        const projection = immutableObjectProjection(candidate.value, route.path, new Set(), node)
                        return (
                          projection.state === "found" &&
                          projection.values.some((value) =>
                            containsTransparentDerivedOperand(value, directMatch, visitedVariables)
                          )
                        )
                      })
                      if (projectedSensitive) return true
                    }
                  }
                  if (replacerFunction.type === "FunctionExpression") {
                    const contextSensitive = (expression, visited = new Set()) => {
                      const candidate = unwrapTypeExpression(expression)
                      if (visited.has(candidate)) return false
                      visited.add(candidate)
                      try {
                        if (candidate.type === "Identifier") {
                          const binding = immutableConstInitializer(candidate)
                          return binding !== undefined && contextSensitive(binding.initializer, visited)
                        }
                        if (candidate.type === "MemberExpression") {
                          const propertyName = memberPropertyName(candidate)
                          const receiver = unwrapTypeExpression(candidate.object)
                          if (receiver.type === "Identifier" && receiver.name === "arguments" && propertyName === "1") {
                            return valueCandidates.some(containsSerializedSensitive)
                          }
                          if (receiver.type === "ThisExpression") {
                            if (propertyName === "") return valueCandidates.some(containsSerializedSensitive)
                            return valueCandidates.some((value) => {
                              if (value.hookOwner !== undefined) return false
                              const projection = immutableObjectProjection(value.value, [propertyName], new Set(), node)
                              return (
                                projection.state === "found" &&
                                projection.values.some((projected) =>
                                  containsTransparentDerivedOperand(projected, directMatch, visitedVariables)
                                )
                              )
                            })
                          }
                        }
                        if (
                          candidate.type === "BinaryExpression" &&
                          booleanComparisonOperators.has(candidate.operator)
                        ) {
                          return false
                        }
                        if (candidate.type === "CallExpression") return false
                        return (context.sourceCode.visitorKeys[candidate.type] ?? []).some((key) => {
                          const child = candidate[key]
                          return Array.isArray(child)
                            ? child.some((entry) => entry !== null && contextSensitive(entry, visited))
                            : child !== null && child !== undefined && contextSensitive(child, visited)
                        })
                      } finally {
                        visited.delete(candidate)
                      }
                    }
                    if (returns.some((value) => contextSensitive(value))) return true
                  }
                  return false
                }
                const whitelistCandidates = staticArrayCandidates(replacer, node)
                if (whitelistCandidates === undefined) return false
                const canonicalWhitelistValue = (value) => {
                  const whitelistValue = unwrapTypeExpression(value)
                  if (whitelistValue.type === "Identifier") {
                    const stringValue = immutableConstString(whitelistValue)
                    if (stringValue !== undefined) return stringValue
                    const numericValue = immutableConstNumber(whitelistValue)
                    return numericValue === undefined ? undefined : String(numericValue)
                  }
                  const numericValue = immutableConstNumber(whitelistValue)
                  if (numericValue !== undefined) return String(numericValue)
                  return staticPropertyName(whitelistValue)
                }
                const flattenedWhitelist = whitelistCandidates.flat()
                const whitelist = new Set(
                  flattenedWhitelist.map(canonicalWhitelistValue).filter((value) => value !== undefined)
                )
                const hasUnresolvedWhitelistEntry = flattenedWhitelist.some(
                  (value) => canonicalWhitelistValue(value) === undefined
                )
                return valueCandidates.some((candidate) =>
                  candidate.hookOwner === undefined
                    ? containsWhitelistedValue(candidate.value, whitelist, hasUnresolvedWhitelistEntry)
                    : containsSerializedSensitive(candidate)
                )
              })
            }
            const receiverOnlyStringMethods = new Set([
              "normalize",
              "repeat",
              "slice",
              "substring",
              "toLocaleLowerCase",
              "toLocaleUpperCase",
              "toLowerCase",
              "toUpperCase",
              "trim",
              "trimEnd",
              "trimStart"
            ])
            if (
              !["concat", "padStart", "padEnd", "replace", "replaceAll", ...receiverOnlyStringMethods].includes(
                method
              ) ||
              !isProvablyStringExpression(callee.object)
            ) {
              return false
            }
            const argumentCandidates = expandedCallArgumentCandidates(node.arguments, node) ?? []
            const propagatedArguments =
              method === "concat"
                ? argumentCandidates.flat()
                : method === "padStart" || method === "padEnd"
                  ? (argumentCandidates[1] ?? [])
                  : (argumentCandidates[1] ?? []).flatMap((replacement) => {
                      const returns = functionReturnExpressions(replacement)
                      return returns.length === 0 ? [replacement] : returns
                    })
            return (
              containsTransparentDerivedOperand(callee.object, directMatch, visitedVariables) ||
              propagatedArguments.some(
                (argument) =>
                  argument.type !== "SpreadElement" &&
                  containsTransparentDerivedOperand(argument, directMatch, visitedVariables)
              )
            )
          }
          if (node.type === "AssignmentExpression") {
            return (
              containsTransparentDerivedOperand(node.right, directMatch, visitedVariables) ||
              (node.operator !== "=" && containsTransparentDerivedOperand(node.left, directMatch, visitedVariables))
            )
          }
          if (node.type === "SequenceExpression") {
            const finalExpression = node.expressions.at(-1)
            return (
              finalExpression !== undefined &&
              containsTransparentDerivedOperand(finalExpression, directMatch, visitedVariables)
            )
          }
          if (node.type === "MemberExpression") {
            const projection = memberProjection(node)
            return projection.state === "found"
              ? projection.values.some((value) =>
                  containsTransparentDerivedOperand(value, directMatch, visitedVariables)
                )
              : containsTransparentDerivedOperand(node.object, directMatch, visitedVariables)
          }
          if (!transparentDerivedExpressionTypes.has(node.type)) return false
          const visitorKeys = context.sourceCode.visitorKeys[node.type] ?? []
          return visitorKeys.some((key) => {
            const child = node[key]
            return Array.isArray(child)
              ? child.some(
                  (entry) => entry !== null && containsTransparentDerivedOperand(entry, directMatch, visitedVariables)
                )
              : child !== null &&
                  child !== undefined &&
                  containsTransparentDerivedOperand(child, directMatch, visitedVariables)
          })
        } finally {
          visitedVariables.delete(node)
        }
      }
      const containsMatchingOperand = (node, directMatch, visitedVariables = new Set()) => {
        if (directMatch(node)) {
          return true
        }
        if (
          node.type === "TSAsExpression" ||
          node.type === "TSTypeAssertion" ||
          node.type === "TSSatisfiesExpression" ||
          node.type === "TSNonNullExpression"
        ) {
          return containsMatchingOperand(node.expression, directMatch, visitedVariables)
        }
        if (node.type.startsWith("TS")) return false
        if (node.type === "CallExpression") {
          return containsTransparentDerivedOperand(node, directMatch, visitedVariables)
        }
        if (node.type === "MemberExpression") {
          const projection = memberProjection(node)
          if (projection.state === "found") {
            return projection.values.some((value) =>
              containsTransparentDerivedOperand(value, directMatch, visitedVariables)
            )
          }
          if (
            isCalledMemberReceiver(node) &&
            containsTransparentDerivedOperand(node.object, directMatch, visitedVariables)
          ) {
            return true
          }
          return false
        }
        if (node.type === "Identifier") {
          const destructuredValues = destructuredConstValues(node)
          if (
            destructuredValues !== undefined &&
            destructuredValues.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedVariables))
          ) {
            return true
          }
          const binding = immutableConstInitializer(node)
          const expression = outerIdentityExpression(node)
          const isMemberObject =
            expression.parent?.type === "MemberExpression" && expression.parent.object === expression
          if (binding !== undefined && !isMemberObject && !visitedVariables.has(binding.variable)) {
            visitedVariables.add(binding.variable)
            const containsMatch = containsTransparentDerivedOperand(binding.initializer, directMatch, visitedVariables)
            visitedVariables.delete(binding.variable)
            if (containsMatch) return true
          }
          const scalarValues = mutableScalarValues(node, node)
          const iterationValues = forOfDeclarationValues(node)
          if (scalarValues?.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedVariables))) {
            return true
          }
          if (
            iterationValues?.some((value) => containsTransparentDerivedOperand(value, directMatch, visitedVariables))
          ) {
            return true
          }
        }
        if (node.type === "SpreadElement") {
          const arrayIdentifier = identityExpressionIdentifier(node.argument)
          const analysis = arrayIdentifier === undefined ? undefined : immutableConstArray(arrayIdentifier, node)
          if (analysis !== undefined && !visitedVariables.has(analysis.root.variable)) {
            const addedVariables = [...analysis.graphVariables].filter((variable) => !visitedVariables.has(variable))
            for (const variable of addedVariables) visitedVariables.add(variable)
            const containsMatch = [analysis.root.initializer, ...analysis.mutationValues].some((expression) =>
              containsMatchingOperand(expression, directMatch, visitedVariables)
            )
            for (const variable of addedVariables) visitedVariables.delete(variable)
            if (containsMatch) return true
          }
        }
        const visitorKeys = context.sourceCode.visitorKeys[node.type] ?? []
        return visitorKeys.some((key) => {
          const child = node[key]
          return Array.isArray(child)
            ? child.some((entry) => entry !== null && containsMatchingOperand(entry, directMatch, visitedVariables))
            : child !== null && child !== undefined && containsMatchingOperand(child, directMatch, visitedVariables)
        })
      }
      const containsProviderImmutableId = (node) => containsMatchingOperand(node, isDirectProviderImmutableId)
      const containsSensitiveConfiguration = (node) =>
        containsMatchingOperand(
          node,
          (candidate) => isCredentialEmail(candidate) || isRawCredentialApiKey(candidate) || isFixtureLocator(candidate)
        )
      const booleanAssertionMethods = new Set([
        "isFalse",
        "isNotFalse",
        "isNotOk",
        "isNotTrue",
        "isOk",
        "isTrue",
        "notOk",
        "ok"
      ])
      const isStaticAssertionMessage = (node) =>
        node !== undefined &&
        (((node.type === "Literal" || node.type === "TemplateLiteral") && staticPropertyName(node) !== undefined) ||
          (node.type === "Identifier" && immutableConstString(node) !== undefined))
      const booleanComparisonOperators = new Set(["!=", "!==", "<", "<=", "==", "===", ">", ">=", "in", "instanceof"])
      const isProvenBooleanOperand = (candidate, visitedVariables = new Set()) => {
        const node = unwrapTypeExpression(candidate)
        if (node.type === "Identifier") {
          const binding = immutableConstInitializer(node)
          if (binding === undefined || visitedVariables.has(binding.variable)) return false
          visitedVariables.add(binding.variable)
          const isBoolean = isProvenBooleanOperand(binding.initializer, visitedVariables)
          visitedVariables.delete(binding.variable)
          return isBoolean
        }
        if (node.type === "BinaryExpression") return booleanComparisonOperators.has(node.operator)
        if (node.type === "UnaryExpression") return node.operator === "!"
        if (node.type === "LogicalExpression") {
          return (
            isProvenBooleanOperand(node.left, visitedVariables) && isProvenBooleanOperand(node.right, visitedVariables)
          )
        }
        if (node.type === "ConditionalExpression") {
          return (
            isProvenBooleanOperand(node.consequent, visitedVariables) &&
            isProvenBooleanOperand(node.alternate, visitedVariables)
          )
        }
        return (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "Boolean" &&
          (resolvedVariable(context, node.callee)?.defs.length ?? 0) === 0
        )
      }

      return {
        CallExpression(node) {
          const callee = assertionMemberCallee(node.callee)
          if (callee === undefined) return
          const property = unwrapTypeExpression(callee.property)
          const method = callee.computed && property.type === "Identifier" ? undefined : staticPropertyName(property)
          const argumentsWithStableIds = node.arguments.filter(containsProviderImmutableId)
          const argumentsWithSensitiveConfiguration = node.arguments.filter(containsSensitiveConfiguration)
          const hasSensitiveOperand =
            argumentsWithStableIds.length > 0 || argumentsWithSensitiveConfiguration.length > 0
          const firstArgument = node.arguments[0]
          const booleanAssertionIsSafe =
            method !== undefined &&
            booleanAssertionMethods.has(method) &&
            firstArgument !== undefined &&
            firstArgument.type !== "SpreadElement" &&
            isProvenBooleanOperand(firstArgument) &&
            (node.arguments[1] === undefined || isStaticAssertionMessage(node.arguments[1]))
          const staticAssertionWithSensitiveOperandIsUnsafe =
            method !== undefined && hasSensitiveOperand && !booleanAssertionIsSafe
          const awsIdentityArrayLengthIsUnsafe =
            method === "lengthOf" && firstArgument?.type === "Identifier" && firstArgument.name === "awsIdentities"
          const dynamicAssertionWithStableIdsIsUnsafe = method === undefined && callee.computed && hasSensitiveOperand
          const echoesSensitiveOperand =
            staticAssertionWithSensitiveOperandIsUnsafe ||
            awsIdentityArrayLengthIsUnsafe ||
            dynamicAssertionWithStableIdsIsUnsafe
          if (!echoesSensitiveOperand) {
            return
          }
          context.report({
            messageId: "echoingAssertion",
            node
          })
        }
      }
    }
  },
  "no-invalid-branded-uuid-literal": {
    meta: {
      type: "problem",
      docs: {
        description: "require canonical UUIDv7 literals in branded Control Center identifier constructors",
        category: "Best Practices",
        recommended: false
      },
      schema: [],
      messages: {
        invalidUuid: "Use a canonical lowercase UUIDv7 literal with {{identifier}}.make()."
      }
    },
    create(context) {
      const canonicalUuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      const uuid7Identifiers = new Set([
        "AgentId",
        "AgentThreadId",
        "DomainEventId",
        "EntityId",
        "EnvironmentId",
        "EvidenceClaimId",
        "EvidenceId",
        "FollowedResourceId",
        "GovernedActionAttemptId",
        "GovernedActionAuthorizationId",
        "GovernedActionId",
        "GovernedActionTransitionId",
        "GraphNodeId",
        "JobId",
        "PersonId",
        "PluginConnectionId",
        "ProviderAccountId",
        "ReadinessAssessmentId",
        "RelationshipId",
        "RelationshipRepairProposalId",
        "RelationshipRepairReviewId",
        "ReleaseId",
        "ReviewSuggestionPublicationReservationId",
        "RoleAssignmentId",
        "SessionId",
        "ShareId",
        "WorkspaceId"
      ])
      const staticMemberName = (node) =>
        node.computed
          ? node.property.type === "Literal" && Predicate.isString(node.property.value)
            ? node.property.value
            : undefined
          : node.property.type === "Identifier"
            ? node.property.name
            : undefined
      const identifierFactory = (node) => {
        if (node.type === "Identifier") {
          const definition = importedBinding(context, node)
          const importedName =
            definition?.node.type === "ImportSpecifier" ? staticPropertyName(definition.node.imported) : undefined
          return {
            definition,
            identifier: importedName
          }
        }
        if (
          node.type === "MemberExpression" &&
          node.object.type === "Identifier" &&
          staticMemberName(node) !== undefined
        ) {
          const definition = importedBinding(context, node.object)
          return {
            definition,
            identifier: definition?.node.type === "ImportNamespaceSpecifier" ? staticMemberName(node) : undefined
          }
        }
        return {}
      }
      return {
        CallExpression(node) {
          if (
            node.callee.type !== "MemberExpression" ||
            staticMemberName(node.callee) !== "make" ||
            node.arguments.length === 0 ||
            node.arguments[0].type !== "Literal" ||
            !Predicate.isString(node.arguments[0].value) ||
            canonicalUuid7.test(node.arguments[0].value)
          ) {
            return
          }
          const { definition, identifier } = identifierFactory(node.callee.object)
          const source = importSource(definition)
          if (
            !isValueImport(definition) ||
            identifier === undefined ||
            !uuid7Identifiers.has(identifier) ||
            !Predicate.isString(source) ||
            !source.endsWith("/domain/identifiers.js")
          ) {
            return
          }
          context.report({
            data: { identifier },
            messageId: "invalidUuid",
            node
          })
        }
      }
    }
  },
  "no-opaque-instance-fields": {
    meta: {
      type: "problem",
      docs: {
        description: "disallow instance fields in classes extending Schema.Opaque(...)",
        category: "Best Practices",
        recommended: false
      },
      schema: [], // no options
      messages: {
        noFields: "Classes extending Schema.Opaque(...) must not declare instance fields."
      }
    },
    create(context) {
      // ----------------------------------------------------------------------
      // Helpers
      // ----------------------------------------------------------------------
      function isSchemaOpaqueExtension(node) {
        // expect node.superClass to be a CallExpression
        // whose callee is itself a CallExpression of Schema.Opaque
        const sc = node.superClass
        if (!sc || sc.type !== "CallExpression") return false
        const inner = sc.callee
        if (!inner || inner.type !== "CallExpression") return false
        const fn = inner.callee
        return (
          fn &&
          fn.type === "MemberExpression" &&
          fn.object.type === "Identifier" &&
          fn.object.name === "Schema" &&
          fn.property.type === "Identifier" &&
          fn.property.name === "Opaque"
        )
      }

      // ----------------------------------------------------------------------
      // Public
      // ----------------------------------------------------------------------
      function checkClass(node) {
        if (!isSchemaOpaqueExtension(node)) return

        for (const element of node.body.body) {
          // only report non-static property definitions
          if (element.type === "PropertyDefinition" && element.static === false) {
            context.report({
              node: element,
              messageId: "noFields"
            })
          }
        }
      }

      return {
        ClassDeclaration: checkClass,
        ClassExpression: checkClass
      }
    }
  }
}
