import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import * as TypeScript from "typescript"

const REQUIRED_TOKEN_FIELDS = new Set(["authorizationId", "idempotencyKey", "payloadDigest"])

const propertyName = (name) => {
  if (name === undefined) return undefined
  if (TypeScript.isIdentifier(name) || TypeScript.isStringLiteral(name)) return name.text
  return undefined
}

const inspectTokenExample = (code, location) => {
  const source = TypeScript.createSourceFile(
    `${location}.ts`,
    code,
    TypeScript.ScriptTarget.Latest,
    true,
    TypeScript.ScriptKind.TS
  )
  const initializersByScope = new Map()
  const tokenExpressions = []
  let reassignsDigestHelper = false

  const isLexicalScope = (node) =>
    TypeScript.isSourceFile(node) ||
    TypeScript.isBlock(node) ||
    TypeScript.isModuleBlock(node) ||
    TypeScript.isCaseBlock(node) ||
    TypeScript.isCatchClause(node) ||
    TypeScript.isFunctionLike(node)

  const lexicalScope = (node) => {
    let current = node.parent
    while (current !== undefined && !isLexicalScope(current)) current = current.parent
    return current
  }

  const functionScope = (node) => {
    let current = node.parent
    while (current !== undefined && !TypeScript.isFunctionLike(current) && !TypeScript.isSourceFile(current)) {
      current = current.parent
    }
    return current
  }

  const bindingNames = (name) => {
    if (TypeScript.isIdentifier(name)) return [name.text]
    const names = []
    for (const element of name.elements) {
      if (!TypeScript.isOmittedExpression(element)) {
        for (const nested of bindingNames(element.name)) names.push(nested)
      }
    }
    return names
  }

  const registerBinding = (scope, name, initializer) => {
    const scoped = initializersByScope.get(scope) ?? new Map()
    scoped.set(name, scoped.has(name) ? null : initializer)
    initializersByScope.set(scope, scoped)
  }

  const visit = (node) => {
    if (TypeScript.isVariableDeclaration(node)) {
      const declarationList = TypeScript.isVariableDeclarationList(node.parent) ? node.parent : undefined
      const immutable = declarationList !== undefined && (declarationList.flags & TypeScript.NodeFlags.Const) !== 0
      const blockScoped =
        declarationList !== undefined &&
        (declarationList.flags & (TypeScript.NodeFlags.Const | TypeScript.NodeFlags.Let)) !== 0
      const scope = TypeScript.isCatchClause(node.parent)
        ? node.parent
        : blockScoped
          ? lexicalScope(node)
          : functionScope(node)
      if (scope !== undefined) {
        const initializer =
          immutable && TypeScript.isIdentifier(node.name) && node.initializer !== undefined ? node.initializer : null
        for (const name of bindingNames(node.name)) registerBinding(scope, name, initializer)
      }
    }
    if (TypeScript.isParameter(node) && isLexicalScope(node.parent)) {
      for (const name of bindingNames(node.name)) registerBinding(node.parent, name, null)
    }
    if ((TypeScript.isFunctionDeclaration(node) || TypeScript.isClassDeclaration(node)) && node.name !== undefined) {
      const scope = lexicalScope(node)
      if (scope !== undefined) registerBinding(scope, node.name.text, null)
    }
    if (TypeScript.isImportDeclaration(node) && node.importClause !== undefined) {
      if (node.importClause.name !== undefined) {
        registerBinding(source, node.importClause.name.text, null)
      }
      const namedBindings = node.importClause.namedBindings
      if (namedBindings !== undefined) {
        if (TypeScript.isNamespaceImport(namedBindings)) {
          registerBinding(source, namedBindings.name.text, null)
        } else {
          for (const element of namedBindings.elements) {
            registerBinding(source, element.name.text, null)
          }
        }
      }
    }
    if (TypeScript.isImportEqualsDeclaration(node)) {
      registerBinding(source, node.name.text, null)
    }
    if (
      TypeScript.isBinaryExpression(node) &&
      node.operatorToken.kind === TypeScript.SyntaxKind.EqualsToken &&
      TypeScript.isIdentifier(node.left) &&
      node.left.text === "digestGovernedActionPayload"
    ) {
      reassignsDigestHelper = true
    }
    if (TypeScript.isPropertyAssignment(node) && propertyName(node.name) === "clientRequestToken") {
      tokenExpressions.push(node.initializer)
    }
    if (TypeScript.isShorthandPropertyAssignment(node) && propertyName(node.name) === "clientRequestToken") {
      tokenExpressions.push(node.name)
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(source)

  const findInitializer = (identifier) => {
    let current = identifier.parent
    while (current !== undefined) {
      if (isLexicalScope(current)) {
        const scoped = initializersByScope.get(current)
        if (scoped?.has(identifier.text)) {
          const initializer = scoped.get(identifier.text)
          return initializer !== null && initializer !== undefined && initializer.pos < identifier.pos
            ? initializer
            : null
        }
      }
      current = current.parent
    }
    return undefined
  }

  const inspectDigestCall = (call) => {
    const argument = call.arguments[0]
    if (argument === undefined || !TypeScript.isObjectLiteralExpression(argument)) {
      return {
        diagnostics: [`${location}: digestGovernedActionPayload must receive the canonical token identity object`],
        found: true,
        supported: false
      }
    }
    const fields = new Set()
    let exactCanonicalShape = argument.properties.length === REQUIRED_TOKEN_FIELDS.size
    for (const property of argument.properties) {
      if (!TypeScript.isPropertyAssignment(property)) {
        exactCanonicalShape = false
        continue
      }
      const field = propertyName(property.name)
      if (
        field === undefined ||
        !REQUIRED_TOKEN_FIELDS.has(field) ||
        fields.has(field) ||
        !TypeScript.isPropertyAccessExpression(property.initializer) ||
        !TypeScript.isIdentifier(property.initializer.expression) ||
        property.initializer.expression.text !== "request" ||
        property.initializer.name.text !== field
      ) {
        exactCanonicalShape = false
        continue
      }
      fields.add(field)
    }
    exactCanonicalShape = exactCanonicalShape && fields.size === REQUIRED_TOKEN_FIELDS.size
    return {
      diagnostics: exactCanonicalShape
        ? []
        : [
            `${location}: clientRequestToken digest must contain exactly authorizationId, idempotencyKey, and payloadDigest from their matching request fields`
          ],
      found: true,
      supported: exactCanonicalShape
    }
  }

  const inspectExpression = (expression, resolving) => {
    if (TypeScript.isCallExpression(expression)) {
      const trustedDigestHelper =
        TypeScript.isIdentifier(expression.expression) &&
        expression.expression.text === "digestGovernedActionPayload" &&
        findInitializer(expression.expression) === undefined &&
        !reassignsDigestHelper
      return trustedDigestHelper ? inspectDigestCall(expression) : { diagnostics: [], found: false, supported: false }
    }
    if (TypeScript.isIdentifier(expression)) {
      const initializer = findInitializer(expression)
      if (initializer === undefined || initializer === null || resolving.has(initializer)) {
        return { diagnostics: [], found: false, supported: false }
      }
      return inspectExpression(initializer, new Set([...resolving, initializer]))
    }
    if (
      TypeScript.isParenthesizedExpression(expression) ||
      TypeScript.isAwaitExpression(expression) ||
      TypeScript.isAsExpression(expression) ||
      TypeScript.isTypeAssertionExpression(expression) ||
      TypeScript.isNonNullExpression(expression) ||
      TypeScript.isSatisfiesExpression(expression)
    ) {
      return inspectExpression(expression.expression, resolving)
    }
    if (TypeScript.isYieldExpression(expression) && expression.expression !== undefined) {
      return inspectExpression(expression.expression, resolving)
    }
    if (TypeScript.isTemplateExpression(expression)) {
      const inspectedSpans = []
      for (const span of expression.templateSpans) {
        inspectedSpans.push(inspectExpression(span.expression, resolving))
      }
      return {
        diagnostics: inspectedSpans.flatMap(({ diagnostics }) => diagnostics),
        found: inspectedSpans.some(({ found }) => found),
        supported: inspectedSpans.every(({ supported }) => supported)
      }
    }
    if (
      TypeScript.isBinaryExpression(expression) &&
      expression.operatorToken.kind === TypeScript.SyntaxKind.PlusToken
    ) {
      const left = inspectExpression(expression.left, resolving)
      const right = inspectExpression(expression.right, resolving)
      return {
        diagnostics: [...left.diagnostics, ...right.diagnostics],
        found: left.found || right.found,
        supported: left.supported && right.supported
      }
    }
    if (
      TypeScript.isBinaryExpression(expression) &&
      expression.operatorToken.kind === TypeScript.SyntaxKind.AsteriskToken &&
      TypeScript.isIdentifier(expression.left) &&
      expression.left.text === "yield"
    ) {
      return inspectExpression(expression.right, resolving)
    }
    if (TypeScript.isStringLiteral(expression) || TypeScript.isNoSubstitutionTemplateLiteral(expression)) {
      return { diagnostics: [], found: false, supported: true }
    }
    return { diagnostics: [], found: false, supported: false }
  }

  const diagnostics = []
  for (const expression of tokenExpressions) {
    const inspected = inspectExpression(expression, new Set())
    if ((!inspected.found || !inspected.supported) && inspected.diagnostics.length === 0) {
      diagnostics.push(`${location}: clientRequestToken must derive from digestGovernedActionPayload`)
    }
    for (const diagnostic of inspected.diagnostics) diagnostics.push(diagnostic)
  }
  return diagnostics
}

const invalidFixture = `
  const digest = digestGovernedActionPayload({
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken: digest })
`
const validFixture = `
  const digest = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken: digest })
`
const shorthandInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken })
`
const shorthandValidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken })
`
const unrelatedDigestInvalidFixture = `
  const unusedDigest = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  const clientRequestToken = request.clientRequestToken
  provider.start({ clientRequestToken })
`
const mixedDynamicInvalidFixture = `
  const digest = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken: request.rawPrefix + digest })
`
const shadowedAliasInvalidFixture = `
  const clientRequestToken = request.clientRequestToken
  {
    const clientRequestToken = digestGovernedActionPayload({
      authorizationId: request.authorizationId,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: request.payloadDigest
    })
  }
  provider.start({ clientRequestToken })
`
const spreadOverrideInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest,
    ...unsafe
  })
  provider.start({ clientRequestToken })
