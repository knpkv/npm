const path = require("node:path")

const staticPropertyName = (node) => {
  if (node.type === "Identifier") return node.name
  if (node.type === "Literal" && typeof node.value === "string") return node.value
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

const isNamedImportFrom = (context, identifier, sources, importedNames) => {
  const definition = importedBinding(context, identifier)
  return (
    isValueImport(definition) &&
    definition.node.type === "ImportSpecifier" &&
    sources.includes(importSource(definition)) &&
    importedNames.includes(staticPropertyName(definition.node.imported))
  )
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
  if (source.type === "Literal" && typeof source.value === "string") return source.value
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
  if (key.type === "Literal" && typeof key.value === "string") return key.value
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

const isEffectModule = (context, expression) => {
  if (expression.type === "Identifier") {
    return (
      isNamespaceImportFrom(context, expression, ["effect/Effect"]) ||
      isNamedImportFrom(context, expression, ["effect"], ["Effect"])
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
  expression.type === "Literal" && typeof expression.value === "string" ? expression.value : undefined

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
      ? child.some((entry) => entry !== null && typeof entry === "object" && containsAssertion(context, entry))
      : child !== null && typeof child === "object" && containsAssertion(context, child)
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
            )
              return
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
          return typeof expression.value === "string" && expression.value.includes(":")
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
          ? node.property.type === "Literal" && typeof node.property.value === "string"
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
            typeof node.arguments[0].value !== "string" ||
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
            typeof source !== "string" ||
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
