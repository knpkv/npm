import assert from "node:assert/strict"
import test from "node:test"

import { unexpectedDiagnostics } from "./check-invalid-contract.mjs"

const expected =
  "dtslint/public-contract.ts(40,14): error TS377003: Missing errors AgentRuntimeProtocolError in the expected Effect type. effect(missingEffectError)"

test("only the protocol-error rejection passes", () => {
  assert.deepEqual(unexpectedDiagnostics(`${expected}\n`), { missing: [], unexpected: [] })
})

test("a missing export fails for the wrong reason and is reported", () => {
  const output =
    "dtslint/public-contract.ts(8,3): error TS2305: Module '\"../src/index.js\"' has no exported member 'AgentRuntimeProtocolError'.\n"
  const result = unexpectedDiagnostics(output)
  assert.equal(result.missing.length, 1)
  assert.deepEqual(
    result.unexpected.map(({ code }) => code),
    ["TS2305"]
  )
})

test("an extra error beside the expected one is reported", () => {
  const output = `${expected}\nsrc/index.ts(1,1): error TS1005: ';' expected.\n`
  assert.deepEqual(
    unexpectedDiagnostics(output).unexpected.map(({ file }) => file),
    ["src/index.ts"]
  )
})
