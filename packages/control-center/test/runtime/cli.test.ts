import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"

import { classifyControlCenterCliArguments } from "../../src/server/cliArguments.js"
import { decodeControlCenterDataPaths, prepareControlCenterDataRoot } from "../../src/server/cliConfiguration.js"
import { PersistenceConfigError } from "../../src/server/persistence/errors.js"

describe("Control Center CLI", () => {
  it("accepts exactly the serve and recover-owner argument shapes", () => {
    assert.deepStrictEqual(classifyControlCenterCliArguments([]), { _tag: "serve" })
    assert.deepStrictEqual(classifyControlCenterCliArguments(["recover-owner"]), { _tag: "recover-owner" })
    assert.deepStrictEqual(classifyControlCenterCliArguments(["recover-owner", "unexpected"]), {
      _tag: "invalid",
      command: "recover-owner unexpected"
    })
  })

  it.effect("decodes derived data paths without defecting on invalid environment input", () =>
    Effect.gen(function*() {
      const valid = yield* decodeControlCenterDataPaths(".control-center")
      assert.match(valid.persistenceConfig.databaseUrl, /^file:\//u)
      assert.match(valid.persistenceConfig.blobRoot, /\/blobs$/u)
      assert.match(valid.secretRoot, /\/secrets$/u)

      const invalid = yield* decodeControlCenterDataPaths(`root-${"a".repeat(4_096)}`).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) {
        assert.instanceOf(invalid.failure, PersistenceConfigError)
      }

      for (const unsafeRoot of ["", " ", "/"]) {
        const result = yield* decodeControlCenterDataPaths(unsafeRoot).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistenceConfigError)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses an unrelated existing directory without changing its mode", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-unrelated-" })
      const privateRoot = path.join(parent, "private")
      yield* fileSystem.chmod(parent, 0o755)
      yield* fileSystem.makeDirectory(privateRoot, { mode: 0o700 })

      const unrelatedRoots: ReadonlyArray<readonly [string, number]> = [
        [parent, 0o755],
        [privateRoot, 0o700]
      ]
      for (const [root, expectedMode] of unrelatedRoots) {
        const dataPaths = yield* decodeControlCenterDataPaths(root)
        const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)
        assert.isTrue(Result.isFailure(prepared))
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, expectedMode)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("creates a marked root and accepts it again without changing its identity", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-fresh-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)

      yield* prepareControlCenterDataRoot(dataPaths)
      const before = yield* fileSystem.stat(root)
      yield* prepareControlCenterDataRoot(dataPaths)
      const after = yield* fileSystem.stat(root)

      assert.strictEqual(before.ino._tag, "Some")
      assert.deepStrictEqual(after.ino, before.ino)
      assert.strictEqual(after.mode & 0o777, 0o700)
      assert.include(yield* fileSystem.readDirectory(root), ".control-center-root")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("adopts an existing private legacy Control Center root", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-legacy-" })
      yield* fileSystem.chmod(root, 0o700)
      yield* fileSystem.writeFileString(path.join(root, "control-center.db"), "legacy")
      yield* fileSystem.makeDirectory(path.join(root, "blobs"), { mode: 0o700 })
      yield* fileSystem.makeDirectory(path.join(root, "secrets"), { mode: 0o700 })
      const dataPaths = yield* decodeControlCenterDataPaths(root)

      yield* prepareControlCenterDataRoot(dataPaths)
      yield* prepareControlCenterDataRoot(dataPaths)

      assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, 0o700)
      assert.include(yield* fileSystem.readDirectory(root), ".control-center-root")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
