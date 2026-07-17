import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PersistenceConfigError } from "./persistence/errors.js"
import { decodePersistenceConfig, type PersistenceConfig } from "./persistence/PersistenceConfig.js"
import { SecretRoot } from "./secrets/SecretStore.js"

export interface ControlCenterDataPaths {
  readonly dataRoot: string
  readonly persistenceConfig: PersistenceConfig
  readonly secretRoot: SecretRoot
}

export const DATA_ROOT_DIRECTORY_MODE = 0o700
export const DATA_ROOT_MARKER_MODE = 0o600
export const DATA_ROOT_MARKER_NAME = ".control-center-root"
export const DATA_ROOT_MARKER_V1_CONTENT = "@knpkv/control-center:data-root:v1\n"
export const DATA_ROOT_MARKER_V2_PREFIX = "@knpkv/control-center:data-root:v2\nclaim-basename:"
export const DATA_ROOT_MARKER_MAX_BYTES = 8_192
export const DATA_ROOT_PENDING_MARKER_PREFIX = `${DATA_ROOT_MARKER_NAME}.pending-`
export const DATA_ROOT_STAGING_PREFIX = ".control-center-incoming-"

const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined &&
      !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
  })

const ConfiguredDataRoot = Schema.String.check(
  Schema.makeFilter(hasNoControlCharacters, { expected: "a path without control characters" }),
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096)
)

export const dataRootConfigurationError = (): PersistenceConfigError =>
  new PersistenceConfigError({
    message: "Control Center data root must identify a private, dedicated application directory"
  })

export const mapDataRootConfigurationError = Effect.fn("DataRootProtocol.mapDataRootConfigurationError")(function*<
  Value,
  Failure,
  Requirements
>(
  effect: Effect.Effect<Value, Failure, Requirements>
): Effect.fn.Return<Value, PersistenceConfigError, Requirements> {
  return yield* effect.pipe(Effect.mapError(dataRootConfigurationError))
})

export const boundDataRootMarkerContent = (claimBasename: string, targetBasename: string): string =>
  `${DATA_ROOT_MARKER_V2_PREFIX}${Encoding.encodeBase64Url(claimBasename)}\ntarget-basename:${
    Encoding.encodeBase64Url(targetBasename)
  }\n`

export class FreshDataRootClaimConflict extends Schema.TaggedErrorClass<FreshDataRootClaimConflict>()(
  "FreshDataRootClaimConflict",
  { reason: Schema.Literal("target-raced") }
) {}

export class DataRootProtocolError extends Schema.TaggedErrorClass<DataRootProtocolError>()(
  "DataRootProtocolError",
  {
    reason: Schema.Literals([
      "cleanup-uncertain",
      "invalid-path",
      "parent-changed",
      "post-claim-sync-failed",
      "storage"
    ])
  }
) {}

export interface DataRootClaimLocation {
  readonly canonicalDataRoot: string
  readonly canonicalParent: string
  readonly configuredDataRoot: string
  readonly parent: string
  readonly parentInfo: FileSystem.File.Info
}

const protocolError = (reason: DataRootProtocolError["reason"]): DataRootProtocolError =>
  new DataRootProtocolError({ reason })

const mapProtocolStorage = Effect.fn("DataRootProtocol.mapProtocolStorage")(function*<
  Value,
  Failure,
  Requirements
>(
  effect: Effect.Effect<Value, Failure, Requirements>
): Effect.fn.Return<Value, DataRootProtocolError, Requirements> {
  return yield* effect.pipe(Effect.mapError(() => protocolError("storage")))
})

const sameIdentity = (left: FileSystem.File.Info, right: FileSystem.File.Info): boolean =>
  left.dev === right.dev &&
  Option.isSome(left.ino) &&
  Option.isSome(right.ino) &&
  left.ino.value === right.ino.value &&
  Option.isSome(left.uid) &&
  Option.isSome(right.uid) &&
  left.uid.value === right.uid.value

const descriptorAliases = (path: Path.Path, descriptor: FileSystem.File.Descriptor): ReadonlyArray<string> => [
  path.join("/proc/self/fd", String(descriptor)),
  path.join("/dev/fd", String(descriptor))
]

