import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { discoverReferenceManifests, gitText, productMatrix } from "../scripts/discovery.js"
import { loadReferences } from "../src/references.js"
import { Manifest } from "../src/schema.js"
import { manifest } from "./models.js"

layer(NodeServices.layer)("reference product discovery", (it) => {
  it.effect(
    "discovery under inherited hook Git routing leaves the sentinel HEAD and index unchanged",
    () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const sentinel = yield* fs.makeTempDirectoryScoped({ prefix: "design-git-sentinel-" })
        yield* gitText(sentinel, ["init", "--quiet"])
        yield* fs.writeFileString(path.join(sentinel, "sentinel.txt"), "committed\n")
        yield* gitText(sentinel, ["add", "."])
        yield* gitText(sentinel, [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fixture Maintainer",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "sentinel"
        ])
        yield* fs.writeFileString(path.join(sentinel, "sentinel.txt"), "staged\n")
        yield* gitText(sentinel, ["add", "."])
        const head = yield* gitText(sentinel, ["rev-parse", "HEAD"])
        const indexPath = path.join(sentinel, ".git", "index")
        const index = yield* fs.readFile(indexPath)
        const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
        const handle = yield* spawner.spawn(ChildProcess.make("pnpm", [
          "exec",
          "vitest",
          "run",
          "test/discovery.test.ts",
          "--maxWorkers",
          "1",
          "--testNamePattern",
          "base-only deleted products"
        ], {
          cwd: path.join(repository, "packages", "design-conformance"),
          env: {
            GIT_DIR: path.join(sentinel, ".git"),
            GIT_INDEX_FILE: indexPath,
            GIT_WORK_TREE: sentinel,
            GIT_COMMON_DIR: path.join(sentinel, ".git"),
            GIT_OBJECT_DIRECTORY: path.join(sentinel, ".git", "objects"),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(sentinel, ".git", "objects"),
            GIT_CEILING_DIRECTORIES: path.dirname(sentinel)
          },
          extendEnv: true,
          stderr: "pipe"
        }))
        const output = yield* Stream.mkString(Stream.decodeText(handle.all))
        expect(yield* gitText(sentinel, ["rev-parse", "HEAD"])).toBe(head)
        expect(yield* fs.readFile(indexPath)).toEqual(index)
        expect(yield* handle.exitCode, output).toBe(0)
        expect(output).toContain("1 passed")
      }),
    30_000
  )

  it.effect("base-only deleted products retain jobs alongside new and unchanged current products", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const write = Effect.fn("DiscoveryTest.writeManifest")(function*(product: string, pkg = manifest.live.package) {
        const directory = path.join(root, "design-refs", product)
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(
          path.join(directory, "manifest.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))({
            ...manifest,
            product,
            live: { package: pkg, adapter: `packages/${pkg.slice("@knpkv/".length)}/scripts/adapter.ts` }
          })
        )
      })
      yield* gitText(root, ["init", "--quiet"])
      yield* write("deleted")
      yield* write("retained")
      yield* gitText(root, ["add", "."])
      yield* gitText(root, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture Maintainer",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "fixture"
      ])
      const base = (yield* gitText(root, ["rev-parse", "HEAD"])).trim()
      yield* fs.remove(path.join(root, "design-refs/deleted"), { recursive: true })
      yield* write("new")
      yield* write("retained", "@knpkv/toy")
      const discovered = yield* discoverReferenceManifests(root, base)
      expect(productMatrix(discovered.current, discovered.base)).toEqual({
        include: [
          { product: "deleted", package: "@knpkv/design-conformance" },
          { product: "new", package: "@knpkv/design-conformance" },
          { product: "retained", package: "@knpkv/toy" }
        ]
      })
      expect(yield* loadReferences(path.join(root, "design-refs/deleted")).pipe(Effect.flip)).toMatchObject({
        _tag: "PlatformError"
      })
      yield* fs.remove(path.join(root, "design-refs"), { recursive: true })
      const allDeleted = yield* discoverReferenceManifests(root, base)
      expect(productMatrix(allDeleted.current, allDeleted.base).include.map((item) => item.product)).toEqual([
        "deleted",
        "retained"
      ])
    }))
})
