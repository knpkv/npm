import assert from "node:assert/strict"
import test from "node:test"

import { checkedProjects, coverageFailures, isTestSource } from "./check-test-typecheck-coverage.mjs"

test("treats test, e2e and dtslint sources and *.test/*.spec files as test code", () => {
  assert.equal(isTestSource("test/store.test.ts"), true)
  assert.equal(isTestSource("test/fixtures/legacy.ts"), true)
  assert.equal(isTestSource("e2e/review.spec.ts"), true)
  assert.equal(isTestSource("dtslint/requirements.ts"), true)
  assert.equal(isTestSource("src/store.test.tsx"), true)
  assert.equal(isTestSource("src/store.ts"), false)
  assert.equal(isTestSource("test/raw-imports.d.ts"), false)
  assert.equal(isTestSource("test/node_modules/x/index.ts"), false)
  assert.equal(isTestSource("vitest.config.ts"), false)
})

test("reads the projects a check script typechecks", () => {
  assert.deepEqual(checkedProjects("tsc -b tsconfig.json && tsc -p test/tsconfig.json --noEmit"), [
    "tsconfig.json",
    "test/tsconfig.json"
  ])
  assert.deepEqual(checkedProjects("tsc --noEmit"), ["tsconfig.json"])
  assert.deepEqual(checkedProjects("tsc -b"), ["tsconfig.json"])
  assert.deepEqual(checkedProjects("tsc -b ./scripts"), ["scripts/tsconfig.json"])
  assert.deepEqual(checkedProjects("vitest run && eslint src"), [])
  assert.deepEqual(checkedProjects(undefined), [])
})

test("fails a package with untypechecked tests unless it is allowlisted", () => {
  const coverage = new Map([
    ["covered", []],
    ["gap", ["test/a.test.ts"]],
    ["listed", ["test/b.test.ts"]]
  ])
  const allowlist = { listed: { owner: "lane", reason: "follow-up" } }
  assert.deepEqual(coverageFailures(coverage, allowlist), [
    { _tag: "Uncovered", package: "gap", files: ["test/a.test.ts"] }
  ])
})

test("fails an allowlist entry once its package is covered, so the list only shrinks", () => {
  const coverage = new Map([["listed", []]])
  assert.deepEqual(coverageFailures(coverage, { listed: { owner: "lane", reason: "done" } }), [
    { _tag: "AllowlistStale", package: "listed" }
  ])
})

test("fails an allowlist entry for a package that does not exist", () => {
  assert.deepEqual(coverageFailures(new Map(), { gone: { owner: "lane", reason: "renamed" } }), [
    { _tag: "AllowlistUnknown", package: "gone" }
  ])
})
