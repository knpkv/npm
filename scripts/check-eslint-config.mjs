import { ESLint } from "eslint"
import { fileURLToPath, URL } from "node:url"
import fixture from "./fixtures/eslint/invalid-component.mjs"

const eslint = new ESLint()
const fixturePaths = ["packages/codecommit-web/src/invalid-component.tsx", "packages/rly/src/invalid-component.tsx"]

for (const filePath of fixturePaths) {
  const [result] = await eslint.lintText(fixture, { filePath, warnIgnored: true })

  if (result === undefined) {
    throw new Error(`ESLint returned no result for the React discovery fixture at ${filePath}`)
  }

  const explicitAnyViolation = result.messages.some(
    (message) => message.ruleId === "@typescript-eslint/no-explicit-any"
  )

  if (!explicitAnyViolation) {
    throw new Error(`React source linting did not report no-explicit-any at ${filePath}`)
  }
}

const assertRuleDiagnostics = async ({ code, eslintInstance = eslint, expected, filePath, ruleId }) => {
  const [result] = await eslintInstance.lintText(code, { filePath, warnIgnored: true })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const diagnostics = result.messages.filter((message) => message.ruleId === ruleId)
  if (diagnostics.length !== expected) {
    const locations = diagnostics.map((message) => `${message.line}:${message.column}`).join(", ")
    throw new Error(
      `${ruleId} reported ${diagnostics.length} diagnostics instead of ${expected} for ${filePath} (${locations})`
    )
  }
}

await assertRuleDiagnostics({
  code: `
    test("late clock", async ({ page }) => {
      await page.goto("/work")
      await page.clock.install()
      await page.clock.runFor(1_000)
    })
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-invalid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    test("late pause", async ({ page }) => {
      await page.goto("/work")
      await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"))
    })
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-pause-invalid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    test("late install", async ({ page }) => {
      await page.goto("/work")
      await page.clock.install()
    })
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-install-invalid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    test("installed clock", async ({ page }) => {
      await page.clock.install()
      await page.goto("/work")
      await page.clock.runFor(1_000)
    })
  `,
  expected: 0,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-valid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    test("unawaited clock", async ({ page }) => {
      page.clock.install()
      await page.goto("/work")
      await page.clock.runFor(1_000)
    })
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-unawaited-invalid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    test("mixed clock installs", async ({ page }) => {
      page.clock.install()
      await page.clock.install()
      await page.goto("/work")
      await page.clock.runFor(1_000)
    })
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-playwright-clock-mixed-invalid.spec.ts",
  ruleId: "local-rules/require-playwright-clock-before-navigation"
})

