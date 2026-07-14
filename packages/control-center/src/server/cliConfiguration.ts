import type { FileSystem as FileSystemType, Path as PathType } from "effect"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { validateExistingControlCenterDatabase } from "./persistence/Database.js"
import { PersistenceConfigError } from "./persistence/errors.js"
import { decodePersistenceConfig, type PersistenceConfig } from "./persistence/PersistenceConfig.js"
import { SecretRoot } from "./secrets/SecretStore.js"

/** Validated filesystem paths derived from the untrusted data-root environment value. */
export interface ControlCenterDataPaths {
  readonly dataRoot: string
  readonly persistenceConfig: PersistenceConfig
  readonly secretRoot: SecretRoot
}

const DATA_ROOT_DIRECTORY_MODE = 0o700
const DATA_ROOT_MARKER_MODE = 0o600
const DATA_ROOT_MARKER_NAME = ".control-center-root"
const DATA_ROOT_MARKER_V1_CONTENT = "@knpkv/control-center:data-root:v1\n"
const DATA_ROOT_MARKER_V2_PREFIX = "@knpkv/control-center:data-root:v2\nclaim-basename:"
const DATA_ROOT_MARKER_MAX_BYTES = 8_192
const DATA_ROOT_PENDING_MARKER_PREFIX = `${DATA_ROOT_MARKER_NAME}.pending-`
const DATA_ROOT_STAGING_PREFIX = ".control-center-incoming-"
const DATA_ROOT_OWNER_PROBE_PREFIX = ".control-center-owner-"
const SQLITE_HEADER = Uint8Array.from([
  0x53,
  0x51,
  0x4c,
  0x69,
  0x74,
  0x65,
  0x20,
  0x66,
  0x6f,
  0x72,
  0x6d,
  0x61,
  0x74,
  0x20,
  0x33,
  0x00
])

const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined && !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
  })

const ConfiguredDataRoot = Schema.String.check(
  Schema.makeFilter(hasNoControlCharacters, { expected: "a path without control characters" }),
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096)
)

const hasRandomHexSuffix = (entry: string, prefix: string): boolean => {
  if (!entry.startsWith(prefix)) return false
  const suffix = entry.slice(prefix.length)
  return suffix.length === 32 && Array.from(suffix).every((character) => /[0-9a-f]/u.test(character))
}

const configurationError = (): PersistenceConfigError =>
  new PersistenceConfigError({
    message: "Control Center data root must identify a private, dedicated application directory"
  })

const mapConfigurationError = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, PersistenceConfigError, Requirements> => effect.pipe(Effect.mapError(configurationError))

const sameOwner = (left: FileSystem.File.Info, right: FileSystem.File.Info): boolean =>
  Option.isSome(left.uid) && Option.isSome(right.uid) && left.uid.value === right.uid.value

const sameIdentity = (left: FileSystem.File.Info, right: FileSystem.File.Info): boolean =>
  left.dev === right.dev &&
  Option.isSome(left.ino) &&
  Option.isSome(right.ino) &&
  left.ino.value === right.ino.value &&
  sameOwner(left, right)

const descriptorAliases = (
  path: PathType.Path,
  descriptor: FileSystemType.File.Descriptor
): ReadonlyArray<string> => [
  path.join("/proc/self/fd", String(descriptor)),
  path.join("/dev/fd", String(descriptor))
]

interface MarkerPublication {
  readonly claimBasename: string
  readonly cryptoService: Crypto.Crypto
  readonly dataRoot: string
  readonly fileSystem: FileSystem.FileSystem
  readonly markerPath: string
  readonly targetBasename: string
}

interface LegacyDataRootValidation {
  readonly dataPaths: ControlCenterDataPaths
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly rootInfo: FileSystem.File.Info
}

interface ProcessOwnershipVerification {
  readonly cryptoService: Crypto.Crypto
  readonly dataRoot: string
  readonly fileSystem: FileSystem.FileSystem
  readonly initialRootInfo: FileSystem.File.Info
  readonly path: Path.Path
}

interface FreshDataRootPublication {
  readonly cryptoService: Crypto.Crypto
  readonly dataRoot: string
  readonly fileSystem: FileSystem.FileSystem
  readonly parent: string
  readonly path: Path.Path
}

