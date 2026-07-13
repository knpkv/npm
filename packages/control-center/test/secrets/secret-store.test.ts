import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Crypto, Scope } from "effect"
import { Deferred, Effect, Fiber, FileSystem, Logger, Option, Path, PlatformError, Ref, Result, Schema } from "effect"

import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import { makeSecretStore, SecretRoot, type SecretStore } from "../../src/server/secrets/SecretStore.js"
import {
  SecretNotFoundError,
  SecretProtectionError,
  SecretStoreInputError,
  SecretStoreIoError,
  SecretTooLargeError
} from "../../src/server/secrets/SecretStoreError.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const withSecretStore = <A, E>(
  use: (
    store: SecretStore["Service"],
    root: SecretRoot
  ) => Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secrets-" })
    const root = Schema.decodeSync(SecretRoot)(directory)
    const store = yield* makeSecretStore({ secretRoot: root, maximumSecretBytes: 64 })
    return yield* use(store, root)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const resolveString = (store: SecretStore["Service"], ref: SecretRef) =>
  Effect.scoped(
    Effect.gen(function*() {
      const lease = yield* store.resolve(ref)
      return yield* lease.withBytes((bytes) => Effect.succeed(decoder.decode(bytes)))
    })
  )

describe("SecretRef", () => {
  it("accepts only opaque, path-safe canonical references", () => {
    const canonical = `secret_${"a".repeat(64)}`

    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(SecretRef)(canonical)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(SecretRef)(canonical.toUpperCase())))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(SecretRef)(canonical.slice(1))))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(SecretRef)(`../${canonical}`)))
  })
})

