import type { FileSystem as FileSystemType, Path as PathType, Scope } from "effect"
import { Context, Crypto, Effect, FileSystem, Layer, Option, Path, Predicate, Result, Schema } from "effect"

import { SecretRef } from "./SecretRef.js"
import {
  SecretNotFoundError,
  SecretProtectionError,
  type SecretStoreError,
  SecretStoreInputError,
  secretStoreIoError,
  SecretTooLargeError
} from "./SecretStoreError.js"

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/])/u
const DIRECTORY_MODE = 0o700
const SECRET_FILE_MODE = 0o600
const DEFAULT_MAXIMUM_SECRET_BYTES = 64 * 1024
const MAXIMUM_CONFIGURED_SECRET_BYTES = 1024 * 1024
const PUBLICATION_ATTEMPTS = 8

const BoundedPositiveInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAXIMUM_CONFIGURED_SECRET_BYTES)
)
const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined &&
      !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
  })

/** Absolute owner-controlled directory for secret values. */
export const SecretRoot = Schema.String.check(
  Schema.makeFilter(hasNoControlCharacters, { expected: "a path without control characters" }),
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(ABSOLUTE_PATH_PATTERN, { expected: "an absolute filesystem path" })
).pipe(Schema.brand("SecretRoot"))

/** Decoded owner-controlled secret root. */
export type SecretRoot = typeof SecretRoot.Type

/** Construction options. Values remain bounded even when callers omit the limit. */
export interface SecretStoreOptions {
  readonly secretRoot: SecretRoot
  readonly maximumSecretBytes?: number | undefined
}

/**
 * Scoped access to one secret value. The backing bytes are zeroed when the
 * surrounding Effect scope closes and are intentionally not serializable.
 */