interface PendingMarkerCleanup {
  readonly dataRoot: string
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly rootInfo: FileSystem.File.Info
}

interface LostClaimDetection {
  readonly fileSystem: FileSystem.FileSystem
  readonly parent: string
  readonly path: Path.Path
  readonly requestedClaimBasename: string
}

type DataRootMarker =
  | { readonly _tag: "Legacy" }
  | { readonly _tag: "Bound"; readonly claimBasename: string; readonly targetBasename: string }

const boundMarkerContent = (claimBasename: string, targetBasename: string): string =>
  `${DATA_ROOT_MARKER_V2_PREFIX}${Encoding.encodeBase64Url(claimBasename)}\ntarget-basename:${
    Encoding.encodeBase64Url(targetBasename)
  }\n`

const decodeMarkerBasename = (
  path: Path.Path,
  encodedBasename: string
): Result.Result<string, PersistenceConfigError> => {
  const decodedBasename = Encoding.decodeBase64UrlString(encodedBasename)
  if (
    Result.isFailure(decodedBasename) ||
    decodedBasename.success.length === 0 ||
    decodedBasename.success.length > 4_096 ||
    !hasNoControlCharacters(decodedBasename.success) ||
    decodedBasename.success === "." ||
    decodedBasename.success === ".." ||
    path.basename(decodedBasename.success) !== decodedBasename.success ||
    Encoding.encodeBase64Url(decodedBasename.success) !== encodedBasename
  ) {
    return Result.fail(configurationError())
  }
  return Result.succeed(decodedBasename.success)
}

const decodeDataRootMarker = (
  path: Path.Path,
  content: string
): Result.Result<DataRootMarker, PersistenceConfigError> => {
  if (content === DATA_ROOT_MARKER_V1_CONTENT) return Result.succeed({ _tag: "Legacy" })
  if (!content.startsWith(DATA_ROOT_MARKER_V2_PREFIX) || !content.endsWith("\n")) {
    return Result.fail(configurationError())
  }
  const encodedFields = content.slice(DATA_ROOT_MARKER_V2_PREFIX.length, -1).split("\ntarget-basename:")
  if (encodedFields.length !== 2) return Result.fail(configurationError())
  const encodedClaim = encodedFields[0]
  const encodedTarget = encodedFields[1]
  if (encodedClaim === undefined || encodedTarget === undefined) return Result.fail(configurationError())
  const claimBasename = decodeMarkerBasename(path, encodedClaim)
  if (Result.isFailure(claimBasename)) return Result.fail(claimBasename.failure)
  if (claimBasename.success.startsWith(DATA_ROOT_STAGING_PREFIX)) return Result.fail(configurationError())
  const targetBasename = decodeMarkerBasename(path, encodedTarget)
  if (Result.isFailure(targetBasename)) return Result.fail(targetBasename.failure)
  return Result.succeed({
    _tag: "Bound",
    claimBasename: claimBasename.success,
    targetBasename: targetBasename.success
  })
}

const validatePrivateDirectory = Effect.fn("ControlCenterCli.validatePrivateDirectory")(function*(
  fileSystem: FileSystem.FileSystem,
  dataRoot: string
) {
  const canonicalRoot = yield* mapConfigurationError(fileSystem.realPath(dataRoot))
  const info = yield* mapConfigurationError(fileSystem.stat(dataRoot))
  if (
    canonicalRoot !== dataRoot ||
    info.type !== "Directory" ||
    (info.mode & 0o777) !== DATA_ROOT_DIRECTORY_MODE ||
    Option.isNone(info.uid) ||
    Option.isNone(info.ino)
  ) {
    return yield* configurationError()
  }
  return info
})

const validateMarker = Effect.fn("ControlCenterCli.validateDataRootMarker")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  markerPath: string,
  rootInfo: FileSystem.File.Info
) {
  const canonicalMarker = yield* mapConfigurationError(fileSystem.realPath(markerPath))
  const markerInfo = yield* mapConfigurationError(fileSystem.stat(markerPath))
  if (
    canonicalMarker !== markerPath ||
    markerInfo.type !== "File" ||
    (markerInfo.mode & 0o777) !== DATA_ROOT_MARKER_MODE ||
    !sameOwner(rootInfo, markerInfo) ||
    Number(markerInfo.size) > DATA_ROOT_MARKER_MAX_BYTES
  ) {
    return yield* configurationError()
  }
  const content = yield* mapConfigurationError(fileSystem.readFileString(markerPath))
  return yield* Effect.fromResult(decodeDataRootMarker(path, content))
})