describe("SecretStore", () => {
  it.effect("creates and durably secures a missing root beneath a canonical parent", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-new-root-" })
      const directory = path.join(parent, "secrets")
      const root = Schema.decodeSync(SecretRoot)(directory)
      const store = yield* makeSecretStore({ secretRoot: root })
      const ref = yield* store.create(encoder.encode("new-root-secret"))
      const rootInfo = yield* fs.stat(root)

      assert.strictEqual(rootInfo.type, "Directory")
      assert.strictEqual(rootInfo.mode & 0o777, 0o700)
      assert.strictEqual(yield* resolveString(store, ref), "new-root-secret")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("creates owner-only values and exposes only opaque references", () =>
    withSecretStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const rootInfo = yield* fs.stat(root)
        const ref = yield* store.create(encoder.encode("release-token-canary"))
        const fileInfo = yield* fs.stat(path.join(root, ref))

        assert.match(ref, /^secret_[0-9a-f]{64}$/u)
        assert.strictEqual(rootInfo.mode & 0o777, 0o700)
        assert.strictEqual(fileInfo.mode & 0o777, 0o600)
        assert.strictEqual(fileInfo.type, "File")
        assert.deepEqual(fileInfo.uid, rootInfo.uid)
        assert.strictEqual(yield* resolveString(store, ref), "release-token-canary")
      })
    ))

  it.effect("copies caller-owned bytes before asynchronous publication", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-copy-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const publicationStarted = yield* Deferred.make<void>()
      const continuePublication = yield* Deferred.make<void>()
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (target, options) =>
          target.includes(".incoming-")
            ? Deferred.succeed(publicationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(continuePublication)),
              Effect.andThen(fs.open(target, options))
            )
            : fs.open(target, options)
      })
      const store = yield* makeSecretStore({ secretRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem)
      )
      const callerBytes = encoder.encode("owner-controlled-value")
      const createFiber = yield* store.create(callerBytes).pipe(Effect.forkScoped)

      yield* Deferred.await(publicationStarted)
      callerBytes.fill(0)
      yield* Deferred.succeed(continuePublication, undefined)

      const ref = yield* Fiber.join(createFiber)
      assert.strictEqual(yield* resolveString(store, ref), "owner-controlled-value")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rotates one reference atomically and removes it", () =>
    withSecretStore((store) =>
      Effect.gen(function*() {
        const ref = yield* store.create(encoder.encode("old-value"))

        yield* store.rotate(ref, encoder.encode("new-value"))
        assert.strictEqual(yield* resolveString(store, ref), "new-value")

        yield* store.remove(ref)
        const missing = yield* Effect.scoped(store.resolve(ref)).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missing))
        if (Result.isFailure(missing)) assert.instanceOf(missing.failure, SecretNotFoundError)
      })
    ))

  it.effect("isolates references across resolve, rotate, and removal", () =>
    withSecretStore((store) =>
      Effect.gen(function*() {
        const first = yield* store.create(encoder.encode("first-secret"))
        const second = yield* store.create(encoder.encode("second-secret"))

        assert.notStrictEqual(first, second)
        yield* store.rotate(first, encoder.encode("first-rotated"))
        assert.strictEqual(yield* resolveString(store, first), "first-rotated")
        assert.strictEqual(yield* resolveString(store, second), "second-secret")

        yield* store.remove(first)
        assert.strictEqual(yield* resolveString(store, second), "second-secret")
      })
    ))

  it.effect("redacts leases, errors, logs, and zeroes scoped backing bytes", () =>
    withSecretStore((store) =>
      Effect.gen(function*() {
        const canary = "never-serialize-this-canary"
        const messages = yield* Ref.make<Array<unknown>>([])
        const logger = Logger.make<unknown, void>((entry) => {
          Effect.runSync(Ref.update(messages, (items) => [...items, entry.message]))
        })
        const ref = yield* store.create(encoder.encode(canary)).pipe(Effect.withLogger(logger))
        let retained: Uint8Array | undefined

        yield* Effect.scoped(
          Effect.gen(function*() {
            const lease = yield* store.resolve(ref)
            assert.strictEqual(JSON.stringify(lease), "\"[REDACTED]\"")
            assert.strictEqual(String(lease), "[REDACTED]")
            yield* lease.withBytes((bytes) =>
              Effect.sync(() => {
                retained = bytes
                assert.strictEqual(decoder.decode(bytes), canary)
              })
            )
          })
        ).pipe(Effect.withLogger(logger))

        assert.isDefined(retained)
        assert.deepEqual(retained, new Uint8Array(encoder.encode(canary).byteLength))

        const tooLarge = yield* store.create(encoder.encode(canary.repeat(4))).pipe(
          Effect.withLogger(logger),
          Effect.result
        )
        assert.isTrue(Result.isFailure(tooLarge))
        if (Result.isFailure(tooLarge)) {
          assert.instanceOf(tooLarge.failure, SecretTooLargeError)
          assert.notInclude(JSON.stringify(tooLarge.failure), canary)
        }
        assert.notInclude(JSON.stringify(yield* Ref.get(messages)), canary)
      })
    ))

  it.effect("redacts rejected configuration values", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-invalid-secret-config-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const result = yield* makeSecretStore({ secretRoot: root, maximumSecretBytes: 0 }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SecretStoreInputError)
        assert.notInclude(JSON.stringify(result.failure), directory)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails closed on insecure root modes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-insecure-secrets-" })
      yield* fs.chmod(directory, 0o755)
      const root = Schema.decodeSync(SecretRoot)(directory)
      const result = yield* makeSecretStore({ secretRoot: root }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("proves the running process owns the root with a pinned creation probe", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-owner-probe-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const rootInfo = yield* fs.stat(root)
      const mismatchedUid = Option.getOrElse(rootInfo.uid, () => 0) + 1
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((opened) =>
              requestedPath.includes(".owner-probe-")
                ? {
                  ...opened,
                  stat: opened.stat.pipe(Effect.map((info) => ({ ...info, uid: Option.some(mismatchedUid) })))
                }
                : opened
            )
          )
      })
      const result = yield* makeSecretStore({ secretRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
      assert.deepEqual(yield* fs.readDirectory(root), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rechecks root protection on every operation", () =>
    withSecretStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.chmod(root, 0o755)

        const result = yield* store.create(encoder.encode("root-mode-canary")).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
      })
    ))

  it.effect("does not create a missing root through a symbolic-link parent", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-parent-" })
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-parent-outside-" })
      const linkedParent = path.join(base, "linked-parent")
      const configured = path.join(linkedParent, "secrets")
      yield* fs.symlink(outside, linkedParent)

      const root = Schema.decodeSync(SecretRoot)(configured)
      const result = yield* makeSecretStore({ secretRoot: root }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
      assert.deepEqual(yield* fs.readDirectory(outside), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects secret-file mode and ownership mismatches", () =>
    withSecretStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const ref = yield* store.create(encoder.encode("mode-canary"))
        const file = path.join(root, ref)
        yield* fs.chmod(file, 0o644)

        const modeResult = yield* Effect.scoped(store.resolve(ref)).pipe(Effect.result)
        assert.isTrue(Result.isFailure(modeResult))
        if (Result.isFailure(modeResult)) assert.instanceOf(modeResult.failure, SecretProtectionError)

        yield* fs.chmod(file, 0o600)
        const realInfo = yield* fs.stat(file)
        const faultingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          open: (requestedPath, options) =>
            fs.open(requestedPath, options).pipe(
              Effect.map((opened) =>
                requestedPath.endsWith(ref)
                  ? {
                    ...opened,
                    stat: opened.stat.pipe(
                      Effect.map((info) => ({ ...info, uid: Option.some(Option.getOrElse(realInfo.uid, () => 0) + 1) }))
                    )
                  }
                  : opened
              )
            )
        })
        const isolatedStore = yield* makeSecretStore({ secretRoot: root }).pipe(
          Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
        )
        const ownerResult = yield* Effect.scoped(isolatedStore.resolve(ref)).pipe(Effect.result)
        assert.isTrue(Result.isFailure(ownerResult))
        if (Result.isFailure(ownerResult)) assert.instanceOf(ownerResult.failure, SecretProtectionError)
      })
    ))

  it.effect("does not follow a secret-entry symlink outside the protected root", () =>
    withSecretStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const outside = yield* fs.makeTempFileScoped({ prefix: "control-center-outside-secret-" })
        yield* fs.writeFile(outside, encoder.encode("outside-secret-canary"))
        const ref = yield* store.create(encoder.encode("inside-secret"))
        const file = path.join(root, ref)
        yield* fs.remove(file)
        yield* fs.symlink(outside, file)

        const result = yield* Effect.scoped(store.resolve(ref)).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
      })
    ))

  it.effect("pins the root during an active same-UID path swap", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-swap-" })
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-outside-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const displaced = `${directory}-displaced`
      const swapped = yield* Ref.make(false)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          Effect.gen(function*() {
            if (requestedPath.includes(".incoming-") && !(yield* Ref.getAndSet(swapped, true))) {
              yield* fs.rename(directory, displaced)
              yield* fs.symlink(outside, directory)
            }
            return yield* fs.open(requestedPath, options)
          })
      })
      const store = yield* makeSecretStore({ secretRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const result = yield* store.create(encoder.encode("swap-secret-canary")).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretProtectionError)
      assert.deepEqual(yield* fs.readDirectory(outside), [])
      assert.deepEqual(yield* fs.readDirectory(displaced), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps the previous value when atomic rotation publication fails", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-secret-rotate-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        rename: (fromPath, toPath) =>
          fromPath.includes(".incoming-")
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename"
            }))
            : fs.rename(fromPath, toPath)
      })
      const store = yield* makeSecretStore({ secretRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const ref = yield* store.create(encoder.encode("durable-old"))
      const result = yield* store.rotate(ref, encoder.encode("never-published")).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, SecretStoreIoError)
      assert.strictEqual(yield* resolveString(store, ref), "durable-old")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("closes every handle so the root can be removed after use", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectory({ prefix: "control-center-secret-teardown-" })
      const root = Schema.decodeSync(SecretRoot)(directory)
      const store = yield* makeSecretStore({ secretRoot: root })
      const ref = yield* store.create(encoder.encode("teardown-secret"))
      yield* resolveString(store, ref)
      yield* fs.remove(root, { recursive: true })

      assert.isFalse(yield* fs.exists(root))
    }).pipe(Effect.provide(NodeServices.layer)))
})
