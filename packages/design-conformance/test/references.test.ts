import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import { loadReferences, readVerifiedJson, verifiedBody } from "../src/references.js"
import { Fixture } from "../src/schema.js"

layer(NodeServices.layer)("reference filesystem", (it) => {
  it.effect("a product root symlink fails while its ordinary tree and a linked ancestor remain valid", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* path.fromFileUrl(new URL("../../../design-refs/_fixture/", import.meta.url))
      const parent = yield* fs.makeTempDirectoryScoped()
      const product = path.join(parent, "product")
      yield* fs.copy(source, product)
      expect((yield* loadReferences(product)).manifest.product).toBe("_fixture")
      const alias = path.join(parent, "alias")
      yield* fs.symlink(product, alias)
      for (const directory of [alias, alias + path.sep]) {
        expect(yield* loadReferences(directory).pipe(Effect.flip)).toMatchObject({
          _tag: "ReferenceFailure",
          detail: "Symlinks are not reference roots"
        })
      }
      const ancestor = path.join(parent, "ancestor")
      yield* fs.symlink(parent, ancestor)
      expect((yield* loadReferences(path.join(ancestor, "product"))).manifest.product).toBe("_fixture")
    }))

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

  // Design uploads are source material (prototypes, screenshots) that can carry real names; refs are exports only.
  it.effect("a design upload fails even when hashed, while a file merely named uploads loads", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const source = yield* path.fromFileUrl(new URL("../../../design-refs/_fixture/", import.meta.url))
      const hashed = (root: string, relative: string, body: string) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true })
          yield* fs.writeFileString(path.join(root, relative), body)
          const manifestPath = path.join(root, "manifest.json")
          const manifest: { files: Record<string, string> } = JSON.parse(yield* fs.readFileString(manifestPath))
          const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(body))
          manifest.files[relative] = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
          yield* fs.writeFileString(manifestPath, JSON.stringify(manifest))
        })
      for (
        const relative of ["uploads/prototype.html", "revisions/export-1/uploads/prototype.html", "Uploads/shot.png"]
      ) {
        const root = yield* fs.makeTempDirectoryScoped()
        yield* fs.copy(source, root)
        yield* hashed(root, relative, "<p>prototype</p>")
        expect(yield* loadReferences(root).pipe(Effect.flip)).toMatchObject({
          _tag: "ReferenceFailure",
          file: relative,
          detail: "Design uploads are never reference files"
        })
      }
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.copy(source, root)
      yield* hashed(root, "screens/uploads.css", "p {}")
      expect((yield* loadReferences(root)).manifest.product).toBe("_fixture")
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

  it.effect("verified fixture and asset bytes survive later disk rewrites and missing bodies fail typed", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* path.fromFileUrl(new URL("../../../design-refs/_fixture/", import.meta.url))
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.copy(source, root)
      const refs = yield* loadReferences(root)
      const file = "screens/screen.html"
      const original = yield* fs.readFile(path.join(root, file))
      yield* fs.writeFileString(path.join(root, file), "unverified HTML")
      yield* fs.writeFileString(
        path.join(root, refs.manifest.fixture),
        JSON.stringify({ version: 1, data: { changed: true } })
      )
      expect(yield* verifiedBody(refs.bodies, file)).toEqual(original)
      expect(yield* readVerifiedJson(refs.bodies, refs.manifest.fixture, Fixture)).toEqual(refs.fixture)
      expect(yield* verifiedBody(refs.bodies, "unlisted.html").pipe(Effect.flip)).toMatchObject({
        _tag: "ReferenceFailure",
        file: "unlisted.html",
        detail: "Verified reference body is unavailable"
      })
    }))
})