const validateMarkerForClaim = Effect.fn("ControlCenterCli.validateDataRootMarkerForClaim")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  markerPath: string,
  rootInfo: FileSystem.File.Info,
  claimBasename: string,
  targetBasename: string
) {
  const marker = yield* validateMarker(fileSystem, path, markerPath, rootInfo)
  if (
    marker._tag === "Bound" &&
    (marker.claimBasename !== claimBasename || marker.targetBasename !== targetBasename)
  ) {
    return yield* configurationError()
  }
  return marker
})

const validateLegacyDataRoot = Effect.fn("ControlCenterCli.validateLegacyDataRoot")(function*(
  request: LegacyDataRootValidation
) {
  const { dataPaths, fileSystem, path, rootInfo } = request
  const databasePath = path.join(dataPaths.dataRoot, "control-center.db")
  const canonicalDatabase = yield* mapConfigurationError(fileSystem.realPath(databasePath))
  const databaseInfo = yield* mapConfigurationError(fileSystem.stat(databasePath))
  if (
    canonicalDatabase !== databasePath ||
    databaseInfo.type !== "File" ||
    !sameOwner(rootInfo, databaseInfo) ||
    Number(databaseInfo.size) < SQLITE_HEADER.length
  ) {
    return yield* configurationError()
  }

  const header = yield* Effect.scoped(
    mapConfigurationError(fileSystem.open(databasePath, { flag: "r" })).pipe(
      Effect.flatMap((file) => mapConfigurationError(file.readAlloc(SQLITE_HEADER.length)))
    )
  )
  if (
    Option.isNone(header) ||
    header.value.length !== SQLITE_HEADER.length ||
    !SQLITE_HEADER.every((byte, index) => header.value[index] === byte)
  ) return yield* configurationError()

  // A non-empty exact migration prefix is the durable identity shared by
  // pre-marker releases. Inspecting a scoped snapshot prevents SQLite journal
  // recovery or WAL bookkeeping from mutating a root before it is adopted.
  yield* Effect.scoped(
    Effect.gen(function*() {
      const snapshotRoot = yield* mapConfigurationError(
        fileSystem.makeTempDirectoryScoped({ prefix: "control-center-legacy-snapshot-" })
      )
      const snapshotDatabase = path.join(snapshotRoot, "control-center.db")
      yield* mapConfigurationError(fileSystem.copyFile(databasePath, snapshotDatabase))

      for (const suffix of ["-wal", "-journal"]) {
        const sidecar = `${databasePath}${suffix}`
        if (!(yield* mapConfigurationError(fileSystem.exists(sidecar)))) continue
        const canonicalSidecar = yield* mapConfigurationError(fileSystem.realPath(sidecar))
        const sidecarInfo = yield* mapConfigurationError(fileSystem.stat(sidecar))
        if (
          canonicalSidecar !== sidecar ||
          sidecarInfo.type !== "File" ||
          !sameOwner(rootInfo, sidecarInfo)
        ) return yield* configurationError()
        yield* mapConfigurationError(fileSystem.copyFile(sidecar, `${snapshotDatabase}${suffix}`))
      }

      yield* validateExistingControlCenterDatabase({
        blobRoot: path.join(snapshotRoot, "blobs"),
        busyTimeoutMilliseconds: dataPaths.persistenceConfig.busyTimeoutMilliseconds,
        databaseUrl: `file:${snapshotDatabase}`,
        maxConnections: dataPaths.persistenceConfig.maxConnections
      }).pipe(Effect.mapError(configurationError))
    })
  )
})

const syncPath = Effect.fn("ControlCenterCli.syncDataRootPath")(function*(
  fileSystem: FileSystem.FileSystem,
  target: string
) {
  yield* Effect.scoped(
    mapConfigurationError(fileSystem.open(target, { flag: "r" })).pipe(
      Effect.flatMap((handle) => mapConfigurationError(handle.sync))
    )
  )
})

