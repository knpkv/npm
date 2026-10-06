import assert from "node:assert/strict"
import test from "node:test"

import * as Effect from "effect/Effect"

import {
  compareToBaseline,
  isLedgerSource,
  makeBaseline,
  packageOf,
  renderLedger,
  scanDirectives,
  scanSources
} from "./check-debt-ledger.mjs"

const scan = (text, file = "packages/demo/src/a.ts") => scanDirectives(file, text)

test("finds every directive spelling", () => {
  const found = scan(
    [
      "// @effect-diagnostics-next-line strictEffectProvide:off",
      "/* @effect-diagnostics leakingRequirements:off */",
      "/** @effect-diagnostics floatingEffect:skip-file */",
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
  assert.deepEqual(found.map(({ kind }) => kind).sort(), [
    "ast-grep",
    "effect-diagnostics",
    "effect-diagnostics",
    "effect-diagnostics",
    "eslint",
    "eslint",
    "eslint",
    "oxlint",
    "typescript",
    "typescript",
    "typescript"
  ])
})

test("counts TypeScript suppressions the way the compiler recognises them", () => {
  const kinds = (text) => scan(text).map(({ kind }) => kind)
  assert.deepEqual(kinds("/// @ts-expect-error the value is untyped\nexport const n: number = 1"), ["typescript"])
  assert.deepEqual(kinds('/// <reference types="node" />\nexport {}'), [])
  assert.deepEqual(kinds("/* The value is untyped.\n @ts-expect-error */\nexport const n: number = 1"), ["typescript"])
  assert.deepEqual(kinds("/**\n * Never write @ts-expect-error here.\n */\nexport const n = 1"), [])
})

test("follows TypeScript for indented block suppressions and the ts-nocheck pragma", () => {
  const kinds = (text) => scan(text).map(({ kind }) => kind)
  assert.deepEqual(kinds("/**\n * @ts-ignore */\nexport const n: number = 1"), ["typescript"])
  assert.deepEqual(kinds("/**\n * @ts-expect-error */\nexport const n: number = 1"), ["typescript"])
  assert.deepEqual(kinds("// @TS-NOCHECK: legacy integration\nexport const n = 1"), ["typescript"])
  assert.deepEqual(kinds("export const n = 1\n// @ts-nocheck"), [])
  assert.deepEqual(kinds("/* @ts-nocheck */\nexport const n = 1"), [])
  assert.equal(scan("// @ts-nocheck: legacy integration\nexport {}")[0]?.reasoned, true)
})

test("counts every ast-grep suppression the CLI honours", () => {
  assert.deepEqual(
    scan("// ast-grep-ignore-file -- generated fixture\nexport {}").map(({ kind }) => kind),
    ["ast-grep"]
  )
})

test("counts a lint and a TypeScript escape that share one block comment", () => {
  const found = scan(
    "/* eslint-disable no-console -- adapter reason\n * @ts-expect-error type reason */\nexport const n: number = 1"
  )
  assert.deepEqual(found.map(({ kind }) => kind).sort(), ["eslint", "typescript"])
  assert.deepEqual(
    scan("/* eslint-disable no-console -- adapter reason */\nexport {}").map(({ kind }) => kind),
    ["eslint"]
  )
})

test("treats CR, CRLF and Unicode separators as line breaks, as TypeScript does", () => {
  assert.deepEqual(
    scan("/* reason\r @ts-ignore */\rexport const n: number = 1").map(({ kind }) => kind),
    ["typescript"]
  )
  assert.deepEqual(
    scan("/* reason\u2028 @ts-ignore */\nexport const n: number = 1").map(({ kind }) => kind),
    ["typescript"]
  )
  assert.equal(scan("// The value is untyped.\r\n// @ts-expect-error\r\nexport const n: number = 1")[0]?.reasoned, true)
})

test("counts the @-prefixed ast-grep suppression and ignores prose about it", () => {
  assert.deepEqual(
    scan("// @ast-grep-ignore\nexport {}").map(({ kind }) => kind),
    ["ast-grep"]
  )
  assert.deepEqual(
    scan("// @ast-grep-ignore-file -- fixture\nexport {}").map(({ kind }) => kind),
    ["ast-grep"]
  )
  assert.deepEqual(scan("// Prefer @ast-grep-ignore only as a last resort\nexport {}"), [])
})

test("skips a tracked file deleted from the working tree and still fails on other read errors", async () => {
  const sources = { "packages/demo/src/a.ts": "// @ts-ignore\nexport {}" }
  const read = (file) => Effect.succeed(sources[file])
  const found = await Effect.runPromise(scanSources(["packages/demo/src/a.ts", "packages/demo/src/gone.ts"], read))
  assert.deepEqual(
    found.map(({ file }) => file),
    ["packages/demo/src/a.ts"]
  )
  const failing = () => Effect.fail(new Error("permission denied"))
  await assert.rejects(Effect.runPromise(scanSources(["packages/demo/src/a.ts"], failing)), /permission denied/u)
})

test("counts an Effect directive wherever the language service reads it, strings included, in TypeScript files", () => {
  const marker = 'export const marker = "@effect-diagnostics floatingEffect:off"'
  assert.deepEqual(
    scan(marker).map(({ kind }) => kind),
    ["effect-diagnostics"]
  )
  assert.deepEqual(scan('export const prose = "the @effect-diagnostics syntax"'), [])
  assert.deepEqual(scan(marker, "scripts/tool.mjs"), [])
})

test("keeps vendored files out of the ledger", () => {
  assert.equal(isLedgerSource("packages/demo/src/vendor/library.ts"), false)
  assert.equal(isLedgerSource("packages/demo/src/vendored-names.ts"), true)
  assert.equal(isLedgerSource("packages/demo/src/library.ts"), true)
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
  assert.deepEqual(found.map(({ kind, reasoned }) => `${kind}:${reasoned}`).sort(), [
    "effect-diagnostics:false",
    "effect-diagnostics:true",
    "eslint:true",
    "typescript:false",
    "typescript:true"
  ])
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
