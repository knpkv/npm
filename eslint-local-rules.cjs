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

const HTTP_HANDLER_STABLE_SERVICE_SOURCES = [
  "../auth/Auth.js",
  "./ApiConfiguration.js",
  "./ApplicationServices.js",
  "./LiveStreamAdmission.js"
]

const isHttpHandleCallback = (node) => {
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return false
  const parent = node.parent
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return false
  return parent.callee.type === "MemberExpression" && staticPropertyName(parent.callee.property) === "handle"
}

module.exports = {
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
          if (node.argument?.type !== "Identifier") return
          const definition = importedBinding(context, node.argument)
          if (!isValueImport(definition) || !HTTP_HANDLER_STABLE_SERVICE_SOURCES.includes(importSource(definition))) {
            return
          }
          if (!context.sourceCode.getAncestors(node).some(isHttpHandleCallback)) return
          context.report({
            data: { service: node.argument.name },
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