const publishMarker = Effect.fn("ControlCenterCli.publishDataRootMarker")(function*(
  request: MarkerPublication
) {
  const { claimBasename, cryptoService, dataRoot, fileSystem, markerPath, targetBasename } = request
  const markerContent = boundMarkerContent(claimBasename, targetBasename)
  yield* Effect.scoped(
    Effect.uninterruptible(
      Effect.gen(function*() {
        const random = yield* mapConfigurationError(cryptoService.randomBytes(16))
        const pendingMarker = `${markerPath}.pending-${Encoding.encodeHex(random)}`
        yield* Effect.addFinalizer(() =>
          fileSystem.remove(pendingMarker, { force: true }).pipe(
            Effect.andThen(syncPath(fileSystem, dataRoot)),
            Effect.ignore
          )
        )
        yield* mapConfigurationError(
          fileSystem.writeFileString(pendingMarker, markerContent, {
            flag: "wx",
            mode: DATA_ROOT_MARKER_MODE
          })
        )
        yield* mapConfigurationError(fileSystem.chmod(pendingMarker, DATA_ROOT_MARKER_MODE))
        yield* syncPath(fileSystem, pendingMarker)
        yield* mapConfigurationError(fileSystem.rename(pendingMarker, markerPath))
        yield* syncPath(fileSystem, dataRoot)
      })
    )
  )
})

const removeValidPendingMarkers = Effect.fn("ControlCenterCli.removeValidPendingMarkers")(function*(
  request: PendingMarkerCleanup,
  claimBasename: string,
  targetBasename: string
) {
  const { dataRoot, fileSystem, path, rootInfo } = request
  const entries = yield* mapConfigurationError(fileSystem.readDirectory(dataRoot))
  const pendingNames = entries.filter((entry) => hasRandomHexSuffix(entry, DATA_ROOT_PENDING_MARKER_PREFIX))
  const validPendingPaths: Array<string> = []

  for (const pendingName of pendingNames) {
    const pendingPath = path.join(dataRoot, pendingName)
    const canonicalPending = yield* mapConfigurationError(fileSystem.realPath(pendingPath))
    const pendingInfo = yield* mapConfigurationError(fileSystem.stat(pendingPath))
    if (
      canonicalPending !== pendingPath ||
      pendingInfo.type !== "File" ||
      (pendingInfo.mode & 0o777) !== DATA_ROOT_MARKER_MODE ||
      !sameOwner(rootInfo, pendingInfo) ||
      Number(pendingInfo.size) > boundMarkerContent(claimBasename, targetBasename).length
    ) return yield* configurationError()

    const content = yield* mapConfigurationError(fileSystem.readFileString(pendingPath))
    if (
      !DATA_ROOT_MARKER_V1_CONTENT.startsWith(content) &&
      !boundMarkerContent(claimBasename, targetBasename).startsWith(content)
    ) return yield* configurationError()
    validPendingPaths.push(pendingPath)
  }

  for (const pendingPath of validPendingPaths) {
    const removed = yield* fileSystem.remove(pendingPath).pipe(Effect.result)
    if (Result.isFailure(removed) && removed.failure.reason._tag !== "NotFound") {
      return yield* configurationError()
    }
  }

  if (pendingNames.length > 0) yield* syncPath(fileSystem, dataRoot)
})

