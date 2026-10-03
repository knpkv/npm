import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { systemError } from "effect/PlatformError"
import { databaseLayer } from "../src/core/Database.js"

const openStore = (directory: string) => Effect.scoped(Layer.build(databaseLayer(directory)).pipe(Effect.asVoid))

describe("databaseLayer", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("creates an owner-only directory and an owner-only database", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const directory = path.join(root, "agent-usage")
        yield* openStore(directory)
        expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(path.join(directory, "usage.db"))).mode & 0o777).toBe(0o600)
      }))

    it.effect("refuses a symlinked store directory", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const real = path.join(root, "real")
        yield* fs.makeDirectory(real, { mode: 0o700 })
        const link = path.join(root, "link")
        yield* fs.symlink(real, link)
        const error = yield* Effect.flip(openStore(link))
        expect(error).toMatchObject({ _tag: "StoreError", operation: "secure.symlink" })
      }))

    it.effect("refuses a store directory others can read", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const directory = path.join(root, "open")
        yield* fs.makeDirectory(directory)
        yield* fs.chmod(directory, 0o755)
        const error = yield* Effect.flip(openStore(directory))
        expect(error).toMatchObject({ _tag: "StoreError", operation: "secure.directory-mode" })
      }))
  })

  /** The real file system, except that every readlink fails with EIO. */
  const failingReadLink = Layer.merge(
    NodeServices.layer,
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        readLink: (path: string) =>
          Effect.fail(
            systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "readLink",
              pathOrDescriptor: path,
              cause: { code: "EIO" }
            })
          )
      }))
    ).pipe(Layer.provide(NodeServices.layer))
  )

  it.layer(failingReadLink)((it) => {
    it.effect("fails closed when readlink fails for any reason other than \"not a link\"", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(openStore("/nonexistent/agent-usage"))
        expect(error).toMatchObject({ _tag: "StoreError", operation: "secure.readlink" })
      }))
  })
})