`
const mismatchedValueInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.payloadDigest,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.authorizationId
  })
  provider.start({ clientRequestToken })
`
const duplicateFieldInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest,
    payloadDigest: unsafe
  })
  provider.start({ clientRequestToken })
`
const mutableAliasInvalidFixture = `
  let clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  clientRequestToken = request.clientRequestToken
  provider.start({ clientRequestToken })
`
const forwardAliasInvalidFixture = `
  provider.start({ clientRequestToken })
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
`
const parameterShadowInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  const dispatch = (clientRequestToken) => provider.start({ clientRequestToken })
`
const functionScopedVarInvalidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  function dispatch(useRaw) {
    if (useRaw) {
      var clientRequestToken = request.clientRequestToken
    }
    provider.start({ clientRequestToken })
  }
`
const spoofedDigestHelperInvalidFixture = `
  const digestGovernedActionPayload = () => request.clientRequestToken
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken })
`
const propertyDigestHelperInvalidFixture = `
  const clientRequestToken = unsafe.digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  provider.start({ clientRequestToken })
`
const directValidFixture = `
  provider.start({
    clientRequestToken: digestGovernedActionPayload({
      authorizationId: request.authorizationId,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: request.payloadDigest
    })
  })
`
const aliasValidFixture = `
  const tokenDigest = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  const token = \`cc-\${tokenDigest}\`
  provider.start({ clientRequestToken: token })
`
const nestedAliasValidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  {
    provider.start({ clientRequestToken })
  }