const verifyProcessOwnership = Effect.fn("ControlCenterCli.verifyProcessOwnership")(function*(
  request: ProcessOwnershipVerification
) {
  const { cryptoService, dataRoot, fileSystem, initialRootInfo, path } = request
  const isExpectedRoot = (info: FileSystem.File.Info): boolean =>
    info.type === "Directory" &&
    (info.mode & 0o777) === DATA_ROOT_DIRECTORY_MODE &&
    sameIdentity(initialRootInfo, info)

  yield* Effect.scoped(
    Effect.uninterruptible(
      Effect.gen(function*() {
        const directory = yield* mapConfigurationError(fileSystem.open(dataRoot, { flag: "r" }))
        const directoryInfo = yield* mapConfigurationError(directory.stat)
        if (!isExpectedRoot(directoryInfo)) return yield* configurationError()

        let alias: string | undefined
        for (const candidate of descriptorAliases(path, directory.fd)) {
          const resolved = yield* fileSystem.realPath(candidate).pipe(Effect.result)
          if (Result.isSuccess(resolved) && resolved.success === dataRoot) {
            alias = candidate
            break
          }
        }
        if (alias === undefined) return yield* configurationError()

        const assertIdentity = Effect.gen(function*() {
          const current = yield* directory.stat.pipe(Effect.result)
          const resolved = yield* fileSystem.realPath(alias).pipe(Effect.result)
          if (
            Result.isFailure(current) ||
            Result.isFailure(resolved) ||
            resolved.success !== dataRoot ||
            !isExpectedRoot(current.success)
          ) return yield* configurationError()
        })

        yield* assertIdentity
        const random = yield* mapConfigurationError(cryptoService.randomBytes(16))
        const probePath = path.join(alias, `${DATA_ROOT_OWNER_PROBE_PREFIX}${Encoding.encodeHex(random)}`)
        const probe = yield* mapConfigurationError(
          fileSystem.open(probePath, { flag: "wx", mode: DATA_ROOT_MARKER_MODE })
        )
        yield* Effect.addFinalizer(() =>
          fileSystem.remove(probePath, { force: true }).pipe(
            Effect.andThen(directory.sync),
            Effect.ignore
          )
        )
        yield* mapConfigurationError(fileSystem.chmod(probePath, DATA_ROOT_MARKER_MODE))
        const probeInfo = yield* mapConfigurationError(probe.stat)
        if (
          probeInfo.type !== "File" ||
          (probeInfo.mode & 0o777) !== DATA_ROOT_MARKER_MODE ||
          !sameOwner(directoryInfo, probeInfo)
        ) return yield* configurationError()

        yield* assertIdentity
        yield* mapConfigurationError(fileSystem.remove(probePath))
        yield* mapConfigurationError(directory.sync)
        yield* assertIdentity
      })
    )
  )
})

const resolveStagingRoot = (path: Path.Path, parent: string, target: string): Option.Option<string> => {
  const name = path.basename(target)
  return !path.isAbsolute(target) && target === name && name.startsWith(DATA_ROOT_STAGING_PREFIX)
    ? Option.some(path.join(parent, name))
    : Option.none()
}

const isBase64UrlPrefix = (value: string): boolean =>
  Array.from(value).every((character) => /[0-9A-Za-z_-]/u.test(character))

const isPotentialBoundMarkerPrefix = (path: Path.Path, content: string): boolean => {
  if (DATA_ROOT_MARKER_V2_PREFIX.startsWith(content)) return true
  if (!content.startsWith(DATA_ROOT_MARKER_V2_PREFIX)) return false
  const remaining = content.slice(DATA_ROOT_MARKER_V2_PREFIX.length)
  const claimTerminator = remaining.indexOf("\n")
  if (claimTerminator === -1) return isBase64UrlPrefix(remaining)
  const encodedClaim = remaining.slice(0, claimTerminator)
  if (!isBase64UrlPrefix(encodedClaim)) return false

  const targetLabel = "target-basename:"
  const targetField = remaining.slice(claimTerminator + 1)
  if (targetLabel.startsWith(targetField)) return true
  if (!targetField.startsWith(targetLabel)) return false
  const encodedTargetWithTerminator = targetField.slice(targetLabel.length)
  if (!encodedTargetWithTerminator.endsWith("\n")) return isBase64UrlPrefix(encodedTargetWithTerminator)
  return Result.isSuccess(decodeDataRootMarker(path, content))
}

const isPotentialMarkerPrefix = (path: Path.Path, content: string): boolean =>
  DATA_ROOT_MARKER_V1_CONTENT.startsWith(content) || isPotentialBoundMarkerPrefix(path, content)

