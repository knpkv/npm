import { assert } from "@effect/vitest"

/**
 * Assert a credential-bearing value is absent without giving the assertion
 * library either operand to echo when the boundary fails.
 */
export const assertSensitiveTextAbsent = (serialized: string, sensitive: string): void => {
  assert.isFalse(
    serialized.includes(sensitive),
    "Sensitive live-integration text crossed a redaction boundary"
  )
}
