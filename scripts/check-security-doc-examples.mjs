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

const callName = (expression) => {
  if (TypeScript.isIdentifier(expression)) return expression.text
  if (TypeScript.isPropertyAccessExpression(expression)) return expression.name.text
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
  const digestCalls = []
  let assignsClientRequestToken = false

  const visit = (node) => {
    if (TypeScript.isPropertyAssignment(node) && propertyName(node.name) === "clientRequestToken") {
      assignsClientRequestToken = true
    }
    if (TypeScript.isCallExpression(node) && callName(node.expression) === "digestGovernedActionPayload") {
      digestCalls.push(node)
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(source)
  if (!assignsClientRequestToken || digestCalls.length === 0) return []

  return digestCalls.flatMap((call) => {
    const argument = call.arguments[0]
    if (argument === undefined || !TypeScript.isObjectLiteralExpression(argument)) {
      return [`${location}: digestGovernedActionPayload must receive the canonical token identity object`]
    }
    const fields = new Set(argument.properties.map((property) => propertyName(property.name)))
    const missing = [...REQUIRED_TOKEN_FIELDS].filter((field) => !fields.has(field))
    return missing.length === 0
      ? []
      : [`${location}: clientRequestToken digest is missing canonical field(s): ${missing.join(", ")}`]
  })
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

const program = Effect.gen(function* () {
  if (inspectTokenExample(invalidFixture, "invalid fixture").length !== 1) {
    return yield* Effect.fail(new Error("security documentation checker did not reject the two-key token fixture"))
  }
  if (inspectTokenExample(validFixture, "valid fixture").length !== 0) {
    return yield* Effect.fail(
      new Error("security documentation checker rejected the canonical three-key token fixture")
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
      diagnostics.push(...inspectTokenExample(fence[1] ?? "", `${file}: TypeScript fence ${fenceIndex}`))
    }
  }

  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe security documentation examples:\n${diagnostics.join("\n")}`))
  }

  yield* Console.log(`Security documentation examples checked across ${markdownFiles.length} Markdown files`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