const validateProtocolArtifact = Effect.fn("ControlCenterCli.validateDataRootProtocolArtifact")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  stagingRoot: string,
  rootInfo: FileSystem.File.Info,
  entry: string
) {
  const isFinalMarker = entry === DATA_ROOT_MARKER_NAME
  const isOwnerProbe = hasRandomHexSuffix(entry, DATA_ROOT_OWNER_PROBE_PREFIX)
  const isPendingMarker = hasRandomHexSuffix(entry, DATA_ROOT_PENDING_MARKER_PREFIX)
  if (!isFinalMarker && !isOwnerProbe && !isPendingMarker) return false

  const artifactPath = path.join(stagingRoot, entry)
  const canonicalArtifact = yield* mapConfigurationError(fileSystem.realPath(artifactPath))
  const artifactInfo = yield* mapConfigurationError(fileSystem.stat(artifactPath))
  if (
    canonicalArtifact !== artifactPath ||
    artifactInfo.type !== "File" ||
    (artifactInfo.mode & 0o777) !== DATA_ROOT_MARKER_MODE ||
    !sameOwner(rootInfo, artifactInfo)
  ) return yield* configurationError()

  if (isFinalMarker) {
    if (Number(artifactInfo.size) > DATA_ROOT_MARKER_MAX_BYTES) return yield* configurationError()
    const content = yield* mapConfigurationError(fileSystem.readFileString(artifactPath))
    const marker = decodeDataRootMarker(path, content)
    if (
      Result.isFailure(marker) ||
      (marker.success._tag === "Bound" && marker.success.targetBasename !== path.basename(stagingRoot))
    ) return yield* configurationError()
    return true
  }

  if (isOwnerProbe) {
    if (Number(artifactInfo.size) !== 0) return yield* configurationError()
    return true
  }

  if (Number(artifactInfo.size) > DATA_ROOT_MARKER_MAX_BYTES) return yield* configurationError()
  const content = yield* mapConfigurationError(fileSystem.readFileString(artifactPath))
  const completeMarker = decodeDataRootMarker(path, content)
  if (
    Result.isSuccess(completeMarker) &&
    completeMarker.success._tag === "Bound" &&
    completeMarker.success.targetBasename !== path.basename(stagingRoot)
  ) return yield* configurationError()
  if (!isPotentialMarkerPrefix(path, content)) return yield* configurationError()
  return true
})

const inspectLostDataRootClaims = Effect.fn("ControlCenterCli.inspectLostDataRootClaims")(function*(
  request: LostClaimDetection
) {
  const { fileSystem, parent, path, requestedClaimBasename } = request
  const entries = yield* mapConfigurationError(fileSystem.readDirectory(parent))
  for (const entry of entries) {
    if (!entry.startsWith(DATA_ROOT_STAGING_PREFIX) || path.basename(entry) !== entry) continue
    const stagingRoot = path.join(parent, entry)
    const rootInfo = yield* validatePrivateDirectory(fileSystem, stagingRoot)
    const stagingEntries = yield* mapConfigurationError(fileSystem.readDirectory(stagingRoot))
    let hasDurableEntry = false
    for (const name of stagingEntries) {
      if (!(yield* validateProtocolArtifact(fileSystem, path, stagingRoot, rootInfo, name))) {
        hasDurableEntry = true
      }
    }
    if (!hasDurableEntry) continue

    const marker = yield* validateMarker(
      fileSystem,
      path,
      path.join(stagingRoot, DATA_ROOT_MARKER_NAME),
      rootInfo
    )
    if (marker._tag === "Legacy") return yield* configurationError()
    if (marker.targetBasename !== entry) return yield* configurationError()
    if (marker.claimBasename !== requestedClaimBasename) continue

    const boundClaim = path.join(parent, marker.claimBasename)
    const claimedTarget = yield* fileSystem.readLink(boundClaim).pipe(Effect.result)
    if (Result.isFailure(claimedTarget) || claimedTarget.success !== entry) {
      return yield* configurationError()
    }
  }
})

const refuseLostDataRootClaim = Effect.fn("ControlCenterCli.refuseLostDataRootClaim")(function*(
  request: LostClaimDetection
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspected = yield* inspectLostDataRootClaims(request).pipe(Effect.result)
    if (Result.isSuccess(inspected)) return
    if (attempt === 2) return yield* Effect.fail(inspected.failure)
    yield* Effect.yieldNow
  }
})

