import assert from "node:assert/strict"
import test from "node:test"

import {
  extensionsOf,
  languageFailures,
  languagesFor,
  samplePath,
  smokeFiles
} from "./check-ast-grep-rule-languages.mjs"

const languageGlobs = { tsx: ["**/*.ts", "**/*.tsx"], javascript: ["**/*.mjs"] }

test("reads the extensions a files glob selects", () => {
  assert.deepEqual(extensionsOf("packages/**/*.ts"), ["ts"])
  assert.deepEqual(extensionsOf("packages/**/*.{ts,tsx}"), ["ts", "tsx"])
  assert.equal(extensionsOf("packages/**/*"), undefined)
})

test("resolves a path's language through sgconfig languageGlobs before ast-grep's defaults", () => {
  assert.deepEqual(languagesFor("packages/a/src/x.ts", languageGlobs), ["tsx"])
  assert.deepEqual(languagesFor("scripts/x.mjs", languageGlobs), ["javascript"])
  assert.deepEqual(languagesFor("packages/a/src/x.css", languageGlobs), ["css"])
  assert.deepEqual(languagesFor("x.ts", {}), ["typescript"])
})

test("resolves path-scoped languageGlobs by the whole path, not the extension", () => {
  const scoped = { tsx: ["packages/**/*.ts"], typescript: ["scripts/**/*.ts"] }
  assert.deepEqual(
    languageFailures({ id: "script-rule", language: "typescript", files: ["scripts/**/*.ts"] }, scoped),
    []
  )
  assert.deepEqual(
    languageFailures({ id: "script-rule", language: "tsx", files: ["scripts/**/*.ts"] }, scoped).map(
      ({ _tag }) => _tag
    ),
    ["LanguageMismatch"]
  )
  const overlapping = { tsx: ["**/*.ts"], typescript: ["packages/**/*.ts"] }
  assert.deepEqual(
    languageFailures({ id: "both", language: "tsx", files: ["packages/**/*.ts"] }, overlapping).map(({ _tag }) => _tag),
    ["LanguageAmbiguous"]
  )
})

test("fails a glob whose files sgconfig parses as another language", () => {
  assert.deepEqual(
    languageFailures({ id: "no-cast", language: "tsx", files: ["scripts/**/*.ts", "scripts/**/*.mjs"] }, languageGlobs),
    [
      {
        _tag: "LanguageMismatch",
        rule: "no-cast",
        ruleLanguage: "tsx",
        glob: "scripts/**/*.mjs",
        path: "scripts/smoke/no-cast-0.mjs",
        language: "javascript"
      }
    ]
  )
  assert.deepEqual(languageFailures({ id: "no-cast", language: "tsx", files: ["**/*.tsx"] }, languageGlobs), [])
  assert.deepEqual(languageFailures({ id: "any", language: "tsx", files: ["packages/**/*"] }, languageGlobs), [
    { _tag: "LanguageUndetermined", rule: "any", glob: "packages/**/*" }
  ])
})

test("writes one fixture per files glob, at a path that glob selects", () => {
  assert.equal(
    samplePath("packages/*/src/commands/errorHandler.ts", "rule", 0),
    "packages/rule-0/src/commands/errorHandler.ts"
  )
  assert.equal(samplePath("**/models/**/*.{ts,tsx}", "rule", 1), "smoke/models/smoke/rule-1.ts")
  assert.deepEqual(
    smokeFiles({ id: "rule", language: "tsx", files: ["a/**/*.ts", "b/*.tsx"] }, "x as Y", languageGlobs).map(
      ({ path }) => path
    ),
    ["a/smoke/rule-0.ts", "b/rule-1.tsx"]
  )
  assert.deepEqual(
    smokeFiles({ id: "rule", language: "javascript" }, "fetch(url)", languageGlobs).map(({ path }) => path),
    ["smoke/rule-0.js"]
  )
})
