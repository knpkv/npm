import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Path, Result } from "effect"

import { makeStaticAssetStore } from "../../../src/server/http/security/index.js"

const MANIFEST = `{
  "src/client/main.tsx": {
    "file": "assets/app-a1b2c3.js",
    "css": ["assets/app-a1b2c3.css"],
    "isEntry": true
  }
}`

const makeFixture = Effect.fn("StaticAssetStoreTest.makeFixture")(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-static-assets-" })
  yield* fileSystem.makeDirectory(path.join(root, ".vite"), { recursive: true })
  yield* fileSystem.makeDirectory(path.join(root, "assets"), { recursive: true })
  yield* fileSystem.writeFileString(path.join(root, ".vite", "manifest.json"), MANIFEST)
  yield* fileSystem.writeFileString(path.join(root, "index.html"), "<main>Control Center</main>")
  yield* fileSystem.writeFileString(path.join(root, "assets", "app-a1b2c3.js"), "export const app = true")
  yield* fileSystem.writeFileString(path.join(root, "assets", "app-a1b2c3.css"), "body{color:CanvasText}")
  return { fileSystem, path, root }
})

describe("StaticAssetStore", () => {
  it.effect("loads a closed immutable asset map and resolves exact and SPA requests", () =>
    Effect.gen(function*() {
      const { fileSystem, path, root } = yield* makeFixture()
      const store = yield* makeStaticAssetStore({ root })
      assert.strictEqual(store.assetCount, 3)

      const script = store.resolve("/assets/app-a1b2c3.js?cache=1", "*/*")
      assert.isTrue(Option.isSome(script))
      if (Option.isSome(script)) {
        assert.strictEqual(script.value.mimeType, "text/javascript; charset=utf-8")
        assert.strictEqual(script.value.cacheControl, "public, max-age=31536000, immutable")
      }

      const spa = store.resolve("/releases/rainbow-otter", "text/html,application/xhtml+xml")
      assert.isTrue(Option.isSome(spa))
      if (Option.isSome(spa)) assert.strictEqual(spa.value.kind, "spa")
      assert.isTrue(Option.isNone(store.resolve("/api/releases", "text/html")))
      assert.isTrue(Option.isNone(store.resolve("/missing.js", "text/html")))
      assert.isTrue(Option.isNone(store.resolve("/assets/%2e%2e/secret", "text/html")))
      assert.isTrue(Option.isNone(store.resolve("/assets\\secret", "text/html")))

      yield* fileSystem.writeFileString(path.join(root, "assets", "app-a1b2c3.js"), "changed on disk")
      const afterMutation = store.resolve("/assets/app-a1b2c3.js", "*/*")
      assert.isTrue(Option.isSome(afterMutation))
      if (Option.isSome(afterMutation)) {
        assert.strictEqual(new TextDecoder().decode(afterMutation.value.bytes), "export const app = true")
        afterMutation.value.bytes.fill(0)
      }
      const afterCallerMutation = store.resolve("/assets/app-a1b2c3.js", "*/*")
      assert.isTrue(Option.isSome(afterCallerMutation))
      if (Option.isSome(afterCallerMutation)) {
        assert.strictEqual(new TextDecoder().decode(afterCallerMutation.value.bytes), "export const app = true")
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects a manifest asset symlinked outside the canonical build root", () =>
    Effect.gen(function*() {
      const { fileSystem, path, root } = yield* makeFixture()
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-static-outside-" })
      const outsideFile = path.join(outsideRoot, "outside.js")
      yield* fileSystem.writeFileString(outsideFile, "secret")
      yield* fileSystem.remove(path.join(root, "assets", "app-a1b2c3.js"))
      yield* fileSystem.symlink(outsideFile, path.join(root, "assets", "app-a1b2c3.js"))

      const result = yield* makeStaticAssetStore({ root }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "containment-rejected")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects oversized and non-allowlisted asset types during startup", () =>
    Effect.gen(function*() {
      const { fileSystem, path, root } = yield* makeFixture()
      const oversized = yield* makeStaticAssetStore({ root, maximumIndexBytes: 4 }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(oversized))
      if (Result.isFailure(oversized)) assert.strictEqual(oversized.failure.reason, "asset-too-large")

      yield* fileSystem.writeFileString(path.join(root, "assets", "source.map"), "source")
      const sourceMap = yield* makeStaticAssetStore({ root, publicAssets: ["assets/source.map"] }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(sourceMap))
      if (Result.isFailure(sourceMap)) assert.strictEqual(sourceMap.failure.reason, "mime-rejected")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
