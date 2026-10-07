import assert from "node:assert/strict"
import test from "node:test"

import { typeScriptRuntimeExports, unpublishedSubpaths } from "./check-workspace-exports.mjs"

test("rejects exports that load TypeScript at runtime (QA-J74)", () => {
  assert.deepEqual(typeScriptRuntimeExports({ exports: { ".": "./src/index.ts", "./*.js": "./src/*.ts" } }), [
    ". -> ./src/index.ts",
    "./*.js -> ./src/*.ts"
  ])
  assert.deepEqual(typeScriptRuntimeExports({ exports: "./src/index.ts" }), [". -> ./src/index.ts"])
  assert.deepEqual(
    typeScriptRuntimeExports({ exports: { ".": { types: "./src/index.ts", import: "./src/index.mts" } } }),
    [". -> ./src/index.mts"]
  )
})

test("rejects a TypeScript main when there are no exports (codecommit-web)", () => {
  assert.deepEqual(typeScriptRuntimeExports({ main: "src/index.ts" }), ["main -> src/index.ts"])
  assert.deepEqual(typeScriptRuntimeExports({ main: "dist/index.js", types: "src/index.ts" }), [])
  // With exports, Node ignores main, so a TypeScript main there is only an editor hint.
  assert.deepEqual(
    typeScriptRuntimeExports({
      main: "src/index.ts",
      exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } }
    }),
    []
  )
})

test("accepts TypeScript under the types condition with a JavaScript runtime target", () => {
  assert.deepEqual(
    typeScriptRuntimeExports({ exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } } }),
    []
  )
  assert.deepEqual(
    typeScriptRuntimeExports({ exports: { ".": "./dist/index.js", "./package.json": "./package.json" } }),
    []
  )
  assert.deepEqual(typeScriptRuntimeExports({}), [])
})

test("exempts a private package with no executable, but not one with an executable", () => {
  const exports = { "./main": "./src/main.ts" }
  assert.deepEqual(typeScriptRuntimeExports({ private: true, exports }), [])
  assert.deepEqual(typeScriptRuntimeExports({ private: true, bin: { tool: "dist/cli.js" }, exports }), [
    "./main -> ./src/main.ts"
  ])
})

test("requires publishConfig.exports to publish every workspace subpath (codecommit-core CacheService.js)", () => {
  const exports = {
    ".": { types: "./src/index.ts", default: "./dist/index.js" },
    "./CacheService.js": { types: "./src/CacheService/index.ts", default: "./dist/CacheService/index.js" },
    "./*.js": { types: "./src/*.ts", default: "./dist/*.js" }
  }
  assert.deepEqual(
    unpublishedSubpaths({ exports, publishConfig: { exports: { ".": "./dist/index.js", "./*.js": "./dist/*.js" } } }),
    ["./CacheService.js is not in publishConfig.exports"]
  )
  assert.deepEqual(
    unpublishedSubpaths({
      exports,
      publishConfig: {
        exports: {
          ".": "./dist/index.js",
          "./CacheService.js": "./dist/CacheService/index.js",
          "./*.js": "./dist/*.js"
        }
      }
    }),
    []
  )
  assert.deepEqual(unpublishedSubpaths({ exports, publishConfig: { access: "public" } }), [])
})
