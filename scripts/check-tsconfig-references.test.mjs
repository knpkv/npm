import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

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

test("reads nested package tsconfigs too, and never one under node_modules", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tsconfig-references-" })
      const write = (file, config) =>
        fs
          .makeDirectory(`${root}/${file.split("/").slice(0, -1).join("/")}`, { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(`${root}/${file}`, JSON.stringify(config))))
      yield* write("packages/a/tsconfig.json", { references: [{ path: "./test" }] })
      yield* write("packages/a/test/tsconfig.json", { references: [{ path: "../../b/tsconfig.build.json" }] })
      yield* write("packages/a/node_modules/dep/tsconfig.json", { references: [{ path: "../../../b" }] })
      return yield* checkTsconfigReferences(root)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
  assert.equal(result.files, 2)
  assert.deepEqual(result.failures, [
    { file: "packages/a/test/tsconfig.json", reference: "../../b/tsconfig.build.json" }
  ])
})

test("no package tsconfig in the repository references another package", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const result = await Effect.runPromise(checkTsconfigReferences(root).pipe(Effect.provide(NodeServices.layer)))
  assert.ok(result.files > 0)
  assert.deepEqual(result.failures, [])
})
