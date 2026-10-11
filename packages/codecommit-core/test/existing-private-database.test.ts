import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import {
  ensurePrivateDatabasePath,
  verifyExistingPrivateDatabasePath
} from "../src/CacheService/internal/PrivateDatabasePathNode.js"

const withDatabase = <A, E, R>(
  run: (directory: string, database: string, fs: FileSystem.FileSystem) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-existing-cache-" })
    const database = path.join(directory, "cache.db")
    return yield* run(directory, database, fs)
  })

it.layer(NodeServices.layer)("existing Code cache boundary", (it) => {
  it.effect("verifies a private existing cache without changing content", () =>
    withDatabase((directory, database, fs) =>
      Effect.gen(function*() {
        yield* ensurePrivateDatabasePath(directory, database)
        yield* fs.writeFileString(database, "owner cache")
        yield* verifyExistingPrivateDatabasePath(directory, database)
        expect(yield* fs.readFileString(database)).toBe("owner cache")
      })
    ))

  /** The hub must refuse insecure owner storage rather than repair another application's files. */
  it.effect("refuses a public database without chmod repair", () =>
    withDatabase((directory, database, fs) =>
      Effect.gen(function*() {
        yield* ensurePrivateDatabasePath(directory, database)
        yield* fs.chmod(database, 0o644)
        expect(Result.isFailure(yield* Effect.result(verifyExistingPrivateDatabasePath(directory, database)))).toBe(
          true
        )
        expect((yield* fs.stat(database)).mode & 0o777).toBe(0o644)
      })
    ))

  it.effect("never creates a missing database", () =>
    withDatabase((directory, database, fs) =>
      Effect.gen(function*() {
        expect(Result.isFailure(yield* Effect.result(verifyExistingPrivateDatabasePath(directory, database)))).toBe(
          true
        )
        expect(yield* fs.exists(database)).toBe(false)
      })
    ))

  it.effect("refuses a cache database replaced by a symlink", () =>
    withDatabase((directory, database, fs) =>
      Effect.gen(function*() {
        yield* ensurePrivateDatabasePath(directory, database)
        const original = `${database}.owner`
        yield* fs.rename(database, original)
        yield* fs.symlink(original, database)
        const outcome = yield* Effect.result(verifyExistingPrivateDatabasePath(directory, database))
        expect(Result.isFailure(outcome)).toBe(true)
        if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("CacheError")
        expect((yield* fs.stat(original)).mode & 0o777).toBe(0o600)
      })
    ))

  /** Rechecking must compare against the retained fd, never accept a fresh pathname snapshot. */
  it.effect("detects replacement after attachment", () =>
    withDatabase((directory, database, fs) =>
      Effect.gen(function*() {
        yield* ensurePrivateDatabasePath(directory, database)
        const verifyIdentity = yield* verifyExistingPrivateDatabasePath(directory, database)
        yield* fs.rename(database, `${database}.owner`)
        yield* fs.writeFileString(database, "replacement")
        yield* fs.chmod(database, 0o600)
        expect(Result.isFailure(yield* Effect.result(verifyIdentity()))).toBe(true)
      })
    ))
})
