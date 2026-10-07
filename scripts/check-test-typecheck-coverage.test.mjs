import assert from "node:assert/strict"
import test from "node:test"

import { fileURLToPath, URL } from "node:url"

import {
  allowlistAdditions,
  checkedProjects,
  configDirectory,
  coverageFailures,
  isTestSource,
  projectFiles
} from "./check-test-typecheck-coverage.mjs"

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

test("reads the projects a check script typechecks, and whether tsc runs in build mode", () => {
  assert.deepEqual(checkedProjects("tsc -b tsconfig.json && tsc -p test/tsconfig.json --noEmit"), [
    { project: "tsconfig.json", build: true },
    { project: "test/tsconfig.json", build: false }
  ])
  assert.deepEqual(checkedProjects("tsc --noEmit"), [{ project: "tsconfig.json", build: false }])
  assert.deepEqual(checkedProjects("tsc -b"), [{ project: "tsconfig.json", build: true }])
  assert.deepEqual(checkedProjects("tsc -b ./scripts"), [{ project: "scripts/tsconfig.json", build: true }])
  assert.deepEqual(checkedProjects("vitest run && eslint src"), [])
  assert.deepEqual(checkedProjects(undefined), [])
})

test("counts only tsc commands that gate the script", () => {
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json || true"), [])
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json; echo done"), [])
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json | tee out.txt"), [])
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json --noEmit && echo done"), [
    { project: "test/tsconfig.json", build: false }
  ])
})

test("credits no coverage when any recovery path can mask a failing tsc", () => {
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json && echo checked || true"), [])
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json --noEmit & wait"), [])
  assert.deepEqual(checkedProjects("tsc -p test/tsconfig.json --noEmit && echo checked"), [
    { project: "test/tsconfig.json", build: false }
  ])
})

test("credits only tsc invocations that typecheck, in command position", () => {
  for (const script of [
    "tsc -p test/tsconfig.json --noEmit --noCheck",
    "tsc -p test/tsconfig.json --showConfig",
    "tsc -p test/tsconfig.json --listFilesOnly",
    "tsc -b tsconfig.json --clean",
    "tsc -b tsconfig.json --dry",
    "echo tsc -p test/tsconfig.json",
    "tsc -p test/tsconfig.json --nocheck",
    "tsc -p test/tsconfig.json --NoCheck",
    "tsc source.ts --noEmit --ignoreConfig",
    "tsc -p test/tsconfig.json --noEmit test/extra.ts",
    "tsc -p"
  ]) {
    assert.deepEqual(checkedProjects(script), [], script)
  }
  assert.deepEqual(checkedProjects("tsc -P test/tsconfig.json --NOEMIT"), [
    { project: "test/tsconfig.json", build: false }
  ])
  assert.deepEqual(checkedProjects("tsc -b packages/a packages/b"), [
    { project: "packages/a/tsconfig.json", build: true },
    { project: "packages/b/tsconfig.json", build: true }
  ])
  assert.deepEqual(checkedProjects("pnpm exec tsc -p test/tsconfig.json --noEmit"), [
    { project: "test/tsconfig.json", build: false }
  ])
})

test("a project that inherits noCheck typechecks nothing", () => {
  const fixture = (name) => fileURLToPath(new URL(`./fixtures/test-typecheck-coverage/${name}`, import.meta.url))
  const isFixtureTest = (file) => file.endsWith("/fixtures/test-typecheck-coverage/test/example.test.ts")
  assert.equal(projectFiles(fixture("test/tsconfig.json"), false).some(isFixtureTest), true)
  assert.equal(projectFiles(fixture("tsconfig.nocheck.json"), false).some(isFixtureTest), false)
})

test("follows project references only in build mode, as tsc does", () => {
  const fixture = fileURLToPath(new URL("./fixtures/test-typecheck-coverage/tsconfig.json", import.meta.url))
  const isFixtureTest = (file) => file.endsWith("/fixtures/test-typecheck-coverage/test/example.test.ts")
  assert.equal(projectFiles(fixture, true).some(isFixtureTest), true)
  assert.equal(projectFiles(fixture, false).some(isFixtureTest), false)
})

test("finds a config's directory for POSIX and Windows paths", () => {
  assert.equal(configDirectory("/repo/packages/demo/test/tsconfig.json"), "/repo/packages/demo/test")
  assert.equal(configDirectory("C:\\repo\\packages\\demo\\test\\tsconfig.json"), "C:/repo/packages/demo/test")
})

test("the allowlist may only shrink against its base", () => {
  const base = { listed: { owner: "lane", reason: "follow-up" } }
  assert.deepEqual(allowlistAdditions({ ...base, "new-package": { owner: "lane", reason: "new" } }, base), [
    "new-package"
  ])
  assert.deepEqual(allowlistAdditions({}, base), [])
  assert.deepEqual(allowlistAdditions(base, undefined), [])
  assert.deepEqual(
    coverageFailures(
      new Map([["new-package", ["test/a.test.ts"]]]),
      { "new-package": { owner: "lane", reason: "new" } },
      {}
    ),
    [{ _tag: "AllowlistGrew", package: "new-package" }]
  )
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
