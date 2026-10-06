import assert from "node:assert/strict"
import test from "node:test"

import { compareToBaseline, makeBaseline, packageOf, renderLedger, scanDirectives } from "./check-debt-ledger.mjs"

const scan = (text, file = "packages/demo/src/a.ts") => scanDirectives(file, text)

test("finds every directive spelling in comments", () => {
  const found = scan(
    [
      "// @effect-diagnostics-next-line strictEffectProvide:off",
      "/* @effect-diagnostics leakingRequirements:off */",
      "// @effect-diagnostics-skip-file",
      "// @ts-expect-error the caller boundary is untyped",
      "// @ts-ignore",
      "// @ts-nocheck",
      "// eslint-disable-next-line no-console -- debug output",
      "/* eslint-disable no-console */",
      "// eslint-disable-line no-console",
      "// oxlint-disable-next-line no-console -- debug output",
      "// ast-grep-ignore: no-released-ephemeral-test-port -- the server takes its port",
      "export {}"
    ].join("\n")
  )
  assert.deepEqual(
    found.map(({ kind }) => kind),
    [
      "effect-diagnostics",
      "effect-diagnostics",
      "effect-diagnostics",
      "typescript",
      "typescript",
      "typescript",
      "eslint",
      "eslint",
      "eslint",
      "oxlint",
      "ast-grep"
    ]
  )
})

test("ignores directive text inside string and template literals", () => {
  const found = scan(
    [
      'const fixture = "// eslint-disable-next-line no-console"',
      "const template = `// @ts-expect-error ${fixture} // oxlint-disable-next-line x`",
      "export { fixture, template }"
    ].join("\n")
  )
  assert.deepEqual(found, [])
})

test("ignores enable directives and prose that mentions a directive mid-sentence", () => {
  const found = scan(
    ["/* eslint-enable no-console */", "// Prefer a typed fix over eslint-disable here.", "export {}"].join("\n")
  )
  assert.deepEqual(found, [])
})

test("recognises a reason after --, after @ts-expect-error, or on the comment line above", () => {
  const found = scan(
    [
      "// eslint-disable-next-line no-console -- debug output",
      "// @ts-expect-error the caller boundary is untyped",
      "// The layer is provided by the runtime entrypoint.",
      "// @effect-diagnostics-next-line strictEffectProvide:off",
      "const a = 1",
      "// @effect-diagnostics-next-line strictEffectProvide:off",
      "// @ts-expect-error",
      "export { a }"
    ].join("\n")
  )
  assert.deepEqual(
    found.map(({ reasoned }) => reasoned),
    [true, true, true, false, false]
  )
})

test("attributes files to their package", () => {
  assert.equal(packageOf("packages/herdr-work/src/store.ts"), "herdr-work")
  assert.equal(packageOf("scripts/check-debt-ledger.mjs"), "scripts")
  assert.equal(packageOf("vitest.setup.ts"), "(root)")
})

const directive = (overrides) => ({
  file: "packages/demo/src/a.ts",
  package: "demo",
  kind: "eslint",
  text: "eslint-disable-next-line no-console -- debug output",
  reasoned: true,
  ...overrides
})

test("equal counts pass and an exact baseline needs no update", () => {
  const current = [directive({})]
  assert.deepEqual(compareToBaseline(current, makeBaseline(current)), [])
})

test("a raised count in one package fails with the new directive named", () => {
  const baseline = makeBaseline([directive({})])
  const failures = compareToBaseline([directive({}), directive({ file: "packages/demo/src/b.ts" })], baseline)
  assert.equal(failures.length, 1)
  assert.equal(failures[0]._tag, "CountRaised")
  assert.equal(failures[0].package, "demo")
  assert.equal(failures[0].kind, "eslint")
  assert.deepEqual([failures[0].baseline, failures[0].current], [1, 2])
})

test("a raise in one package cannot be paid for by a removal in another", () => {
  const baseline = makeBaseline([directive({}), directive({ package: "other", file: "packages/other/src/a.ts" })])
  const failures = compareToBaseline([directive({}), directive({ file: "packages/demo/src/b.ts" })], baseline)
  assert.deepEqual(failures.map(({ _tag }) => _tag).sort(), ["CountLowered", "CountRaised"])
})

test("a lowered count fails until the baseline is tightened", () => {
  const baseline = makeBaseline([directive({}), directive({ file: "packages/demo/src/b.ts" })])
  const failures = compareToBaseline([directive({})], baseline)
  assert.deepEqual(
    failures.map(({ _tag }) => _tag),
    ["CountLowered"]
  )
})

test("a new directive without a reason fails even when the count is unchanged", () => {
  const baseline = makeBaseline([directive({})])
  const failures = compareToBaseline(
    [directive({ text: "eslint-disable-next-line no-alert", reasoned: false })],
    baseline
  )
  assert.deepEqual(
    failures.map(({ _tag }) => _tag),
    ["MissingReason"]
  )
})

test("an existing directive without a reason is grandfathered", () => {
  const unreasoned = directive({ text: "eslint-disable-next-line no-alert", reasoned: false })
  assert.deepEqual(compareToBaseline([unreasoned], makeBaseline([unreasoned])), [])
})

test("a grandfathered directive is grandfathered once, not for every copy", () => {
  const unreasoned = directive({ text: "eslint-disable-next-line no-alert", reasoned: false })
  const baseline = makeBaseline([unreasoned, directive({ file: "packages/demo/src/b.ts" })])
  const failures = compareToBaseline([unreasoned, unreasoned], baseline)
  assert.deepEqual(
    failures.map(({ _tag }) => _tag),
    ["MissingReason"]
  )
})

test("the ledger has no line numbers, so moving code does not change it", () => {
  const ledger = renderLedger([directive({})])
  assert.match(ledger, /packages\/demo\/src\/a\.ts/u)
  assert.doesNotMatch(ledger, /a\.ts:\d/u)
})
