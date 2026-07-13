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
