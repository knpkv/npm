import { ESLint } from "eslint"
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

const assertRuleDiagnostics = async ({ code, expected, filePath, ruleId }) => {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: true })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const diagnostics = result.messages.filter((message) => message.ruleId === ruleId)
  if (diagnostics.length !== expected) {
    throw new Error(`${ruleId} reported ${diagnostics.length} diagnostics instead of ${expected} for ${filePath}`)
  }
}

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
    import * as CanonicalSchemas from "./canonical-wire.js"
    export { type NumberFromString } from "effect/Schema"
    export type { NumberFromString as NumberFromStringType } from "effect/Schema"
    CanonicalSchemas.NumberFromString
  `,
  expected: 0,
  filePath: "packages/control-center/src/api/eslint-number-from-string-valid.ts",
  ruleId: "local-rules/no-number-from-string-in-control-center-api"
})
