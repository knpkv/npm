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
  while (current !== undefined) {
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
    factory.parent.id.name !== "makeCommand"
  ) {
    return false
  }
  const parameter = factory.params.find((candidate) => candidate.type === "Identifier" && candidate.name === "options")
  return (
    parameter !== undefined && resolvedVariable(context, expression.object)?.identifiers.includes(parameter) === true
  )
}

const hasIsolatedChildEnvironment = (context, options, call) => {
  if (options?.type !== "ObjectExpression") return false
  if (options.properties.some((property) => property.type === "SpreadElement")) return false
  const environment = options.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "env"
  )
  const inheritance = options.properties.filter(
    (property) => property.type === "Property" && staticPropertyName(property.key) === "extendEnv"
  )
  return (
    environment.length === 1 &&
    inheritance.length === 1 &&
    isReviewedEnvironmentProjection(context, environment[0].value, call) &&
    inheritance[0].value.type === "Literal" &&
    inheritance[0].value.value === false
  )
}

const CHILD_PROCESS_MODULE = "effect/unstable/process/ChildProcess"
const CHILD_PROCESS_BARREL = "effect/unstable/process"
const AGENT_COMMAND_SEAMS = new Map([
  ["packages/ai-claude/src/runner.ts", { importKind: "named", localName: "ChildProcess" }],
  ["packages/ai-codex/src/internal/process.ts", { importKind: "namespace", localName: "ChildProcess" }]
])

const commandSeamFor = (context) => {
  const filename = context.filename.replaceAll("\\", "/")
  for (const [suffix, seam] of AGENT_COMMAND_SEAMS) {
    if (filename.endsWith(suffix)) return seam
  }
  return undefined
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

const isHttpHandleCallback = (node) => {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return false
  const parent = node.parent
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return false
  return parent.callee.type === "MemberExpression" && staticPropertyName(parent.callee.property) === "handle"
}

module.exports = {
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
        unsafeEnvironment:
          "Pass a direct options object with env: options.environment and extendEnv: false; do not spread or inherit child environment options."
      }
    },
    create(context) {
      const approvedBindings = []
      const seam = commandSeamFor(context)
      const report = (node) => context.report({ node, messageId: "unsafeEnvironment" })

      return {
        ImportDeclaration(node) {
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
          if (node.source.value === CHILD_PROCESS_MODULE || node.source.value === CHILD_PROCESS_BARREL) report(node)
        },
        ExportNamedDeclaration(node) {
          if (node.source?.value === CHILD_PROCESS_MODULE || node.source?.value === CHILD_PROCESS_BARREL) report(node)
        },
        ImportExpression(node) {
          if (
            node.source.type === "Literal" &&
            (node.source.value === CHILD_PROCESS_MODULE || node.source.value === CHILD_PROCESS_BARREL)
          ) {
            report(node)
          }
        },
        "Program:exit"() {
          for (const binding of approvedBindings) {
            for (const reference of binding.references) {
              const call = directChildProcessMakeCall(reference.identifier)
              if (call === undefined) {
                report(reference.identifier)
                continue
              }
              if (!hasIsolatedChildEnvironment(context, call.arguments.at(-1), call)) report(call)
            }
          }
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
          const reference = importReference(context, node.argument)
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
