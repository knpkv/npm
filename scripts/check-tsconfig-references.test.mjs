import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

import * as Effect from "effect/Effect"

import { checkTsconfigReferences, crossPackageReferences } from "./check-tsconfig-references.mjs"

test("flags a reference that leaves its package, and keeps one inside it", () => {
  const config = {
    references: [
      { path: "./tsconfig.client.json" },
      { path: "../ai-codex/tsconfig.build.json" },
      { path: "../codecommit-web" },
      { path: "./nested/../tsconfig.server.json" }
    ]
  }
  assert.deepEqual(crossPackageReferences("packages/codecommit/tsconfig.json", config), [
    { file: "packages/codecommit/tsconfig.json", reference: "../ai-codex/tsconfig.build.json" },
    { file: "packages/codecommit/tsconfig.json", reference: "../codecommit-web" }
  ])
})

test("a reference that climbs out and back into its own package stays inside it", () => {
  assert.deepEqual(
    crossPackageReferences("packages/relay/tsconfig.build.json", {
      references: [{ path: "../relay/tsconfig.json" }]
    }),
    []
  )
})

test("a config without references has none to flag", () => {
  assert.deepEqual(crossPackageReferences("packages/rly/tsconfig.json", { compilerOptions: {} }), [])
})

test("no package tsconfig in the repository references another package", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const result = await Effect.runPromise(checkTsconfigReferences(root).pipe(Effect.provide(NodeServices.layer)))
  assert.ok(result.files > 0)
  assert.deepEqual(result.failures, [])
})