const resolveDescriptorAlias = Effect.fn("DataRootProtocol.resolveDescriptorAlias")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  descriptor: FileSystem.File.Descriptor,
  expectedPath: string
) {
  for (const alias of descriptorAliases(path, descriptor)) {
    const resolved = yield* fileSystem.realPath(alias).pipe(Effect.result)
    if (Result.isSuccess(resolved) && resolved.success === expectedPath) return alias
  }
  return yield* protocolError("storage")
})

interface PinnedStage {
  readonly _tag: "PinnedStage"
  readonly accessPath: string
  readonly canonicalPath: string
  readonly handle: FileSystem.File
  readonly info: FileSystem.File.Info
  readonly name: string
}

interface UnidentifiedStage {
  readonly _tag: "UnidentifiedStage"
  readonly createdPath: string
}

interface StagingLease {
  readonly state: Ref.Ref<PinnedStage | UnidentifiedStage>
}

/** Bracket whose release starts masked even when use observes a pending interrupt. */
const acquireUseReleaseMasked = Effect.fn("DataRootProtocol.acquireUseReleaseMasked")(function*<
  Resource,
  AcquireFailure,
  AcquireRequirements,
  Value,
  UseFailure,
  UseRequirements,
  ReleaseFailure,
  ReleaseRequirements
>(
  acquire: Effect.Effect<Resource, AcquireFailure, AcquireRequirements>,
  use: (resource: Resource) => Effect.Effect<Value, UseFailure, UseRequirements>,
  release: (
    resource: Resource,
    exit: Exit.Exit<Value, UseFailure>
  ) => Effect.Effect<void, ReleaseFailure, ReleaseRequirements>
): Effect.fn.Return<
  Value,
  AcquireFailure | ReleaseFailure | UseFailure,
  AcquireRequirements | ReleaseRequirements | UseRequirements
> {
  return yield* Effect.uninterruptibleMask(() =>
    acquire.pipe(
      Effect.flatMap((resource) =>
        Effect.interruptible(use(resource)).pipe(
          Effect.exit,
          Effect.flatMap((useExit) =>
            release(resource, useExit).pipe(
              Effect.exit,
              Effect.flatMap((releaseExit): Effect.Effect<Value, ReleaseFailure | UseFailure> => {
                if (Exit.isFailure(releaseExit)) {
                  return Effect.failCause(releaseExit.cause)
                }
                return Exit.isFailure(useExit)
                  ? Effect.failCause(useExit.cause)
                  : Effect.succeed(useExit.value)
              })
            )
          )
        )
      )
    )
  )
})

/** Validate only a configured claim path; generated operational staging paths use a separate decoder. */
export const validateConfiguredDataRootClaim = Effect.fn("DataRootProtocol.validateConfiguredClaim")(function*(
  configuredDataRoot: string
) {
  const path = yield* Path.Path
  const decoded = yield* Schema.decodeUnknownEffect(ConfiguredDataRoot)(configuredDataRoot).pipe(
    Effect.mapError(() => protocolError("invalid-path"))
  )
  const dataRoot = path.resolve(decoded)
  if (
    path.dirname(dataRoot) === dataRoot ||
    path.basename(dataRoot).startsWith(DATA_ROOT_STAGING_PREFIX)
  ) return yield* protocolError("invalid-path")
  return dataRoot
})

/** Capture the canonical prospective target and stable identity of its existing parent. */
export const inspectFreshDataRootClaim = Effect.fn("DataRootProtocol.inspectFreshClaim")(function*(
  configuredDataRoot: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataRoot = yield* validateConfiguredDataRootClaim(configuredDataRoot)
  const parent = path.dirname(dataRoot)
  const canonicalParent = yield* mapProtocolStorage(fileSystem.realPath(parent))
  const parentInfo = yield* mapProtocolStorage(fileSystem.stat(parent))
  if (parentInfo.type !== "Directory") return yield* protocolError("invalid-path")
  return {
    canonicalDataRoot: path.join(canonicalParent, path.basename(dataRoot)),
    canonicalParent,
    configuredDataRoot: dataRoot,
    parent,
    parentInfo
  } satisfies DataRootClaimLocation
})