const resolveClaimedDataRoot = Effect.fn("ControlCenterCli.resolveClaimedDataRoot")(function*(
  request: FreshDataRootPublication
) {
  const { cryptoService, dataRoot, fileSystem, parent, path } = request
  const canonicalRoot = yield* mapConfigurationError(fileSystem.realPath(dataRoot))
  if (canonicalRoot === dataRoot) return dataRoot

  const claimedTarget = yield* mapConfigurationError(fileSystem.readLink(dataRoot))
  const stagingRoot = resolveStagingRoot(path, parent, claimedTarget)
  if (Option.isNone(stagingRoot)) return yield* configurationError()

  const stagingInfo = yield* validatePrivateDirectory(fileSystem, stagingRoot.value)
  const marker = yield* validateMarkerForClaim(
    fileSystem,
    path,
    path.join(stagingRoot.value, DATA_ROOT_MARKER_NAME),
    stagingInfo,
    path.basename(dataRoot),
    path.basename(stagingRoot.value)
  )
  if (marker._tag === "Legacy") return yield* configurationError()
  yield* verifyProcessOwnership({
    cryptoService,
    dataRoot: stagingRoot.value,
    fileSystem,
    initialRootInfo: stagingInfo,
    path
  })
  return stagingRoot.value
})

const publishFreshDataRoot = Effect.fn("ControlCenterCli.publishFreshDataRoot")(function*(
  request: FreshDataRootPublication
) {
  const { cryptoService, dataRoot, fileSystem, parent, path } = request
  yield* Effect.scoped(
    Effect.uninterruptible(
      Effect.gen(function*() {
        const stagingRoot = yield* mapConfigurationError(
          fileSystem.makeTempDirectory({ directory: parent, prefix: DATA_ROOT_STAGING_PREFIX })
        )
        const stagingName = path.basename(stagingRoot)
        const removeUnclaimedStagingRoot = fileSystem.remove(stagingRoot, { force: true, recursive: true }).pipe(
          Effect.andThen(syncPath(fileSystem, parent)),
          Effect.ignore
        )
        yield* Effect.addFinalizer(() =>
          fileSystem.readLink(dataRoot).pipe(
            Effect.result,
            Effect.flatMap((claimedTarget) => {
              if (Result.isSuccess(claimedTarget)) {
                return claimedTarget.success === stagingName ? Effect.void : removeUnclaimedStagingRoot
              }
              if (claimedTarget.failure.reason._tag === "NotFound") return removeUnclaimedStagingRoot
              return fileSystem.realPath(dataRoot).pipe(
                Effect.result,
                Effect.flatMap((resolvedRoot) =>
                  Result.isSuccess(resolvedRoot) && resolvedRoot.success !== stagingRoot
                    ? removeUnclaimedStagingRoot
                    : Effect.void
                )
              )
            })
          )
        )
        yield* mapConfigurationError(fileSystem.chmod(stagingRoot, DATA_ROOT_DIRECTORY_MODE))
        yield* publishMarker({
          claimBasename: path.basename(dataRoot),
          cryptoService,
          dataRoot: stagingRoot,
          fileSystem,
          markerPath: path.join(stagingRoot, DATA_ROOT_MARKER_NAME),
          targetBasename: path.basename(stagingRoot)
        })
        yield* syncPath(fileSystem, stagingRoot)

        const claimed = yield* fileSystem.symlink(stagingName, dataRoot).pipe(Effect.result)
        if (Result.isFailure(claimed)) {
          if (claimed.failure.reason._tag !== "AlreadyExists") return yield* configurationError()
          const existingClaim = yield* fileSystem.readLink(dataRoot).pipe(Effect.result)
          if (Result.isFailure(existingClaim) || existingClaim.success !== stagingName) return
        }
        yield* syncPath(fileSystem, parent)
      })
    )
  )
})

