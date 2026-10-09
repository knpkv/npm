import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  checkRuleLanguages,
  extensionsOf,
  languageFailures,
  languagesFor,
  samplePaths,
  scratchGitEnv,
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
    ["LanguageMismatch", "LanguageMismatch"]
  )
  const overlapping = { tsx: ["**/*.ts"], typescript: ["packages/**/*.ts"] }
  assert.deepEqual(
    languageFailures({ id: "both", language: "tsx", files: ["packages/**/*.ts"] }, overlapping).map(({ _tag }) => _tag),
    ["LanguageAmbiguous", "LanguageAmbiguous"]
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
      },
      {
        _tag: "LanguageMismatch",
        rule: "no-cast",
        ruleLanguage: "tsx",
        glob: "scripts/**/*.mjs",
        path: "scripts/smoke/deep/nested/no-cast-alt-0.mjs",
        language: "javascript"
      }
    ]
  )
  assert.deepEqual(languageFailures({ id: "no-cast", language: "tsx", files: ["**/*.tsx"] }, languageGlobs), [])
  assert.deepEqual(languageFailures({ id: "any", language: "tsx", files: ["packages/**/*"] }, languageGlobs), [
    { _tag: "LanguageUndetermined", rule: "any", glob: "packages/**/*" }
  ])
})

test("writes fixtures at a shallow and a deep path for every files glob", () => {
  assert.deepEqual(samplePaths("packages/*/src/commands/errorHandler.ts", "rule", 0), [
    "packages/rule-0/src/commands/errorHandler.ts",
    "packages/rule-alt-0/src/commands/errorHandler.ts"
  ])
  assert.deepEqual(samplePaths("**/models/**/*.{ts,tsx}", "rule", 1), [
    "smoke/models/smoke/rule-1.ts",
    "smoke/deep/nested/models/smoke/deep/nested/rule-alt-1.ts"
  ])
  assert.deepEqual(
    smokeFiles({ id: "rule", language: "javascript" }, "fetch(url)", languageGlobs).map(({ path }) => path),
    ["smoke/rule-0.cjs", "smoke/rule-alt-0.cjs"]
  )
})

test("an override that claims only one sample path does not stand in for the whole glob", () => {
  const narrow = { tsx: ["**/no-cast-0.ts"] }
  assert.deepEqual(
    languageFailures({ id: "no-cast", language: "tsx", files: ["packages/**/*.ts"] }, narrow).map(
      ({ _tag, path }) => `${_tag} ${path}`
    ),
    ["LanguageMismatch packages/smoke/deep/nested/no-cast-alt-0.ts"]
  )
})

test("knows ast-grep's built-in languages beyond TypeScript", () => {
  assert.deepEqual(languageFailures({ id: "json-rule", language: "json", files: ["**/*.json"] }, {}), [])
  assert.deepEqual(
    languageFailures({ id: "yaml-rule", language: "yaml", files: ["**/*.json"] }, {}).map(({ _tag }) => _tag),
    ["LanguageMismatch", "LanguageMismatch"]
  )
})

const astGrep = fileURLToPath(new URL("../node_modules/.bin/ast-grep", import.meta.url))

// Builds a scratch repository from `files` (path → content) and checks it with the real ast-grep binary.
const checkRepository = (files) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ast-grep-rule-languages-test-" })
    for (const [file, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      yield* fs.writeFileString(path.join(root, file), content)
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    for (const args of [
      ["init", "--quiet"],
      ["add", "-A"]
    ]) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", args, { cwd: root, env: scratchGitEnv(root), extendEnv: true })
      )
      assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(0), `git ${args.join(" ")}`)
    }
    const result = yield* checkRuleLanguages(root, astGrep)
    return result.failures.map(({ _tag, rule }) => `${_tag} ${rule}`)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const sgconfig = 'ruleDirs: [rules]\nlanguageGlobs:\n  tsx: ["**/*.ts"]\ntestConfigs:\n  - testDir: tests\n'
const castRule = (id, files) =>
  `id: ${id}\nlanguage: tsx\nseverity: error\nrule:\n  pattern: $V as $T\nfiles:\n${files.map((glob) => `  - "${glob}"`).join("\n")}\n`
const castTest = (id) => `id: ${id}\nvalid:\n  - const a = b\ninvalid:\n  - const a = b as C\n`

test("a glob that only selects gitignored files fails, a live one passes", async () => {
  assert.deepEqual(
    await checkRepository({
      "sgconfig.yml": sgconfig,
      ".gitignore": "ignored/**/*.ts\n",
      "rules/ignored-cast.yml": castRule("ignored-cast", ["ignored/**/*.ts"]),
      "tests/ignored-cast-test.yml": castTest("ignored-cast"),
      "rules/live-cast.yml": castRule("live-cast", ["live/**/*.ts"]),
      "tests/live-cast-test.yml": castTest("live-cast")
    }),
    ["FixtureNotMatched ignored-cast", "FixtureNotMatched ignored-cast"]
  )
})

test("rules and fixtures in nested directories are checked like top-level ones", async () => {
  assert.deepEqual(
    await checkRepository({
      "sgconfig.yml": sgconfig,
      "rules/nested/untested-cast.yml": castRule("untested-cast", ["live/**/*.ts"]),
      "rules/nested/tested-cast.yml": castRule("tested-cast", ["live/**/*.ts"]),
      "tests/nested/tested-cast-test.yml": castTest("tested-cast")
    }),
    ["MissingFixture untested-cast"]
  )
})