/** Resolve a not-yet-created claim through its nearest existing canonical ancestor without writing. */
export const canonicalProspectiveDataRoot = Effect.fn("DataRootProtocol.canonicalProspectiveRoot")(function*(
  configuredDataRoot: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataRoot = yield* validateConfiguredDataRootClaim(configuredDataRoot)
  const missingSegments: Array<string> = []
  let cursor = path.dirname(dataRoot)
  while (!(yield* mapProtocolStorage(fileSystem.exists(cursor)))) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return yield* protocolError("invalid-path")
    missingSegments.unshift(path.basename(cursor))
    cursor = parent
  }
  const canonicalAncestor = yield* mapProtocolStorage(fileSystem.realPath(cursor))
  return path.join(canonicalAncestor, ...missingSegments, path.basename(dataRoot))
})

/** Durably create only missing configured-parent segments without changing existing ancestor modes. */
export const ensureFreshDataRootParent = Effect.fn("DataRootProtocol.ensureFreshParent")(function*(
  configuredDataRoot: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataRoot = yield* validateConfiguredDataRootClaim(configuredDataRoot)
  const missingSegments: Array<string> = []
  let cursor = path.dirname(dataRoot)
  while (!(yield* mapProtocolStorage(fileSystem.exists(cursor)))) {
    missingSegments.unshift(path.basename(cursor))
    const parent = path.dirname(cursor)
    if (parent === cursor) return yield* protocolError("invalid-path")
    cursor = parent
  }
  let current = cursor
  for (const segment of missingSegments) {
    const child = path.join(current, segment)
    const created = yield* fileSystem.makeDirectory(child, { mode: DATA_ROOT_DIRECTORY_MODE }).pipe(Effect.result)
    if (Result.isFailure(created)) return yield* protocolError("parent-changed")
    yield* mapProtocolStorage(fileSystem.chmod(child, DATA_ROOT_DIRECTORY_MODE))
    yield* syncDataRootPath(child).pipe(Effect.mapError(() => protocolError("storage")))
    yield* syncDataRootPath(current).pipe(Effect.mapError(() => protocolError("storage")))
    current = child
  }
})

const assertParentIdentity = Effect.fn("DataRootProtocol.assertParentIdentity")(function*(
  location: DataRootClaimLocation
) {
  const fileSystem = yield* FileSystem.FileSystem
  const canonicalParent = yield* mapProtocolStorage(fileSystem.realPath(location.parent))
  const parentInfo = yield* mapProtocolStorage(fileSystem.stat(location.parent))
  if (canonicalParent !== location.canonicalParent || !sameIdentity(parentInfo, location.parentInfo)) {
    return yield* protocolError("parent-changed")
  }
})

export const syncDataRootPath = Effect.fn("DataRootProtocol.syncPath")(function*(target: string) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* Effect.scoped(
    mapDataRootConfigurationError(fileSystem.open(target, { flag: "r" })).pipe(
      Effect.flatMap((handle) => mapDataRootConfigurationError(handle.sync))
    )
  )
})

export const publishDataRootMarker = Effect.fn("DataRootProtocol.publishMarker")(function*(
  dataRoot: string,
  claimBasename: string,
  targetBasename: string
) {
  const cryptoService = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const markerPath = path.join(dataRoot, DATA_ROOT_MARKER_NAME)
  const markerContent = boundDataRootMarkerContent(claimBasename, targetBasename)
  yield* Effect.scoped(Effect.uninterruptible(Effect.gen(function*() {
    const random = yield* mapDataRootConfigurationError(cryptoService.randomBytes(16))
    const pendingMarker = `${markerPath}.pending-${Encoding.encodeHex(random)}`
    yield* Effect.addFinalizer(() =>
      fileSystem.remove(pendingMarker, { force: true }).pipe(
        Effect.andThen(syncDataRootPath(dataRoot)),
        Effect.ignore
      )
    )
    yield* mapDataRootConfigurationError(fileSystem.writeFileString(pendingMarker, markerContent, {
      flag: "wx",
      mode: DATA_ROOT_MARKER_MODE
    }))
    yield* mapDataRootConfigurationError(fileSystem.chmod(pendingMarker, DATA_ROOT_MARKER_MODE))
    yield* syncDataRootPath(pendingMarker)
    yield* mapDataRootConfigurationError(fileSystem.rename(pendingMarker, markerPath))
    yield* syncDataRootPath(dataRoot)
  })))
})

