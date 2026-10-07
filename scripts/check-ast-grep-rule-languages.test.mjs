import assert from "node:assert/strict"
import test from "node:test"

import {
  extensionsOf,
  languageFailures,
  languageFor,
  samplePath,
  smokeFiles
} from "./check-ast-grep-rule-languages.mjs"

const languageGlobs = { tsx: ["**/*.ts", "**/*.tsx"], javascript: ["**/*.mjs"] }

test("reads the extensions a files glob selects", () => {
  assert.deepEqual(extensionsOf("packages/**/*.ts"), ["ts"])
  assert.deepEqual(extensionsOf("packages/**/*.{ts,tsx}"), ["ts", "tsx"])
  assert.equal(extensionsOf("packages/**/*"), undefined)
})

test("resolves languages through sgconfig languageGlobs before ast-grep's defaults", () => {
  assert.equal(languageFor("ts", languageGlobs), "tsx")
  assert.equal(languageFor("mjs", languageGlobs), "javascript")
  assert.equal(languageFor("css", languageGlobs), "css")
  assert.equal(languageFor("ts", {}), "typescript")
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
        language: "javascript",
        extension: "mjs"
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
