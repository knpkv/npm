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
const DATA_ROOT_MARKER_CONTENT = "@knpkv/control-center:data-root:v1\n"
const DATA_ROOT_PENDING_MARKER_PREFIX = `${DATA_ROOT_MARKER_NAME}.pending-`
const DATA_ROOT_STAGING_PREFIX = ".control-center-incoming-"
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
  readonly cryptoService: Crypto.Crypto
  readonly dataRoot: string
  readonly fileSystem: FileSystem.FileSystem
  readonly markerPath: string
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
    Number(markerInfo.size) !== DATA_ROOT_MARKER_CONTENT.length
  ) {
    return yield* configurationError()
  }
  const content = yield* mapConfigurationError(fileSystem.readFileString(markerPath))
  if (content !== DATA_ROOT_MARKER_CONTENT) return yield* configurationError()
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
  const { cryptoService, dataRoot, fileSystem, markerPath } = request
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
          fileSystem.writeFileString(pendingMarker, DATA_ROOT_MARKER_CONTENT, {
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

const validateRepairableMarker = Effect.fn("ControlCenterCli.validateRepairableDataRootMarker")(function*(
  fileSystem: FileSystem.FileSystem,
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
    Number(markerInfo.size) >= DATA_ROOT_MARKER_CONTENT.length
  ) return yield* configurationError()

  const content = yield* mapConfigurationError(fileSystem.readFileString(markerPath))
  if (!DATA_ROOT_MARKER_CONTENT.startsWith(content)) return yield* configurationError()
})

const removeValidPendingMarkers = Effect.fn("ControlCenterCli.removeValidPendingMarkers")(function*(
  request: PendingMarkerCleanup
) {
  const { dataRoot, fileSystem, path, rootInfo } = request
  const entries = yield* mapConfigurationError(fileSystem.readDirectory(dataRoot))
  const pendingNames = entries.filter((entry) => {
    if (!entry.startsWith(DATA_ROOT_PENDING_MARKER_PREFIX)) return false
    const suffix = entry.slice(DATA_ROOT_PENDING_MARKER_PREFIX.length)
    return suffix.length === 32 && Array.from(suffix).every((character) => /[0-9a-f]/u.test(character))
  })

  for (const pendingName of pendingNames) {
    const pendingPath = path.join(dataRoot, pendingName)
    const canonicalPending = yield* mapConfigurationError(fileSystem.realPath(pendingPath))
    const pendingInfo = yield* mapConfigurationError(fileSystem.stat(pendingPath))
    if (
      canonicalPending !== pendingPath ||
      pendingInfo.type !== "File" ||
      (pendingInfo.mode & 0o777) !== DATA_ROOT_MARKER_MODE ||
      !sameOwner(rootInfo, pendingInfo) ||
      Number(pendingInfo.size) > DATA_ROOT_MARKER_CONTENT.length
    ) continue

    const content = yield* mapConfigurationError(fileSystem.readFileString(pendingPath))
    if (!DATA_ROOT_MARKER_CONTENT.startsWith(content)) continue
    yield* mapConfigurationError(fileSystem.remove(pendingPath))
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
        const probePath = path.join(alias, `.control-center-owner-${Encoding.encodeHex(random)}`)
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

const resolveClaimedDataRoot = Effect.fn("ControlCenterCli.resolveClaimedDataRoot")(function*(
  request: FreshDataRootPublication
) {
  const { cryptoService, dataRoot, fileSystem, parent, path } = request
  const claimedTarget = yield* fileSystem.readLink(dataRoot).pipe(Effect.result)
  if (Result.isFailure(claimedTarget)) return dataRoot
  const stagingRoot = resolveStagingRoot(path, parent, claimedTarget.success)
  if (Option.isNone(stagingRoot)) return yield* configurationError()

  const stagingInfo = yield* validatePrivateDirectory(fileSystem, stagingRoot.value)
  yield* verifyProcessOwnership({
    cryptoService,
    dataRoot: stagingRoot.value,
    fileSystem,
    initialRootInfo: stagingInfo,
    path
  })
  yield* validateMarker(
    fileSystem,
    path.join(stagingRoot.value, DATA_ROOT_MARKER_NAME),
    stagingInfo
  )
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
        yield* Effect.addFinalizer(() =>
          fileSystem.readLink(dataRoot).pipe(
            Effect.result,
            Effect.flatMap((claimedTarget) =>
              Result.isSuccess(claimedTarget) && claimedTarget.success === stagingName
                ? Effect.void
                : fileSystem.remove(stagingRoot, { force: true, recursive: true }).pipe(
                  Effect.andThen(syncPath(fileSystem, parent)),
                  Effect.ignore
                )
            )
          )
        )
        yield* mapConfigurationError(fileSystem.chmod(stagingRoot, DATA_ROOT_DIRECTORY_MODE))
        yield* publishMarker({
          cryptoService,
          dataRoot: stagingRoot,
          fileSystem,
          markerPath: path.join(stagingRoot, DATA_ROOT_MARKER_NAME)
        })
        yield* syncPath(fileSystem, stagingRoot)

        const claimed = yield* fileSystem.symlink(stagingName, dataRoot).pipe(Effect.result)
        if (Result.isFailure(claimed)) {
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
  const existed = yield* mapConfigurationError(fileSystem.exists(dataPaths.dataRoot))

  if (!existed) {
    yield* mapConfigurationError(fileSystem.makeDirectory(parent, { recursive: true }))
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
  yield* verifyProcessOwnership({
    cryptoService,
    dataRoot: operationalPaths.dataRoot,
    fileSystem,
    initialRootInfo: rootInfo,
    path
  })
  const markerPath = path.join(operationalPaths.dataRoot, DATA_ROOT_MARKER_NAME)
  const hasMarker = yield* mapConfigurationError(fileSystem.exists(markerPath))
  if (!hasMarker) {
    yield* validateLegacyDataRoot({ dataPaths: operationalPaths, fileSystem, path, rootInfo })
    yield* removeValidPendingMarkers({
      dataRoot: operationalPaths.dataRoot,
      fileSystem,
      path,
      rootInfo
    })
    yield* publishMarker({
      cryptoService,
      dataRoot: operationalPaths.dataRoot,
      fileSystem,
      markerPath
    })
  } else {
    const markerValidation = yield* validateMarker(fileSystem, markerPath, rootInfo).pipe(Effect.result)
    if (Result.isFailure(markerValidation)) {
      yield* validateRepairableMarker(fileSystem, markerPath, rootInfo)
      yield* removeValidPendingMarkers({
        dataRoot: operationalPaths.dataRoot,
        fileSystem,
        path,
        rootInfo
      })
      const otherEntries = (yield* mapConfigurationError(fileSystem.readDirectory(operationalPaths.dataRoot)))
        .filter((entry) => entry !== DATA_ROOT_MARKER_NAME)
      if (otherEntries.length > 0) {
        yield* validateLegacyDataRoot({ dataPaths: operationalPaths, fileSystem, path, rootInfo })
      }
      yield* publishMarker({
        cryptoService,
        dataRoot: operationalPaths.dataRoot,
        fileSystem,
        markerPath
      })
    }
  }
  yield* validateMarker(fileSystem, markerPath, rootInfo)
  return operationalPaths
})