await assertRuleDiagnostics({
  code: `
    import { WorkspaceId } from "../../src/domain/identifiers.js"
    WorkspaceId.make("00000000-0000-4000-8000-000000000000")
    WorkspaceId.make("not-a-uuid")
  `,
  expected: 2,
  filePath: "packages/control-center/test/eslint-branded-uuid-invalid.ts",
  ruleId: "local-rules/no-invalid-branded-uuid-literal"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Redacted from "effect/Redacted"
    import { value as revealRedacted } from "effect/Redacted"
    import type {
      LiveConnectionConfiguration as LiveConfig
    } from "./liveConnectionConfiguration.js"
    assert.notInclude(serialized, Redacted.value(configuration.jiraApiKey))
    assert["notInclude"](serialized, configuration.jiraEmail)
    assert[\`notInclude\`](serialized, configuration.confluenceEmail)
    const method = "notInclude"
    assert[method](serialized, Redacted.value(configuration.confluenceApiKey))
    assert[method](...[serialized, configuration.jiraEmail])
    const emailField = "confluenceEmail"
    const emailKey = emailField
    assert[method](serialized, configuration[emailKey])
    const apiKeyField = "jiraApiKey"
    const apiKey = apiKeyField
    assert[method](serialized, Redacted.value(configuration[apiKey]))
    assert.strictEqual(configuration.jiraEmail, expectedEmail)
    assert.include(serialized, Redacted.value(configuration.jiraApiKey))
    assert.strictEqual(details.pipelineName, configuration.codePipelinePipeline)
    assert.isTrue(configuration.jiraEmail, "credential must exist")
    assert.isFalse(Redacted.value(configuration.jiraApiKey), "token should differ")
    const token = Redacted.value(configuration.confluenceApiKey)
    assert.include(serialized, token)
    const pipeline = configuration.codePipelinePipeline
    assert[method](details.pipelineName, pipeline)
    const config = configuration
    assert.strictEqual(actualRegion, config.awsRegion)
    const aliasedConfig = configuration
    const aliasedApiKey = aliasedConfig.jiraApiKey
    assert.isFalse(Redacted.value(aliasedApiKey), "token should differ")
    assert.include(serialized, Redacted.value(aliasedApiKey))
    assert[method](serialized, Redacted.value(aliasedApiKey))
    const closureEmail = configuration.jiraEmail
    const validateClosure = () => assert.strictEqual(actualEmail, closureEmail)
    validateClosure()
    const moduleEmailKey = "jiraEmail"
    const validateModuleKey = () =>
      assert[method](serialized, configuration[moduleEmailKey])
    validateModuleKey()
    const closureOperands = [serialized, configuration.jiraEmail] as const
    const validateClosureOperands = () => assert[method](...closureOperands)
    validateClosureOperands()
    const validateTypedConfiguration = (settings: LiveConfig) =>
      assert.strictEqual(settings.awsRegion, expectedRegion)
    validateTypedConfiguration(configuration)
    const {
      jiraApiKey: destructuredApiKey,
      jiraEmail: destructuredEmail,
      awsRegion: destructuredRegion
    } = configuration
    assert.isFalse(Redacted.value(destructuredApiKey), "token should differ")
    assert.include(serialized, Redacted.value(destructuredApiKey))
    assert[method](serialized, Redacted.value(destructuredApiKey))
    assert.strictEqual(actualEmail, destructuredEmail)
    assert[method](actualRegion, destructuredRegion)
    const tupleOperands = [serialized, configuration.jiraEmail] as const
    const tupleAlias = tupleOperands
    const validateTupleAlias = () => assert[method](...tupleAlias)
    validateTupleAlias()
    const Boolean = (value: string) => value
    assert.isFalse(Boolean(configuration.jiraEmail), "credential must be absent")
    let mutableMessage = "region must match"
    assert.isTrue(configuration.awsRegion === expectedRegion, mutableMessage)
    const interpolatedMessage = \`region must match \${expectedRegion}\`
    assert.isTrue(configuration.awsRegion === expectedRegion, interpolatedMessage)
    const typedTuple = [serialized, configuration.jiraEmail] as const
    const typedTupleAlias = typedTuple as readonly [string, string]
    assert[method](...typedTupleAlias)
    const satisfiedTuple = [serialized, configuration.jiraEmail] as const
    const satisfiedTupleAlias = satisfiedTuple satisfies readonly [string, string]
    assert[method](...satisfiedTupleAlias)
    const inlineTuple = [serialized, configuration.jiraEmail] as const
    assert[method](...(inlineTuple as readonly [string, string]))
    assert[method](...(inlineTuple satisfies readonly [string, string]))
    assert[method](...inlineTuple!)
    const sharedSensitiveTuple = [serialized, configuration.jiraEmail]
    const assertedSensitiveTuple = sharedSensitiveTuple
    const mutatedSensitiveTuple = sharedSensitiveTuple
    mutatedSensitiveTuple[1] = "sanitized"
    assert[method](...assertedSensitiveTuple)
    assert[method](...sharedSensitiveTuple)
    const partiallyMutatedTuple = [serialized, configuration.jiraEmail]
    partiallyMutatedTuple[0] = partiallyMutatedTuple[0]
    assert[method](...partiallyMutatedTuple)
    assert.notEqual(configuration.jiraEmail, expectedEmail)
    assert.notStrictEqual(configuration.jiraEmail, expectedEmail)
    assert.notDeepEqual(configuration.jiraEmail, expectedEmail)
    assert.notDeepStrictEqual(configuration.jiraEmail, expectedEmail)
    assert.deepInclude(serialized, configuration.jiraEmail)
    assert.notDeepInclude(serialized, configuration.jiraEmail)
    assert.notMatch(configuration.jiraEmail, /public/u)
    assert.isOk(configuration.jiraEmail)
    assert.ok(configuration.jiraEmail)
    assert.isNotOk(configuration.jiraEmail)
    assert.notOk(configuration.jiraEmail)
    assert.isNotTrue(configuration.jiraEmail)
    assert.isNotFalse(configuration.jiraEmail)
    assert.isNotEmpty(configuration.jiraEmail)
    assert.notEmpty(configuration.jiraEmail)
    const decoratedEmail = \`owner:\${configuration.jiraEmail}\`
    assert.notEqual(decoratedEmail, expectedEmail)
    const locatorMessage = \`region \${configuration.awsRegion}\`
    assert.ok(Boolean(false), locatorMessage)
    const directlyTaintedTuple = [serialized, "public"]
    directlyTaintedTuple[1] = configuration.jiraEmail
    assert.include(...directlyTaintedTuple)
    const aliasedTaintedTuple = [serialized, "public"]
    const taintedTupleAlias = aliasedTaintedTuple
    taintedTupleAlias[1] = configuration.jiraEmail
    assert.include(...aliasedTaintedTuple)
    const pushedTuple = [serialized, "public"]
    pushedTuple.push(configuration.jiraEmail)
    assert.include(...pushedTuple)
    const predicate = {
      test: (value: string) => value,
      includes: (value: string) => value
    }
    assert.notOk(predicate.test(configuration.jiraEmail), "credential must be absent")
    assert.ok(predicate.includes(configuration.jiraEmail), "credential must exist")
    ;(assert as typeof assert).strictEqual(actualEmail, configuration.jiraEmail)
    assert!.notEqual(actualEmail, configuration.jiraEmail)
    ;(assert.strictEqual as typeof assert.strictEqual)(actualEmail, configuration.jiraEmail)
    ;(assert[method] as typeof assert.strictEqual)(actualEmail, configuration.jiraEmail)
    ;(assert[method] satisfies typeof assert.strictEqual)(actualEmail, configuration.jiraEmail)
    ;(<typeof assert.strictEqual>assert[method])(actualEmail, configuration.jiraEmail)
    assert[method]!(actualRegion, configuration.awsRegion)
    const decoratedReceiver = \`owner:\${configuration.jiraEmail}\`
    assert.notEqual(decoratedReceiver.trim(), expectedEmail)
    const rawReceiver = Redacted.value(configuration.jiraApiKey)
    assert.strictEqual(rawReceiver.trim(), expectedToken)
    const decoratedReceiverTuple = [serialized, "public"]
    decoratedReceiverTuple.push(decoratedReceiver.trim())
    assert.include(...decoratedReceiverTuple)
    const rawReceiverTuple = [serialized, "public"]
    rawReceiverTuple.push(rawReceiver.trim())
    assert.include(...rawReceiverTuple)
    const sensitiveResult = { email: configuration.jiraEmail, status: "ok" }
    assert.equal(sensitiveResult.email, expectedEmail)
    assert.equal((sensitiveResult as typeof sensitiveResult).email, expectedEmail)
    const spreadSpliceTuple = [serialized, "public"]
    const spliceArguments = [0, 0, configuration.jiraEmail] as const
    spreadSpliceTuple.splice(...spliceArguments)
    assert.include(...spreadSpliceTuple)
    const filledTuple = [serialized, "public"]
    filledTuple.fill(configuration.jiraEmail)
    assert.include(...filledTuple)
    const unshiftedTuple = [serialized, "public"]
    unshiftedTuple.unshift(configuration.jiraEmail)
    assert.include(...unshiftedTuple)
    const pushedSpreadTuple = [serialized, "public"]
    const pushedValues = [configuration.jiraEmail] as const
    pushedSpreadTuple.push(...pushedValues)
    assert.include(...pushedSpreadTuple)
    const objectEmailKey = "email"
    const computedSensitiveResult = { [objectEmailKey]: configuration.jiraEmail }
    assert.equal(computedSensitiveResult.email, expectedEmail)
    const sensitiveSpreadSource = { email: configuration.jiraEmail }
    const sensitiveSpreadResult = { status: "ok", ...sensitiveSpreadSource }
    assert.equal(sensitiveSpreadResult.email, expectedEmail)
    assert.equal({ status: "ok", ...sensitiveSpreadSource }.email, expectedEmail)
    const nestedSensitiveResult = {
      nested: { email: configuration.jiraEmail, status: "ok" }
    }
    assert.equal(nestedSensitiveResult.nested.email, expectedEmail)
    assert.equal(sensitiveResult["email" as const], expectedEmail)
    assert["strictEqual" as const](configuration.jiraEmail, expectedEmail)
    const wrappedPushTuple = [serialized, "public"]
    ;(wrappedPushTuple.push as typeof wrappedPushTuple.push)(configuration.jiraEmail)
    assert.include(...wrappedPushTuple)
    const wrappedUnshiftTuple = [serialized, "public"]
    wrappedUnshiftTuple.unshift!(configuration.jiraEmail)
    assert.include(...wrappedUnshiftTuple)
    const wrappedSpliceTuple = [serialized, "public"]
    ;(wrappedSpliceTuple.splice satisfies typeof wrappedSpliceTuple.splice)(...spliceArguments)
    assert.include(...wrappedSpliceTuple)
    const wrappedFillTuple = [serialized, "public"]
    ;(<typeof wrappedFillTuple.fill>wrappedFillTuple.fill)(configuration.jiraEmail)
    assert.include(...wrappedFillTuple)
    const wrappedKeyPushTuple = [serialized, "public"]
    wrappedKeyPushTuple["push" as const](configuration.jiraEmail)
    assert.include(...wrappedKeyPushTuple)
    const trimmedCredentialEmail = configuration.jiraEmail.trim()
    assert.equal(trimmedCredentialEmail.toLowerCase(), expectedEmail)
    const trimmedRawToken = Redacted.value(configuration.jiraApiKey).trim()
    assert.equal(trimmedRawToken.toLowerCase(), expectedToken)
    const projectedRawResult = { token: Redacted.value(configuration.jiraApiKey) }
    assert.equal(projectedRawResult.token.trim(), expectedToken)
    const projectedTemplateResult = { email: \`owner:\${configuration.jiraEmail}\` }
    assert.equal(projectedTemplateResult.email.trim(), expectedEmail)
    const dynamicObjectKey = getDynamicKey()
    const sensitiveDynamicOverride = {
      email: configuration.jiraEmail,
      [dynamicObjectKey]: "public"
    }
    assert.equal(sensitiveDynamicOverride.email, expectedEmail)
    const opaquePublicOverrides = getPublicOverrides()
    const sensitiveOpaqueSpread = {
      email: configuration.jiraEmail,
      ...opaquePublicOverrides
    }
    assert.equal(sensitiveOpaqueSpread.email, expectedEmail)
    assert.equal(revealRedacted(configuration.jiraApiKey), expectedToken)
    const revealRedactedAlias = revealRedacted
    assert.equal(revealRedactedAlias(configuration.confluenceApiKey), expectedToken)
    const indexedSensitiveValues = ["public", configuration.jiraEmail] as const
    assert.equal(indexedSensitiveValues[1], expectedEmail)
    const nestedIndexedSensitiveValues = { values: indexedSensitiveValues }
    assert.equal(nestedIndexedSensitiveValues.values[1], expectedEmail)
    const directlyMutatedSensitiveResult = { email: "public", status: "ok" }
    directlyMutatedSensitiveResult.email = configuration.jiraEmail
    assert.equal(directlyMutatedSensitiveResult.email, expectedEmail)
    const aliasedMutatedSensitiveResult = { email: "public", status: "ok" }
    const sensitiveMutationAlias = aliasedMutatedSensitiveResult
    sensitiveMutationAlias.email = configuration.confluenceEmail
    assert.equal(aliasedMutatedSensitiveResult.email, expectedEmail)
    const sensitiveUnknownKeyResult = {
      email: "public",
      [dynamicObjectKey]: configuration.jiraEmail
    }
    assert.equal(sensitiveUnknownKeyResult.email, expectedEmail)
    const cyclicSensitiveResult = {
      email: false ? cyclicSensitiveResult.email : configuration.jiraEmail
    }
    assert.equal(cyclicSensitiveResult.email, expectedEmail)
    const destructuredSensitiveSource = { email: configuration.jiraEmail, status: "ok" }
    const { email: destructuredDerivedEmail } = destructuredSensitiveSource
    assert.equal(destructuredDerivedEmail, expectedEmail)
    const nestedDestructuredSensitiveSource = {
      nested: { email: configuration.confluenceEmail }
    }
    const {
      nested: { email: nestedDestructuredDerivedEmail }
    } = nestedDestructuredSensitiveSource
    assert.equal(nestedDestructuredDerivedEmail, expectedEmail)
    const arrayDestructuredSensitiveSource = ["public", configuration.jiraEmail] as const
    const [, arrayDestructuredDerivedEmail] = arrayDestructuredSensitiveSource
    assert.equal(arrayDestructuredDerivedEmail, expectedEmail)
    const { missing: defaultedSensitiveEmail = configuration.jiraEmail } = {}
    assert.equal(defaultedSensitiveEmail, expectedEmail)
    const publicNestedSpreadSource = { nested: { status: "ok" } }
    const sensitiveNestedSpreadSource = {
      nested: { email: configuration.jiraEmail }
    }
    const nestedSpreadSensitiveResult = {
      ...publicNestedSpreadSource,
      ...sensitiveNestedSpreadSource
    }
    assert.equal(nestedSpreadSensitiveResult.nested.email, expectedEmail)
    const loopMutatedSensitiveValues = ["public"]
    for (let index = 0; index < 2; index += 1) {
      assert.include(...loopMutatedSensitiveValues)
      loopMutatedSensitiveValues.push(configuration.jiraEmail)
    }
    const compoundSensitiveResult = { email: configuration.jiraEmail }
    compoundSensitiveResult.email += ":suffix"
    assert.equal(compoundSensitiveResult.email, expectedEmail)
    const logicalSensitiveResult = { email: configuration.jiraEmail }
    logicalSensitiveResult.email ||= "public"
    assert.equal(logicalSensitiveResult.email, expectedEmail)
    const destructuredMutationSource = { nested: { email: "public" } }
    const { nested: destructuredMutationAlias } = destructuredMutationSource
    destructuredMutationAlias.email = configuration.jiraEmail
    assert.equal(destructuredMutationSource.nested.email, expectedEmail)
    const spreadIndexedSensitiveSource = ["public", configuration.jiraEmail] as const
    const spreadIndexedSensitiveValues = [...spreadIndexedSensitiveSource]
    assert.equal(spreadIndexedSensitiveValues[1], expectedEmail)
    const pushedIndexedSensitiveValues = ["public"]
    pushedIndexedSensitiveValues.push(configuration.jiraEmail)
    assert.equal(pushedIndexedSensitiveValues[1], expectedEmail)
    const unshiftedIndexedSensitiveValues = ["public"]
    unshiftedIndexedSensitiveValues.unshift(configuration.jiraEmail)
    assert.equal(unshiftedIndexedSensitiveValues[0], expectedEmail)
    const compoundIndexedSensitiveValues = ["public"]
    compoundIndexedSensitiveValues[0] += configuration.jiraEmail
    assert.equal(compoundIndexedSensitiveValues[0], expectedEmail)
    const unknownSensitiveReadSource = {
      email: configuration.jiraEmail,
      status: "ok"
    }
    assert.equal(unknownSensitiveReadSource[getDynamicKey()], expectedEmail)
    const computedDestructuringKey = getDynamicKey()
    const { [computedDestructuringKey]: computedDestructuredEmail } =
      destructuredSensitiveSource
    assert.equal(computedDestructuredEmail, expectedEmail)
    const {
      status: excludedSensitiveRestStatus,
      ...sensitiveDestructuredRest
    } = destructuredSensitiveSource
    assert.equal(sensitiveDestructuredRest.email, expectedEmail)
    const callbackReentryValues = ["public"]
    ;[0, 1].forEach(() => {
      assert.include(...callbackReentryValues)
      callbackReentryValues.push(configuration.jiraEmail)
    })
    const reversedSensitiveValues = [configuration.jiraEmail, "public"]
    reversedSensitiveValues.reverse()
    assert.equal(reversedSensitiveValues[1], expectedEmail)
    const copiedWithinSensitiveValues = [configuration.jiraEmail, "public"]
    copiedWithinSensitiveValues.copyWithin(1, 0, 1)
    assert.equal(copiedWithinSensitiveValues[1], expectedEmail)
    const [, ...arraySensitiveRest] = ["public", configuration.jiraEmail]
    assert.equal(arraySensitiveRest[0], expectedEmail)
    const {
      status: objectSensitiveRestStatus,
      ...objectSensitiveRest
    } = { status: "ok", email: "public" }
    objectSensitiveRest.email = configuration.jiraEmail
    assert.equal(objectSensitiveRest.email, expectedEmail)
    const nestedBeforeAssertionValues = ["public"]
    if (shouldMutate) {
      nestedBeforeAssertionValues.push(configuration.jiraEmail)
    }
    assert.include(...nestedBeforeAssertionValues)
    const conditionallySanitizedResult = { email: configuration.jiraEmail }
    if (shouldMutate) {
      conditionallySanitizedResult.email = "public"
    }
    assert.equal(conditionallySanitizedResult.email, expectedEmail)
    const conditionallySanitizedValues = [configuration.jiraEmail]
    if (shouldMutate) {
      conditionallySanitizedValues[0] = "public"
    }
    assert.equal(conditionallySanitizedValues[0], expectedEmail)
    const aliasedSpliceStart = 1
    const aliasedSpliceDeleteCount = 0
    const aliasedSpliceSensitiveValues = ["public"]
    aliasedSpliceSensitiveValues.splice(
      aliasedSpliceStart,
      aliasedSpliceDeleteCount,
      configuration.jiraEmail
    )
    assert.equal(aliasedSpliceSensitiveValues[1], expectedEmail)
    const [, ...mutatedArraySensitiveRest] = ["ignored", "public"]
    mutatedArraySensitiveRest.push(configuration.jiraEmail)
    assert.equal(mutatedArraySensitiveRest[1], expectedEmail)
    const negativeFillSensitiveValues = ["public", "public"]
    negativeFillSensitiveValues.fill(configuration.jiraEmail, -1)
    assert.equal(negativeFillSensitiveValues[1], expectedEmail)
    const recursiveIifeValues = ["public"]
    ;(function validateRecursively(remaining: number) {
      assert.include(...recursiveIifeValues)
      recursiveIifeValues.push(configuration.jiraEmail)
      if (remaining > 0) validateRecursively(remaining - 1)
    })(1)
    const conditionallyReversedSensitiveValues = [
      configuration.jiraEmail,
      "public"
    ]
    if (shouldMutate) {
      conditionallyReversedSensitiveValues.reverse()
    }
    assert.equal(conditionallyReversedSensitiveValues[0], expectedEmail)
    const [, ...filledArraySensitiveRest] = ["ignored", "public"]
    filledArraySensitiveRest.fill(configuration.jiraEmail)
    assert.equal(filledArraySensitiveRest[0], expectedEmail)
    const noOpSpliceSensitiveValues = [configuration.jiraEmail]
    noOpSpliceSensitiveValues.splice()
    assert.equal(noOpSpliceSensitiveValues[0], expectedEmail)
    const infiniteFillSensitiveValues = [configuration.jiraEmail]
    infiniteFillSensitiveValues.fill("public", 1e400)
    assert.equal(infiniteFillSensitiveValues[0], expectedEmail)
    const unbracedSanitizedResult = { email: configuration.jiraEmail }
    if (shouldMutate) unbracedSanitizedResult.email = "public"
    assert.equal(unbracedSanitizedResult.email, expectedEmail)
    const shortCircuitSanitizedResult = { email: configuration.jiraEmail }
    shouldMutate && (shortCircuitSanitizedResult.email = "public")
    assert.equal(shortCircuitSanitizedResult.email, expectedEmail)
    const negativePartialFillSensitiveValues = [
      configuration.jiraEmail,
      "public"
    ]
    negativePartialFillSensitiveValues.fill("public", -1)
    assert.equal(negativePartialFillSensitiveValues[0], expectedEmail)
    const [, ...boundedFillSensitiveRest] = [
      "ignored",
      configuration.jiraEmail,
      "public"
    ]
    boundedFillSensitiveRest.fill("public", 1)
    assert.equal(boundedFillSensitiveRest[0], expectedEmail)
    const nestedRestMutationSource = { nested: { email: "public" } }
    const { ...nestedRestMutationCopy } = nestedRestMutationSource
    nestedRestMutationSource.nested.email = configuration.jiraEmail
    assert.equal(nestedRestMutationCopy.nested.email, expectedEmail)
    const revealNamespaceAlias = Redacted.value
    assert.equal(revealNamespaceAlias(configuration.jiraApiKey), expectedToken)
    assert.equal((configuration as LiveConfig).jiraEmail, expectedEmail)
    assert.equal((configuration satisfies LiveConfig).confluenceEmail, expectedEmail)
    const repeatedBranchResult = { email: "public" }
    const validateRepeatedBranch = (mutate: boolean) => {
      if (mutate) {
        repeatedBranchResult.email = configuration.jiraEmail
      } else {
        assert.equal(repeatedBranchResult.email, expectedEmail)
      }
    }
    validateRepeatedBranch(true)
    validateRepeatedBranch(false)
    const [, ...dynamicFillSensitiveRest] = [
      "ignored",
      configuration.jiraEmail,
      "public"
    ]
    dynamicFillSensitiveRest.fill("public", getStart())
    assert.equal(dynamicFillSensitiveRest[0], expectedEmail)
    const objectSharedDescendantSource = { nested: { email: "public" } }
    const objectSharedDescendantCopy = { ...objectSharedDescendantSource }
    objectSharedDescendantSource.nested.email = configuration.jiraEmail
    assert.equal(objectSharedDescendantCopy.nested.email, expectedEmail)
    const arraySharedDescendantSource = [{ email: "public" }]
    const arraySharedDescendantCopy = [...arraySharedDescendantSource]
    arraySharedDescendantSource[0].email = configuration.jiraEmail
    assert.equal(arraySharedDescendantCopy[0].email, expectedEmail)
    const arrayRestSharedDescendantSource = [{ email: "public" }]
    const [...arrayRestSharedDescendantCopy] = arrayRestSharedDescendantSource
    arrayRestSharedDescendantSource[0].email = configuration.jiraEmail
    assert.equal(arrayRestSharedDescendantCopy[0].email, expectedEmail)
    const sequenceSensitiveResult = {
      email: (recordAccess(), configuration.jiraEmail)
    }
    assert.equal(sequenceSensitiveResult.email, expectedEmail)
    const sequenceSensitiveValues = [
      (recordAccess(), configuration.confluenceEmail)
    ]
    assert.equal(sequenceSensitiveValues[0], expectedEmail)
    const RedactedNamespaceAlias = Redacted
    const revealNamespaceAliasChain = RedactedNamespaceAlias.value
    assert.equal(revealNamespaceAliasChain(configuration.jiraApiKey), expectedToken)
    const memberAliasSource = { nested: { email: "public" } }
    const memberAliasCopy = { ...memberAliasSource }
    const memberAliasNested = memberAliasSource.nested
    memberAliasNested.email = configuration.jiraEmail
    assert.equal(memberAliasCopy.nested.email, expectedEmail)
    const unresolvedInsertedValues = ["public"]
    unresolvedInsertedValues.splice(getStart(), 0, configuration.jiraEmail)
    assert.equal(unresolvedInsertedValues[1], expectedEmail)
    const unresolvedShiftedValues = ["public", configuration.jiraEmail]
    unresolvedShiftedValues.splice(getStart(), 1)
    assert.equal(unresolvedShiftedValues[0], expectedEmail)
    const stringSerializedEmail = String(configuration.jiraEmail)
    assert.equal(stringSerializedEmail, expectedEmail)
    const jsonSerializedEmail = JSON.stringify({
      email: configuration.confluenceEmail
    })
    assert.equal(jsonSerializedEmail, expectedEmail)
    assert.equal(encodeURIComponent(configuration.jiraEmail), expectedEmail)
    assert.equal("owner:".concat(configuration.jiraEmail), expectedEmail)
    assert.equal("owner".padEnd(50, configuration.jiraEmail), expectedEmail)
    assert.equal("owner".replace("owner", configuration.jiraEmail), expectedEmail)
    let assignedSensitiveEmail = "public"
    const assignmentSensitiveResult = {
      email: (assignedSensitiveEmail = configuration.jiraEmail)
    }
    assert.equal(assignmentSensitiveResult.email, expectedEmail)
    const { value: destructuredRevealRedacted } = Redacted
    assert.equal(destructuredRevealRedacted(configuration.jiraApiKey), expectedToken)
    const sensitiveGetterResult = {
      get email() {
        return configuration.confluenceEmail
      }
    }
    assert.equal(sensitiveGetterResult.email, expectedEmail)
    const assignedSensitiveResult = { email: "public" }
    Object.assign(assignedSensitiveResult, {
      email: configuration.jiraEmail
    })
    assert.equal(assignedSensitiveResult.email, expectedEmail)
    const constructedSensitiveResult = Object.assign(
      {},
      { email: configuration.jiraEmail }
    )
    assert.equal(constructedSensitiveResult.email, expectedEmail)
    const { ...RedactedCopy } = Redacted
    assert.equal(RedactedCopy.value(configuration.jiraApiKey), expectedToken)
    const redactedValueKey = "value"
    const { [redactedValueKey]: computedRevealRedacted } = Redacted
    assert.equal(computedRevealRedacted(configuration.jiraApiKey), expectedToken)
    const spreadStringValues = [configuration.jiraEmail] as const
    assert.equal(String(...spreadStringValues), expectedEmail)
    assert.equal("owner:".concat(...spreadStringValues), expectedEmail)
    assert.equal(
      "owner".replace("owner", () => configuration.confluenceEmail),
      expectedEmail
    )
    const preservedSensitiveAssign = { email: configuration.jiraEmail }
    Object.assign(preservedSensitiveAssign, { status: "ok" })
    assert.equal(preservedSensitiveAssign.email, expectedEmail)
    const nestedSensitiveAssign = { result: { email: "public" } }
    Object.assign(nestedSensitiveAssign.result, {
      email: configuration.jiraEmail
    })
    assert.equal(nestedSensitiveAssign.result.email, expectedEmail)
    let compoundSensitiveEmail = configuration.jiraEmail
    const scalarCompoundSensitiveResult = {
      email: (compoundSensitiveEmail += "-suffix")
    }
    assert.equal(scalarCompoundSensitiveResult.email, expectedEmail)
    let logicalSensitiveEmail = configuration.confluenceEmail
    const scalarLogicalSensitiveResult = {
      email: (logicalSensitiveEmail ||= "public")
    }
    assert.equal(scalarLogicalSensitiveResult.email, expectedEmail)
    const preCallSensitiveSource = { email: "public" }
    preCallSensitiveSource.email = configuration.jiraEmail
    const preCallSensitiveCopy = Object.assign({}, preCallSensitiveSource)
    assert.equal(preCallSensitiveCopy.email, expectedEmail)
    const assignedSharedDescendantSource = { nested: { email: "public" } }
    const assignedSharedDescendantCopy = Object.assign(
      {},
      assignedSharedDescendantSource
    )
    assignedSharedDescendantSource.nested.email = configuration.jiraEmail
    assert.equal(assignedSharedDescendantCopy.nested.email, expectedEmail)
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        ["email"]
      ),
      expectedEmail
    )
    const { value: defaultedRevealRedacted = identity } = Redacted
    assert.equal(defaultedRevealRedacted(configuration.jiraApiKey), expectedToken)
    const spreadRedactedArguments = [configuration.jiraApiKey] as const
    assert.equal(Redacted.value(...spreadRedactedArguments), expectedToken)
    let mutableSensitiveReceiver = configuration.jiraEmail
    assert.equal(mutableSensitiveReceiver.trim(), expectedEmail)
    let appendedSensitiveReceiver = "owner:"
    appendedSensitiveReceiver += configuration.confluenceEmail
    assert.equal(appendedSensitiveReceiver.trim(), expectedEmail)
    let destructuredWrittenEmail = "public"
    ;[destructuredWrittenEmail] = [configuration.jiraEmail]
    assert.equal(destructuredWrittenEmail, expectedEmail)
    let capturedSensitiveEmail = "public"
    const assertCapturedSensitiveEmail = () => {
      assert.equal(capturedSensitiveEmail, expectedEmail)
      capturedSensitiveEmail = configuration.jiraEmail
    }
    assertCapturedSensitiveEmail()
    assertCapturedSensitiveEmail()
    const spreadAssignSources = [{ email: configuration.jiraEmail }] as const
    const spreadAssignedTarget = { email: "public" }
    Object.assign(spreadAssignedTarget, ...spreadAssignSources)
    assert.equal(spreadAssignedTarget.email, expectedEmail)
    const spreadConstructedResult = Object.assign({}, ...spreadAssignSources)
    assert.equal(spreadConstructedResult.email, expectedEmail)
    assert.equal(
      JSON.stringify(
        { status: "ok" },
        () => configuration.jiraEmail
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (_key, value) => value
      ),
      expectedEmail
    )
    const assignIdentityTarget = { email: "public" }
    const assignIdentityResult = Object.assign(assignIdentityTarget, {
      status: "ok"
    })
    assignIdentityTarget.email = configuration.jiraEmail
    assert.equal(assignIdentityResult.email, expectedEmail)
    const dynamicAssignKey = getDynamicKey()
    const dynamicAssignResult = Object.assign(
      {},
      { email: configuration.jiraEmail },
      { [dynamicAssignKey]: "public" }
    )
    assert.equal(dynamicAssignResult.email, expectedEmail)
    const spreadRedactedNamespace = { ...Redacted }
    assert.equal(spreadRedactedNamespace.value(configuration.jiraApiKey), expectedToken)
    const assignedRedactedNamespace = Object.assign({}, Redacted)
    assert.equal(assignedRedactedNamespace.value(configuration.jiraApiKey), expectedToken)
    const secretToJson = {
      email: "public",
      toJSON() {
        return configuration.jiraEmail
      }
    }
    assert.equal(JSON.stringify(secretToJson), expectedEmail)
    let iteratedSensitiveEmail = "public"
    for (iteratedSensitiveEmail of [configuration.confluenceEmail]) {
      assert.equal(iteratedSensitiveEmail, expectedEmail)
    }
    let iifeWrittenSensitiveEmail = "public"
    ;(() => {
      iifeWrittenSensitiveEmail = configuration.jiraEmail
    })()
    assert.equal(iifeWrittenSensitiveEmail, expectedEmail)
    let outerWrittenSensitiveEmail = "public"
    const assertOuterWrittenSensitiveEmail = () =>
      assert.equal(outerWrittenSensitiveEmail, expectedEmail)
    outerWrittenSensitiveEmail = configuration.confluenceEmail
    assertOuterWrittenSensitiveEmail()
    const spreadStringifyArguments = [
      { status: "ok" },
      () => configuration.jiraEmail
    ] as const
    assert.equal(JSON.stringify(...spreadStringifyArguments), expectedEmail)
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (_key, value) => {
          const kept = value
          return kept
        }
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (_key, value = "public") => value
      ),
      expectedEmail
    )
    const fullySpreadAssignArguments = [
      {},
      { email: configuration.jiraEmail }
    ] as const
    const fullySpreadAssignResult = Object.assign(...fullySpreadAssignArguments)
    assert.equal(fullySpreadAssignResult.email, expectedEmail)
    const explicitRedactedValueCopy = { value: Redacted.value }
    assert.equal(explicitRedactedValueCopy.value(configuration.jiraApiKey), expectedToken)
    const thisSecretToJson = {
      email: configuration.jiraEmail,
      toJSON() {
        return this.email
      }
    }
    assert.equal(JSON.stringify(thisSecretToJson), expectedEmail)
    assert.equal(
      JSON.stringify(
        configuration.jiraEmail,
        (_key, value) => String(value)
      ),
      expectedEmail
    )
    let aliasedInvocationEmail = "public"
    const assertAliasedInvocationEmail = () =>
      assert.equal(aliasedInvocationEmail, expectedEmail)
    const runAliasedInvocation = assertAliasedInvocationEmail
    aliasedInvocationEmail = configuration.confluenceEmail
    runAliasedInvocation()
    const spreadMutationTarget = { email: "public" }
    Object.assign(
      ...[
        spreadMutationTarget,
        { email: configuration.jiraEmail }
      ] as const
    )
    assert.equal(spreadMutationTarget.email, expectedEmail)
    for (const declaredIterationEmail of [configuration.jiraEmail]) {
      assert.equal(declaredIterationEmail, expectedEmail)
    }
    let emptyIterationEmail = configuration.confluenceEmail
    for (emptyIterationEmail of []) {
      recordAccess()
    }
    assert.equal(emptyIterationEmail, expectedEmail)
    assert.equal(
      JSON.stringify(
        {
          0: configuration.jiraEmail,
          status: "ok"
        },
        [0]
      ),
      expectedEmail
    )
    const selfReturningToJson = {
      email: configuration.jiraEmail,
      toJSON() {
        return this
      }
    }
    assert.equal(JSON.stringify(selfReturningToJson), expectedEmail)
    const spreadToJsonHook = {
      toJSON() {
        return this.email
      }
    }
    const spreadToJsonSecret = {
      email: configuration.confluenceEmail,
      ...spreadToJsonHook
    }
    assert.equal(JSON.stringify(spreadToJsonSecret), expectedEmail)
    assert.equal(
      JSON.stringify(
        configuration.jiraEmail,
        (_key, value) => value.trim()
      ),
      expectedEmail
    )
    let callbackSensitiveEmail = "public"
    const assertCallbackSensitiveEmail = () =>
      assert.equal(callbackSensitiveEmail, expectedEmail)
    callbackSensitiveEmail = configuration.jiraEmail
    ;[0].forEach(assertCallbackSensitiveEmail)
    const nestedSpreadMutationTarget = { result: { email: "public" } }
    Object.assign(
      ...[
        nestedSpreadMutationTarget.result,
        { email: configuration.confluenceEmail }
      ] as const
    )
    assert.equal(nestedSpreadMutationTarget.result.email, expectedEmail)
    assert.equal(
      JSON.stringify(
        { Infinity: configuration.jiraEmail },
        [Infinity]
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        { NaN: configuration.confluenceEmail },
        [NaN]
      ),
      expectedEmail
    )
    const frozenRedactedValueCopy = Object.freeze({ value: Redacted.value })
    assert.equal(frozenRedactedValueCopy.value(configuration.jiraApiKey), expectedToken)
    const frozenSensitiveObject = Object.freeze({
      email: configuration.jiraEmail
    })
    assert.equal(frozenSensitiveObject.email, expectedEmail)
    let inlineCallbackSensitiveEmail = "public"
    ;[0].forEach(() => {
      inlineCallbackSensitiveEmail = configuration.confluenceEmail
    })
    assert.equal(inlineCallbackSensitiveEmail, expectedEmail)
    let calledSensitiveEmail = "public"
    const writeCalledSensitiveEmail = () => {
      calledSensitiveEmail = configuration.jiraEmail
    }
    const aliasedCalledWriter = writeCalledSensitiveEmail
    aliasedCalledWriter.call(undefined)
    assert.equal(calledSensitiveEmail, expectedEmail)
    let appliedSensitiveEmail = "public"
    const writeAppliedSensitiveEmail = () => {
      appliedSensitiveEmail = configuration.confluenceEmail
    }
    writeAppliedSensitiveEmail.apply(undefined, [])
    assert.equal(appliedSensitiveEmail, expectedEmail)
    let firstBreakSensitiveEmail = "public"
    for (firstBreakSensitiveEmail of [
      configuration.jiraEmail,
      "public"
    ]) {
      break
    }
    assert.equal(firstBreakSensitiveEmail, expectedEmail)
    const destructuringToJson = {
      email: configuration.confluenceEmail,
      toJSON() {
        const { email } = this
        return email
      }
    }
    assert.equal(JSON.stringify(destructuringToJson), expectedEmail)
    assert.equal(
      JSON.stringify(
        configuration.jiraEmail,
        function () {
          return arguments[1]
        }
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail, status: "ok" },
        (_key, { email }) => email
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        [configuration.confluenceEmail, "ok"],
        (_key, [email]) => email
      ),
      expectedEmail
    )
    assert.equal(
      JSON.stringify(
        { secret: configuration.jiraEmail },
        function () {
          return this.secret
        }
      ),
      expectedEmail
    )
    const unresolvedWhitelistKey = getPropertyName()
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        [unresolvedWhitelistKey]
      ),
      expectedEmail
    )
    const numericExpressionWhitelistKey = 1 - 1
    assert.equal(
      JSON.stringify(
        { 0: configuration.confluenceEmail },
        [numericExpressionWhitelistKey]
      ),
      expectedEmail
    )
    const frozenToJsonReturn = {
      toJSON() {
        return Object.freeze({ email: configuration.jiraEmail })
      }
    }
    assert.equal(JSON.stringify(frozenToJsonReturn), expectedEmail)
    const aliasedThisToJson = {
      email: configuration.confluenceEmail,
      status: "ok",
      toJSON() {
        const self = this
        return self.email
      }
    }
    assert.equal(JSON.stringify(aliasedThisToJson), expectedEmail)
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (...args) => args[1]
      ),
      expectedEmail
    )
    const frozenToJsonOwner = Object.freeze({
      email: configuration.jiraEmail,
      toJSON() {
        return this.email
      }
    })
    assert.equal(JSON.stringify(frozenToJsonOwner), expectedEmail)
  `,
  expected: 228,
  filePath: "packages/control-center/test/integration/live-secret-assertion-invalid.test.ts",
  ruleId: "local-rules/no-echoing-secret-assertions"
})

await assertRuleDiagnostics({
  code: `
    import type {
      LiveConnectionConfiguration as LiveConfig
    } from "./liveConnectionConfiguration.js"
    import { assertSensitiveTextAbsent } from "./liveSecretAssertions.js"
    assertSensitiveTextAbsent(serialized, Redacted.value(configuration.jiraApiKey))
    import { assert } from "@effect/vitest"
    const method = "notInclude"
    assert[method](publicSummary, "non-sensitive")
    assert[method](...[publicSummary, "non-sensitive"])
    const operands = [publicSummary, "non-sensitive"] as const
    assert[method](...operands)
    const publicCredentialField = "siteUrl"
    const publicCredentialKey = publicCredentialField
    assert[method](serialized, configuration[publicCredentialKey])
    assert.isTrue(
      details.pipelineName === configuration.codePipelinePipeline,
      "pipeline must match"
    )
    const matches = details.pipelineName === configuration.codePipelinePipeline
    assert.isTrue(matches, "pipeline must match")
    const publicValue = publicSummary.status
    assert.strictEqual(actualStatus, publicValue)
    const validateSynthetic = (configuration: { readonly awsRegion: string }) =>
      assert.strictEqual(configuration.awsRegion, "synthetic")
    type LiveConnectionConfiguration = { readonly awsRegion: string }
    const validateSameName = (configuration: LiveConnectionConfiguration) =>
      assert.strictEqual(configuration.awsRegion, "synthetic")
    const validateImported = (settings: LiveConfig) =>
      assert.isTrue(settings.awsRegion === "eu-west-1", "region must match")
    const protectedApiKey = configuration.jiraApiKey
    assert.isTrue(protectedApiKey.toString() === "<redacted>", "token wrapper must remain redacted")
    const moduleProviderId = publicSummary.providerId
    const validateProviderId = () => assert.strictEqual(actualProviderId, moduleProviderId)
    validateProviderId()
    assert.isTrue(Boolean(configuration.jiraEmail), "credential must exist")
    const constantMessage = "region must match"
    const templateMessage = \`region must match\`
    const { awsRegion: safeRegion, jiraApiKey: protectedDestructuredApiKey } = configuration
    assert.isTrue(safeRegion === "eu-west-1", constantMessage)
    assert.isTrue(configuration.awsRegion === "eu-west-1", templateMessage)
    assert.isTrue(configuration.awsRegion === "eu-west-1", \`region must match\`)
    assert.isTrue(
      protectedDestructuredApiKey.toString() === "<redacted>",
      "token wrapper must remain redacted"
    )
    const syntheticConfiguration = { awsRegion: "synthetic" }
    const { awsRegion: syntheticRegion } = syntheticConfiguration
    assert.strictEqual(syntheticRegion, "synthetic")
    const publicTuple = [actualStatus, publicSummary.status] as const
    const publicTupleAlias = publicTuple
    assert.strictEqual(...publicTupleAlias)
    const typedPublicTupleAlias = publicTuple as readonly [string, string]
    assert.strictEqual(...typedPublicTupleAlias)
    assert.strictEqual(...(publicTuple as readonly [string, string]))
    assert.notEqual(publicSummary.status, "private")
    assert.notStrictEqual(publicSummary.status, "private")
    assert.notDeepEqual(publicSummary.status, "private")
    assert.notDeepStrictEqual(publicSummary.status, "private")
    assert.deepInclude(publicSummary.status, "public")
    assert.notDeepInclude(publicSummary.status, "private")
    assert.notMatch(publicSummary.status, /private/u)
    assert.isOk(publicSummary.status)
    assert.ok(publicSummary.status)
    assert.isNotOk(publicSummary.status)
    assert.notOk(publicSummary.status)
    assert.isNotTrue(publicSummary.status)
    assert.isNotFalse(publicSummary.status)
    assert.isNotEmpty(publicSummary.status)
    assert.notEmpty(publicSummary.status)
    assert.ok(configuration.awsRegion === "eu-west-1", "region must match")
    assert.isOk(configuration.awsRegion === "eu-west-1", "region must match")
    assert.notOk(configuration.awsRegion !== "eu-west-1", "region must match")
    assert.isNotOk(configuration.awsRegion !== "eu-west-1", "region must match")
    assert.isNotTrue(configuration.awsRegion !== "eu-west-1", "region must match")
    assert.isNotFalse(configuration.awsRegion === "eu-west-1", "region must match")
    const derivedMatches = configuration.awsRegion === "eu-west-1"
    assert.ok(derivedMatches, "region must match")
    const locatorConjunction =
      configuration.awsRegion === "eu-west-1" &&
      configuration.jiraProjectId === expectedProjectId
    assert.isTrue(locatorConjunction, "fixture locators must match")
    assert.notOk(Boolean(pattern.test(configuration.jiraEmail)), "credential must not match")
    assert.isTrue(configuration.awsRegion in publicRegionMap, "region must exist")
    assert.isTrue(publicSummary instanceof PublicSummary, "summary must have the public type")
    const publicDescription = \`status:\${publicSummary.status}\`
    assert.notEqual(publicDescription, "private")
    const publiclyMutatedTuple = [serialized, "public"]
    publiclyMutatedTuple[1] = "sanitized"
    const publicMutationAlias = publiclyMutatedTuple
    publicMutationAlias.push("public")
    assert.include(...publiclyMutatedTuple)
    ;(assert as typeof assert).strictEqual(actualStatus, publicSummary.status)
    assert!.notEqual(actualStatus, "private")
    ;(assert.strictEqual as typeof assert.strictEqual)(actualStatus, publicSummary.status)
    const shadowAssert = { strictEqual: (_actual: unknown, _expected: unknown) => undefined }
    ;(shadowAssert as typeof shadowAssert).strictEqual(actualEmail, configuration.jiraEmail)
    const publicResult = { email: configuration.jiraEmail, status: "ok" }
    assert.equal(publicResult.status, "ok")
    assert.equal((publicResult as typeof publicResult).status, "ok")
    const response = makeRequest(configuration.jiraEmail)
    assert.equal((response as Response).status, 200)
    const publicSpliceTuple = [serialized, "public"]
    publicSpliceTuple.splice(...([0, 0, "public"] as const))
    assert.include(...publicSpliceTuple)
    const publicFillTuple = [serialized, "public"]
    publicFillTuple.fill("public")
    assert.include(...publicFillTuple)
    const publicUnshiftTuple = [serialized, "public"]
    publicUnshiftTuple.unshift("public")
    assert.include(...publicUnshiftTuple)
    const publicPushSpreadTuple = [serialized, "public"]
    publicPushSpreadTuple.push(...(["public"] as const))
    assert.include(...publicPushSpreadTuple)
    const publicEmailKey = "email"
    const publicComputedResult = { [publicEmailKey]: "public" }
    assert.equal(publicComputedResult.email, "public")
    const publicSpreadSource = { email: "public" }
    const publicSpreadResult = { status: "ok", ...publicSpreadSource }
    assert.equal(publicSpreadResult.email, "public")
    const publicOverrideResult = { ...publicResult, email: "public" }
    assert.equal(publicOverrideResult.email, "public")
    const nestedPublicResult = {
      nested: { email: configuration.jiraEmail, status: "ok" }
    }
    assert.equal(nestedPublicResult.nested.status, "ok")
    assert["ok" as const](Boolean(configuration.jiraEmail), "credential must exist")
    const wrappedPublicPushTuple = [serialized, "public"]
    ;(wrappedPublicPushTuple.push as typeof wrappedPublicPushTuple.push)("public")
    assert.include(...wrappedPublicPushTuple)
    const wrappedPublicUnshiftTuple = [serialized, "public"]
    wrappedPublicUnshiftTuple.unshift!("public")
    assert.include(...wrappedPublicUnshiftTuple)
    const wrappedPublicSpliceTuple = [serialized, "public"]
    ;(wrappedPublicSpliceTuple.splice satisfies typeof wrappedPublicSpliceTuple.splice)(
      ...([0, 0, "public"] as const)
    )
    assert.include(...wrappedPublicSpliceTuple)
    const wrappedPublicFillTuple = [serialized, "public"]
    ;(<typeof wrappedPublicFillTuple.fill>wrappedPublicFillTuple.fill)("public")
    assert.include(...wrappedPublicFillTuple)
    const wrappedPublicKeyPushTuple = [serialized, "public"]
    wrappedPublicKeyPushTuple["push" as const]("public")
    assert.include(...wrappedPublicKeyPushTuple)
    const opaqueStatus = fetchStatus(configuration.jiraEmail)
    assert.equal(opaqueStatus.trim(), "ok")
    const opaqueCallResult = { status: fetchStatus(configuration.jiraEmail) }
    assert.equal(opaqueCallResult.status.trim(), "ok")
    const opaqueNestedResult = {
      response: { status: fetchStatus(configuration.jiraEmail) }
    }
    assert.equal(opaqueNestedResult.response.status.trim(), "ok")
    const opaqueCallAlias = opaqueCallResult as typeof opaqueCallResult
    assert.equal(opaqueCallAlias.status.trim(), "ok")
    const opaqueRequestStatus = makeRequest(configuration.jiraEmail).getStatus()
    assert.equal(opaqueRequestStatus.trim(), "ok")
    const publicMethodResult = publicSummary.status.trim()
    assert.equal(publicMethodResult.toLowerCase(), "ok")
    const definitePublicOverride = {
      email: configuration.jiraEmail,
      ...getPublicOverrides(),
      email: "public"
    }
    assert.equal(definitePublicOverride.email, "public")
    function* validateOpaqueYield() {
      const yieldedStatus = yield fetchStatus(configuration.jiraEmail)
      assert.equal(yieldedStatus.trim(), "ok")
      const yieldedResult = { status: yield fetchStatus(configuration.jiraEmail) }
      assert.equal(yieldedResult.status.trim(), "ok")
    }
    validateOpaqueYield()
    const localValue = <Value>(value: Value): Value => value
    assert.equal(localValue(configuration.jiraApiKey).toString(), "<redacted>")
    const indexedPublicValues = ["public", configuration.jiraEmail] as const
    assert.equal(indexedPublicValues[0], "public")
    const nestedIndexedPublicValues = { values: indexedPublicValues }
    assert.equal(nestedIndexedPublicValues.values[0], "public")
    const otherPropertyMutation = { email: "public", status: "pending" }
    otherPropertyMutation.status = configuration.jiraEmail
    assert.equal(otherPropertyMutation.email, "public")
    const definitelyPublicMutation = { email: configuration.jiraEmail }
    definitelyPublicMutation.email = "public"
    assert.equal(definitelyPublicMutation.email, "public")
    const dynamicSensitiveBeforePublic = {
      [getDynamicKey()]: configuration.jiraEmail,
      email: "public"
    }
    assert.equal(dynamicSensitiveBeforePublic.email, "public")
    const dynamicPublicAfterPublic = {
      email: "public",
      [getDynamicKey()]: "public"
    }
    assert.equal(dynamicPublicAfterPublic.email, "public")
    const cyclicPublicResult = {
      email: false ? cyclicPublicResult.email : "public"
    }
    assert.equal(cyclicPublicResult.email, "public")
    const destructuredPublicSource = {
      email: configuration.jiraEmail,
      status: "ok"
    }
    const { status: destructuredDerivedStatus } = destructuredPublicSource
    assert.equal(destructuredDerivedStatus, "ok")
    const arrayDestructuredPublicSource = ["public", configuration.jiraEmail] as const
    const [arrayDestructuredPublicStatus] = arrayDestructuredPublicSource
    assert.equal(arrayDestructuredPublicStatus, "public")
    const { missing: defaultedPublicStatus = "public" } = {}
    assert.equal(defaultedPublicStatus, "public")
    const shallowSensitiveNestedSource = {
      nested: { email: configuration.jiraEmail }
    }
    const shallowPublicNestedReplacement = { nested: { status: "ok" } }
    const shallowNestedOverrideResult = {
      ...shallowSensitiveNestedSource,
      ...shallowPublicNestedReplacement
    }
    assert.equal(shallowNestedOverrideResult.nested.email, undefined)
    const mutatedAfterAssertion = [serialized, "public"]
    assert.include(...mutatedAfterAssertion)
    mutatedAfterAssertion.push(configuration.jiraEmail)
    const aliasedMutationAfterAssertion = [serialized, "public"]
    const mutationAfterAssertionAlias = aliasedMutationAfterAssertion
    assert.include(...aliasedMutationAfterAssertion)
    mutationAfterAssertionAlias.push(configuration.jiraEmail)
    const compoundPublicResult = { email: "public" }
    compoundPublicResult.email += ":suffix"
    assert.equal(compoundPublicResult.email, "public:suffix")
    const destructuredPublicMutationSource = { nested: { email: "public" } }
    const { nested: destructuredPublicMutationAlias } = destructuredPublicMutationSource
    destructuredPublicMutationAlias.email = "still-public"
    assert.equal(destructuredPublicMutationSource.nested.email, "still-public")
    const spreadIndexedPublicSource = ["public", configuration.jiraEmail] as const
    const spreadIndexedPublicValues = [...spreadIndexedPublicSource]
    assert.equal(spreadIndexedPublicValues[0], "public")
    const pushedIndexedPublicValues = ["public"]
    pushedIndexedPublicValues.push(configuration.jiraEmail)
    assert.equal(pushedIndexedPublicValues[0], "public")
    const unshiftedIndexedPublicValues = ["public"]
    unshiftedIndexedPublicValues.unshift(configuration.jiraEmail)
    assert.equal(unshiftedIndexedPublicValues[1], "public")
    const unknownPublicReadSource = { status: "ok", summary: "public" }
    assert.equal(unknownPublicReadSource[getDynamicKey()], "public")
    const computedPublicDestructuringKey = getDynamicKey()
    const {
      [computedPublicDestructuringKey]: computedDestructuredPublicValue
    } = unknownPublicReadSource
    assert.equal(computedDestructuredPublicValue, "public")
    const {
      email: excludedPublicRestEmail,
      ...publicDestructuredRest
    } = destructuredPublicSource
    assert.equal(publicDestructuredRest.status, "ok")
    const definitelyPresentDefaultSource = { email: "public" }
    const {
      email: definitelyPresentDefaultEmail = configuration.jiraEmail
    } = definitelyPresentDefaultSource
    assert.equal(definitelyPresentDefaultEmail, "public")
    const reversedAfterAssertionValues = [configuration.jiraEmail, "public"]
    assert.equal(reversedAfterAssertionValues[1], "public")
    reversedAfterAssertionValues.reverse()
    const nestedArrayMutationAfterAssertion = ["public"]
    assert.include(...nestedArrayMutationAfterAssertion)
    if (shouldMutate) {
      nestedArrayMutationAfterAssertion.push(configuration.jiraEmail)
    }
    const nestedObjectMutationAfterAssertion = { email: "public" }
    assert.equal(nestedObjectMutationAfterAssertion.email, "public")
    if (shouldMutate) {
      nestedObjectMutationAfterAssertion.email = configuration.jiraEmail
    }
    const definitelyPublicAlias = "public"
    const {
      value: definitelyAliasedDefaultValue = configuration.jiraEmail
    } = { value: definitelyPublicAlias }
    assert.equal(definitelyAliasedDefaultValue, "public")
    const unknownReadSensitiveBase = { email: configuration.jiraEmail }
    const unknownReadPublicOverride = {
      ...unknownReadSensitiveBase,
      email: "public",
      status: "ok"
    }
    assert.equal(unknownReadPublicOverride[getDynamicKey()], "public")
    const [, ...arrayPublicRest] = ["ignored", "public"]
    assert.equal(arrayPublicRest[0], "public")
    const {
      status: objectPublicRestStatus,
      ...objectPublicRest
    } = { status: "ok", email: "public" }
    objectPublicRest.email = "still-public"
    assert.equal(objectPublicRest.email, "still-public")
    function validateInvocationLocalValues() {
      const invocationLocalValues = ["public"]
      assert.include(...invocationLocalValues)
      invocationLocalValues.push(configuration.jiraEmail)
    }
    validateInvocationLocalValues()
    const aliasedEqualFillBound = 1
    const aliasedNoOpFillValues = ["public"]
    aliasedNoOpFillValues.fill(
      configuration.jiraEmail,
      aliasedEqualFillBound,
      aliasedEqualFillBound
    )
    assert.equal(aliasedNoOpFillValues[0], "public")
    const [, ...mutatedArrayRestAfterAssertion] = ["ignored", "public"]
    assert.equal(mutatedArrayRestAfterAssertion[0], "public")
    mutatedArrayRestAfterAssertion.push(configuration.jiraEmail)
    ;(() => {
      const anonymousIifeValues = ["public"]
      assert.include(...anonymousIifeValues)
      anonymousIifeValues.push(configuration.jiraEmail)
    })()
    const objectRestSnapshotSource = { email: "public" }
    const { ...objectRestSnapshot } = objectRestSnapshotSource
    objectRestSnapshotSource.email = configuration.jiraEmail
    assert.equal(objectRestSnapshot.email, "public")
    const mutuallyExclusiveResult = { email: "public" }
    if (shouldMutate) {
      assert.equal(mutuallyExclusiveResult.email, "public")
    } else {
      mutuallyExclusiveResult.email = configuration.jiraEmail
    }
    const conditionallyPublicValues = ["public", "public"]
    if (shouldMutate) {
      conditionallyPublicValues.reverse()
    }
    assert.equal(conditionallyPublicValues[0], "public")
    const switchExclusiveResult = { email: "public" }
    switch (selectedCase) {
      case "assert":
        assert.equal(switchExclusiveResult.email, "public")
        break
      case "mutate":
        switchExclusiveResult.email = configuration.jiraEmail
        break
    }
    const conditionalExclusiveResult = { email: "public" }
    shouldMutate
      ? (conditionalExclusiveResult.email = configuration.jiraEmail)
      : assert.equal(conditionalExclusiveResult.email, "public")
    const fullySanitizedNegativeFillValues = [
      configuration.jiraEmail,
      "public"
    ]
    fullySanitizedNegativeFillValues.fill("public", -2)
    assert.equal(fullySanitizedNegativeFillValues[0], "public")
    const [, ...fullySanitizedBoundedRest] = [
      "ignored",
      configuration.jiraEmail,
      "public"
    ]
    fullySanitizedBoundedRest.fill("public", 0, 1)
    assert.equal(fullySanitizedBoundedRest[0], "public")
    const objectSpreadSnapshotSource = { email: "public" }
    const objectSpreadSnapshot = { ...objectSpreadSnapshotSource }
    objectSpreadSnapshotSource.email = configuration.jiraEmail
    assert.equal(objectSpreadSnapshot.email, "public")
    const arraySpreadSnapshotSource = ["public"]
    const arraySpreadSnapshot = [...arraySpreadSnapshotSource]
    arraySpreadSnapshotSource[0] = configuration.jiraEmail
    assert.equal(arraySpreadSnapshot[0], "public")
    const arrayRestSnapshotSource = ["public"]
    const [...arrayRestSnapshotCopy] = arrayRestSnapshotSource
    arrayRestSnapshotSource[0] = configuration.jiraEmail
    assert.equal(arrayRestSnapshotCopy[0], "public")
    const unrelatedValueNamespace = {
      value: (value: unknown) => value
    }
    const unrelatedValueAlias = unrelatedValueNamespace.value
    assert.equal(unrelatedValueAlias(configuration.jiraApiKey).toString(), "<redacted>")
    const wrappedSyntheticConfiguration = {
      configuration: { jiraEmail: "public", status: "ok" }
    }
    assert.equal(wrappedSyntheticConfiguration.configuration.jiraEmail, "public")
    const sequencePublicResult = {
      email: (configuration.jiraEmail, "public")
    }
    assert.equal(sequencePublicResult.email, "public")
    assert.equal(fetchStatus(configuration.jiraEmail), "ok")
    const directOpaqueAlias = fetchStatus(configuration.jiraEmail)
    assert.equal(directOpaqueAlias, "ok")
    let assignedPublicEmail = configuration.jiraEmail
    const assignmentPublicResult = {
      email: (assignedPublicEmail = "public")
    }
    assert.equal(assignmentPublicResult.email, "public")
    const unrelatedDestructuringNamespace = {
      value: (value: unknown) => value
    }
    const { value: unrelatedDestructuredValue } = unrelatedDestructuringNamespace
    assert.equal(unrelatedDestructuredValue(configuration.jiraApiKey).toString(), "<redacted>")
    const publicGetterResult = {
      get email() {
        return "public"
      }
    }
    assert.equal(publicGetterResult.email, "public")
    const assignedPublicResult = { email: configuration.jiraEmail }
    Object.assign(
      assignedPublicResult,
      { email: configuration.jiraEmail },
      { email: "public" }
    )
    assert.equal(assignedPublicResult.email, "public")
    const constructedPublicResult = Object.assign(
      {},
      { email: configuration.jiraEmail },
      { email: "public" }
    )
    assert.equal(constructedPublicResult.email, "public")
    const customFormatter = {
      concat: (_value: string) => "public",
      replace: (_pattern: string, _value: string) => "public"
    }
    assert.equal(customFormatter.concat(configuration.jiraEmail), "public")
    assert.equal(
      customFormatter.replace("owner", configuration.confluenceEmail),
      "public"
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        () => "<redacted>"
      ),
      '"<redacted>"'
    )
    const assignedSnapshotSource = { email: "public" }
    const assignedSnapshot = Object.assign({}, assignedSnapshotSource)
    assignedSnapshotSource.email = configuration.jiraEmail
    assert.equal(assignedSnapshot.email, "public")
    const nestedSanitizedAssign = {
      result: { email: configuration.jiraEmail }
    }
    Object.assign(nestedSanitizedAssign.result, { email: "public" })
    assert.equal(nestedSanitizedAssign.result.email, "public")
    let compoundPublicEmail = configuration.jiraEmail
    compoundPublicEmail = "public"
    const compoundPublicResult = { email: (compoundPublicEmail += "-suffix") }
    assert.equal(compoundPublicResult.email, "public-suffix")
    const unrelatedRedactedNamespace = {
      value: (value: unknown) => value
    }
    const { ...unrelatedRedactedCopy } = unrelatedRedactedNamespace
    assert.equal(
      unrelatedRedactedCopy.value(configuration.jiraApiKey).toString(),
      "<redacted>"
    )
    const unrelatedValueKey = "value"
    const {
      [unrelatedValueKey]: unrelatedComputedReveal
    } = unrelatedRedactedNamespace
    assert.equal(
      unrelatedComputedReveal(configuration.jiraApiKey).toString(),
      "<redacted>"
    )
    const { value: unrelatedDefaultedReveal = identity } =
      unrelatedRedactedNamespace
    assert.equal(
      unrelatedDefaultedReveal(configuration.jiraApiKey).toString(),
      "<redacted>"
    )
    const multipleRedactedArguments = [
      configuration.jiraApiKey,
      configuration.confluenceApiKey
    ] as const
    assert.equal(
      Redacted.value(...multipleRedactedArguments).toString(),
      "<redacted>"
    )
    let overwrittenMutableReceiver = configuration.jiraEmail
    overwrittenMutableReceiver = "public"
    assert.equal(overwrittenMutableReceiver.trim(), "public")
    let laterSensitiveEmail = "public"
    assert.equal(laterSensitiveEmail, "public")
    laterSensitiveEmail = configuration.jiraEmail
    assert.equal(
      JSON.stringify(
        {
          email: configuration.jiraEmail,
          status: "ok"
        },
        ["status"]
      ),
      '{"status":"ok"}'
    )
    const spreadOverrideSources = [
      { email: configuration.jiraEmail },
      { email: "public" }
    ] as const
    const spreadOverrideResult = Object.assign({}, ...spreadOverrideSources)
    assert.equal(spreadOverrideResult.email, "public")
    const overriddenRedactedNamespace = {
      ...Redacted,
      value: (_value: unknown) => "public"
    }
    assert.equal(overriddenRedactedNamespace.value(configuration.jiraApiKey), "public")
    const locallyAssignedNamespace = Object.assign(
      {},
      unrelatedRedactedNamespace
    )
    assert.equal(
      locallyAssignedNamespace.value(configuration.jiraApiKey).toString(),
      "<redacted>"
    )
    const publicToJson = {
      email: configuration.jiraEmail,
      toJSON() {
        return "<redacted>"
      }
    }
    assert.equal(JSON.stringify(publicToJson), '"<redacted>"')
    let iteratedPublicEmail = "public"
    for (iteratedPublicEmail of ["first", "second"]) {
      assert.equal(iteratedPublicEmail, "public")
    }
    let afterInvocationEmail = "public"
    const assertBeforeLaterWrite = () =>
      assert.equal(afterInvocationEmail, "public")
    assertBeforeLaterWrite()
    ;(() => {
      afterInvocationEmail = configuration.jiraEmail
    })()
    assert.equal(
      JSON.stringify(
        {
          outer: {
            email: configuration.jiraEmail,
            status: "ok"
          }
        },
        ["outer", "status"]
      ),
      '{"outer":{"status":"ok"}}'
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (_key, value) => Boolean(value)
      ),
      "true"
    )
    assert.equal(
      JSON.stringify(
        configuration.jiraEmail,
        (_key, value) => value === null
      ),
      "false"
    )
    let overwrittenIterationEmail = configuration.jiraEmail
    for (overwrittenIterationEmail of ["public"]) {
      assert.equal(overwrittenIterationEmail, "public")
    }
    const numericWhitelistPublic = {
      0: configuration.jiraEmail,
      1: "public"
    }
    assert.equal(JSON.stringify(numericWhitelistPublic, [1]), '{"1":"public"}')
    let aliasAfterInvocationEmail = "public"
    const assertAliasBeforeWrite = () =>
      assert.equal(aliasAfterInvocationEmail, "public")
    const runAliasBeforeWrite = assertAliasBeforeWrite
    runAliasBeforeWrite()
    aliasAfterInvocationEmail = configuration.jiraEmail
    const spreadMutationOverrideTarget = { email: "public" }
    Object.assign(
      ...[
        spreadMutationOverrideTarget,
        { email: configuration.jiraEmail },
        { email: "public" }
      ] as const
    )
    assert.equal(spreadMutationOverrideTarget.email, "public")
    let emptyBodyPublicEmail = "public"
    for (emptyBodyPublicEmail of []) {
      emptyBodyPublicEmail = configuration.jiraEmail
    }
    assert.equal(emptyBodyPublicEmail, "public")
    let emptyDestructuredPublicEmail = "public"
    for ([emptyDestructuredPublicEmail] of []) {
      emptyDestructuredPublicEmail = configuration.confluenceEmail
    }
    assert.equal(emptyDestructuredPublicEmail, "public")
    let postLoopPublicEmail = configuration.jiraEmail
    for (postLoopPublicEmail of ["public"]) {
      recordAccess()
    }
    assert.equal(postLoopPublicEmail, "public")
    const publicSpreadToJsonHook = {
      toJSON() {
        return this.email
      }
    }
    const publicSpreadToJsonValue = {
      email: configuration.jiraEmail,
      ...publicSpreadToJsonHook,
      email: "public"
    }
    assert.equal(JSON.stringify(publicSpreadToJsonValue), '"public"')
    let opaqueCallbackEmail = "public"
    const opaqueCallback = () =>
      assert.equal(opaqueCallbackEmail, "public")
    opaqueCallbackEmail = configuration.jiraEmail
    opaqueApi(opaqueCallback)
    const nestedSpreadOverrideTarget = {
      result: { email: configuration.jiraEmail }
    }
    Object.assign(
      ...[
        nestedSpreadOverrideTarget.result,
        { email: configuration.jiraEmail },
        { email: "public" }
      ] as const
    )
    assert.equal(nestedSpreadOverrideTarget.result.email, "public")
    assert.equal(
      JSON.stringify(
        {
          Infinity: configuration.jiraEmail,
          NaN: "ok"
        },
        [NaN]
      ),
      '{"NaN":"ok"}'
    )
    const frozenUnrelatedValue = Object.freeze({
      value: (_value: unknown) => "public"
    })
    assert.equal(frozenUnrelatedValue.value(configuration.jiraApiKey), "public")
    let emptyForEachEmail = "public"
    ;[].forEach(() => {
      emptyForEachEmail = configuration.jiraEmail
    })
    assert.equal(emptyForEachEmail, "public")
    let thisArgEmail = "public"
    const untouchedForEachCallback = () => undefined
    ;[0].forEach(untouchedForEachCallback, () => {
      thisArgEmail = configuration.jiraEmail
    })
    assert.equal(thisArgEmail, "public")
    let calledAfterAssertionEmail = "public"
    const writeAfterAssertionEmail = () => {
      calledAfterAssertionEmail = configuration.jiraEmail
    }
    assert.equal(calledAfterAssertionEmail, "public")
    writeAfterAssertionEmail.call(undefined)
    let firstBreakPublicEmail = configuration.jiraEmail
    for (firstBreakPublicEmail of [
      "public",
      configuration.confluenceEmail
    ]) {
      break
    }
    assert.equal(firstBreakPublicEmail, "public")
    const publicDestructuringToJson = {
      email: configuration.jiraEmail,
      status: "ok",
      toJSON() {
        const { status } = this
        return status
      }
    }
    assert.equal(JSON.stringify(publicDestructuringToJson), '"ok"')
    assert.equal(
      JSON.stringify(
        configuration.jiraEmail,
        function () {
          return arguments[0]
        }
      ),
      '""'
    )
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail, status: "ok" },
        (_key, { status }) => status
      ),
      '"ok"'
    )
    assert.equal(
      JSON.stringify(
        { secret: configuration.jiraEmail, status: "ok" },
        function () {
          return this.status
        }
      ),
      expectedEmail
    )
    const publicNumericExpressionKey = 2 - 1
    assert.equal(
      JSON.stringify(
        { 0: configuration.jiraEmail, 1: "public" },
        [publicNumericExpressionKey]
      ),
      '{"1":"public"}'
    )
    const frozenPublicToJsonReturn = {
      toJSON() {
        return Object.freeze({ email: "public" })
      }
    }
    assert.equal(JSON.stringify(frozenPublicToJsonReturn), '{"email":"public"}')
    const aliasedThisPublicToJson = {
      email: configuration.jiraEmail,
      status: "ok",
      toJSON() {
        const self = this
        return self.status
      }
    }
    assert.equal(JSON.stringify(aliasedThisPublicToJson), '"ok"')
    assert.equal(
      JSON.stringify(
        { email: configuration.jiraEmail },
        (...args) => args[0]
      ),
      '""'
    )
    let nestedBreakFinalPublicEmail = "public"
    for (nestedBreakFinalPublicEmail of [
      configuration.jiraEmail,
      "public"
    ]) {
      switch (selectedCase) {
        case "stop":
          break
      }
    }
    assert.equal(nestedBreakFinalPublicEmail, "public")
    const frozenPublicToJsonOwner = Object.freeze({
      email: configuration.jiraEmail,
      toJSON() {
        return "<redacted>"
      }
    })
    assert.equal(JSON.stringify(frozenPublicToJsonOwner), '"<redacted>"')
    const suffix = "Include"
    assert[\`not\${suffix}\`](publicSummary, "non-sensitive")
  `,
  expected: 0,
  filePath: "packages/control-center/test/integration/live-secret-assertion-valid.test.ts",
  ruleId: "local-rules/no-echoing-secret-assertions"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    assert.match(identity.providerImmutableId, /^[0-9]{12}$/u)
    assert.strictEqual(left.providerImmutableId, right.providerImmutableId)
    assert.equal(left.identity.providerImmutableId, right.identity.providerImmutableId)
    assert.lengthOf(awsIdentities, 2)
    assert.isTrue(identity.providerImmutableId, "constant message")
    assert.isTrue(String(identity.providerImmutableId), "constant message")
    assert.isTrue(pattern.test(identity.providerImmutableId), dynamicMessage)
    const method = "notInclude"
    assert[method](serialized, identity.providerImmutableId)
    assert[method](...[serialized, identity.providerImmutableId])
    const operands = [left.providerImmutableId, right.providerImmutableId] as const
    assert.strictEqual(...operands)
    const computedOperands = [serialized, identity.providerImmutableId] as const
    assert[method](...computedOperands)
    const sensitiveKeyBase = "providerImmutableId"
    const sensitiveKey = sensitiveKeyBase
    assert.strictEqual(result[sensitiveKey], expectedProviderId)
  `,
  expected: 11,
  filePath: "packages/control-center/test/integration/live-provider-id-assertion-invalid.test.ts",
  ruleId: "local-rules/no-echoing-secret-assertions"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    const pattern = /^[0-9]{12}$/u
    assert.isTrue(Boolean(pattern.test(identity.providerImmutableId)), "constant message")
    assert.isTrue(
      left.providerImmutableId === right.providerImmutableId,
      "constant message"
    )
    assert.isTrue(awsIdentities.length === 2, "two AWS identities")
    const publicKey = "providerId"
    const safeKey = publicKey
    assert.strictEqual(result[safeKey], "jira")
    const operands = [publicSummary, "non-sensitive"] as const
    assert.strictEqual(...operands)
    const method = "strictEqual"
    assert[method](...operands)
  `,
  expected: 0,
  filePath: "packages/control-center/test/integration/live-provider-id-assertion-valid.test.ts",
  ruleId: "local-rules/no-echoing-secret-assertions"
})

await assertRuleDiagnostics({
  code: `
    import * as Identifiers from "../../src/domain/identifiers.js"
    Identifiers.WorkspaceId.make("00000000-0000-4000-8000-000000000000")
    Identifiers["WorkspaceId"].make("not-a-uuid")
    Identifiers.WorkspaceId.make("00000000-0000-7000-8000-000000000000")
  `,
  expected: 2,
  filePath: "packages/control-center/test/eslint-branded-uuid-namespace-invalid.ts",
  ruleId: "local-rules/no-invalid-branded-uuid-literal"
})

await assertRuleDiagnostics({
  code: `
    import * as Identifiers from "../../src/domain/identifiers.js"
    const WorkspaceId = "WorkspaceId"
    const make = "make"
    Identifiers[WorkspaceId].make("00000000-0000-4000-8000-000000000000")
    Identifiers.WorkspaceId[make]("00000000-0000-4000-8000-000000000000")
    const acceptsShadowedNamespace = (Identifiers) =>
      Identifiers.WorkspaceId.make("00000000-0000-4000-8000-000000000000")
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-branded-uuid-namespace-valid.ts",
  ruleId: "local-rules/no-invalid-branded-uuid-literal"
})

await assertRuleDiagnostics({
  code: `
    import { PrReviewSuggestionRevisionId, WorkspaceId } from "../../src/domain/identifiers.js"
    WorkspaceId.make("00000000-0000-7000-8000-000000000000")
    WorkspaceId.make(candidate)
    PrReviewSuggestionRevisionId.make("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-branded-uuid-valid.ts",
  ruleId: "local-rules/no-invalid-branded-uuid-literal"
})

await assertRuleDiagnostics({
  code: `
    import { WorkspaceId } from "../src/domain/identifiers.js"
    WorkspaceId.make("00000000-0000-4000-8000-000000000000")
  `,
  expected: 1,
  filePath: "packages/control-center/e2e/eslint-branded-uuid-invalid.spec.ts",
  ruleId: "local-rules/no-invalid-branded-uuid-literal"
})

await assertRuleDiagnostics({
  code: `
    import * as Fx from "effect/Effect"
    import { Effect as RootFx } from "effect"
    import { runPromise as run } from "effect/Effect"
    Fx.runPromise(program).catch(() => {})
    Fx.runPromise(program).catch(() => void 0)
    Fx.runPromise(program).then(undefined, () => undefined)
    RootFx.runPromise(program).catch(() => undefined)
    run(program).catch(function () { return })
  `,
  expected: 5,
  filePath: "packages/control-center/src/client/eslint-run-promise-invalid.ts",
  ruleId: "local-rules/no-silent-run-promise-rejection"
})

await assertRuleDiagnostics({
  code: `
    import * as Fx from "effect/Effect"
    Fx.runPromiseExit(program).then(handleExit)
    Fx.runPromise(program).catch(reportFailure)
    Fx.runPromise(program).catch((failure) => void reportFailure(failure))
    Fx.runPromise(program).catch((failure) => void setState(failure))
  `,
  expected: 0,
  filePath: "packages/control-center/src/client/eslint-run-promise-valid.ts",
  ruleId: "local-rules/no-silent-run-promise-rejection"
})

await assertRuleDiagnostics({
  code: `
    import * as S from "effect/Schema"
    import * as Effect from "effect"
    import { NumberFromString as UnsafeNumber } from "effect/Schema"
    export { NumberFromString as UnsafeExport } from "effect/Schema"
    S["NumberFromString"]
    const { NumberFromString: unsafe } = Effect.Schema
  `,
  expected: 4,
  filePath: "packages/control-center/src/api/eslint-number-from-string-invalid.ts",
  ruleId: "local-rules/no-number-from-string-in-control-center-api"
})

await assertRuleDiagnostics({
  code: `
    window.sessionStorage.getItem("cc_csrf")
    const storage = sessionStorage
    storage.getItem("cc_csrf")
  `,
  expected: 2,
  filePath: "packages/control-center/src/client/eslint-mutation-proof-invalid.ts",
  ruleId: "local-rules/no-direct-mutation-proof-read"
})

await assertRuleDiagnostics({
  code: `
    const client = yield* makeAuthenticatedMutationClient
    sessionStorage.getItem("theme")
  `,
  expected: 0,
  filePath: "packages/control-center/src/client/eslint-mutation-proof-valid.ts",
  ruleId: "local-rules/no-direct-mutation-proof-read"
})

await assertRuleDiagnostics({
  code: `sessionStorage.getItem("cc_csrf")`,
  expected: 0,
  filePath: "packages/control-center/src/client/authenticatedMutationClient.ts",
  ruleId: "local-rules/no-direct-mutation-proof-read"
})

await assertRuleDiagnostics({
  code: `
    const direct = \`/w/\${workspaceId}/items/\${entityId}\`
    const encoded = \`/w/\${workspaceId}/items/\${encodeURIComponent(relatedEntityId)}\`
  `,
  expected: 2,
  filePath: "packages/control-center/src/client/entities/eslint-workspace-entity-path-invalid.ts",
  ruleId: "local-rules/no-ad-hoc-workspace-entity-path"
})

await assertRuleDiagnostics({
  code: `
    const releaseItem = \`/w/\${workspaceId}/items/\${releaseId}\`
    const unrelated = \`/w/\${workspaceId}/releases/\${entityId}\`
    const canonical = workspaceEntityPath(workspaceId, entityId)
  `,
  expected: 0,
  filePath: "packages/control-center/src/client/entities/eslint-workspace-entity-path-valid.ts",
  ruleId: "local-rules/no-ad-hoc-workspace-entity-path"
})

await assertRuleDiagnostics({
  code: `const testHref = \`/w/\${workspaceId}/items/\${entityId}\``,
  expected: 0,
  filePath: "packages/control-center/test/client/eslint-workspace-entity-path.test.ts",
  ruleId: "local-rules/no-ad-hoc-workspace-entity-path"
})

await assertRuleDiagnostics({
  code: `const generatedHref = \`/w/\${workspaceId}/items/\${entityId}\``,
  expected: 0,
  filePath: "packages/control-center/src/client/generated/eslint-workspace-entity-path.ts",
  ruleId: "local-rules/no-ad-hoc-workspace-entity-path"
})

await assertRuleDiagnostics({
  code: `export const workspaceEntityPath = (workspaceId, entityId) => \`/w/\${workspaceId}/items/\${entityId}\``,
  expected: 0,
  filePath: "packages/control-center/src/client/workspaceEntityPaths.ts",
  ruleId: "local-rules/no-ad-hoc-workspace-entity-path"
})

await assertRuleDiagnostics({
  code: `
    const ReplyCommentRequestPayload = Schema.Struct({ parentCommentId: JiraProviderIdentity })
    const FixVersionRequestPayload = Schema.Struct({ versionIds: Schema.Array(JiraProviderIdentity) })
    const LinkIssueRequestPayload = Schema.Struct({ linkedIssueId: JiraProviderIdentity })
    const JiraActionIssue = Schema.Struct({ id: JiraProviderIdentity })
  `,
  expected: 4,
  filePath: "packages/control-center/src/server/plugins/jira/JiraGovernedActions.ts",
  ruleId: "local-rules/require-jira-path-identifier-schema"
})

await assertRuleDiagnostics({
  code: `provider.getIssue(request.target.vendorImmutableId)`,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/jira/JiraReadPlugin.ts",
  ruleId: "local-rules/require-jira-path-identifier-schema"
})

await assertRuleDiagnostics({
  code: `
    const targetIssueId = yield* decodeJiraProviderPathIdentifier(request.target.vendorImmutableId)
    provider.getIssue(targetIssueId)
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/plugins/jira/JiraReadPlugin.ts",
  ruleId: "local-rules/require-jira-path-identifier-schema"
})

await assertRuleDiagnostics({
  code: `
    const ReplyCommentRequestPayload = Schema.Struct({ parentCommentId: JiraProviderPathIdentifier })
    const FixVersionRequestPayload = Schema.Struct({ versionIds: Schema.Array(JiraProviderPathIdentifier) })
    const LinkIssueRequestPayload = Schema.Struct({
      linkedIssueId: JiraProviderPathIdentifier,
      linkTypeName: JiraProviderIdentity
    })
    const JiraActionIssue = Schema.Struct({ id: JiraProviderPathIdentifier })
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/plugins/jira/JiraGovernedActions.ts",
  ruleId: "local-rules/require-jira-path-identifier-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Process from "effect/unstable/process/ChildProcess"
    import { ChildProcess as AliasedProcess } from "effect/unstable/process"
    import { make as makeProcess } from "effect/unstable/process/ChildProcess"
    import * as BarrelProcess from "effect/unstable/process"
    Process.make("codex", ["exec"], {
      metadata: { env: options.environment, extendEnv: false },
      stdout: "pipe"
    })
    AliasedProcess.make("codex", ["exec"], {
      env: options.environment,
      extendEnv: false,
      ...unsafeOptions
    })
    makeProcess("codex", ["exec"], dynamicOptions)
    BarrelProcess.ChildProcess.make("codex", ["exec"], dynamicOptions)
    const makeIndirectly = Process.make
    makeIndirectly("codex", ["exec"], dynamicOptions)
    Process.make.call(undefined, "codex", ["exec"], dynamicOptions)
    function shadowed(options) {
      return Process.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
    export { ChildProcess } from "effect/unstable/process"
    const dynamicallyLoaded = import("effect/unstable/process/ChildProcess")
    const templateLoaded = import(\`effect/unstable/process/ChildProcess\`)
    const moduleName = "effect/unstable/process/ChildProcess"
    const computedLoaded = import(moduleName)
    import { createRequire as makeRequire } from "node:module"
    const require = makeRequire(import.meta.url)
    const required = require("effect/unstable/process/ChildProcess")
  `,
  expected: 9,
  filePath: "packages/ai-codex/src/eslint-agent-environment-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { createRequire as makeRequire } from "module"
    const require = makeRequire(import.meta.url)
    const ChildProcess = require("effect/unstable/process/ChildProcess")
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/commonjs-import-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    export { createRequire } from "node:module"
    export { default as Loader } from "node:module"
    export * from "module"
  `,
  expected: 3,
  filePath: "packages/ai-codex/src/commonjs-export-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    const nodeModule = import("node:module")
    const legacyModule = import("module")
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/commonjs-dynamic-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { builtinModules as nodeBuiltins } from "node:module"
    import { builtinModules as legacyBuiltins } from "module"
    export { builtinModules } from "node:module"
    import type { Module as NodeModule } from "node:module"
    export type { Module as LegacyModule } from "module"
    export type * from "node:module"
    type ModuleNamespace = typeof import("node:module")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/commonjs-safe.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    const Process = await import("node:process")
    const Module = Process.getBuiltinModule("module")
    const require = Module.createRequire(import.meta.url)
    const ChildProcess = require("effect/unstable/process/ChildProcess")
    const runtime = process
    runtime.getBuiltinModule("module")
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/raw-process-invalid.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import type { Process } from "node:process"
    export type { Process as LegacyProcess } from "process"
    export type * from "node:process"
    const process = { getBuiltinModule: () => undefined }
    process.getBuiltinModule()
    type ProcessNamespace = typeof import("node:process")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/raw-process-safe.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/tmp/packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

const aiCodexEslint = new ESLint({
  cwd: fileURLToPath(new URL("../packages/ai-codex/", import.meta.url))
})
const aiClaudeEslint = new ESLint({
  cwd: fileURLToPath(new URL("../packages/ai-claude/", import.meta.url))
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    export type { ChildProcess }
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  eslintInstance: aiCodexEslint,
  expected: 0,
  filePath: "src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      Object.freeze(ChildProcess.make(
        (Object.assign(options.args, { 0: "--dangerously-bypass-safety" }), options.executable),
        Object.freeze([...options.args]),
        Object.freeze({
          env: Object.freeze({ ...options.environment }),
          extendEnv: false
        })
      ))
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options): typeof options.args =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...options.args]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", arguments_, Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { Stream } from "effect"
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false,
        stdin: { stream: Stream.make(options.prompt).pipe(Stream.encodeText), endOnDone: true }
      })))
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      const command = Object.freeze(ChildProcess.make("codex", ["exec"], Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
      Object.assign(command.options, { extendEnv: true })
      Object.assign(command.options.env, unsafeEnvironment)
      return command
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options["environ" + "ment"], unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options[environmentKey], unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        ["stdout"]: "pipe"
      })
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options.environment.SECRET = "leak"
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      Object.assign(options.environment, unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      const environment = options.environment
      Object.assign(environment, unsafeEnvironment)
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) =>
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
  `,
  eslintInstance: aiCodexEslint,
  expected: 1,
  filePath: "src/tmp/packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const makeCommand = (options, arguments_): ChildProcess.Command & { readonly args: typeof arguments_ } =>
      Object.freeze(ChildProcess.make("claude", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment }),
        extendEnv: false
      })))
  `,
  eslintInstance: aiClaudeEslint,
  expected: 0,
  filePath: "src/runner.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make(
        (inspect(arguments_), "claude"),
        Object.freeze([...arguments_]),
        Object.freeze({
          env: Object.freeze({ ...options.environment }),
          extendEnv: false
        })
      ))
  `,
  expected: 1,
  filePath: "packages/ai-claude/src/runner.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options.environment = unsafeEnvironment
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        [inheritanceKey]: true
      })
      ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false,
        [environmentKey]: unsafeEnvironment
      })
    }
  `,
  expected: 2,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const wrapper = () => {
      const makeCommand = (options) =>
        ChildProcess.make("codex", ["exec"], {
          env: options.environment,
          extendEnv: false
        })
      return makeCommand
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      options = unsafeOptions
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 1,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options) => {
      ChildProcess.make("codex", ["exec"], {
        metadata: { env: options.environment, extendEnv: false }
      })
      const makeIndirectly = ChildProcess.make
      makeIndirectly("codex", ["exec"], dynamicOptions)
      ChildProcess.make.call(undefined, "codex", ["exec"], dynamicOptions)
    }
    function shadowed(options) {
      return ChildProcess.make("codex", ["exec"], {
        env: options.environment,
        extendEnv: false
      })
    }
  `,
  expected: 4,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("codex", Object.freeze([...arguments_]), Object.freeze({
        env: Object.freeze({ ...options.environment } as typeof options.environment),
        extendEnv: false,
        stdout: "pipe"
      })))
    const localHelper = import("./known-local-helper.js")
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/internal/process.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
    const makeCommand = (options, arguments_) =>
      Object.freeze(ChildProcess.make("claude", Object.freeze([...arguments_]), Object.freeze({
        extendEnv: false,
        env: Object.freeze({ ...options.environment })
      })))
  `,
  expected: 0,
  filePath: "packages/ai-claude/src/runner.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    export type { Command } from "effect/unstable/process/ChildProcess"
    export type * from "effect/unstable/process/ChildProcess"
    export { ChildProcessSpawner } from "effect/unstable/process"
    import type { Module } from "node:module"
  `,
  expected: 0,
  filePath: "packages/ai-codex/src/type-exports.ts",
  ruleId: "local-rules/require-isolated-agent-child-environment"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { expect } from "@effect/vitest"
    import * as Result from "effect/Result"
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-expect-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Vitest from "vitest"
    import { Result } from "effect"
    if (Result.isFailure(result)) {
      Vitest.expect(result.failure._tag).toBe("BackupStorageError")
    }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      Vitest.expect(result.failure.operation).toEqual("read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-expect-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Result from "effect/Result"
    const expect = (value) => ({ toBe: () => value })
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-local-expect-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { expect } from "@effect/vitest"
    import * as Result from "effect/Result"
    const assert = { strictEqual: () => undefined }
    assert.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      expect(result.failure.operation).toBe("read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-local-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Result from "effect/Result"
    const assert = { strictEqual: () => undefined }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-local-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert as verify } from "@effect/vitest"
    import * as Result from "effect/Result"
    verify.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      verify.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-aliased-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.notStrictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-negative-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 1,
  filePath: "packages/control-center/test/eslint-result-tag-direct-assert-invalid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import * as Result from "effect/Result"
    assert.strictEqual(strictResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(strictResult) && strictResult.failure._tag === "BackupStorageError") {
      assert.strictEqual(strictResult.failure.operation, "read-manifest")
    }
    assert.equal(equalResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(equalResult) && equalResult.failure._tag === "BackupStorageError") {
      assert.equal(equalResult.failure.operation, "read-manifest")
    }
    assert.deepEqual(deepResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(deepResult) && deepResult.failure._tag === "BackupStorageError") {
      assert.deepEqual(deepResult.failure.operation, "read-manifest")
    }
    assert.deepStrictEqual(deepStrictResult.failure._tag, "BackupStorageError")
    if (Result.isFailure(deepStrictResult) && deepStrictResult.failure._tag === "BackupStorageError") {
      assert.deepStrictEqual(deepStrictResult.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-assert-equality-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import * as Vitest from "vitest"
    import * as Result from "effect/Result"
    Vitest.assert.strictEqual(result.failure._tag, "BackupStorageError")
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      Vitest.assert.strictEqual(result.failure.operation, "read-manifest")
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-namespaced-assert-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `
    import { assert } from "@effect/vitest"
    import { Result } from "effect"
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure._tag, "BackupStorageError")
    }
    if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
      assert.strictEqual(result.failure.operation, "read-manifest")
    }
    if (
      Result.isFailure(other) &&
      (other.failure._tag === "BackupInputError" || other.failure._tag === "BackupStorageError")
    ) {
      assert.include(["BackupInputError", "BackupStorageError"], other.failure._tag)
    }
  `,
  expected: 0,
  filePath: "packages/control-center/test/eslint-result-tag-valid.test.ts",
  ruleId: "local-rules/no-conditional-only-result-tag-assertion"
})

await assertRuleDiagnostics({
  code: `export const layerFactory = () => ({ service: "auth" })`,
  expected: 1,
  filePath: "packages/control-center/src/server/auth/Auth.ts",
  ruleId: "@typescript-eslint/explicit-module-boundary-types"
})

await assertRuleDiagnostics({
  code: `export const layerFactory = () => ({ service: "application" })`,
  expected: 0,
  filePath: "packages/control-center/src/server/application/not-reviewed.ts",
  ruleId: "@typescript-eslint/explicit-module-boundary-types"
})

await assertRuleDiagnostics({
  code: `
    import * as Effect from "effect/Effect"
    import { Auth } from "../auth/Auth.js"
    import { CurrentSession } from "../../api/session.js"
    import { PluginAdministration } from "./ApplicationServices.js"
    import { FutureStableService } from "./FutureService.js"
    import * as Services from "./FutureServices.js"
    const AliasedStableService = FutureStableService
    const optionalService = Effect.serviceOption
    handlers
      .handle("first", () => Effect.gen(function*() {
        const auth = yield* Auth
        const session = yield* CurrentSession
        return { auth, session }
      }))
      .handle("second", function() {
        return Effect.gen(function*() {
          return yield* PluginAdministration
        })
      })
      .handle("future", () => Effect.gen(function*() {
        return yield* FutureStableService
      }))
      .handle("namespace", () => Effect.gen(function*() {
        return yield* Services.FutureStableService
      }))
      .handle("alias", () => Effect.gen(function*() {
        return yield* AliasedStableService
      }))
      .handle("optional", () => Effect.gen(function*() {
        return yield* Effect.serviceOption(PluginAdministration)
      }))
      .handle("optional-alias", () => Effect.gen(function*() {
        return yield* optionalService(FutureStableService)
      }))
  `,
  expected: 7,
  filePath: "packages/control-center/src/server/api/Handlers.ts",
  ruleId: "local-rules/no-stable-service-yield-in-http-handler"
})

await assertRuleDiagnostics({
  code: `
    import * as Effect from "effect/Effect"
    import { Auth } from "../auth/Auth.js"
    import { CurrentSession as RequestSession } from "../../api/session.js"
    import * as SessionServices from "../../api/session.js"
    import { PluginAdministration } from "./ApplicationServices.js"
    const AliasedRequestSession = RequestSession
    Effect.gen(function*() {
      const auth = yield* Auth
      const plugins = yield* PluginAdministration
      const optionalPlugins = yield* Effect.serviceOption(PluginAdministration)
      return handlers.handle("first", () => Effect.gen(function*() {
        const session = yield* RequestSession
        const aliasedSession = yield* AliasedRequestSession
        const namespaceSession = yield* SessionServices.CurrentSession
        return { aliasedSession, auth, namespaceSession, optionalPlugins, plugins, session }
      }))
    })
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/api/Handlers.ts",
  ruleId: "local-rules/no-stable-service-yield-in-http-handler"
})

await assertRuleDiagnostics({
  code: `
    import * as CanonicalSchemas from "./canonical-wire.js"
    export { type NumberFromString } from "effect/Schema"
    export type { NumberFromString as NumberFromStringType } from "effect/Schema"
    CanonicalSchemas.NumberFromString
  `,
  expected: 0,
  filePath: "packages/control-center/src/api/eslint-number-from-string-valid.ts",
  ruleId: "local-rules/no-number-from-string-in-control-center-api"
})

await assertRuleDiagnostics({
  code: `
    import * as Encoding from "effect/Encoding"
    import * as Result from "effect/Result"
    import * as Schema from "effect/Schema"
    const ArtifactBytes = Schema.String.check(
      Schema.makeFilter((value) => {
        const decoded = Encoding.decodeBase64(value)
        return Result.isSuccess(decoded) && decoded.success.byteLength <= 1_048_576
      })
    )
  `,
  expected: 1,
  filePath: "packages/control-center/src/domain/plugins/eslint-base64-bound-invalid.ts",
  ruleId: "local-rules/require-bounded-base64-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Encoding from "effect/Encoding"
    import * as Result from "effect/Result"
    import * as Schema from "effect/Schema"
    const ArtifactBytes = Schema.String.check(
      Schema.isMaxLength(1_398_104),
      Schema.isBase64(),
      Schema.makeFilter((value) => {
        const decoded = Encoding.decodeBase64(value)
        return Result.isSuccess(decoded) && decoded.success.byteLength <= 1_048_576
      })
    )
  `,
  expected: 0,
  filePath: "packages/control-center/src/domain/plugins/eslint-base64-bound-valid.ts",
  ruleId: "local-rules/require-bounded-base64-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Encoding from "effect/Encoding"
    const decoded = Encoding.decodeBase64(providerValue)
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/eslint-base64-nonschema-valid.ts",
  ruleId: "local-rules/require-bounded-base64-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Schema from "effect/Schema"
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const UnrelatedLocator = Schema.TemplateLiteralParser(["unrelated:", Schema.String])
    const reconciliationKey = (digest) =>
      PluginActionReconciliationKey.make(\`clockify-correction:v1:\${digest}\`)
    const matches = request.reconciliationKey === reconciliationKey(request.payloadDigest)
  `,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-locator-invalid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const locatorText = (digest) => "clockify-correction:v1:" + digest
    const reconciliationKey = (digest) =>
      PluginActionReconciliationKey.make(locatorText(digest))
    const matches = request.reconciliationKey === reconciliationKey(request.payloadDigest)
  `,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-concatenation-invalid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const locatorText = (digest, providerToken) => {
      if (digest) return \`clockify-correction:v1:\${digest}\`
      return providerToken
    }
    const reconciliationKey = (digest, providerToken) =>
      PluginActionReconciliationKey.make(locatorText(digest, providerToken))
    const matches = request.reconciliationKey === reconciliationKey(request.payloadDigest, providerToken)
  `,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-conditional-return-invalid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Schema from "effect/Schema"
    import { PluginActionPayloadDigest, PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const ReconciliationLocator = Schema.TemplateLiteralParser([
      "clockify-correction:v1:",
      PluginActionPayloadDigest
    ])
    const locatorText = (digest, providerToken) => {
      if (digest) {
        return Schema.encodeSync(ReconciliationLocator)(["clockify-correction:v1:", digest])
      }
      return providerToken
    }
    const reconciliationKey = (digest, providerToken) =>
      PluginActionReconciliationKey.make(locatorText(digest, providerToken))
    const locator = Schema.decodeUnknownSync(ReconciliationLocator)(request.reconciliationKey)
    const matches = locator[1] === request.payloadDigest
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-conditional-return-valid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Schema from "effect/Schema"
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const reconciliationKey = (digest) =>
      PluginActionReconciliationKey.make(
        Schema.encodeSync(Schema.String)(\`clockify-correction:v1:\${digest}\`)
      )
    const matches = request.reconciliationKey === reconciliationKey(request.payloadDigest)
  `,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-unstructured-encoder-invalid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const locatorText = (digest) => encodeURIComponent("clockify-correction:v1:" + digest)
    const reconciliationKey = (digest) =>
      PluginActionReconciliationKey.make(locatorText(digest))
    const matches = request.reconciliationKey === reconciliationKey(request.payloadDigest)
  `,
  expected: 1,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-encoded-invalid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import * as Schema from "effect/Schema"
    import { PluginActionPayloadDigest, PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const ReconciliationLocator = Schema.TemplateLiteralParser([
      "clockify-correction:v1:",
      PluginActionPayloadDigest
    ])
    const reconciliationKey = (digest) =>
      PluginActionReconciliationKey.make(
        Schema.encodeSync(ReconciliationLocator)(["clockify-correction:v1:", digest])
      )
    const locator = Schema.decodeUnknownSync(ReconciliationLocator)(request.reconciliationKey)
    const matches = locator[1] === request.payloadDigest
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/plugins/clockify/eslint-structured-locator-valid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import { PluginActionReconciliationKey } from "../../../domain/plugins/index.js"
    const reconciliationKey = (providerToken) =>
      PluginActionReconciliationKey.make(providerToken)
    const matches = request.reconciliationKey === reconciliationKey(providerToken)
  `,
  expected: 0,
  filePath: "packages/control-center/src/server/plugins/provider/eslint-opaque-locator-valid.ts",
  ruleId: "local-rules/require-structured-reconciliation-key-schema"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const inlineOptions = ChildProcess.make("assume", ["-cd", link, profile], {
      stdout: "inherit",
      env: { GRANTED_ALIAS_CONFIGURED: "true" }
    })
    const extracted = { env: { AWS_PROFILE: profile } }
    const viaBinding = ChildProcess.make("git", args, extracted)
    const frozen = Object.freeze({ env: { AWS_PROFILE: profile } })
    const viaFrozenBinding = ChildProcess.make("git", args, frozen)
  `,
  expected: 3,
  filePath: "packages/codecommit-core/src/eslint-child-env-inheritance-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "effect/unstable/process/ChildProcess"
    const namespaced = ChildProcess.make("git", args, { env: { AWS_PROFILE: profile } })
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-namespace-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const augmented = ChildProcess.make("assume", ["-cd", link, profile], {
      env: { GRANTED_ALIAS_CONFIGURED: "true" },
      extendEnv: true
    })
    const isolated = { env: gitEnvironment, extendEnv: false }
    const viaBinding = ChildProcess.make("git", args, isolated)
    const noEnvironment = ChildProcess.make("aws", ["sso", "login", "--profile", profile], {
      stdout: "inherit",
      stderr: "inherit"
    })
    const noOptions = ChildProcess.make("open", [url])
    const argsOnlyBinding = ChildProcess.make("node", cliArgs)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-inheritance-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const base = { env: { AWS_PROFILE: profile } }
    const viaSpread = ChildProcess.make("git", args, { ...base, stderr: "pipe" })
    const frozenBase = Object.freeze({ env: { AWS_PROFILE: profile } })
    const viaFrozenSpread = ChildProcess.make("git", args, { ...frozenBase })
    const nestedBase = { ...base }
    const viaNestedSpread = ChildProcess.make("git", args, { ...nestedBase, stderr: "pipe" })
  `,
  expected: 3,
  filePath: "packages/codecommit-core/src/eslint-child-env-spread-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const safeBase = { env: { AWS_PROFILE: profile }, extendEnv: true }
    const viaSpread = ChildProcess.make("git", args, { ...safeBase, stderr: "pipe" })
    const splitBase = { env: { AWS_PROFILE: profile } }
    const viaSplitSpread = ChildProcess.make("git", args, { ...splitBase, extendEnv: false })
    const opaque = ChildProcess.make("git", args, { ...buildOptions(), stderr: "pipe" })
    const reassigned = ChildProcess.make("git", args, { ...mutable, stderr: "pipe" })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-spread-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { make } from "effect/unstable/process/ChildProcess"
    const direct = make("git", args, { env: { AWS_PROFILE: profile } })
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-direct-make-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { make as spawn } from "effect/unstable/process/ChildProcess"
    const aliasedBase = { env: { AWS_PROFILE: profile } }
    const aliased = spawn("git", args, { ...aliasedBase, stderr: "pipe" })
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-aliased-make-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { make } from "effect/unstable/process/ChildProcess"
    import { make as unrelatedMake } from "./unrelated.js"
    const augmented = make("git", args, { env: { AWS_PROFILE: profile }, extendEnv: true })
    const isolated = make("git", args, { env: gitEnvironment, extendEnv: false })
    const foreign = unrelatedMake("git", args, { env: { AWS_PROFILE: profile } })
    const shadowed = ((make) => make("git", args, { env: { AWS_PROFILE: profile } }))(unrelatedMake)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-direct-make-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import * as Process from "effect/unstable/process"
    const barrel = Process.ChildProcess.make("git", args, { env: { AWS_PROFILE: profile } })
    const barrelTwoArg = Process.ChildProcess.make("pbcopy", { env: { AWS_PROFILE: profile } })
  `,
  expected: 2,
  filePath: "packages/codecommit-core/src/eslint-child-env-barrel-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import * as Process from "effect/unstable/process"
    import * as Unrelated from "./unrelated.js"
    const barrel = Process.ChildProcess.make("git", args, { env: gitEnvironment, extendEnv: true })
    const foreign = Unrelated.ChildProcess.make("git", args, { env: gitEnvironment })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-barrel-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const completed = { env: gitEnvironment }
    completed.extendEnv = true
    const viaMutation = ChildProcess.make("git", args, completed)
    const trimmed = { env: gitEnvironment, extendEnv: true }
    delete trimmed.extendEnv
    const viaDelete = ChildProcess.make("git", args, trimmed)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-mutated-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    import * as Process from "effect/unstable/process"
    const { make } = ChildProcess
    const destructured = make("git", args, { env: gitEnvironment })
    const { make: spawn } = ChildProcess
    const renamed = spawn("git", args, { env: gitEnvironment })
    const Aliased = ChildProcess
    const aliased = Aliased.make("git", args, { env: gitEnvironment })
    const FromBarrel = Process.ChildProcess
    const barrelAliased = FromBarrel.make("git", args, { env: gitEnvironment })
  `,
  expected: 4,
  filePath: "packages/codecommit-core/src/eslint-child-env-alias-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const Aliased = ChildProcess
    const explicit = Aliased.make("git", args, { env: gitEnvironment, extendEnv: true })
    let mutableAlias = ChildProcess
    const viaMutableAlias = mutableAlias.make("git", args, { env: gitEnvironment })
    const built = buildOptions()
    const viaCallResult = ChildProcess.make("git", args, built)
    const viaTernary = ChildProcess.make("git", args, ready ? { env: gitEnvironment, extendEnv: true } : baseOptions)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-alias-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const literalKey = ChildProcess.make("git", args, { ["env"]: gitEnvironment })
    const templateKey = ChildProcess.make("git", args, { [\`env\`]: gitEnvironment })
    const computedUndefined = ChildProcess.make("git", args, { env: gitEnvironment, ["extendEnv"]: undefined })
    const computedVoid = ChildProcess.make("git", args, { env: gitEnvironment, [\`extendEnv\`]: void 0 })
  `,
  expected: 4,
  filePath: "packages/codecommit-core/src/eslint-child-env-computed-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    import * as Unrelated from "./unrelated-api.js"
    const bothComputed = ChildProcess.make("git", args, { ["env"]: gitEnvironment, ["extendEnv"]: true })
    const computedFalse = ChildProcess.make("git", args, { env: gitEnvironment, ["extendEnv"]: false })
    const dynamicKey = ChildProcess.make("git", args, { env: gitEnvironment, [runtimeKey]: true })
    const identifierKey = ChildProcess.make("git", args, { [env]: gitEnvironment })
    const foreignNamespace = Unrelated.ChildProcess.make("git", args, { env: gitEnvironment })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-computed-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const real = ChildProcess.make("git", args, { env: gitEnvironment })
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-effect-import-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import * as ChildProcess from "./foreign-child-process.js"
    const foreign = ChildProcess.make("tool", args, { env: gitEnvironment })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-foreign-name-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const escaping = { env: gitEnvironment }
    configure(escaping)
    const viaHelper = ChildProcess.make("git", args, escaping)
    const stored = { env: gitEnvironment }
    registry.options = stored
    const viaStored = ChildProcess.make("git", args, stored)
    const collected = { env: gitEnvironment }
    const all = [collected]
    const viaArray = ChildProcess.make("git", args, collected)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-escaping-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const contained = { env: gitEnvironment }
    const viaContained = ChildProcess.make("git", args, contained)
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-contained-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const shared = { env: gitEnvironment }
    const first = ChildProcess.make("a", [], shared)
    const second = ChildProcess.make("b", [], shared)
  `,
  expected: 2,
  filePath: "packages/codecommit-core/src/eslint-child-env-shared-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const shared = { env: gitEnvironment, extendEnv: true }
    const first = ChildProcess.make("a", [], shared)
    const second = ChildProcess.make("b", [], shared)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-shared-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const spawn = ChildProcess.make
    const extracted = spawn("git", args, { env: gitEnvironment })
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-extracted-make-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    import * as Foreign from "./foreign-api.js"
    const spawn = ChildProcess.make
    const augmented = spawn("git", args, { env: gitEnvironment, extendEnv: true })
    const foreignSpawn = Foreign.ChildProcess.make
    const foreign = foreignSpawn("git", args, { env: gitEnvironment })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-extracted-make-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const explicitUndefined = ChildProcess.make("git", args, { env: gitEnvironment, extendEnv: undefined })
    const voidUndefined = ChildProcess.make("git", args, { env: gitEnvironment, extendEnv: void 0 })
  `,
  expected: 2,
  filePath: "packages/codecommit-core/src/eslint-child-env-undefined-extendenv-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const isolated = ChildProcess.make("git", args, { env: gitEnvironment, extendEnv: false })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-undefined-extendenv-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const late = { env: gitEnvironment }
    const afterCall = ChildProcess.make("git", args, late)
    configure(late)
  `,
  expected: 1,
  filePath: "packages/codecommit-core/src/eslint-child-env-mutation-order-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const early = { env: gitEnvironment }
    configure(early)
    const beforeCall = ChildProcess.make("git", args, early)
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-mutation-order-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const safeBase = { env: gitEnvironment, extendEnv: true }
    const overridden = ChildProcess.make("git", args, { ...safeBase, extendEnv: undefined })
    const bare = { env: gitEnvironment }
    const stillMissing = ChildProcess.make("git", args, { ...bare, stderr: "pipe" })
    const envArrivesLast = ChildProcess.make("git", args, { env: undefined, ...bare })
  `,
  expected: 3,
  filePath: "packages/codecommit-core/src/eslint-child-env-lastwrite-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { ChildProcess } from "effect/unstable/process"
    const safeBase = { env: gitEnvironment, extendEnv: true }
    const overriddenFalse = ChildProcess.make("git", args, { ...safeBase, extendEnv: false })
    const inherited = ChildProcess.make("git", args, { ...safeBase, stderr: "pipe" })
    const bare = { env: gitEnvironment }
    const restored = ChildProcess.make("git", args, { ...bare, extendEnv: true })
    const noEnvAtAll = ChildProcess.make("git", args, { env: undefined })
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-lastwrite-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { make } from "effect/unstable/process/ChildProcess"
    import { ChildProcess } from "effect/unstable/process"
    const spawn = make
    const viaImportAlias = spawn("git", args, { env: gitEnvironment })
    const extracted = ChildProcess.make
    const secondLevel = extracted
    const viaSecondAlias = secondLevel("git", args, { env: gitEnvironment })
    const straight = { env: gitEnvironment }
    const afterCall = ChildProcess.make("git", args, straight)
    configure(straight)
  `,
  expected: 3,
  filePath: "packages/codecommit-core/src/eslint-child-env-makealias-invalid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})

await assertRuleDiagnostics({
  code: `
    import { make } from "effect/unstable/process/ChildProcess"
    import { ChildProcess } from "effect/unstable/process"
    import * as Foreign from "./foreign-api.js"
    const spawn = make
    const augmented = spawn("git", args, { env: gitEnvironment, extendEnv: true })
    const foreignMake = Foreign.make
    const foreign = foreignMake("git", args, { env: gitEnvironment })
    const deferredOptions = { env: gitEnvironment }
    const run = () => ChildProcess.make("git", args, deferredOptions)
    configure(deferredOptions)
    run()
  `,
  expected: 0,
  filePath: "packages/codecommit-core/src/eslint-child-env-makealias-valid.ts",
  ruleId: "local-rules/require-explicit-child-process-env-inheritance"
})