`
const nestedFunctionAliasValidFixture = `
  const clientRequestToken = digestGovernedActionPayload({
    authorizationId: request.authorizationId,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest
  })
  function dispatch() {
    if (request.enabled) {
      provider.start({ clientRequestToken })
    }
  }
`

const program = Effect.gen(function* () {
  if (inspectTokenExample(invalidFixture, "invalid fixture").length !== 1) {
    return yield* Effect.fail(new Error("security documentation checker did not reject the two-key token fixture"))
  }
  if (inspectTokenExample(validFixture, "valid fixture").length !== 0) {
    return yield* Effect.fail(
      new Error("security documentation checker rejected the canonical three-key token fixture")
    )
  }
  if (inspectTokenExample(shorthandInvalidFixture, "shorthand invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker did not reject the shorthand two-key token fixture")
    )
  }
  if (inspectTokenExample(shorthandValidFixture, "shorthand valid fixture").length !== 0) {
    return yield* Effect.fail(
      new Error("security documentation checker rejected the shorthand canonical three-key token fixture")
    )
  }
  if (inspectTokenExample(unrelatedDigestInvalidFixture, "unrelated digest invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted a raw token beside an unrelated canonical digest")
    )
  }
  if (inspectTokenExample(mixedDynamicInvalidFixture, "mixed dynamic invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted raw dynamic data mixed into a canonical digest")
    )
  }
  if (inspectTokenExample(shadowedAliasInvalidFixture, "shadowed alias invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker resolved a token alias from the wrong lexical scope")
    )
  }
  if (inspectTokenExample(spreadOverrideInvalidFixture, "spread override invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted a spread in the canonical token identity")
    )
  }
  if (inspectTokenExample(mismatchedValueInvalidFixture, "mismatched value invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted mismatched canonical token identity values")
    )
  }
  if (inspectTokenExample(duplicateFieldInvalidFixture, "duplicate field invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted a duplicate canonical token identity field")
    )
  }
  if (inspectTokenExample(mutableAliasInvalidFixture, "mutable alias invalid fixture").length !== 1) {
    return yield* Effect.fail(new Error("security documentation checker accepted a mutable canonical token alias"))
  }
  if (inspectTokenExample(forwardAliasInvalidFixture, "forward alias invalid fixture").length !== 1) {
    return yield* Effect.fail(new Error("security documentation checker accepted a token alias declared after its use"))
  }
  if (inspectTokenExample(parameterShadowInvalidFixture, "parameter shadow invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker resolved a token alias through a shadowing function parameter")
    )
  }
  if (inspectTokenExample(functionScopedVarInvalidFixture, "function scoped var invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker resolved through a function-scoped mutable var binding")
    )
  }
  if (inspectTokenExample(spoofedDigestHelperInvalidFixture, "spoofed digest helper invalid fixture").length !== 1) {
    return yield* Effect.fail(new Error("security documentation checker accepted a locally spoofed digest helper"))
  }
  if (inspectTokenExample(propertyDigestHelperInvalidFixture, "property digest helper invalid fixture").length !== 1) {
    return yield* Effect.fail(
      new Error("security documentation checker accepted an unsupported property-access digest helper")
    )
  }
  if (inspectTokenExample(directValidFixture, "direct valid fixture").length !== 0) {
    return yield* Effect.fail(new Error("security documentation checker rejected a direct canonical token digest"))
  }
  if (inspectTokenExample(aliasValidFixture, "alias valid fixture").length !== 0) {
    return yield* Effect.fail(new Error("security documentation checker rejected a canonical local token alias"))
  }
  if (inspectTokenExample(nestedAliasValidFixture, "nested alias valid fixture").length !== 0) {
    return yield* Effect.fail(
      new Error("security documentation checker rejected an immutable canonical alias from an outer scope")
    )
  }
  if (inspectTokenExample(nestedFunctionAliasValidFixture, "nested function alias valid fixture").length !== 0) {
    return yield* Effect.fail(
      new Error("security documentation checker rejected an unshadowed canonical alias inside a function")
    )
  }

  const fileSystem = yield* FileSystem.FileSystem
  const markdownFiles = yield* Effect.tryPromise({
    try: () =>
      Glob.glob([".specs/**/*.md", "packages/**/README.md", "packages/**/README.*.md"], {
        ignore: ["**/generated/**", "**/vendor/**", "**/node_modules/**", "repos/**"],
        nodir: true
      }),
    catch: (cause) => new Error("Failed to enumerate security documentation", { cause })
  })
  const diagnostics = []
  for (const file of markdownFiles.toSorted()) {
    const markdown = yield* fileSystem.readFileString(file)
    const fences = markdown.matchAll(/```(?:ts|typescript)\s*\n([\s\S]*?)```/giu)
    let fenceIndex = 0
    for (const fence of fences) {
      fenceIndex += 1
      const fenceDiagnostics = inspectTokenExample(fence[1] ?? "", `${file}: TypeScript fence ${fenceIndex}`)
      for (const diagnostic of fenceDiagnostics) diagnostics.push(diagnostic)
    }
  }

  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe security documentation examples:\n${diagnostics.join("\n")}`))
  }

  yield* Console.log(`Security documentation examples checked across ${markdownFiles.length} Markdown files`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
