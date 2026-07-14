import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

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
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  dataRoot: string,
  rootInfo: FileSystem.File.Info
) {
  const databaseInfo = yield* mapConfigurationError(fileSystem.stat(path.join(dataRoot, "control-center.db")))
  // The database is the earliest durable identity created by pre-marker builds.
  // Blob and secret roots may still be absent when recovering an interrupted
  // first startup, so requiring them here would make the owner code unreachable.
  if (databaseInfo.type !== "File" || !sameOwner(rootInfo, databaseInfo)) {
    return yield* configurationError()
  }
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

const createMarker = Effect.fn("ControlCenterCli.createDataRootMarker")(function*(
  fileSystem: FileSystem.FileSystem,
  markerPath: string,
  dataRoot: string
) {
  const created = yield* fileSystem
    .writeFileString(markerPath, DATA_ROOT_MARKER_CONTENT, {
      flag: "wx",
      mode: DATA_ROOT_MARKER_MODE
    })
    .pipe(Effect.result)
  if (Result.isFailure(created)) {
    if (created.failure.reason._tag === "AlreadyExists") return
    return yield* configurationError()
  }
  yield* mapConfigurationError(fileSystem.chmod(markerPath, DATA_ROOT_MARKER_MODE))
  yield* syncPath(fileSystem, markerPath)
  yield* syncPath(fileSystem, dataRoot)
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

/** Create or verify the private marker that identifies a dedicated Control Center data root. */
export const prepareControlCenterDataRoot = Effect.fn("prepareControlCenterDataRoot")(function*(
  dataPaths: ControlCenterDataPaths
): Effect.fn.Return<void, PersistenceConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(dataPaths.dataRoot)
  const existed = yield* mapConfigurationError(fileSystem.exists(dataPaths.dataRoot))
  let createdRoot = false

  if (!existed) {
    yield* mapConfigurationError(fileSystem.makeDirectory(parent, { recursive: true }))
    const created = yield* fileSystem
      .makeDirectory(dataPaths.dataRoot, {
        mode: DATA_ROOT_DIRECTORY_MODE
      })
      .pipe(Effect.result)
    if (Result.isSuccess(created)) {
      createdRoot = true
      yield* mapConfigurationError(fileSystem.chmod(dataPaths.dataRoot, DATA_ROOT_DIRECTORY_MODE))
    } else if (created.failure.reason._tag !== "AlreadyExists") {
      return yield* configurationError()
    }
  }

  const rootInfo = yield* validatePrivateDirectory(fileSystem, dataPaths.dataRoot)
  const markerPath = path.join(dataPaths.dataRoot, DATA_ROOT_MARKER_NAME)
  const hasMarker = yield* mapConfigurationError(fileSystem.exists(markerPath))
  if (!hasMarker && !createdRoot) {
    yield* validateLegacyDataRoot(fileSystem, path, dataPaths.dataRoot, rootInfo)
  }
  if (!hasMarker) yield* createMarker(fileSystem, markerPath, dataPaths.dataRoot)
  yield* validateMarker(fileSystem, markerPath, rootInfo)
})