/** Decode every path derived from CONTROL_CENTER_DATA_ROOT into typed configuration failures. */
export const decodeControlCenterDataPaths = Effect.fn("decodeControlCenterDataPaths")(function*(
  configuredDataRoot: string
): Effect.fn.Return<ControlCenterDataPaths, PersistenceConfigError, Path.Path> {
  const path = yield* Path.Path
  const decodedRoot = yield* Schema.decodeUnknownEffect(ConfiguredDataRoot)(configuredDataRoot).pipe(
    Effect.mapError(configurationError)
  )
  const dataRoot = path.resolve(decodedRoot)
  if (path.dirname(dataRoot) === dataRoot) return yield* configurationError()
  const persistenceConfig = yield* decodePersistenceConfig({
    blobRoot: path.join(dataRoot, "blobs"),
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${path.join(dataRoot, "control-center.db")}`,
    maxConnections: 1
  })
  const secretRoot = yield* Schema.decodeUnknownEffect(SecretRoot)(path.join(dataRoot, "secrets")).pipe(
    Effect.mapError(configurationError)
  )
  return { dataRoot, persistenceConfig, secretRoot }
})

/** Create or verify a dedicated data root and return its canonical operational paths. */
export const prepareControlCenterDataRoot = Effect.fn("prepareControlCenterDataRoot")(function*(
  dataPaths: ControlCenterDataPaths
): Effect.fn.Return<ControlCenterDataPaths, PersistenceConfigError, Crypto.Crypto | FileSystem.FileSystem | Path.Path> {
  const cryptoService = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(dataPaths.dataRoot)
  const claimBasename = path.basename(dataPaths.dataRoot)
  if (claimBasename.startsWith(DATA_ROOT_STAGING_PREFIX)) return yield* configurationError()
  const existed = yield* mapConfigurationError(fileSystem.exists(dataPaths.dataRoot))

  if (!existed) {
    yield* mapConfigurationError(fileSystem.makeDirectory(parent, { recursive: true }))
    yield* refuseLostDataRootClaim({
      fileSystem,
      parent,
      path,
      requestedClaimBasename: claimBasename
    })
    yield* publishFreshDataRoot({
      cryptoService,
      dataRoot: dataPaths.dataRoot,
      fileSystem,
      parent,
      path
    })
  }

  const operationalRoot = yield* resolveClaimedDataRoot({
    cryptoService,
    dataRoot: dataPaths.dataRoot,
    fileSystem,
    parent,
    path
  })
  const operationalPaths = operationalRoot === dataPaths.dataRoot
    ? dataPaths
    : yield* decodeControlCenterDataPaths(operationalRoot)

  const rootInfo = yield* validatePrivateDirectory(fileSystem, operationalPaths.dataRoot)
  const targetBasename = path.basename(operationalPaths.dataRoot)
  const markerPath = path.join(operationalPaths.dataRoot, DATA_ROOT_MARKER_NAME)
  const hasMarker = yield* mapConfigurationError(fileSystem.exists(markerPath))
  const existingMarker = hasMarker
    ? Option.some(
      yield* validateMarkerForClaim(
        fileSystem,
        path,
        markerPath,
        rootInfo,
        claimBasename,
        targetBasename
      )
    )
    : Option.none<DataRootMarker>()
  yield* verifyProcessOwnership({
    cryptoService,
    dataRoot: operationalPaths.dataRoot,
    fileSystem,
    initialRootInfo: rootInfo,
    path
  })
  if (Option.isNone(existingMarker)) {
    yield* validateLegacyDataRoot({ dataPaths: operationalPaths, fileSystem, path, rootInfo })
    yield* removeValidPendingMarkers(
      {
        dataRoot: operationalPaths.dataRoot,
        fileSystem,
        path,
        rootInfo
      },
      claimBasename,
      targetBasename
    )
    yield* publishMarker({
      claimBasename,
      cryptoService,
      dataRoot: operationalPaths.dataRoot,
      fileSystem,
      markerPath,
      targetBasename
    })
  } else {
    yield* removeValidPendingMarkers(
      {
        dataRoot: operationalPaths.dataRoot,
        fileSystem,
        path,
        rootInfo
      },
      claimBasename,
      targetBasename
    )
    if (existingMarker.value._tag === "Legacy") {
      yield* publishMarker({
        claimBasename,
        cryptoService,
        dataRoot: operationalPaths.dataRoot,
        fileSystem,
        markerPath,
        targetBasename
      })
    }
  }
  const finalMarker = yield* validateMarkerForClaim(
    fileSystem,
    path,
    markerPath,
    rootInfo,
    claimBasename,
    targetBasename
  )
  if (finalMarker._tag !== "Bound") return yield* configurationError()
  return operationalPaths
})
