import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import { loadReferences } from "../src/references.js"

layer(NodeServices.layer)("reference filesystem", (it) => {
  it.effect("hashed fixture and all HTML assets load; changed and unlisted assets fail", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* path.fromFileUrl(new URL("../../../design-refs/_fixture/", import.meta.url))
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.copy(source, root)
      const refs = yield* loadReferences(root)
      expect(refs.manifest.product).toBe("_fixture")
      yield* fs.writeFileString(path.join(root, "screens/screen.css"), "changed")
      const invalid = yield* loadReferences(root).pipe(Effect.flip)
      expect(invalid).toMatchObject({ _tag: "ReferenceFailure", detail: "SHA256 mismatch" })
      yield* fs.copy(source, root)
      yield* fs.writeFileString(path.join(root, "unlisted.js"), "unlisted")
      expect(yield* loadReferences(root).pipe(Effect.flip)).toMatchObject({
        _tag: "ReferenceFailure",
        detail: "Hash inventory must include every reference file, and only existing files"
      })
    }))

  it.effect("reference symlinks cannot bypass the hash inventory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* path.fromFileUrl(new URL("../../../design-refs/_fixture/", import.meta.url))
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.copy(source, root)
      yield* fs.symlink(path.join(root, "fixture.json"), path.join(root, "alias.json"))
      expect(yield* loadReferences(root).pipe(Effect.flip)).toMatchObject({
        _tag: "ReferenceFailure",
        detail: "Symlinks are not reference files"
      })
    }))
})