export interface SecretLease {
  readonly byteLength: number
  readonly withBytes: <A, E, R>(
    use: (bytes: Uint8Array) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  readonly toJSON: () => "[REDACTED]"
  readonly toString: () => "[REDACTED]"
}

interface SecretStoreService {
  readonly create: (value: Uint8Array) => Effect.Effect<SecretRef, SecretStoreError>
  readonly rotate: (ref: SecretRef, value: Uint8Array) => Effect.Effect<void, SecretStoreError>
  readonly remove: (ref: SecretRef) => Effect.Effect<void, SecretStoreError>
  readonly resolve: (
    ref: SecretRef
  ) => Effect.Effect<SecretLease, SecretStoreError, Scope.Scope>
}

/** Owner-only, reference-based storage with scoped secret resolution. */
export class SecretStore extends Context.Service<SecretStore, SecretStoreService>()(
  "@knpkv/control-center/server/secrets/SecretStore"
) {
  static readonly layer = (
    options: SecretStoreOptions
  ): Layer.Layer<SecretStore, SecretStoreError, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
    Layer.effect(SecretStore, makeSecretStore(options))
}

interface PinnedRoot {
  readonly path: string
  readonly sync: Effect.Effect<void, SecretStoreError>
  readonly assertIdentity: Effect.Effect<void, SecretProtectionError>
}

const decodeInput = <S extends Schema.ConstraintDecoder<unknown>>(
  operation: string,
  schema: S,
  input: unknown
): Effect.Effect<S["Type"], SecretStoreInputError> => {
  const result = Schema.decodeUnknownResult(schema)(input)
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new SecretStoreInputError({ operation, message: "input failed schema validation" }))
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const descriptorAliases = (
  path: PathType.Path,
  descriptor: FileSystemType.File.Descriptor
): ReadonlyArray<string> => [
  path.join("/proc/self/fd", String(descriptor)),
  path.join("/dev/fd", String(descriptor))
]

const sameIdentity = (left: FileSystemType.File.Info, right: FileSystemType.File.Info): boolean =>
  left.dev === right.dev &&
  Option.isSome(left.ino) &&
  Option.isSome(right.ino) &&
  left.ino.value === right.ino.value

const secureOwner = (info: FileSystemType.File.Info): number | undefined => Option.getOrUndefined(info.uid)

/** Constructs a store while capturing all runtime services in its layer. */
export const makeSecretStore: (
  options: SecretStoreOptions
) => Effect.Effect<
  SecretStore["Service"],
  SecretStoreError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> = Effect.fn("SecretStore.make")(function*(options: SecretStoreOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const decodedRoot = yield* decodeInput("configure secretRoot", SecretRoot, options.secretRoot)
  const maximumSecretBytes = yield* decodeInput(
    "configure maximumSecretBytes",
    BoundedPositiveInteger,
    options.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES
  )
  const configuredRoot = path.resolve(decodedRoot)

  const existed = yield* fs.exists(configuredRoot).pipe(
    Effect.mapError((cause) => secretStoreIoError("check secret root", cause))
  )
  if (!existed) {
    const configuredParent = path.dirname(configuredRoot)
    const canonicalParent = yield* fs.realPath(configuredParent).pipe(
      Effect.mapError((cause) => secretStoreIoError("resolve secret root parent", cause))
    )
    if (canonicalParent !== configuredParent) {
      return yield* new SecretProtectionError({
        operation: "initialize",
        message: "secretRoot parent must not cross a symbolic link"
      })
    }
    const created = yield* fs.makeDirectory(configuredRoot, {
      mode: DIRECTORY_MODE
    }).pipe(Effect.result)
    if (Result.isFailure(created) && created.failure.reason._tag !== "AlreadyExists") {
      return yield* secretStoreIoError("create secret root", created.failure)
    }
    if (Result.isSuccess(created)) {
      yield* fs.chmod(configuredRoot, DIRECTORY_MODE).pipe(
        Effect.mapError((cause) => secretStoreIoError("secure secret root", cause))
      )
    }
  }

  const canonicalRoot = yield* fs.realPath(configuredRoot).pipe(
    Effect.mapError((cause) => secretStoreIoError("resolve secret root", cause))
  )
  if (canonicalRoot !== configuredRoot) {
    return yield* new SecretProtectionError({
      operation: "initialize",
      message: "secretRoot must not cross a symbolic link"
    })
  }

  const rootInfo = yield* fs.stat(canonicalRoot).pipe(
    Effect.mapError((cause) => secretStoreIoError("inspect secret root", cause))
  )
  const rootOwner = secureOwner(rootInfo)
  const isSecureRootInfo = (info: FileSystemType.File.Info): boolean =>
    info.type === "Directory" &&
    (info.mode & 0o777) === DIRECTORY_MODE &&
    secureOwner(info) === rootOwner &&
    Option.isSome(info.ino)
  if (rootOwner === undefined || !isSecureRootInfo(rootInfo)) {
    return yield* new SecretProtectionError({
      operation: "initialize",
      message: "secretRoot must be an owner-only directory with stable ownership"
    })
  }

  const syncDirectory = Effect.fn("SecretStore.syncDirectory")(function*(directory: string) {
    yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* fs.open(directory, { flag: "r" }).pipe(
          Effect.mapError((cause) => secretStoreIoError("open directory for sync", cause))
        )
        yield* handle.sync.pipe(
          Effect.mapError((cause) => secretStoreIoError("sync directory", cause))
        )
      })
    )
  })
  if (!existed) {
    yield* syncDirectory(canonicalRoot)
    yield* syncDirectory(path.dirname(canonicalRoot))
  }

  const resolveAlias = Effect.fn("SecretStore.resolveDescriptorAlias")(function*(
    descriptor: FileSystemType.File.Descriptor,
    expectedPath: string,
    operation: string
  ) {
    for (const alias of descriptorAliases(path, descriptor)) {
      const resolved = yield* fs.realPath(alias).pipe(Effect.result)
      if (Result.isSuccess(resolved) && resolved.success === expectedPath) return alias
    }
    return yield* new SecretProtectionError({
      operation,
      message: "opened descriptor did not match its expected contained path"
    })
  })

  const randomName = Effect.fn("SecretStore.randomName")(function*(prefix: string) {
    const random = yield* cryptoService.randomBytes(32).pipe(
      Effect.mapError((cause) => secretStoreIoError("generate opaque reference", cause))
    )
    return `${prefix}${hex(random)}`
  })

  const pinRoot = Effect.fn("SecretStore.pinRoot")(function*() {
    const handle = yield* fs.open(canonicalRoot, { flag: "r" }).pipe(
      Effect.mapError((cause) => secretStoreIoError("pin secret root", cause))
    )
    const info = yield* handle.stat.pipe(
      Effect.mapError((cause) => secretStoreIoError("inspect pinned secret root", cause))
    )
    if (!sameIdentity(rootInfo, info) || !isSecureRootInfo(info)) {
      return yield* new SecretProtectionError({
        operation: "pin secret root",
        message: "secretRoot identity changed"
      })
    }
    const alias = yield* resolveAlias(handle.fd, canonicalRoot, "pin secret root")
    const assertIdentity = Effect.gen(function*() {
      const current = yield* handle.stat.pipe(Effect.result)
      const resolved = yield* fs.realPath(alias).pipe(Effect.result)
      if (
        Result.isFailure(current) ||
        Result.isFailure(resolved) ||
        resolved.success !== canonicalRoot ||
        !sameIdentity(rootInfo, current.success) ||
        !isSecureRootInfo(current.success)
      ) {
        return yield* new SecretProtectionError({
          operation: "access secret root",
          message: "pinned secretRoot identity changed"
        })
      }
    })
    return {
      path: alias,
      sync: handle.sync.pipe(
        Effect.mapError((cause) => secretStoreIoError("sync secret root", cause))
      ),
      assertIdentity
    } satisfies PinnedRoot
  })

  const verifyProcessOwnsRoot = Effect.fn("SecretStore.verifyProcessOwnsRoot")(function*() {
    yield* Effect.scoped(
      Effect.uninterruptible(
        Effect.gen(function*() {
          const root = yield* pinRoot()
          for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
            const probe = path.join(root.path, yield* randomName(".owner-probe-"))
            const opened = yield* fs.open(probe, { flag: "wx", mode: SECRET_FILE_MODE }).pipe(Effect.result)
            if (Result.isFailure(opened)) {
              if (opened.failure.reason._tag === "AlreadyExists") continue
              return yield* secretStoreIoError("create secret owner probe", opened.failure)
            }
            yield* Effect.addFinalizer(() =>
              fs.remove(probe, { force: true }).pipe(
                Effect.andThen(root.sync),
                Effect.ignore
              )
            )
            yield* fs.chmod(probe, SECRET_FILE_MODE).pipe(
              Effect.mapError((cause) => secretStoreIoError("secure secret owner probe", cause))
            )
            const info = yield* opened.success.stat.pipe(
              Effect.mapError((cause) => secretStoreIoError("inspect secret owner probe", cause))
            )
            if (
              info.type !== "File" ||
              (info.mode & 0o777) !== SECRET_FILE_MODE ||
              secureOwner(info) !== rootOwner ||
              Option.isNone(info.ino)
            ) {
              return yield* new SecretProtectionError({
                operation: "initialize",
                message: "secretRoot must be owned by the running process"
              })
            }
            yield* root.assertIdentity
            yield* fs.remove(probe).pipe(
              Effect.mapError((cause) => secretStoreIoError("remove secret owner probe", cause))
            )
            yield* root.sync
            yield* root.assertIdentity
            return
          }
          return yield* secretStoreIoError("create secret owner probe", "collision limit reached")
        })
      )
    )
  })

  yield* verifyProcessOwnsRoot()

  const decodeRef = (operation: string, input: unknown) => decodeInput(operation, SecretRef, input)

  const checkedValue = Effect.fn("SecretStore.checkedValue")(function*(value: Uint8Array) {
    if (!Predicate.isUint8Array(value)) {
      return yield* new SecretStoreInputError({
        operation: "write secret",
        message: "secret value must be a byte array"
      })
    }
    if (value.byteLength > maximumSecretBytes) {
      return yield* new SecretTooLargeError({
        actualBytes: value.byteLength,
        maximumBytes: maximumSecretBytes
      })
    }
    return Uint8Array.from(value)
  })

  const inspectSecretFile = Effect.fn("SecretStore.inspectSecretFile")(function*(
    file: FileSystemType.File,
    operation: string
  ) {
    const info = yield* file.stat.pipe(
      Effect.mapError((cause) => secretStoreIoError("inspect secret file", cause))
    )
    // The model explicitly trusts the store owner (same UID). A completed
    // hard-link publication may retain its protected temporary name after a
    // crash, so link count is not treated as a cross-UID protection signal.
    if (
      info.type !== "File" ||
      (info.mode & 0o777) !== SECRET_FILE_MODE ||
      secureOwner(info) !== rootOwner ||
      Option.isNone(info.ino)
    ) {
      return yield* new SecretProtectionError({
        operation,
        message: "secret entry must be an owner-only regular file"
      })
    }
    return info
  })

  const openExisting = Effect.fn("SecretStore.openExisting")(function*(
    root: PinnedRoot,
    ref: SecretRef,
    operation: string
  ) {
    const expected = path.join(canonicalRoot, ref)
    const contained = path.join(root.path, ref)
    const opened = yield* fs.open(contained, { flag: "r" }).pipe(Effect.result)
    if (Result.isFailure(opened)) {
      if (opened.failure.reason._tag === "NotFound") return yield* new SecretNotFoundError({ ref })
      return yield* secretStoreIoError("open secret file", opened.failure)
    }
    yield* resolveAlias(opened.success.fd, expected, operation)
    const info = yield* inspectSecretFile(opened.success, operation)
    yield* root.assertIdentity
    return { file: opened.success, info }
  })

  const writeTemporary = Effect.fn("SecretStore.writeTemporary")(function*(
    root: PinnedRoot,
    bytes: Uint8Array
  ) {
    for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
      const name = yield* randomName(".incoming-")
      const temporary = path.join(root.path, name)
      const opened = yield* fs.open(temporary, { flag: "wx", mode: SECRET_FILE_MODE }).pipe(Effect.result)
      if (Result.isFailure(opened)) {
        if (opened.failure.reason._tag === "AlreadyExists") continue
        return yield* secretStoreIoError("create temporary secret", opened.failure)
      }
      yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore))
      yield* fs.chmod(temporary, SECRET_FILE_MODE).pipe(
        Effect.mapError((cause) => secretStoreIoError("secure temporary secret", cause))
      )
      yield* opened.success.writeAll(bytes).pipe(
        Effect.mapError((cause) => secretStoreIoError("write temporary secret", cause))
      )
      yield* opened.success.sync.pipe(
        Effect.mapError((cause) => secretStoreIoError("sync temporary secret", cause))
      )
      yield* inspectSecretFile(opened.success, "publish secret")
      yield* root.assertIdentity
      return temporary
    }
    return yield* secretStoreIoError("create temporary secret", "collision limit reached")
  })

  const create = Effect.fn("SecretStore.create")(function*(value: Uint8Array) {
    const bytes = yield* checkedValue(value)
    return yield* Effect.gen(function*() {
      for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
        const ref = yield* decodeRef("create secret reference", `secret_${yield* randomName("")}`)
        const linked = yield* Effect.scoped(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              const root = yield* pinRoot()
              const temporary = yield* restore(writeTemporary(root, bytes))
              const destination = path.join(root.path, ref)
              const result = yield* fs.link(temporary, destination).pipe(Effect.result)
              if (Result.isFailure(result)) return result
              yield* root.sync
              yield* fs.remove(temporary).pipe(
                Effect.mapError((cause) => secretStoreIoError("remove temporary secret", cause))
              )
              yield* root.sync
              yield* root.assertIdentity
              return result
            })
          )
        )
        if (Result.isSuccess(linked)) return ref
        if (linked.failure.reason._tag !== "AlreadyExists") {
          return yield* secretStoreIoError("publish secret", linked.failure)
        }
      }
      return yield* secretStoreIoError("publish secret", "reference collision limit reached")
    }).pipe(Effect.ensuring(Effect.sync(() => bytes.fill(0))))
  })

  const rotate = Effect.fn("SecretStore.rotate")(function*(refInput: SecretRef, value: Uint8Array) {
    const ref = yield* decodeRef("rotate secret", refInput)
    const bytes = yield* checkedValue(value)
    yield* Effect.gen(function*() {
      yield* Effect.scoped(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const root = yield* pinRoot()
            yield* openExisting(root, ref, "rotate secret")
            const temporary = yield* restore(writeTemporary(root, bytes))
            yield* root.assertIdentity
            yield* fs.rename(temporary, path.join(root.path, ref)).pipe(
              Effect.mapError((cause) => secretStoreIoError("rotate secret", cause))
            )
            yield* root.sync
            yield* root.assertIdentity
          })
        )
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => bytes.fill(0)))
    )
  })

  const remove = Effect.fn("SecretStore.remove")(function*(refInput: SecretRef) {
    const ref = yield* decodeRef("remove secret", refInput)
    yield* Effect.scoped(
      Effect.uninterruptible(
        Effect.gen(function*() {
          const root = yield* pinRoot()
          yield* openExisting(root, ref, "remove secret")
          yield* root.assertIdentity
          yield* fs.remove(path.join(root.path, ref)).pipe(
            Effect.mapError((cause) => secretStoreIoError("remove secret", cause))
          )
          yield* root.sync
          yield* root.assertIdentity
        })
      )
    )
  })

  const resolve = Effect.fn("SecretStore.resolve")(function*(refInput: SecretRef) {
    const ref = yield* decodeRef("resolve secret", refInput)
    const root = yield* pinRoot()
    const opened = yield* openExisting(root, ref, "resolve secret")
    const size = Number(opened.info.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumSecretBytes) {
      return yield* new SecretTooLargeError({ actualBytes: size, maximumBytes: maximumSecretBytes })
    }
    const bytes = new Uint8Array(size)
    yield* Effect.addFinalizer(() => Effect.sync(() => bytes.fill(0)))
    let offset = 0
    while (offset < size) {
      const read = Number(
        yield* opened.file.read(bytes.subarray(offset)).pipe(
          Effect.mapError((cause) => secretStoreIoError("read secret", cause))
        )
      )
      if (read <= 0) {
        return yield* secretStoreIoError("read secret", "unexpected end of file")
      }
      offset += read
    }
    yield* root.assertIdentity
    return {
      byteLength: size,
      withBytes: (use) => use(bytes),
      toJSON: () => "[REDACTED]",
      toString: () => "[REDACTED]"
    } satisfies SecretLease
  })

  return { create, rotate, remove, resolve }
})