export const publishFreshDataRootClaim = Effect.fn("DataRootProtocol.publishFreshClaim")(function*<
  Failure,
  Requirements
>(
  location: DataRootClaimLocation,
  rejectExistingClaim: boolean,
  initialize: (
    operationalPaths: ControlCenterDataPaths,
    canonicalPaths: ControlCenterDataPaths
  ) => Effect.Effect<void, Failure, Requirements>
): Effect.fn.Return<
  ControlCenterDataPaths,
  DataRootProtocolError | Failure | FreshDataRootClaimConflict,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Requirements
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { configuredDataRoot } = location
  yield* assertParentIdentity(location)
  const claimState = yield* Ref.make<"attempted" | "lost-race" | "not-attempted" | "observed" | "owned">(
    "not-attempted"
  )
  const cleanupFailed = yield* Ref.make(false)
  return yield* Effect.uninterruptibleMask((restore) =>
    restore(Effect.scoped(Effect.gen(function*() {
      const parentHandle = yield* mapProtocolStorage(fileSystem.open(location.canonicalParent, { flag: "r" }))
      const parentInfo = yield* mapProtocolStorage(parentHandle.stat)
      if (!sameIdentity(parentInfo, location.parentInfo)) return yield* protocolError("parent-changed")
      const parentAlias = yield* resolveDescriptorAlias(
        fileSystem,
        path,
        parentHandle.fd,
        location.canonicalParent
      )
      const claimPath = path.join(parentAlias, path.basename(configuredDataRoot))

      const assertPinnedParent = Effect.gen(function*() {
        const descriptorInfo = yield* parentHandle.stat.pipe(Effect.result)
        const descriptorPath = yield* fileSystem.realPath(parentAlias).pipe(Effect.result)
        const configuredParent = yield* fileSystem.realPath(location.parent).pipe(Effect.result)
        if (
          Result.isFailure(descriptorInfo) ||
          Result.isFailure(descriptorPath) ||
          Result.isFailure(configuredParent) ||
          descriptorPath.success !== location.canonicalParent ||
          configuredParent.success !== location.canonicalParent ||
          !sameIdentity(descriptorInfo.success, location.parentInfo)
        ) return yield* protocolError("parent-changed")
      })

      return yield* acquireUseReleaseMasked(
        Effect.gen(function*() {
          const created = yield* mapProtocolStorage(
            fileSystem.makeTempDirectory({ directory: parentAlias, prefix: DATA_ROOT_STAGING_PREFIX })
          )
          // The portable API returns only a pathname from mkdtemp. A same-UID actor
          // can substitute it before the first open; later identity capture detects
          // observable swaps but cannot prove which inode mkdtemp originally created.
          const state = yield* Ref.make<PinnedStage | UnidentifiedStage>({
            _tag: "UnidentifiedStage",
            createdPath: created
          })
          return {
            state
          } satisfies StagingLease
        }),
        (stagingLease) =>
          Effect.gen(function*() {
            const unidentified = yield* Ref.get(stagingLease.state)
            if (unidentified._tag !== "UnidentifiedStage") return yield* protocolError("storage")
            const name = path.basename(unidentified.createdPath)
            if (
              path.dirname(unidentified.createdPath) !== parentAlias ||
              !name.startsWith(DATA_ROOT_STAGING_PREFIX) ||
              name === DATA_ROOT_STAGING_PREFIX
            ) return yield* protocolError("cleanup-uncertain")
            const accessPath = path.join(parentAlias, name)
            const canonicalPath = path.join(location.canonicalParent, name)
            const pinned = yield* Effect.gen(function*() {
              const handle = yield* mapProtocolStorage(fileSystem.open(accessPath, { flag: "r" }))
              const info = yield* mapProtocolStorage(handle.stat)
              const namedInfo = yield* mapProtocolStorage(fileSystem.stat(accessPath))
              const resolved = yield* mapProtocolStorage(fileSystem.realPath(accessPath))
              if (
                info.type !== "Directory" ||
                resolved !== canonicalPath ||
                !sameIdentity(info, namedInfo)
              ) return yield* protocolError("cleanup-uncertain")
              const descriptorPath = yield* resolveDescriptorAlias(fileSystem, path, handle.fd, canonicalPath)
              return {
                _tag: "PinnedStage",
                accessPath: descriptorPath,
                canonicalPath,
                handle,
                info,
                name
              } satisfies PinnedStage
            }).pipe(Effect.result)
            if (Result.isFailure(pinned)) return yield* protocolError("cleanup-uncertain")
            const lease = pinned.success
            yield* Effect.uninterruptible(
              Ref.set(stagingLease.state, lease).pipe(
                Effect.andThen(Effect.addFinalizer((scopeExit) =>
                  Exit.isSuccess(scopeExit)
                    ? Effect.void
                    : Effect.gen(function*() {
                      const entries = yield* fileSystem.readDirectory(parentAlias).pipe(Effect.result)
                      if (Result.isFailure(entries)) return yield* Ref.set(cleanupFailed, true)
                      if (!entries.success.includes(lease.name)) {
                        const synced = yield* parentHandle.sync.pipe(Effect.result)
                        return yield* Ref.set(cleanupFailed, Result.isFailure(synced))
                      }
                      if (entries.success.includes(path.basename(configuredDataRoot))) {
                        return yield* Ref.set(cleanupFailed, true)
                      }
                      const currentInfo = yield* fileSystem.stat(path.join(parentAlias, lease.name)).pipe(
                        Effect.result
                      )
                      const currentPath = yield* fileSystem.realPath(path.join(parentAlias, lease.name)).pipe(
                        Effect.result
                      )
                      if (
                        Result.isFailure(currentInfo) ||
                        Result.isFailure(currentPath) ||
                        currentPath.success !== lease.canonicalPath ||
                        !sameIdentity(currentInfo.success, lease.info)
                      ) return yield* Ref.set(cleanupFailed, true)
                      // This finalizer was registered after fs.open, so the descriptor
                      // still pins lease.info until it returns. The pinned Effect file
                      // service can defect when handle.stat is evaluated under a pending interrupt;
                      // named identity is compared with the already captured fstat.
                      const preflightSynced = yield* parentHandle.sync.pipe(Effect.result)
                      if (Result.isFailure(preflightSynced)) return yield* Ref.set(cleanupFailed, true)
                      const removed = yield* fileSystem.remove(path.join(parentAlias, lease.name), {
                        force: true,
                        recursive: true
                      }).pipe(Effect.result)
                      if (Result.isFailure(removed)) return yield* Ref.set(cleanupFailed, true)
                      const synced = yield* parentHandle.sync.pipe(Effect.result)
                      if (Result.isFailure(synced)) return yield* Ref.set(cleanupFailed, true)
                      yield* Ref.set(cleanupFailed, false)
                    })
                ))
              )
            )
            yield* mapProtocolStorage(fileSystem.chmod(lease.accessPath, DATA_ROOT_DIRECTORY_MODE))
            const pinnedPaths = yield* decodeOperationalDataPaths(lease.accessPath).pipe(
              Effect.mapError(() => protocolError("storage"))
            )
            const canonicalPaths = yield* decodeOperationalDataPaths(lease.canonicalPath).pipe(
              Effect.mapError(() => protocolError("storage"))
            )
            const assertPinnedStageBinding = Effect.gen(function*() {
              const descriptorInfo = yield* lease.handle.stat.pipe(Effect.result)
              const namedInfo = yield* fileSystem.stat(path.join(parentAlias, lease.name)).pipe(Effect.result)
              const namedPath = yield* fileSystem.realPath(path.join(parentAlias, lease.name)).pipe(Effect.result)
              const descriptorPath = yield* fileSystem.realPath(lease.accessPath).pipe(Effect.result)
              if (
                Result.isFailure(descriptorInfo) ||
                Result.isFailure(namedInfo) ||
                Result.isFailure(namedPath) ||
                Result.isFailure(descriptorPath) ||
                namedPath.success !== lease.canonicalPath ||
                descriptorPath.success !== lease.canonicalPath ||
                !sameIdentity(descriptorInfo.success, lease.info) ||
                !sameIdentity(namedInfo.success, lease.info)
              ) return yield* protocolError("cleanup-uncertain")
            })
            yield* Effect.interruptible(initialize(pinnedPaths, canonicalPaths))
            yield* Effect.uninterruptible(Effect.gen(function*() {
              yield* assertPinnedParent
              yield* publishDataRootMarker(
                lease.accessPath,
                path.basename(configuredDataRoot),
                lease.name
              ).pipe(Effect.mapError(() => protocolError("storage")))
              yield* lease.handle.sync.pipe(Effect.mapError(() => protocolError("storage")))
              yield* assertPinnedStageBinding
              yield* Ref.set(claimState, "attempted")
              const claimed = yield* fileSystem.symlink(lease.name, claimPath).pipe(Effect.result)
              if (Result.isFailure(claimed)) {
                if (claimed.failure.reason._tag !== "AlreadyExists") return yield* protocolError("storage")
                if (rejectExistingClaim) {
                  yield* Ref.set(claimState, "lost-race")
                  return yield* new FreshDataRootClaimConflict({ reason: "target-raced" })
                }
                const existing = yield* fileSystem.readLink(claimPath).pipe(Effect.result)
                if (Result.isFailure(existing) || existing.success !== lease.name) {
                  return yield* protocolError("storage")
                }
                yield* Ref.set(claimState, "observed")
              } else {
                yield* Ref.set(claimState, "owned")
              }
              const parentSynced = yield* parentHandle.sync.pipe(Effect.result)
              if (Result.isFailure(parentSynced)) return yield* protocolError("post-claim-sync-failed")
              yield* assertPinnedStageBinding
              const claimInfo = yield* fileSystem.stat(claimPath).pipe(Effect.result)
              const claimTarget = yield* fileSystem.realPath(claimPath).pipe(Effect.result)
              if (
                Result.isFailure(claimInfo) ||
                Result.isFailure(claimTarget) ||
                claimTarget.success !== lease.canonicalPath ||
                !sameIdentity(claimInfo.success, lease.info)
              ) return yield* protocolError("cleanup-uncertain")
              yield* assertPinnedParent
            }))
            return canonicalPaths
          }),
        (stagingLease, exit) =>
          Effect.uninterruptible(
            Effect.gen(function*() {
              if (Exit.isSuccess(exit)) return
              const lease = yield* Ref.get(stagingLease.state)
              // Effect preserves a pending external interruption over this release
              // failure. The stage is still retained; ordinary open/stat failures
              // expose cleanup-uncertain through the typed error channel.
              if (lease._tag === "UnidentifiedStage") return yield* protocolError("cleanup-uncertain")

              const removeOwnedStaging = Effect.gen(function*() {
                const descriptorInfo = yield* lease.handle.stat.pipe(Effect.result)
                const currentInfo = yield* fileSystem.stat(path.join(parentAlias, lease.name)).pipe(Effect.result)
                const canonical = yield* fileSystem.realPath(path.join(parentAlias, lease.name)).pipe(Effect.result)
                if (
                  Result.isFailure(descriptorInfo) ||
                  Result.isFailure(currentInfo) ||
                  Result.isFailure(canonical) ||
                  canonical.success !== lease.canonicalPath ||
                  !sameIdentity(descriptorInfo.success, lease.info) ||
                  !sameIdentity(currentInfo.success, lease.info)
                ) return yield* protocolError("cleanup-uncertain")

                // Effect's public FileSystem has no unlinkat. A same-UID actor can still race
                // the final checked pathname operation; all observable substitutions fail closed.
                const preflightSynced = yield* parentHandle.sync.pipe(Effect.result)
                if (Result.isFailure(preflightSynced)) return yield* protocolError("cleanup-uncertain")
                const removed = yield* fileSystem.remove(path.join(parentAlias, lease.name), {
                  force: true,
                  recursive: true
                }).pipe(Effect.result)
                if (Result.isFailure(removed)) return yield* protocolError("cleanup-uncertain")
                const synced = yield* parentHandle.sync.pipe(Effect.result)
                if (Result.isFailure(synced)) return yield* protocolError("cleanup-uncertain")
              })

              return yield* Effect.gen(function*() {
                const claim = yield* Ref.get(claimState)
                if (claim === "owned") {
                  const ownedClaim = yield* fileSystem.readLink(claimPath).pipe(Effect.result)
                  if (Result.isFailure(ownedClaim) || ownedClaim.success !== lease.name) {
                    return yield* protocolError("cleanup-uncertain")
                  }
                  const removed = yield* fileSystem.remove(claimPath).pipe(Effect.result)
                  if (Result.isFailure(removed)) return yield* protocolError("cleanup-uncertain")
                  const rollbackSynced = yield* parentHandle.sync.pipe(Effect.result)
                  if (Result.isFailure(rollbackSynced)) return yield* protocolError("cleanup-uncertain")
                  yield* Ref.set(claimState, "not-attempted")
                }

                const parentEntries = yield* fileSystem.readDirectory(parentAlias).pipe(Effect.result)
                if (Result.isFailure(parentEntries)) return yield* protocolError("cleanup-uncertain")
                if (!parentEntries.success.includes(path.basename(configuredDataRoot))) {
                  yield* removeOwnedStaging
                  return
                }
                const claimed = yield* fileSystem.readLink(claimPath).pipe(Effect.result)
                if (Result.isSuccess(claimed)) {
                  if (claimed.success === lease.name) return yield* protocolError("cleanup-uncertain")
                  yield* removeOwnedStaging
                  return
                }
                if (claimed.failure.reason._tag === "NotFound") {
                  yield* removeOwnedStaging
                  return
                }
                const directInfo = yield* fileSystem.stat(claimPath).pipe(Effect.result)
                const directPath = yield* fileSystem.realPath(claimPath).pipe(Effect.result)
                if (
                  Result.isSuccess(directInfo) &&
                  Result.isSuccess(directPath) &&
                  (directPath.success !== lease.canonicalPath || !sameIdentity(directInfo.success, lease.info))
                ) {
                  yield* removeOwnedStaging
                  return
                }
                return yield* protocolError("cleanup-uncertain")
              })
            }).pipe(
              Effect.exit,
              Effect.flatMap((releaseExit) =>
                Exit.isFailure(releaseExit)
                  ? Ref.set(cleanupFailed, true)
                  : Effect.void
              )
            )
          )
      )
    }))).pipe(
      Effect.exit,
      Effect.flatMap((scopeExit) =>
        Ref.get(cleanupFailed).pipe(
          Effect.flatMap((failed): Effect.Effect<
            ControlCenterDataPaths,
            DataRootProtocolError | Failure | FreshDataRootClaimConflict
          > => {
            if (failed) return Effect.fail(protocolError("cleanup-uncertain"))
            return Exit.isFailure(scopeExit)
              ? Effect.failCause(scopeExit.cause)
              : Effect.succeed(scopeExit.value)
          })
        )
      )
    )
  )
})

export const decodeControlCenterDataPaths = Effect.fn("decodeControlCenterDataPaths")(function*(
  configuredDataRoot: string
): Effect.fn.Return<ControlCenterDataPaths, PersistenceConfigError, Path.Path> {
  const path = yield* Path.Path
  const dataRoot = yield* validateConfiguredDataRootClaim(configuredDataRoot).pipe(
    Effect.mapError(dataRootConfigurationError)
  )
  return yield* decodeOperationalDataPaths(path.resolve(dataRoot))
})

export const decodeOperationalDataPaths = Effect.fn("DataRootProtocol.decodeOperationalPaths")(function*(
  dataRoot: string
) {
  const path = yield* Path.Path
  const persistenceConfig = yield* decodePersistenceConfig({
    blobRoot: path.join(dataRoot, "blobs"),
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${path.join(dataRoot, "control-center.db")}`,
    maxConnections: 1
  })
  const secretRoot = yield* Schema.decodeUnknownEffect(SecretRoot)(path.join(dataRoot, "secrets")).pipe(
    Effect.mapError(dataRootConfigurationError)
  )
  return { dataRoot, persistenceConfig, secretRoot }
})
